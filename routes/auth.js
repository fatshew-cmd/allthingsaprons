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
      .select('accountStatus onboardingStatus username displayName email avatar bio sex orientation location birthdate');
    if (!user || user.accountStatus !== 'onboarding') return res.redirect('/onboarding');
    const lockedStatuses = ['pending_id_verification', 'pending_approval', 'approved'];
    if (lockedStatuses.includes(user.onboardingStatus)) return res.redirect('/onboarding');
    return res.render('signup', {
      title: 'Edit Profile',
      error: null,
      editUser: {
        username:    user.username?.value    || '',
        displayName: user.displayName?.value || '',
        email:       user.email?.value       || '',
        bio:         user.bio?.value         || '',
        sex:         user.sex?.value         || '',
        orientation: user.orientation?.value || '',
        location:    user.location?.value    || '',
        birthdate:   user.birthdate?.value ? new Date(user.birthdate.value).toISOString().split('T')[0] : '',
        avatar:      user.avatar?.value      || null,
      },
    });
  }
  res.render('signup', { title: 'Sign Up', error: null, editUser: null });
});

router.post('/auth/send-otp', async (req, res) => {
  const { email, username } = req.body;
  try {
    if (!req.session.userId) {
      const existing = await User.findOne({
        $or: [{ 'email.value': email.toLowerCase() }, { 'username.value': username.toLowerCase() }],
      });
      if (existing) {
        if (existing.email.value === email.toLowerCase()) {
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
      username, displayName, email, password, confirmPassword,
      bio, sex, orientation, location, birthdate, otp,
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
    if (bio && bio.trim().length > 0 && (bio.trim().length < 20 || bio.trim().length > 220)) {
      return renderError('Bio must be between 20 and 220 characters.');
    }

    // ── Edit path ────────────────────────────────────────────────────
    if (isEdit) {
      const currentUser = await User.findById(req.session.userId).select('accountStatus onboardingStatus');
      if (!currentUser || currentUser.accountStatus !== 'onboarding') {
        return renderError('Cannot edit profile at this stage.');
      }
      const lockedStatuses = ['pending_id_verification', 'pending_approval', 'approved'];
      if (lockedStatuses.includes(currentUser.onboardingStatus)) {
        return res.redirect('/onboarding');
      }

      const conflict = await User.findOne({
        _id: { $ne: req.session.userId },
        $or: [{ 'email.value': email.toLowerCase() }, { 'username.value': username.toLowerCase() }],
      });
      if (conflict) {
        if (conflict.email.value === email.toLowerCase()) return renderError('This email is already registered by another account.');
        return renderError('This username is already taken.');
      }

      const now    = new Date();
      const setOp  = {};
      const pushOp = {};

      setOp['email.value']     = email.toLowerCase().trim();
      setOp['email.confirmed'] = true;
      pushOp['email.history']  = { value: email.toLowerCase().trim(), setAt: now, source: 'signup' };

      setOp['username.value']    = username.toLowerCase().trim();
      pushOp['username.history'] = { value: username.toLowerCase().trim(), setAt: now, source: 'signup' };

      setOp['displayName.value']    = displayNameTrimmed;
      pushOp['displayName.history'] = { value: displayNameTrimmed, setAt: now, source: 'signup' };

      setOp['sex.value']    = sex;
      pushOp['sex.history'] = { value: sex, setAt: now, source: 'signup' };

      setOp['birthdate.value']    = new Date(birthdate);
      pushOp['birthdate.history'] = { value: new Date(birthdate), setAt: now, source: 'signup' };

      if (bio) {
        setOp['bio.value']    = bio.trim();
        pushOp['bio.history'] = { value: bio.trim(), setAt: now, source: 'signup' };
      }
      if (orientation) {
        setOp['orientation.value']    = orientation;
        pushOp['orientation.history'] = { value: orientation, setAt: now, source: 'signup' };
      }
      if (location) {
        setOp['location.value']    = location;
        pushOp['location.history'] = { value: location, setAt: now, source: 'signup' };
      }
      if (req.files?.avatar?.[0]) {
        const avatarPath = `/uploads/avatars/${req.files.avatar[0].filename}`;
        setOp['avatar.value']    = avatarPath;
        pushOp['avatar.history'] = { value: avatarPath, setAt: now, source: 'signup' };
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
        setOp.password = await bcrypt.hash(password, 12);
      }

      delete req.session.pendingOtp;
      await User.findByIdAndUpdate(req.session.userId, { $set: setOp, $push: pushOp });
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
      $or: [{ 'email.value': email.toLowerCase() }, { 'username.value': username.toLowerCase() }],
    });
    if (existing) {
      if (existing.email.value === email.toLowerCase()) {
        if (existing.accountStatus === 'onboarding')
          return renderError('An account with this email is already being set up. Please log in to continue your onboarding.');
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
    const user = await User.findOne({ 'email.value': email.toLowerCase() });
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
