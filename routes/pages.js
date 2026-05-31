const express       = require('express');
const router        = express.Router();
const path          = require('path');
const fs            = require('fs');
const bcrypt        = require('bcrypt');
const User                  = require('../models/User');
const Entry                 = require('../models/Entry');
const Rating                = require('../models/Rating');
const Comment               = require('../models/Comment');
const CommentReport         = require('../models/CommentReport');
const Contest               = require('../models/Contest');
const ContestVote           = require('../models/ContestVote');
const Nomination            = require('../models/Nomination');
const RatingsChallengeVote  = require('../models/RatingsChallengeVote');
const TournamentEntry       = require('../models/TournamentEntry');
const Tournament            = require('../models/Tournament');
const Follow                = require('../models/Follow');
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

// ── Entry page (stub — fleshed out next) ─────────────────────────

router.get('/entry/:id', async (req, res) => {
  const entry = await Entry.findById(req.params.id).populate('userId', 'username avatar').catch(() => null);
  if (!entry) return res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser });
  res.render('entry', {
    title:      entry.caption ? entry.caption.slice(0, 60) : 'Entry',
    activePage: '',
    currentUser: req.currentUser,
    entry,
  });
});

// ── Profile ───────────────────────────────────────────────────────

router.get('/profile', (req, res) => res.redirect(`/${req.currentUser.username}`));

// ── Settings ──────────────────────────────────────────────────────

router.get('/settings', async (req, res) => {
  const user = await User.findById(req.session.userId).select(
    'username displayName bio avatar banner location url sex birthdate email'
  );
  res.render('settings', {
    title:      'Settings',
    activePage: 'settings',
    currentUser: req.currentUser,
    user,
    success: req.query.saved || null,
    error:   null,
  });
});

// ── Account Deletion ──────────────────────────────────────────────

router.post('/account/delete', async (req, res) => {
  const renderError = async (msg) => {
    const user = await User.findById(req.session.userId).select(
      'username displayName bio avatar banner location url sex birthdate email'
    );
    return res.render('settings', {
      title: 'Settings', activePage: 'settings', currentUser: req.currentUser,
      user, success: null, error: msg,
    });
  };

  const { password } = req.body;
  if (!password) return renderError('Password is required to delete your account.');

  try {
    const user = await User.findById(req.session.userId);
    if (!user) return req.session.destroy(() => res.redirect('/signup'));

    const match = await bcrypt.compare(password, user.password);
    if (!match) return renderError('Incorrect password. Account not deleted.');

    const userId = user._id;

    // collect entry file paths before deletion
    const entries = await Entry.find({ userId }).select('mediaUrl');

    // cascade delete all user-owned and user-authored data
    await Rating.deleteMany({ userId });
    await Rating.deleteMany({ entryId: { $in: entries.map(e => e._id) } });
    await Comment.deleteMany({ userId });
    await CommentReport.deleteMany({ reportedBy: userId });
    await ContestVote.deleteMany({ userId });
    await Nomination.deleteMany({ $or: [{ nominatorId: userId }, { nomineeId: userId }] });
    await RatingsChallengeVote.deleteMany({ userId });
    await TournamentEntry.deleteMany({ userId });
    await Entry.deleteMany({ userId });

    // remove uploaded media files
    for (const entry of entries) {
      if (entry.mediaUrl) {
        fs.unlink(path.join(__dirname, '../public', entry.mediaUrl), () => {});
      }
    }
    if (user.avatar) fs.unlink(path.join(__dirname, '../public', user.avatar), () => {});
    if (user.banner) fs.unlink(path.join(__dirname, '../public', user.banner), () => {});

    await User.findByIdAndDelete(userId);
    req.session.destroy(() => res.redirect('/signup'));
  } catch (err) {
    console.error('Account deletion error:', err);
    return renderError('Something went wrong. Please try again.');
  }
});

// ── Submit Entry ──────────────────────────────────────────────────

router.get('/submit', (req, res) => {
  res.render('submit', {
    title:      'Submit Entry',
    activePage: 'submit',
    currentUser: req.currentUser,
    error: null,
  });
});

