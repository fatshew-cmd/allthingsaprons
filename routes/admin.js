const express        = require('express');
const router         = express.Router();
const crypto         = require('crypto');
const bcrypt         = require('bcrypt');
const User           = require('../models/User');
const TournamentEntry = require('../models/TournamentEntry');
const SupportMessage = require('../models/SupportMessage');
const isAdmin        = require('../middleware/isAdmin');
const requireDomain  = require('../middleware/requireDomain');

router.get('/login', (req, res) => {
  res.render('admin/login', { title: 'Admin Login', error: null, setup: req.query.setup === '1' });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const ADMIN_TIERS = ['moderator', 'supervisor', 'superadmin', 'founder'];
    const user = await User.findOne({ 'email.value': email.toLowerCase(), role: { $in: ADMIN_TIERS } });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.render('admin/login', { title: 'Admin Login', error: 'Invalid credentials' });
    }
    if (user.accountStatus === 'invited') {
      return res.render('admin/login', { title: 'Admin Login', error: 'Please set up your account using the invite link sent to your email.' });
    }
    if (user.isTemporary && user.temporaryUntil && user.temporaryUntil < new Date()) {
      return res.render('admin/login', { title: 'Admin Login', error: 'Your account has expired. Please contact your administrator.' });
    }
    req.session.isAdmin            = true;
    req.session.adminId            = user._id;
    req.session.adminRole          = user.role;
    req.session.adminPermissions   = user.permissions || [];
    req.session.adminDisplayName   = user.displayName?.value || null;
    req.session.adminEmail         = user.email?.value || null;
    req.session.adminAvatar        = user.avatar?.value || null;
    res.redirect('/admin');
  } catch {
    res.render('admin/login', { title: 'Admin Login', error: 'Something went wrong' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ── Invite acceptance (public — before isAdmin) ───────────────────

router.get('/accept-invite', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/admin/login');
  const user = await User.findOne({ adminInviteToken: token }).lean();
  if (!user) {
    return res.render('admin/accept-invite', { title: 'Set Up Account', token: null, error: 'This invite link is invalid.' });
  }
  if (new Date() > user.adminInviteExpiry) {
    return res.render('admin/accept-invite', { title: 'Set Up Account', token: null, error: 'This invite link has expired. Please contact your administrator.' });
  }
  res.render('admin/accept-invite', { title: 'Set Up Account', token, error: null });
});

router.post('/accept-invite', async (req, res) => {
  const { token, password, confirmPassword } = req.body;
  const renderErr = (msg) => res.render('admin/accept-invite', { title: 'Set Up Account', token, error: msg });

  if (!token) return res.redirect('/admin/login');
  if (!password || password.length < 8) return renderErr('Password must be at least 8 characters.');
  if (password !== confirmPassword) return renderErr('Passwords do not match.');

  const user = await User.findOne({ adminInviteToken: token });
  if (!user) return renderErr('This invite link is invalid.');
  if (new Date() > user.adminInviteExpiry) return renderErr('This invite link has expired. Please contact your administrator.');

  try {
    const hashed = await bcrypt.hash(password, 12);
    await User.findByIdAndUpdate(user._id, {
      password:          hashed,
      accountStatus:     'active',
      $unset:            { adminInviteToken: 1, adminInviteExpiry: 1 },
    });
    res.redirect('/admin/login?setup=1');
  } catch (err) {
    console.error(err);
    renderErr('Something went wrong. Please try again.');
  }
});

router.use(isAdmin);

// Inject sidebar data into res.locals for all protected routes
router.use(async (req, res, next) => {
  const role        = req.session.roleOverride        || req.session.adminRole        || '';
  const permissions = req.session.permissionsOverride || req.session.adminPermissions || [];
  const isFullAccess = role === 'superadmin' || role === 'founder';
  const hasContent   = isFullAccess || permissions.includes('content');
  const hasSupport   = isFullAccess || permissions.includes('support');
  try {
    const [pendingEntries, pendingVerifications, unreadMessages] = await Promise.all([
      hasContent ? TournamentEntry.countDocuments({ approvalStatus: 'pending' })            : Promise.resolve(0),
      hasContent ? User.countDocuments({ idVerificationStatus: 'pending' })                 : Promise.resolve(0),
      hasSupport ? SupportMessage.countDocuments({ from: 'user', readBySupport: false })    : Promise.resolve(0),
    ]);
    res.locals.sidebarCounts    = { pendingEntries, pendingVerifications, unreadMessages };
  } catch {
    res.locals.sidebarCounts    = { pendingEntries: 0, pendingVerifications: 0, unreadMessages: 0 };
  }
  res.locals.adminRole          = role;
  res.locals.adminPermissions   = permissions;
  res.locals.adminDisplayName   = req.session.adminDisplayName || null;
  res.locals.adminEmail         = req.session.adminEmail       || null;
  res.locals.adminAvatar        = req.session.adminAvatar      || null;
  res.locals.isImpersonating    = !!req.session.roleOverride;
  res.locals.realAdminRole      = req.session.adminRole        || '';
  next();
});

router.use('/entries',      requireDomain('content'));
router.use('/verification', requireDomain('content'));
router.use('/profile',      require('./adminProfile'));
router.use('/support',      requireDomain('support'), require('./adminSupport'));
router.use('/admins',       requireDomain(null));
router.use('/applications', requireDomain(null), require('./adminApplications'));

// ── Role impersonation (founder only) ────────────────────────────

const IMPERSONATE_PRESETS = {
  'superadmin':          { role: 'superadmin',  permissions: [] },
  'supervisor:content':  { role: 'supervisor',  permissions: ['content'] },
  'supervisor:comments': { role: 'supervisor',  permissions: ['comments'] },
  'supervisor:support':  { role: 'supervisor',  permissions: ['support'] },
  'moderator:content':   { role: 'moderator',   permissions: ['content'] },
  'moderator:comments':  { role: 'moderator',   permissions: ['comments'] },
  'moderator:support':   { role: 'moderator',   permissions: ['support'] },
};

router.post('/impersonate', (req, res) => {
  if (req.session.adminRole !== 'founder') return res.redirect('/admin');
  const preset = IMPERSONATE_PRESETS[req.body.preset];
  if (!preset) return res.redirect('/admin');
  req.session.roleOverride        = preset.role;
  req.session.permissionsOverride = preset.permissions;
  res.redirect('/admin');
});

router.post('/impersonate/exit', (req, res) => {
  delete req.session.roleOverride;
  delete req.session.permissionsOverride;
  res.redirect('/admin');
});

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

// ── Admin Accounts ────────────────────────────────────────────────

router.get('/admins', async (req, res) => {
  const ADMIN_TIERS = ['moderator', 'supervisor', 'superadmin', 'founder'];
  const admins = await User.find({ role: { $in: ADMIN_TIERS } })
    .select('username displayName email role permissions createdAt')
    .sort({ createdAt: 1 })
    .lean();
  res.render('admin/admins/index', {
    title:       'Admin Accounts',
    currentPage: 'admins',
    admins,
    granterRole: req.session.adminRole,
  });
});

// ── Role Assignment ───────────────────────────────────────────────

const TIER = { user: 0, moderator: 1, supervisor: 2, superadmin: 3, founder: 4 };
const VALID_PERMISSIONS = ['content', 'chat', 'comments', 'financial', 'support'];

router.post('/users/:id/role', async (req, res) => {
  const granterRole = req.session.adminRole;
  if (granterRole !== 'superadmin' && granterRole !== 'founder') {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const target = await User.findById(req.params.id).select('role');
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'founder') return res.status(403).json({ error: 'Founders cannot be reassigned' });

    const { role, permissions = [] } = req.body;
    if (!(role in TIER)) return res.status(400).json({ error: 'Invalid role' });
    if (TIER[granterRole] - TIER[role] < 2) {
      return res.status(403).json({ error: 'Insufficient authority to assign this role' });
    }

    const perms = permissions.filter(p => VALID_PERMISSIONS.includes(p));
    if (role === 'moderator' && perms.length !== 1) {
      return res.status(400).json({ error: 'Moderators must have exactly 1 permission' });
    }
    if (role === 'supervisor' && perms.length < 1) {
      return res.status(400).json({ error: 'Supervisors must have at least 1 permission' });
    }

    const finalPerms = (role === 'user' || role === 'superadmin' || role === 'founder') ? [] : perms;
    await User.findByIdAndUpdate(req.params.id, { role, permissions: finalPerms });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update role' });
  }
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
