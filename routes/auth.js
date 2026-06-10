const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcrypt');
const { Resend } = require('resend');
const User        = require('../models/User');
const BannedEmail = require('../models/BannedEmail');
const upload   = require('../middleware/upload');

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@allthingsaprons.com';

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

function genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── Signup ────────────────────────────────────────────────────────

router.get('/signup', (req, res) => {
  if (req.session.userId) return res.redirect('/feed');
  res.render('signup', { title: 'Sign Up', error: null, editUser: null });
});

router.post('/auth/send-otp', async (req, res) => {
  const { email, username } = req.body;
  try {
    if (!req.session.userId) {
      const [existing, banned] = await Promise.all([
        User.findOne({ $or: [{ 'email.value': email.toLowerCase() }, { 'username.value': username.toLowerCase() }] }),
        BannedEmail.exists({ email: email.toLowerCase() }),
      ]);
      if (banned) {
        return res.json({ ok: false, field: 'email', message: 'Email already registered.' });
      }
      if (existing) {
        if (existing.email.value === email.toLowerCase()) {
          return res.json({ ok: false, field: 'email', message: 'Email already registered.' });
        }
        return res.json({ ok: false, field: 'username', message: 'Username already taken.' });
      }
    }

    const code = genOtp();
    req.session.pendingOtp = { email: email.toLowerCase(), code };

    const resend = getResend();
    if (resend) {
      await resend.emails.send({
        from: FROM_EMAIL,
        to: email,
        subject: 'Your AllThingsAprons verification code',
        html: `<p style="font-family:sans-serif">Your verification code is: <strong style="font-size:24px;letter-spacing:4px">${code}</strong></p><p style="font-family:sans-serif;color:#666">This code does not expire.</p>`,
      });
      res.json({ ok: true });
    } else {
      console.log(`[DEV OTP] ${email} → ${code}`);
      res.json({ ok: true, devCode: code });
    }
  } catch (err) {
    console.error('send-otp error:', err);
    res.json({ ok: false, message: 'Failed to send code. Please try again.' });
  }
});

router.post('/signup', upload.fields([{ name: 'avatar', maxCount: 1 }]), async (req, res) => {
  const renderError = (msg) => res.render('signup', { title: 'Sign Up', error: msg, editUser: null });

  try {
    const {
      username, displayName, email, password, confirmPassword,
      bio, sex, orientation, location, birthdate, otp,
      ageAcknowledged, adultContentAcknowledged,
    } = req.body;

    const pending = req.session.pendingOtp;
    if (!pending || pending.email !== email.toLowerCase() || pending.code !== String(otp).trim()) {
      return renderError('Invalid or expired verification code. Please go back and try again.');
    }

    if (!username || !displayName || !email || !sex || !birthdate) {
      return renderError('Please complete all required fields.');
    }
    if (!/^[a-zA-Z][a-zA-Z0-9]{2,14}$/.test(username)) {
      return renderError('Username must start with a letter, contain only letters and digits, and be 3–15 characters.');
    }
    const displayNameTrimmed = displayName.trim();
    const displayNameWords   = displayNameTrimmed.split(/\s+/).filter(Boolean).length;
    if (!displayNameTrimmed) return renderError('Display name is required.');
    if (displayNameWords > 3) return renderError('Display name can be at most 3 words.');
    if (displayNameTrimmed.length > 50) return renderError('Display name cannot exceed 50 characters.');
    const bioCharCount = bio ? bio.replace(/\s/g, '').length : 0;
    if (bioCharCount > 0 && (bioCharCount < 20 || bioCharCount > 220)) {
      return renderError('Bio must be between 20 and 220 characters (spaces not counted).');
    }

    // ── New signup path ──────────────────────────────────────────────
    if (!password) return renderError('Please complete all required fields.');
    if (password !== confirmPassword) return renderError('Passwords do not match.');
    const pwLower   = (password.match(/[a-z]/g) || []).length;
    const pwUpper   = (password.match(/[A-Z]/g) || []).length;
    const pwDigit   = (password.match(/[0-9]/g) || []).length;
    const pwSpecial = (password.match(/[^a-zA-Z0-9]/g) || []).length;
    if (password.length < 12 || pwLower < 3 || pwUpper < 3 || pwDigit < 3 || pwSpecial < 3) {
      return renderError('Password must be at least 12 characters with 3+ lowercase, 3+ uppercase, 3+ digits, and 3+ special characters.');
    }

    if (ageAcknowledged !== 'on') return renderError('You must confirm that you are 18 years of age or older.');
    if (adultContentAcknowledged !== 'on') return renderError('You must acknowledge that this platform contains adult-rated content.');

    const [existing, banned] = await Promise.all([
      User.findOne({ $or: [{ 'email.value': email.toLowerCase() }, { 'username.value': username.toLowerCase() }] }),
      BannedEmail.exists({ email: email.toLowerCase() }),
    ]);
    if (banned) return renderError('This email is already registered.');
    if (existing) {
      if (existing.email.value === email.toLowerCase()) {
        return renderError('This email is already registered.');
      }
      return renderError('This username is already taken.');
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const avatarPath     = req.files?.avatar?.[0]
      ? `/uploads/avatars/${req.files.avatar[0].filename}`
      : null;

    const now = new Date();

    const createData = {
      password: hashedPassword,
      email: {
        value:     email.toLowerCase().trim(),
        confirmed: true,
        history:   [{ value: email.toLowerCase().trim(), setAt: now, source: 'signup' }],
      },
      username: {
        value:   username.toLowerCase().trim(),
        history: [{ value: username.toLowerCase().trim(), setAt: now, source: 'signup' }],
      },
      displayName: {
        value:   displayNameTrimmed,
        history: [{ value: displayNameTrimmed, setAt: now, source: 'signup' }],
      },
      sex: {
        value:   sex,
        history: [{ value: sex, setAt: now, source: 'signup' }],
      },
      birthdate: {
        value:   new Date(birthdate),
        history: [{ value: new Date(birthdate), setAt: now, source: 'signup' }],
      },
      ageAcknowledged:            true,
      ageAcknowledgedAt:          now,
      adultContentAcknowledged:   true,
      adultContentAcknowledgedAt: now,
      accountStatus:              'active',
    };

    if (bio) {
      createData.bio = { value: bio.trim(), history: [{ value: bio.trim(), setAt: now, source: 'signup' }] };
    }
    if (orientation) {
      createData.orientation = { value: orientation, history: [{ value: orientation, setAt: now, source: 'signup' }] };
    }
    if (location) {
      createData.location = { value: location, history: [{ value: location, setAt: now, source: 'signup' }] };
    }
    if (avatarPath) {
      createData.avatar = { value: avatarPath, history: [{ value: avatarPath, setAt: now, source: 'signup' }] };
    }

    const user = await User.create(createData);

    delete req.session.pendingOtp;
    req.session.userId = user._id.toString();
    res.redirect('/feed');
  } catch (err) {
    console.error('Signup error:', err);
    renderError('Something went wrong. Please try again.');
  }
});

// ── Login ─────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/feed');
  res.render('auth/login', { title: 'Log In', error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ 'email.value': email.toLowerCase() });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.render('auth/login', { title: 'Log In', error: 'Invalid email or password.' });
    }
    req.session.userId = user._id.toString();
    res.redirect('/feed');
  } catch (err) {
    console.error('Login error:', err);
    res.render('auth/login', { title: 'Log In', error: 'Something went wrong. Please try again.' });
  }
});

// ── Logout ────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
