const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcrypt');
const { Resend } = require('resend');
const User     = require('../models/User');
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

router.get('/signup', async (req, res) => {
  if (req.session.userId) {
    const user = await User.findById(req.session.userId)
      .select('accountStatus username email avatar bio sex orientation location birthdate');
    if (!user || user.accountStatus !== 'onboarding') return res.redirect('/onboarding');
    return res.render('signup', {
      title: 'Edit Profile',
      error: null,
      editUser: {
        username:    user.username    || '',
        email:       user.email       || '',
        bio:         user.bio         || '',
        sex:         user.sex         || '',
        orientation: user.orientation || '',
        location:    user.location    || '',
        birthdate:   user.birthdate ? user.birthdate.toISOString().split('T')[0] : '',
        avatar:      user.avatar      || null,
      },
    });
  }
  res.render('signup', { title: 'Sign Up', error: null, editUser: null });
});

router.post('/auth/send-otp', async (req, res) => {
  const { email, username } = req.body;
  try {
    // Skip uniqueness checks when an onboarding user is editing their own profile;
    // conflict with other accounts is caught at POST /signup instead.
    if (!req.session.userId) {
      const existing = await User.findOne({
        $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }],
      });
      if (existing) {
        if (existing.email === email.toLowerCase()) {
          if (existing.accountStatus === 'onboarding')
            return res.json({ ok: false, field: 'email', message: 'An account with this email is already being set up. Please log in to continue your onboarding.' });
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
  const isEdit      = !!(req.session.userId);
  const renderError = (msg) => res.render('signup', { title: isEdit ? 'Edit Profile' : 'Sign Up', error: msg, editUser: null });

  try {
    const {
      username, email, password, confirmPassword,
      bio, sex, orientation, location, birthdate, otp,
    } = req.body;

    const pending = req.session.pendingOtp;
    if (!pending || pending.email !== email.toLowerCase() || pending.code !== String(otp).trim()) {
      return renderError('Invalid or expired verification code. Please go back and try again.');
    }

    if (!username || !email || !sex || !birthdate) {
      return renderError('Please complete all required fields.');
    }
    if (!/^[a-zA-Z][a-zA-Z0-9]{2,14}$/.test(username)) {
      return renderError('Username must start with a letter, contain only letters and digits, and be 3–15 characters.');
    }
    if (bio && bio.trim().length > 0 && (bio.trim().length < 20 || bio.trim().length > 220)) {
      return renderError('Bio must be between 20 and 220 characters.');
    }

    // ── Edit path ────────────────────────────────────────────────────
    if (isEdit) {
      const currentUser = await User.findById(req.session.userId).select('accountStatus');
      if (!currentUser || currentUser.accountStatus !== 'onboarding') {
        return renderError('Cannot edit profile at this stage.');
      }

      const conflict = await User.findOne({
        _id: { $ne: req.session.userId },
        $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }],
      });
      if (conflict) {
        if (conflict.email === email.toLowerCase()) return renderError('This email is already registered by another account.');
        return renderError('This username is already taken.');
      }

      const updateData = {
        username:       username.toLowerCase().trim(),
        email:          email.toLowerCase().trim(),
        bio:            bio || undefined,
        sex,
        orientation:    orientation || undefined,
        location:       location || undefined,
        birthdate:      new Date(birthdate),
        emailConfirmed: true,
      };

      if (req.files?.avatar?.[0]) {
        updateData.avatar = `/uploads/avatars/${req.files.avatar[0].filename}`;
      }

      if (password && password.length > 0) {
        if (password !== confirmPassword) return renderError('Passwords do not match.');
        const pwLower   = (password.match(/[a-z]/g) || []).length;
        const pwUpper   = (password.match(/[A-Z]/g) || []).length;
        const pwDigit   = (password.match(/[0-9]/g) || []).length;
        const pwSpecial = (password.match(/[^a-zA-Z0-9]/g) || []).length;
        if (password.length < 12 || pwLower < 3 || pwUpper < 3 || pwDigit < 3 || pwSpecial < 3) {
          return renderError('Password must be at least 12 characters with 3+ lowercase, 3+ uppercase, 3+ digits, and 3+ special characters.');
        }
        updateData.password = await bcrypt.hash(password, 12);
      }

      delete req.session.pendingOtp;
      await User.findByIdAndUpdate(req.session.userId, updateData);
      return res.redirect('/onboarding');
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

    const existing = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }],
    });
    if (existing) {
      if (existing.email === email.toLowerCase()) {
        if (existing.accountStatus === 'onboarding')
          return renderError('An account with this email is already being set up. Please log in to continue your onboarding.');
        return renderError('This email is already registered.');
      }
      return renderError('This username is already taken.');
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const avatarPath = req.files?.avatar?.[0]
      ? `/uploads/avatars/${req.files.avatar[0].filename}`
      : null;

    const user = await User.create({
      username:         username.toLowerCase().trim(),
      email:            email.toLowerCase().trim(),
      password:         hashedPassword,
      bio:              bio || undefined,
      sex,
      orientation:      orientation || undefined,
      location:         location || undefined,
      birthdate:        new Date(birthdate),
      avatar:           avatarPath,
      emailConfirmed:   true,
      onboardingStatus: 'pending_submission',
    });

    delete req.session.pendingOtp;
    req.session.userId = user._id.toString();
    res.redirect('/onboarding');
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
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.render('auth/login', { title: 'Log In', error: 'Invalid email or password.' });
    }
    req.session.userId = user._id.toString();
    res.redirect(user.onboardingStatus === 'approved' ? '/feed' : '/onboarding');
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
