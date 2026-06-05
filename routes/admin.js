const express        = require('express');
const router         = express.Router();
const bcrypt         = require('bcrypt');
const User           = require('../models/User');
const TournamentEntry = require('../models/TournamentEntry');
const SupportMessage = require('../models/SupportMessage');
const isAdmin        = require('../middleware/isAdmin');

router.get('/login', (req, res) => {
  res.render('admin/login', { title: 'Admin Login', error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ 'email.value': email.toLowerCase(), role: 'admin' });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.render('admin/login', { title: 'Admin Login', error: 'Invalid credentials' });
    }
    req.session.isAdmin = true;
    req.session.adminId = user._id;
    res.redirect('/admin');
  } catch {
    res.render('admin/login', { title: 'Admin Login', error: 'Something went wrong' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

router.use(isAdmin);

// Inject sidebar badge counts into res.locals for all protected routes
router.use(async (req, res, next) => {
  try {
    const [pendingEntries, pendingVerifications, unreadMessages] = await Promise.all([
      TournamentEntry.countDocuments({ approvalStatus: 'pending' }),
      User.countDocuments({ idVerificationStatus: 'pending' }),
      SupportMessage.countDocuments({ from: 'user', readBySupport: false }),
    ]);
    res.locals.sidebarCounts = { pendingEntries, pendingVerifications, unreadMessages };
  } catch {
    res.locals.sidebarCounts = { pendingEntries: 0, pendingVerifications: 0, unreadMessages: 0 };
  }
  next();
});

router.use('/support', require('./adminSupport'));

// ── Dashboard ─────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const [pendingCount, totalUsers, activeUsers, onboardingUsers] = await Promise.all([
    TournamentEntry.countDocuments({ approvalStatus: 'pending' }),
    User.countDocuments({ role: 'user' }),
    User.countDocuments({ role: 'user', accountStatus: 'active' }),
    User.countDocuments({ role: 'user', accountStatus: 'onboarding' }),
  ]);
  res.render('admin/dashboard', {
    title: 'Dashboard',
    currentPage: 'dashboard',
    pendingCount,
    totalUsers,
    activeUsers,
    onboardingUsers,
  });
});

// ── Users ─────────────────────────────────────────────────────────

router.get('/users', async (req, res) => {
  const users = await User.find({ role: 'user' }).sort({ createdAt: -1 });
  res.render('admin/users/index', { title: 'Users', currentPage: 'users', users });
});

router.get('/users/:id', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).send('User not found');
  res.render('admin/users/detail', { title: user.email?.value, currentPage: 'users', user });
});

// ── Entry Review ──────────────────────────────────────────────────

router.get('/entries', async (req, res) => {
  const entries = await TournamentEntry.find({ approvalStatus: 'pending' })
    .populate('userId', 'username email avatar')
    .populate('entryId', 'mediaUrl mediaType caption')
    .populate('tournamentId', 'name')
    .sort({ submittedAt: 1 });
  res.render('admin/entries', { title: 'Entry Review', currentPage: 'entries', entries });
});

router.post('/entries/:id/approve', async (req, res) => {
  const te = await TournamentEntry.findById(req.params.id);
  if (!te) return res.redirect('/admin/entries');
  await Promise.all([
    TournamentEntry.findByIdAndUpdate(te._id, { approvalStatus: 'approved', reviewedAt: new Date() }),
    User.findByIdAndUpdate(te.userId, { onboardingStatus: 'approved', accountStatus: 'active' }),
  ]);
  res.redirect('/admin/entries');
});

router.post('/entries/:id/reject', async (req, res) => {
  const te = await TournamentEntry.findById(req.params.id);
  if (!te) return res.redirect('/admin/entries');
  await Promise.all([
    TournamentEntry.findByIdAndUpdate(te._id, { approvalStatus: 'rejected', reviewedAt: new Date() }),
    User.findByIdAndUpdate(te.userId, { onboardingStatus: 'rejected' }),
  ]);
  res.redirect('/admin/entries');
});

// ── ID Verification ───────────────────────────────────────────────

const SEX_LABELS_V = { male: 'Male', female: 'Female', other: 'Other', 'prefer-not-to-say': 'Prefer not to say' };

