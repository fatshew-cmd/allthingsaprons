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

router.get('/', (req, res) => {
  res.render('admin/dashboard', { title: 'Dashboard' });
});

router.get('/users', async (req, res) => {
  const users = await User.find().sort({ createdAt: -1 });
  res.render('admin/users/index', { title: 'Users', users });
});

router.get('/users/:id', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).send('User not found');
  res.render('admin/users/detail', { title: user.email, user });
});

// ── Tournament Entry Review ───────────────────────────────────────

router.get('/entries', async (req, res) => {
  const entries = await TournamentEntry.find({ approvalStatus: 'pending' })
    .populate('userId', 'username email avatar')
    .populate('entryId', 'mediaUrl caption')
    .populate('tournamentId', 'name')
    .sort({ submittedAt: 1 });
  res.render('admin/entries', { title: 'Entry Review', entries });
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

module.exports = router;