router.post('/submit', upload.fields([{ name: 'entryMedia', maxCount: 1 }]), async (req, res) => {
  const renderError = (msg) => res.render('submit', {
    title: 'Submit Entry', activePage: 'submit', currentUser: req.currentUser, error: msg,
  });

  const file = req.files?.entryMedia?.[0];
  if (!file) return renderError('Please upload a photo or video.');

  const isVideo = file.mimetype.startsWith('video/');
  if (!isVideo && file.size > 10 * 1024 * 1024) return renderError('Photo files must be under 10 MB.');

  let tags = [];
  if (req.body.tags) {
    const raw = Array.isArray(req.body.tags) ? req.body.tags : [req.body.tags];
    tags = raw.map(t => t.trim().toLowerCase()).filter(Boolean).slice(0, 6);
  }

  try {
    const entry = await Entry.create({
      userId:    req.session.userId,
      mediaUrl:  `/uploads/entries/${file.filename}`,
      mediaType: isVideo ? 'video' : 'photo',
      caption:   req.body.caption?.trim() || undefined,
      tags,
    });
    res.redirect(`/entry/${entry._id}`);
  } catch (err) {
    console.error('Entry submit error:', err);
    renderError('Something went wrong. Please try again.');
  }
});

router.post('/settings/profile', upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), async (req, res) => {
  const { username, displayName, bio, location, url, sex, birthdate, returnTo, bannerRemove, avatarRemove } = req.body;
  const errors = [];
  const safeReturnTo = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//')
    ? returnTo
    : null;

  const renderSettingsError = async (msg) => {
    const user = await User.findById(req.session.userId).select(
      'username displayName bio avatar banner location url sex birthdate email'
    );
    return res.render('settings', {
      title: 'Settings', activePage: 'settings', currentUser: req.currentUser,
      user, success: null, error: msg,
    });
  };

  const redirectWithError = (msg) => {
    if (!safeReturnTo || safeReturnTo.startsWith('/settings')) return null;
    const join = safeReturnTo.includes('?') ? '&' : '?';
    return res.redirect(`${safeReturnTo}${join}editError=${encodeURIComponent(msg)}`);
  };

  const usernameNormalized = (username || '').toLowerCase().trim();
  const hasDisplayName = Object.prototype.hasOwnProperty.call(req.body, 'displayName');
  const hasBio = Object.prototype.hasOwnProperty.call(req.body, 'bio');
  const hasLocation = Object.prototype.hasOwnProperty.call(req.body, 'location');
  const hasUrl = Object.prototype.hasOwnProperty.call(req.body, 'url');
  const hasSex = Object.prototype.hasOwnProperty.call(req.body, 'sex');
  const hasBirthdate = Object.prototype.hasOwnProperty.call(req.body, 'birthdate');

  const displayNameTrimmed = hasDisplayName ? (displayName || '').trim() : null;
  const bioTrimmed = hasBio ? (bio || '').trim() : null;
  const locationTrimmed = hasLocation ? (location || '').trim() : null;
  const urlTrimmed = hasUrl ? (url || '').trim() : null;
  const sexTrimmed = hasSex ? (sex || '').trim() : null;

  if (!usernameNormalized || !/^[a-z][a-z0-9]{2,14}$/.test(usernameNormalized)) {
    errors.push('Username must start with a letter, contain only letters and digits, and be 3-15 characters.');
  }
  if (hasDisplayName && displayNameTrimmed && displayNameTrimmed.length > 50) {
    errors.push('Display name cannot exceed 50 characters.');
  }
  if (hasDisplayName && displayNameTrimmed && displayNameTrimmed.split(/\s+/).filter(Boolean).length > 3) {
    errors.push('Display name can be at most 3 words.');
  }
  if (hasBio && bioTrimmed.length > 0 && (bioTrimmed.length < 20 || bioTrimmed.length > 220)) {
    errors.push('Bio must be between 20 and 220 characters.');
  }
  if (hasUrl && urlTrimmed.length > 200) {
    errors.push('Website URL cannot exceed 200 characters.');
  }
  if (hasSex && sexTrimmed && !['male', 'female', 'other', 'prefer-not-to-say'].includes(sexTrimmed)) {
    errors.push('Invalid sex value.');
  }

  let birthdateValue = null;
  if (hasBirthdate && birthdate) {
    const parsedBirthdate = new Date(birthdate);
    if (Number.isNaN(parsedBirthdate.getTime())) {
      errors.push('Invalid birthdate.');
    } else {
      birthdateValue = parsedBirthdate;
    }
  }

  if (errors.length) {
    const redirected = redirectWithError(errors[0]);
    if (redirected) return redirected;
    return renderSettingsError(errors[0]);
  }

  const taken = await User.findOne({ username: usernameNormalized, _id: { $ne: req.session.userId } });
  if (taken) {
    const redirected = redirectWithError('Username already taken.');
    if (redirected) return redirected;
    return renderSettingsError('Username already taken.');
  }

  const setUpdate = {
    username: usernameNormalized,
  };
  const unsetUpdate = {};

  if (hasDisplayName) {
    if (displayNameTrimmed) setUpdate.displayName = displayNameTrimmed;
    else unsetUpdate.displayName = 1;
  }

  if (hasBio) {
    if (bioTrimmed) setUpdate.bio = bioTrimmed;
    else unsetUpdate.bio = 1;
  }

  if (hasLocation) {
    if (locationTrimmed) setUpdate.location = locationTrimmed;
    else unsetUpdate.location = 1;
  }

  if (hasUrl) {
    if (urlTrimmed) setUpdate.url = urlTrimmed;
    else unsetUpdate.url = 1;
  }

  if (hasSex) {
    if (sexTrimmed) setUpdate.sex = sexTrimmed;
    else unsetUpdate.sex = 1;
  }

  if (hasBirthdate) {
    if (birthdateValue) setUpdate.birthdate = birthdateValue;
    else unsetUpdate.birthdate = 1;
  }

  if (req.files?.avatar?.[0]) {
    setUpdate.avatar = `/uploads/avatars/${req.files.avatar[0].filename}`;
  } else if (avatarRemove === '1') {
    unsetUpdate.avatar = 1;
  }
  if (req.files?.banner?.[0]) {
    setUpdate.banner = `/uploads/banners/${req.files.banner[0].filename}`;
  } else if (bannerRemove === '1') {
    unsetUpdate.banner = 1;
  }

  const updateDoc = { $set: setUpdate };
  if (Object.keys(unsetUpdate).length) {
    updateDoc.$unset = unsetUpdate;
  }

  await User.findByIdAndUpdate(req.session.userId, updateDoc);

  if (safeReturnTo) {
    const join = safeReturnTo.includes('?') ? '&' : '?';
    return res.redirect(`${safeReturnTo}${join}saved=1`);
  }
  res.redirect('/settings?saved=1');
});

