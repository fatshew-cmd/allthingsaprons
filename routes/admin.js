const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcrypt');
const User     = require('../models/User');
const TournamentEntry = require('../models/TournamentEntry');
const isAdmin  = require('../middleware/isAdmin');

router.get('/login', (req, res) => {
  res.render('admin/login', { title: 'Admin Login', error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email: email.toLowerCase(), role: 'admin' });
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
    const pendingEntries = await TournamentEntry.countDocuments({ approvalStatus: 'pending' });
    res.locals.sidebarCounts = { pendingEntries };
  } catch {
    res.locals.sidebarCounts = { pendingEntries: 0 };
  }
  next();
});

// ── Dashboard ─────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const [pendingCount, totalUsers, activeUsers, onboardingUsers] = await Promise.all([
    TournamentEntry.countDocuments({ approvalStatus: 'pending' }),
    User.countDocuments({ role: 'user' }),
    User.countDocuments({ accountStatus: 'active' }),
    User.countDocuments({ accountStatus: 'onboarding' }),
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
  res.render('admin/users/detail', { title: user.email, currentPage: 'users', user });
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

// ── Phase 6 stub routes ───────────────────────────────────────────

router.get('/verification', (req, res) => {
  res.render('admin/verification', { title: 'ID Verification', currentPage: 'verification' });
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
