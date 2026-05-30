const express       = require('express');
const router        = express.Router();
const bcrypt        = require('bcrypt');
const User          = require('../models/User');
const Entry         = require('../models/Entry');
const requireAuth   = require('../middleware/requireAuth');
const requireApproved = require('../middleware/requireApproved');
const upload        = require('../middleware/upload');

router.use(requireAuth);
router.use(requireApproved);

router.get('/', (req, res) => res.redirect('/feed'));

router.get('/feed', (req, res) => {
  res.render('feed', {
    title:      'Feed',
    activePage: 'feed',
    currentUser: req.currentUser,
  });
});

router.get('/leaderboard', (req, res) => {
  res.render('leaderboard', {
    title:      'Leaderboard',
    activePage: 'leaderboard',
    currentUser: req.currentUser,
  });
});

router.get('/search', (req, res) => {
  res.render('search', {
    title:      'Search',
    activePage: 'search',
    currentUser: req.currentUser,
  });
});

router.get('/contests', (req, res) => {
  res.render('contests', {
    title:      'Contests',
    activePage: 'contests',
    currentUser: req.currentUser,
  });
});

router.get('/notifications', (req, res) => {
  res.render('notifications', {
    title:      'Notifications',
    activePage: 'notifications',
    currentUser: req.currentUser,
  });
});

router.get('/messages', (req, res) => {
  res.render('messages', {
    title:      'Messages',
    activePage: 'messages',
    currentUser: req.currentUser,
  });
});

// ── Profile ───────────────────────────────────────────────────────

router.get(['/profile', '/profile/:id'], async (req, res) => {
  const targetId = req.params.id || req.session.userId;
  const isOwn    = targetId === req.session.userId;

  const [user, entries] = await Promise.all([
    User.findById(targetId).select('username bio avatar location createdAt'),
    Entry.find({ userId: targetId }).sort({ createdAt: -1 }),
  ]);

  if (!user) return res.status(404).render('404', { title: 'Not Found' });

  const totalRatings = entries.reduce((s, e) => s + e.ratingCount, 0);
  const avgScore = entries.length
    ? (entries.reduce((s, e) => s + e.ratingAvg * e.ratingCount, 0) / Math.max(totalRatings, 1)).toFixed(1)
    : null;

  res.render('profile', {
    title:      `@${user.username}`,
    activePage: isOwn ? 'profile' : '',
    currentUser: req.currentUser,
    profileUser: user,
    entries,
    totalRatings,
    avgScore,
    isOwn,
  });
});

// ── Settings ──────────────────────────────────────────────────────

router.get('/settings', async (req, res) => {
  const user = await User.findById(req.session.userId).select('username bio avatar email');
  res.render('settings', {
    title:      'Settings',
    activePage: 'settings',
    currentUser: req.currentUser,
    user,
    success: req.query.saved || null,
    error:   null,
  });
});

router.post('/settings/profile', upload.fields([{ name: 'avatar', maxCount: 1 }]), async (req, res) => {
  const { username, bio } = req.body;
  const errors = [];

  if (!username || !/^[a-zA-Z][a-zA-Z0-9]{2,14}$/.test(username)) {
    errors.push('Username must start with a letter, contain only letters and digits, and be 3–15 characters.');
  }
  if (bio && bio.trim().length > 0 && (bio.trim().length < 20 || bio.trim().length > 220)) {
    errors.push('Bio must be between 20 and 220 characters.');
  }

  if (errors.length) {
    const user = await User.findById(req.session.userId).select('username bio avatar email');
    return res.render('settings', {
      title: 'Settings', activePage: 'settings', currentUser: req.currentUser,
      user, success: null, error: errors[0],
    });
  }

  const taken = await User.findOne({ username: username.toLowerCase(), _id: { $ne: req.session.userId } });
  if (taken) {
    const user = await User.findById(req.session.userId).select('username bio avatar email');
    return res.render('settings', {
      title: 'Settings', activePage: 'settings', currentUser: req.currentUser,
      user, success: null, error: 'Username already taken.',
    });
  }

  const update = {
    username: username.toLowerCase().trim(),
    bio:      bio || undefined,
  };
  if (req.files?.avatar?.[0]) {
    update.avatar = `/uploads/avatars/${req.files.avatar[0].filename}`;
  }

  await User.findByIdAndUpdate(req.session.userId, update);
  res.redirect('/settings?saved=1');
});

module.exports = router;