// ── Public profile — must be last to avoid swallowing other routes ─

router.get('/:username', async (req, res) => {
  const user = await User.findOne({ username: req.params.username.toLowerCase() })
    .select('username displayName bio avatar banner location sex birthdate url createdAt');

  if (!user) return res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser });

  const isOwn   = user._id.toString() === req.session.userId;
  const entries = await Entry.find({ userId: user._id }).sort({ createdAt: -1 });

  const entryIds = entries.map(e => e._id);

  const [followerCount, followingCount, nominationsAccepted, firstPrizes, secondPrizes, thirdPrizes, userContests, userTournamentEntries] = await Promise.all([
    Follow.countDocuments({ followingId: user._id }),
    Follow.countDocuments({ followerId: user._id }),
    Nomination.countDocuments({ nomineeId: user._id, status: 'accepted' }),
    entryIds.length ? Tournament.countDocuments({ 'prizes.first.entryId': { $in: entryIds }, status: 'closed' }) : Promise.resolve(0),
    entryIds.length ? Tournament.countDocuments({ 'prizes.second.entryId': { $in: entryIds }, status: 'closed' }) : Promise.resolve(0),
    entryIds.length ? Tournament.countDocuments({ 'prizes.third.entryId': { $in: entryIds }, status: 'closed' }) : Promise.resolve(0),
    Contest.find({ 'entries.userId': user._id }).sort({ createdAt: -1 }).populate('entries.entryId', 'mediaUrl caption').lean(),
    TournamentEntry.find({ userId: user._id }).sort({ submittedAt: -1 }).populate('tournamentId', 'name status type prizes').populate('entryId', 'mediaUrl caption').lean(),
  ]);

  const ratedEntries = entries.filter(e => e.ratingCount > 0);
  const overallRank = ratedEntries.length
    ? (ratedEntries.reduce((s, e) => s + e.ratingAvg, 0) / ratedEntries.length).toFixed(1)
    : null;

  const title = user.displayName
    ? `${user.displayName} - @${user.username} on AllThingsAprons.com`
    : `@${user.username} on AllThingsAprons.com`;

  res.render('profile', {
    title,
    activePage: isOwn ? 'profile' : '',
    currentUser: req.currentUser,
    profileUser: user,
    entries,
    followerCount,
    followingCount,
    nominationsAccepted,
    firstPrizes,
    secondPrizes,
    thirdPrizes,
    overallRank,
    isOwn,
    userContests,
    userTournamentEntries,
    editError: typeof req.query.editError === 'string' ? req.query.editError : null,
  });
});

module.exports = router;