function genClaimNumber() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return 'VRF-' + code;
}

function calcAgeVerify(birthdate) {
  if (!birthdate) return null;
  const today = new Date();
  const birth  = new Date(birthdate);
  let age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth() ||
      (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age--;
  return age;
}

router.get('/verification', async (req, res) => {
  const pending = await User.find({ idVerificationStatus: 'pending' })
    .select('username email avatar sex birthdate createdAt')
    .sort({ createdAt: 1 });
  res.render('admin/verification', {
    title: 'ID Verification',
    currentPage: 'verification',
    pending,
  });
});

router.get('/verification/:id', async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, idVerificationStatus: 'pending' })
    .select('username email avatar sex birthdate idSelfieUrl idDocUrl idVerificationCode idVerificationSubmittedAt');
  if (!user) return res.redirect('/admin/verification');
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setFullYear(today.getFullYear() - 19);
  cutoff.setDate(cutoff.getDate() - 1);

  const submittedAt = user.idVerificationSubmittedAt;
  const submittedAtFormatted = submittedAt
    ? submittedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' at ' +
      submittedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    : null;

  res.render('admin/verification-review', {
    title: 'Review Submission',
    currentPage: 'verification',
    user,
    age:      calcAgeVerify(user.birthdate?.value),
    sexLabel: SEX_LABELS_V[user.sex?.value] || user.sex?.value || '—',
    birthdateFormatted: user.birthdate?.value
      ? new Date(user.birthdate.value).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
      : '—',
    ageCutoffFormatted: cutoff.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' }),
    ageCutoffISO: cutoff.toISOString().split('T')[0],
    submittedAtFormatted,
  });
});

router.post('/verification/:id/approve', async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, idVerificationStatus: 'pending' });
    if (!user) return res.redirect('/admin/verification');
    await User.findByIdAndUpdate(user._id, {
      $set:   { idVerified: true, idVerificationStatus: 'none', onboardingStatus: 'pending_submission', idVerificationReviewedAt: new Date() },
      $unset: { idSelfieUrl: 1, idDocUrl: 1, idVerificationCode: 1, idVerificationSubmittedAt: 1, idVerificationRejectionReasons: 1 },
    });
    res.redirect('/admin/verification');
  } catch (err) {
    console.error('Verification approve error:', err);
    res.redirect('/admin/verification');
  }
});

router.post('/verification/:id/reject', async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, idVerificationStatus: 'pending' });
    if (!user) return res.redirect('/admin/verification');
    const raw     = req.body.reasons;
    const reasons = raw ? (Array.isArray(raw) ? raw : [raw]).filter(Boolean) : [];

    const newCount = (user.idVerifyFailedAttempts || 0) + 1;
    const update = {
      $set: {
        idVerificationStatus:           'none',
        idVerificationRejectionReasons: reasons,
        idVerifyFailedAttempts:         newCount,
        idVerificationReviewedAt:       new Date(),
        idVerificationClaimNumber:      genClaimNumber(),
      },
      $unset: { idSelfieUrl: 1, idDocUrl: 1, idVerificationCode: 1, idVerificationSubmittedAt: 1 },
    };

    if (newCount % 3 === 0) {
      update.$set.idVerifyBlockedUntil = new Date(Date.now() + 6 * 60 * 60 * 1000);
    }

    await User.findByIdAndUpdate(user._id, update);
    res.redirect('/admin/verification');
  } catch (err) {
    console.error('Verification reject error:', err);
    res.redirect('/admin/verification');
  }
});

router.get('/tournaments', (req, res) => {
  res.render('admin/tournaments/index', { title: 'Tournaments', currentPage: 'tournaments' });
});

router.get('/tournaments/review', (req, res) => {
  res.render('admin/tournaments/review', { title: 'Tournament Review', currentPage: 'tournament-review' });
});

router.get('/moderation', (req, res) => {
  res.render('admin/moderation', { title: 'Reported Comments', currentPage: 'moderation' });
});

router.get('/content', (req, res) => {
  res.render('admin/content/index', { title: 'Entries', currentPage: 'content' });
});

module.exports = router;
