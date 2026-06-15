const express       = require('express');
const router        = express.Router();
const mongoose      = require('mongoose');
const path          = require('path');
const fs            = require('fs');
const bcrypt        = require('bcrypt');
const User                  = require('../models/User');
const Entry                 = require('../models/Entry');
const Rating                = require('../models/Rating');
const Comment               = require('../models/Comment');
const CommentReport         = require('../models/CommentReport');
const ContestComment        = require('../models/ContestComment');
const Contest               = require('../models/Contest');
const ContestVote           = require('../models/ContestVote');
const Nomination            = require('../models/Nomination');
const RatingsChallengeVote  = require('../models/RatingsChallengeVote');
const TournamentEntry       = require('../models/TournamentEntry');
const Tournament            = require('../models/Tournament');
const Follow                = require('../models/Follow');
const UserAffinity          = require('../models/UserAffinity');
const { computeEffectiveAffinity, buildFeedPage } = require('../utils/feedScorer');
const requireAuth   = require('../middleware/requireAuth');
const requireApproved = require('../middleware/requireApproved');
const upload        = require('../middleware/upload');

router.use(requireAuth);
router.use(requireApproved);

router.get('/', (req, res) => res.redirect('/feed'));

router.get('/feed', async (req, res) => {
  const currentUserId = req.session.userId;

  const candidates = await Entry.find({ userId: { $ne: currentUserId } })
    .sort({ createdAt: -1 })
    .limit(150)
    .populate('userId', 'username displayName avatar')
    .lean();

  if (!candidates.length) {
    return res.render('feed', {
      title: 'Feed', activePage: 'feed', currentUser: req.currentUser, feedEntries: [],
    });
  }

  const ids         = candidates.map(e => e._id);
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

  const [myRatings, follows, velocityAgg, activeContests, affinityDoc] = await Promise.all([
    Rating.find({ userId: currentUserId, entryId: { $in: ids } }).select('entryId score').lean(),
    Follow.find({ followerId: currentUserId }).select('followingId').lean(),
    Rating.aggregate([
      { $match: { entryId: { $in: ids }, createdAt: { $gte: sixHoursAgo } } },
      { $group: { _id: '$entryId', count: { $sum: 1 } } },
    ]),
    Contest.find({ 'entries.entryId': { $in: ids }, status: 'active' }).select('entries').lean(),
    UserAffinity.findOne({ userId: currentUserId }).lean(),
  ]);

  const ratedMap = {};
  for (const r of myRatings) ratedMap[r.entryId.toString()] = r.score;

  const followingSet = new Set(follows.map(f => f.followingId.toString()));

  const velocityMap = {};
  for (const v of velocityAgg) velocityMap[v._id.toString()] = v.count;

  const inActiveContestSet = new Set();
  for (const c of activeContests) {
    for (const e of c.entries) inActiveContestSet.add(e.entryId.toString());
  }

  const affinity = computeEffectiveAffinity(affinityDoc?.history || []);

  const feedEntries = buildFeedPage(candidates, {
    followingSet,
    ratedMap,
    velocityMap,
    inActiveContestSet,
    affinity,
  });

  res.render('feed', {
    title:      'Feed',
    activePage: 'feed',
    currentUser: req.currentUser,
    feedEntries,
  });
});

router.get('/leaderboard', async (req, res) => {
  const entries = await Entry.find({ ratingCount: { $gte: 3 } })
    .sort({ ratingAvg: -1 })
    .limit(50)
    .populate('userId', 'username displayName')
    .lean();

  const items = entries.map(e => ({
    mediaUrl:    e.mediaUrl,
    title:       e.caption || '',
    authorName:  e.userId?.displayName?.value || e.userId?.username?.value || 'Unknown',
    ratingScore: e.ratingAvg,
    ratingCount: e.ratingCount,
  }));

  res.render('leaderboard', {
    title:      'Leaderboard',
    activePage: 'leaderboard',
    currentUser: req.currentUser,
    items,
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
    contests: [],
  });
});

router.get('/notifications', (req, res) => {
  res.render('notifications', {
    title:      'Notifications',
    activePage: 'notifications',
    currentUser: req.currentUser,
  });
});

// ── Entry page ────────────────────────────────────────────────────

router.get('/entry/:id', async (req, res) => {
  const entry = await Entry.findById(req.params.id).populate('userId', 'username displayName avatar').catch(() => null);
  if (!entry) return res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser });
  const ownerId = entry.userId._id;
  const isOwn = ownerId.toString() === req.session.userId;
  const [followDoc, activeContest, entryContests] = await Promise.all([
    (!isOwn && req.session.userId)
      ? Follow.findOne({ followerId: req.session.userId, followingId: ownerId }).lean()
      : Promise.resolve(null),
    Contest.findOne({ 'entries.entryId': entry._id, status: { $in: ['pending', 'active'] } })
      .select('_id status voidDeadline').lean().catch(() => null),
    Contest.find({ 'entries.entryId': entry._id }).select('_id status entries voidDeadline').lean(),
  ]);

  const nominations = entryContests.length
    ? await Nomination.find({
        contestId:   { $in: entryContests.map(c => c._id) },
        nominatorId: ownerId,
        status:      'pending',
      })
      .populate('nomineeId', 'username displayName avatar')
      .lean()
    : [];

  const entryContestById = {};
  for (const c of entryContests) entryContestById[c._id.toString()] = c;

  const liveContestIds = entryContests.filter(c => c.status === 'active' || c.status === 'closed').map(c => c._id);
  const entryVoteAggs  = liveContestIds.length
    ? await ContestVote.aggregate([
        { $match: { contestId: { $in: liveContestIds } } },
        { $group: { _id: { contestId: '$contestId', entryId: '$entryId' }, count: { $sum: 1 } } },
      ])
    : [];
  const entryVoteMap = {};
  for (const a of entryVoteAggs) {
    const cid = a._id.contestId.toString();
    if (!entryVoteMap[cid]) entryVoteMap[cid] = {};
    entryVoteMap[cid][a._id.entryId.toString()] = a.count;
  }

  const myEid    = entry._id.toString();
  const nominees = [];
  const seenNominees = new Set();
  for (const n of nominations) {
    const uname = n.nomineeId.username?.value;
    if (!uname || seenNominees.has(uname)) continue;
    seenNominees.add(uname);
    const cid     = n.contestId.toString();
    const contest = entryContestById[cid];
    const cvotes  = entryVoteMap[cid] || {};
    const oppEid  = contest?.entries?.find(e => e.entryId?.toString() !== myEid)?.entryId?.toString();
    nominees.push({
      contestId:        cid,
      username:         uname,
      displayName:      n.nomineeId.displayName?.value || uname,
      avatar:           n.nomineeId.avatar?.value || null,
      status:           contest?.status === 'void' ? 'void' : n.status,
      contestStatus:    contest?.status || null,
      voteCountMine:     cvotes[myEid]  || 0,
      voteCountNominee: oppEid ? (cvotes[oppEid] || 0) : 0,
    });
  }

  const [topLevelComments, hiddenComments] = await Promise.all([
    Comment.find({ entryId: entry._id, parentId: null, hidden: false })
      .populate('userId', 'username displayName avatar')
      .sort({ createdAt: 1 })
      .lean(),
    isOwn
      ? Comment.find({ entryId: entry._id, parentId: null, hidden: true })
          .populate('userId', 'username displayName avatar')
          .sort({ createdAt: 1 })
          .lean()
      : Promise.resolve([]),
  ]);

  const topLevelIds = topLevelComments.map(c => c._id);
  const replies = topLevelIds.length
    ? await Comment.find({ parentId: { $in: topLevelIds }, hidden: false })
        .populate('userId', 'username displayName avatar')
        .sort({ createdAt: 1 })
        .lean()
    : [];

  const replyMap = {};
  for (const r of replies) {
    const pid = r.parentId.toString();
    if (!replyMap[pid]) replyMap[pid] = [];
    replyMap[pid].push(r);
  }
  const comments = topLevelComments.map(c => ({ ...c, replies: replyMap[c._id.toString()] || [] }));

  res.render('entry', {
    title:       entry.title || entry.caption?.slice(0, 60) || 'Entry',
    activePage:  '',
    currentUser: req.currentUser,
    entry,
    isFollowing:    !!followDoc,
    currentUserId:  req.session.userId || null,
    contestInfo:    (activeContest && activeContest.status !== 'void') ? { contestId: activeContest._id.toString(), status: activeContest.status } : null,
    nominees,
    comments,
    hiddenComments,
  });
});

// ── Entry edit page ───────────────────────────────────────────────

router.get('/entry/:id/edit', async (req, res) => {
  const entry = await Entry.findById(req.params.id)
    .populate('userId', 'username displayName avatar')
    .catch(() => null);
  if (!entry) return res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser });

  if (entry.userId._id.toString() !== req.session.userId) {
    return res.status(403).render('404', { title: 'Not Found', currentUser: req.currentUser });
  }

  const activeContest = await Contest.findOne({
    'entries.entryId': entry._id,
    status: 'active',
  }).select('_id').lean().catch(() => null);

  if (activeContest) return res.redirect(`/contest/${activeContest._id}`);

  const [pendingContests, pendingNominations] = await Promise.all([
    Contest.find({
      entries: { $elemMatch: { entryId: entry._id, userId: req.session.userId } },
      status: 'pending',
    }).select('_id status voidDeadline').lean().catch(() => []),
    Nomination.find({ nomineeId: req.session.userId, status: 'pending', expiresAt: { $gt: new Date() } })
      .populate('nominatorId', 'username displayName avatar')
      .sort({ createdAt: -1 })
      .lean()
      .catch(() => []),
  ]);

  const timedOutContestIds = new Set(pendingContests.filter(c => c.status === 'void').map(c => c._id.toString()));
  const pendingContest = pendingContests.find(c => c.status === 'pending') || null;

  const outgoingNoms = pendingContests.length
    ? await Nomination.find({
        contestId: { $in: pendingContests.map(c => c._id) },
        nominatorId: req.session.userId,
        status: 'pending',
      }).populate('nomineeId', 'username displayName avatar').lean().catch(() => [])
    : [];

  const _seenNomineeIds = new Set();
  const existingNominees = [];
  for (const n of outgoingNoms) {
    const uid = n.nomineeId._id.toString();
    if (_seenNomineeIds.has(uid)) continue;
    _seenNomineeIds.add(uid);
    existingNominees.push({
      _id:         uid,
      username:    n.nomineeId.username?.value,
      displayName: n.nomineeId.displayName?.value || n.nomineeId.username?.value,
      avatar:      n.nomineeId.avatar?.value || null,
      contestId:   n.contestId.toString(),
      timedOut:    timedOutContestIds.has(n.contestId.toString()),
    });
  }

  res.render('edit-entry', {
    title:            'Edit Entry',
    activePage:       '',
    currentUser:      req.currentUser,
    entry,
    pendingContestId: pendingContest ? pendingContest._id.toString() : null,
    pendingNominations,
    existingNominees,
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

    const entries = await Entry.find({ userId }).select('mediaUrl');

    await Rating.deleteMany({ userId });
    await Rating.deleteMany({ entryId: { $in: entries.map(e => e._id) } });
    await Comment.deleteMany({ userId });
    await CommentReport.deleteMany({ reportedBy: userId });
    await ContestVote.deleteMany({ userId });
    await Nomination.deleteMany({ $or: [{ nominatorId: userId }, { nomineeId: userId }] });
    await RatingsChallengeVote.deleteMany({ userId });
    await TournamentEntry.deleteMany({ userId });
    await Entry.deleteMany({ userId });

    for (const entry of entries) {
      if (entry.mediaUrl) {
        fs.unlink(path.join(__dirname, '../public', entry.mediaUrl), () => {});
      }
    }
    if (user.avatar?.value) fs.unlink(path.join(__dirname, '../public', user.avatar.value), () => {});
    if (user.banner?.value) fs.unlink(path.join(__dirname, '../public', user.banner.value), () => {});

    await User.findByIdAndDelete(userId);
    req.session.destroy(() => res.redirect('/signup'));
  } catch (err) {
    console.error('Account deletion error:', err);
    return renderError('Something went wrong. Please try again.');
  }
});

// ── Submit Entry ──────────────────────────────────────────────────

router.get('/submit', async (req, res) => {
  if (!req.currentUser.idVerified) return res.redirect('/verify-identity?reason=entry');

  const userId = req.currentUser._id;

  const [pendingNominations, userEntries] = await Promise.all([
    Nomination.find({ nomineeId: userId, status: 'pending', expiresAt: { $gt: new Date() } })
      .populate('nominatorId', 'username displayName avatar')
      .sort({ createdAt: -1 })
      .lean(),
    Entry.find({ userId })
      .sort({ createdAt: -1 })
      .limit(24)
      .select('mediaUrl mediaType caption ratingAvg ratingCount')
      .lean(),
  ]);

  let acceptingNomination = null;
  if (req.query.nomination) {
    const nom = pendingNominations.find(n => n._id.toString() === req.query.nomination);
    if (nom) {
      const contest = await Contest.findById(nom.contestId)
        .populate('entries.entryId', 'mediaUrl mediaType title caption tags')
        .lean();
      const challEntry = contest?.entries.find(
        e => e.userId.toString() === nom.nominatorId._id.toString()
      );
      acceptingNomination = {
        _id:       nom._id,
        nominator: nom.nominatorId,
        entry:     challEntry?.hidden ? null : (challEntry?.entryId || null),
        hidden:    challEntry?.hidden || false,
        expiresAt: nom.expiresAt,
        message:   nom.message || null,
        contestId: nom.contestId,
      };
    }
  }

  let challengeEntry = null;
  if (req.query.challenge && mongoose.isValidObjectId(req.query.challenge)) {
    challengeEntry = await Entry.findById(req.query.challenge)
      .populate('userId', 'username displayName avatar')
      .select('mediaUrl mediaType title caption tags userId')
      .lean()
      .catch(() => null);
  }

  res.render('submit', {
    title:      'Submit Entry',
    activePage: 'submit',
    currentUser: req.currentUser,
    error: null,
    pendingNominations: acceptingNomination
      ? pendingNominations.filter(n => n._id.toString() !== acceptingNomination._id.toString())
      : pendingNominations,
    userEntries,
    acceptingNomination,
    challengeEntry,
  });
});

router.post('/submit', upload.fields([{ name: 'entryMedia', maxCount: 1 }]), async (req, res) => {
  if (!req.currentUser.idVerified) return res.redirect('/verify-identity?reason=entry');
  const renderError = (msg) => res.render('submit', {
    title: 'Submit Entry', activePage: 'submit', currentUser: req.currentUser, error: msg,
    pendingNominations: [], userEntries: [], acceptingNomination: null, challengeEntry: null,
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
    const caption = req.body.caption?.trim() || undefined;
    if (caption && caption.replace(/\s/g, '').length > 140) return renderError('Description cannot exceed 140 characters (spaces not counted).');

    const entry = await Entry.create({
      userId:    req.session.userId,
      mediaUrl:  `/uploads/entries/${file.filename}`,
      mediaType: isVideo ? 'video' : 'photo',
      caption,
      tags,
    });
    res.redirect(`/entry/${entry._id}`);
  } catch (err) {
    console.error('Entry submit error:', err);
    renderError('Something went wrong. Please try again.');
  }
});

// ── Profile settings update ───────────────────────────────────────

router.post('/settings/profile', upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), async (req, res) => {
  const { username, displayName, bio, location, url, sex, birthdate, returnTo, bannerRemove, avatarRemove, bannerPosX, bannerPosY, bannerZoom } = req.body;
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
    if (!safeReturnTo || safeReturnTo.startsWith('/settings')) return false;
    const join = safeReturnTo.includes('?') ? '&' : '?';
    res.redirect(`${safeReturnTo}${join}editError=${encodeURIComponent(msg)}`);
    return true;
  };

  const usernameNormalized = (username || '').toLowerCase().trim();
  const hasDisplayName = Object.prototype.hasOwnProperty.call(req.body, 'displayName');
  const hasBio         = Object.prototype.hasOwnProperty.call(req.body, 'bio');
  const hasLocation    = Object.prototype.hasOwnProperty.call(req.body, 'location');
  const hasUrl         = Object.prototype.hasOwnProperty.call(req.body, 'url');
  const hasSex         = Object.prototype.hasOwnProperty.call(req.body, 'sex');
  const hasBirthdate   = Object.prototype.hasOwnProperty.call(req.body, 'birthdate');

  const displayNameTrimmed = hasDisplayName ? (displayName || '').trim() : null;
  const bioTrimmed         = hasBio         ? (bio         || '').trim() : null;
  const locationTrimmed    = hasLocation    ? (location    || '').trim() : null;
  const urlTrimmed         = hasUrl         ? (url         || '').trim() : null;
  const sexTrimmed         = hasSex         ? (sex         || '').trim() : null;

  if (!usernameNormalized || !/^[a-z][a-z0-9]{2,14}$/.test(usernameNormalized)) {
    errors.push('Username must start with a letter, contain only letters and digits, and be 3-15 characters.');
  }
  if (hasDisplayName && displayNameTrimmed && displayNameTrimmed.length > 50) {
    errors.push('Display name cannot exceed 50 characters.');
  }
  if (hasDisplayName && displayNameTrimmed && displayNameTrimmed.split(/\s+/).filter(Boolean).length > 3) {
    errors.push('Display name can be at most 3 words.');
  }
  const bioCharCount = bioTrimmed ? bioTrimmed.replace(/\s/g, '').length : 0;
  if (hasBio && bioCharCount > 0 && (bioCharCount < 20 || bioCharCount > 220)) {
    errors.push('Bio must be between 20 and 220 characters (spaces not counted).');
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

  // Fetch current user to check username edit limits and compare values
  const currentUserDoc = await User.findById(req.session.userId).select(
    'username displayName bio location url sex birthdate avatar banner'
  );

  const currentUsername = currentUserDoc.username?.value || '';
  const isChangingUsername = currentUsername !== usernameNormalized;

  if (isChangingUsername) {
    const histLen   = currentUserDoc.username?.history?.length || 1;
    const editCount = histLen - 1;
    if (editCount >= 3) {
      const redirected = redirectWithError('You have reached the lifetime limit of 3 username changes.');
      if (redirected) return redirected;
      return renderSettingsError('You have reached the lifetime limit of 3 username changes.');
    }
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const recentEdits = (currentUserDoc.username?.history || []).slice(1)
      .filter(h => new Date(h.setAt) > fourteenDaysAgo);
    if (recentEdits.length >= 2) {
      const redirected = redirectWithError('You can only change your username twice within a 14-day period.');
      if (redirected) return redirected;
      return renderSettingsError('You can only change your username twice within a 14-day period.');
    }
  }

  const taken = await User.findOne({ 'username.value': usernameNormalized, _id: { $ne: req.session.userId } });
  if (taken) {
    const redirected = redirectWithError('Username already taken.');
    if (redirected) return redirected;
    return renderSettingsError('Username already taken.');
  }

  const now    = new Date();
  const setOp  = {};
  const pushOp = {};

  setOp['username.value'] = usernameNormalized;
  if (isChangingUsername) {
    pushOp['username.history'] = { value: usernameNormalized, setAt: now, source: 'edit_profile' };
  }

  if (hasDisplayName) {
    const newVal = displayNameTrimmed || null;
    const oldVal = currentUserDoc.displayName?.value || null;
    setOp['displayName.value'] = newVal;
    if (newVal !== oldVal) {
      pushOp['displayName.history'] = { value: newVal, setAt: now, source: 'edit_profile' };
    }
  }

  if (hasBio) {
    const newVal = bioTrimmed || null;
    const oldVal = currentUserDoc.bio?.value || null;
    setOp['bio.value'] = newVal;
    if (newVal !== oldVal) {
      pushOp['bio.history'] = { value: newVal, setAt: now, source: 'edit_profile' };
    }
  }

  if (hasLocation) {
    const newVal = locationTrimmed || null;
    const oldVal = currentUserDoc.location?.value || null;
    setOp['location.value'] = newVal;
    if (newVal !== oldVal) {
      pushOp['location.history'] = { value: newVal, setAt: now, source: 'edit_profile' };
    }
  }

  if (hasUrl) {
    const newVal = urlTrimmed || null;
    const oldVal = currentUserDoc.url?.value || null;
    setOp['url.value'] = newVal;
    if (newVal !== oldVal) {
      pushOp['url.history'] = { value: newVal, setAt: now, source: 'edit_profile' };
    }
  }

  if (hasSex) {
    const newVal = sexTrimmed || null;
    const oldVal = currentUserDoc.sex?.value || null;
    setOp['sex.value'] = newVal;
    if (newVal !== oldVal) {
      pushOp['sex.history'] = { value: newVal, setAt: now, source: 'edit_profile' };
    }
  }

  if (hasBirthdate) {
    const newVal    = birthdateValue || null;
    const oldValStr = currentUserDoc.birthdate?.value ? new Date(currentUserDoc.birthdate.value).toISOString() : null;
    const newValStr = newVal ? newVal.toISOString() : null;
    setOp['birthdate.value'] = newVal;
    if (newValStr !== oldValStr) {
      pushOp['birthdate.history'] = { value: newVal, setAt: now, source: 'edit_profile' };
    }
  }

  if (req.files?.avatar?.[0]) {
    const avatarPath = `/uploads/avatars/${req.files.avatar[0].filename}`;
    const oldVal     = currentUserDoc.avatar?.value || null;
    setOp['avatar.value'] = avatarPath;
    if (avatarPath !== oldVal) {
      pushOp['avatar.history'] = { value: avatarPath, setAt: now, source: 'edit_profile' };
    }
  } else if (avatarRemove === '1') {
    const oldVal = currentUserDoc.avatar?.value || null;
    setOp['avatar.value'] = null;
    if (oldVal !== null) {
      pushOp['avatar.history'] = { value: null, setAt: now, source: 'edit_profile' };
    }
  }

  const bpx  = parseFloat(bannerPosX);
  const bpy  = parseFloat(bannerPosY);
  const bzm  = parseFloat(bannerZoom);
  const posX = isNaN(bpx) ? 0.5 : Math.max(0, Math.min(1, bpx));
  const posY = isNaN(bpy) ? 0.5 : Math.max(0, Math.min(1, bpy));
  const zoom = isNaN(bzm) ? 1   : Math.max(1, bzm);

  if (req.files?.banner?.[0]) {
    const bannerPath = `/uploads/banners/${req.files.banner[0].filename}`;
    const oldVal     = currentUserDoc.banner?.value || null;
    setOp['banner.value'] = bannerPath;
    setOp['banner.posX']  = posX;
    setOp['banner.posY']  = posY;
    setOp['banner.zoom']  = zoom;
    if (bannerPath !== oldVal) {
      pushOp['banner.history'] = { value: bannerPath, setAt: now, source: 'edit_profile' };
    }
  } else if (bannerRemove === '1') {
    const oldVal = currentUserDoc.banner?.value || null;
    setOp['banner.value'] = null;
    setOp['banner.posX']  = 0.5;
    setOp['banner.posY']  = 0.5;
    setOp['banner.zoom']  = 1;
    if (oldVal !== null) {
      pushOp['banner.history'] = { value: null, setAt: now, source: 'edit_profile' };
    }
  } else if (currentUserDoc.banner?.value) {
    setOp['banner.posX'] = posX;
    setOp['banner.posY'] = posY;
    setOp['banner.zoom'] = zoom;
  }

  const updateDoc = { $set: setOp };
  if (Object.keys(pushOp).length) updateDoc.$push = pushOp;

  await User.findByIdAndUpdate(req.session.userId, updateDoc);

  if (safeReturnTo) {
    const join = safeReturnTo.includes('?') ? '&' : '?';
    return res.redirect(`${safeReturnTo}${join}saved=1`);
  }
  res.redirect('/settings?saved=1');
});

// ── Contest page ──────────────────────────────────────────────────

router.get('/contest/:id', async (req, res) => {
  const contest = await Contest.findById(req.params.id)
    .populate('entries.entryId', 'mediaUrl mediaType title caption tags ratingAvg ratingCount aiGenerated')
    .populate('createdBy', 'username displayName avatar')
    .lean()
    .catch(() => null);

  if (!contest) {
    return res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser });
  }

  const nomCE = contest.entries.find(e => e.userId.toString() === contest.createdBy._id.toString());
  const resCE = contest.entries.find(e => e.userId.toString() !== contest.createdBy._id.toString());

  const userIds = contest.entries.map(e => e.userId);
  const users   = await User.find({ _id: { $in: userIds } }).select('username displayName avatar').lean();
  const userMap = {};
  users.forEach(u => { userMap[u._id.toString()] = u; });

  const myId   = req.session.userId?.toString();
  const myVote = await ContestVote.findOne({ contestId: contest._id, userId: req.session.userId })
    .select('entryId').lean().catch(() => null);

  const voteCounts = {};
  let totalVotes = 0;
  if (myVote || contest.status === 'closed') {
    const agg = await ContestVote.aggregate([
      { $match: { contestId: contest._id } },
      { $group: { _id: '$entryId', count: { $sum: 1 } } },
    ]);
    for (const r of agg) { voteCounts[r._id.toString()] = r.count; totalVotes += r.count; }
  }

  // TEMP: participant check disabled for testing — re-enable before launch
  // const isParticipant =
  //   contest.createdBy?.toString() === myId ||
  //   contest.entries.some(e => e.userId.toString() === myId);
  const canVote     = !myVote /* TEMP: status === 'active' disabled for testing — re-enable before launch */;
  const isNominator = !!(myId && contest.createdBy?._id?.toString() === myId);

  function buildSide(ce) {
    if (!ce) return null;
    const uid  = ce.userId.toString();
    const user = userMap[uid] || null;
    const eid  = ce.entryId?._id?.toString();
    return {
      userId:    uid,
      user,
      entry:     ce.entryId || null,
      entryId:   eid || null,
      hidden:    ce.hidden || false,
      voteCount: voteCounts[eid] || 0,
      votePct:   totalVotes > 0 ? Math.round(((voteCounts[eid] || 0) / totalVotes) * 100) : 50,
      isWinner:  !!(contest.winnerEntryId && eid && contest.winnerEntryId.toString() === eid),
      isMine:    uid === myId,
      iVotedFor: !!(myVote && eid && myVote.entryId.toString() === eid),
    };
  }

  const left  = buildSide(nomCE);
  const right = resCE ? buildSide(resCE) : null;

  let nomineeUser = null;
  if (!right && contest.status === 'pending') {
    const nom = await Nomination.findOne({ contestId: contest._id, status: 'pending' })
      .select('nomineeId').lean().catch(() => null);
    if (nom) {
      nomineeUser = await User.findById(nom.nomineeId).select('username displayName avatar').lean().catch(() => null);
    }
  }

  const followingIds = {};
  if (req.session.userId) {
    const targetIds = [
      left?.userId,
      right ? right.userId : (nomineeUser ? nomineeUser._id : null),
    ].filter(Boolean);
    if (targetIds.length) {
      const follows = await Follow.find({
        followerId:  req.session.userId,
        followingId: { $in: targetIds },
      }).select('followingId').lean().catch(() => []);
      follows.forEach(f => { followingIds[f.followingId.toString()] = true; });
    }
  }

  const statusLabel = { pending: 'Pending', active: 'Live', void: 'Void', closed: 'Closed' }[contest.status] || contest.status;

  const topLevelComments = await ContestComment.find({ contestId: contest._id, parentId: null, hidden: false })
    .populate('userId', 'username displayName avatar')
    .sort({ createdAt: 1 })
    .lean()
    .catch(() => []);

  const topLevelIds = topLevelComments.map(c => c._id);
  const allReplies  = topLevelIds.length
    ? await ContestComment.find({ parentId: { $in: topLevelIds }, hidden: false })
        .populate('userId', 'username displayName avatar')
        .sort({ createdAt: 1 })
        .lean()
        .catch(() => [])
    : [];

  const replyMap = {};
  for (const r of allReplies) {
    const pid = r.parentId.toString();
    if (!replyMap[pid]) replyMap[pid] = [];
    replyMap[pid].push(r);
  }
  const comments = topLevelComments.map(c => ({ ...c, replies: replyMap[c._id.toString()] || [] }));

  const participantIds = [left?.userId, right?.userId].filter(Boolean);
  const relatedContests = participantIds.length
    ? await Contest.find({
        _id:               { $ne: contest._id },
        'entries.userId':  { $in: participantIds },
        visibility:        'public',
        status:            { $nin: ['void'] },
      })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('entries.entryId', 'mediaUrl mediaType')
      .lean()
      .catch(() => [])
    : [];

  const relatedUserIds = [...new Set(relatedContests.flatMap(c => c.entries.map(e => e.userId.toString())))];
  const relatedUserDocs = relatedUserIds.length
    ? await User.find({ _id: { $in: relatedUserIds } }).select('username displayName avatar').lean().catch(() => [])
    : [];
  const relatedUserMap = {};
  relatedUserDocs.forEach(u => { relatedUserMap[u._id.toString()] = u; });

  res.render('contest', {
    title:      'H2H Contest',
    activePage: '',
    currentUser: req.currentUser,
    contest,
    left,
    right,
    nomineeUser,
    followingIds,
    myVote,
    canVote,
    isNominator,
    totalVotes,
    showVotes:   !!(myVote || contest.status === 'closed'),
    statusLabel,
    comments,
    relatedContests,
    relatedUserMap,
  });
});

// ── Public profile — must be last to avoid swallowing other routes ─

router.get('/:username', async (req, res) => {
  const user = await User.findOne({ 'username.value': req.params.username.toLowerCase() })
    .select('username displayName bio avatar banner location sex birthdate url createdAt');

  if (!user) return res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser });

  const isOwn   = user._id.toString() === req.session.userId;
  const entries = await Entry.find({ userId: user._id }).sort({ createdAt: -1 });

  const entryIds = entries.map(e => e._id);

  const [followerCount, followingCount, nominationsAccepted, firstPrizes, secondPrizes, thirdPrizes, userContests, userTournamentEntries, followDoc] = await Promise.all([
    Follow.countDocuments({ followingId: user._id }),
    Follow.countDocuments({ followerId: user._id }),
    Nomination.countDocuments({ nomineeId: user._id, status: 'accepted' }),
    entryIds.length ? Tournament.countDocuments({ 'prizes.first.entryId': { $in: entryIds }, status: 'closed' }) : Promise.resolve(0),
    entryIds.length ? Tournament.countDocuments({ 'prizes.second.entryId': { $in: entryIds }, status: 'closed' }) : Promise.resolve(0),
    entryIds.length ? Tournament.countDocuments({ 'prizes.third.entryId': { $in: entryIds }, status: 'closed' }) : Promise.resolve(0),
    Contest.find({ 'entries.userId': user._id }).sort({ createdAt: -1 }).populate('entries.entryId', 'mediaUrl caption').lean(),
    TournamentEntry.find({ userId: user._id }).sort({ submittedAt: -1 }).populate('tournamentId', 'name status type prizes').populate('entryId', 'mediaUrl caption').lean(),
    (!isOwn && req.session.userId) ? Follow.findOne({ followerId: req.session.userId, followingId: user._id }).lean() : Promise.resolve(null),
  ]);

  const isFollowing = !!followDoc;

  const contestMap = {};
  for (const c of userContests) {
    if (c.status !== 'active' && c.status !== 'pending') continue;
    for (const ce of c.entries) {
      const eid = ce.entryId?._id?.toString();
      if (eid && !contestMap[eid]) {
        contestMap[eid] = { contestId: c._id.toString(), status: c.status };
      }
    }
  }

  const contestToEntryId = {};
  for (const c of userContests) {
    for (const ce of c.entries) {
      const eid = ce.entryId?._id?.toString();
      const uid = ce.userId?.toString();
      if (eid && uid === user._id.toString()) contestToEntryId[c._id.toString()] = eid;
    }
  }
  const profileNominations = userContests.length
    ? await Nomination.find({
        contestId:   { $in: userContests.map(c => c._id) },
        nominatorId: user._id,
        status:      'pending',
      }).populate('nomineeId', 'username displayName avatar').lean()
    : [];

  const profileContestById = {};
  for (const c of userContests) profileContestById[c._id.toString()] = c;

  const profileLiveCIds = userContests.filter(c => c.status === 'active' || c.status === 'closed').map(c => c._id);
  const profileVoteAggs = profileLiveCIds.length
    ? await ContestVote.aggregate([
        { $match: { contestId: { $in: profileLiveCIds } } },
        { $group: { _id: { contestId: '$contestId', entryId: '$entryId' }, count: { $sum: 1 } } },
      ])
    : [];
  const profileVoteMap = {};
  for (const a of profileVoteAggs) {
    const cid = a._id.contestId.toString();
    if (!profileVoteMap[cid]) profileVoteMap[cid] = {};
    profileVoteMap[cid][a._id.entryId.toString()] = a.count;
  }

  const nomineesMap = {};
  const seenNomineesPerEntry = {};
  for (const n of profileNominations) {
    const eid = contestToEntryId[n.contestId.toString()];
    if (!eid) continue;
    const uname = n.nomineeId.username?.value;
    if (!uname) continue;
    if (!seenNomineesPerEntry[eid]) seenNomineesPerEntry[eid] = new Set();
    if (seenNomineesPerEntry[eid].has(uname)) continue;
    seenNomineesPerEntry[eid].add(uname);
    if (!nomineesMap[eid]) nomineesMap[eid] = [];
    const cid     = n.contestId.toString();
    const pContest = profileContestById[cid];
    const cvotes  = profileVoteMap[cid] || {};
    const oppEid  = pContest?.entries?.find(e => e.entryId?._id?.toString() !== eid)?.entryId?._id?.toString();
    nomineesMap[eid].push({
      contestId:         cid,
      username:          uname,
      avatar:            n.nomineeId.avatar?.value || null,
      status:            pContest?.status === 'void' ? 'void' : n.status,
      contestStatus:     pContest?.status || null,
      voteCountMine:     cvotes[eid]    || 0,
      voteCountNominee: oppEid ? (cvotes[oppEid] || 0) : 0,
    });
  }

  const ratedEntries = entries.filter(e => e.ratingCount > 0);
  const overallRank = ratedEntries.length
    ? (ratedEntries.reduce((s, e) => s + e.ratingAvg, 0) / ratedEntries.length).toFixed(1)
    : null;

  const title = user.displayName?.value
    ? `${user.displayName.value} - @${user.username.value} on AllThingsAprons.com`
    : `@${user.username.value} on AllThingsAprons.com`;

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
    isFollowing,
    userContests,
    userTournamentEntries,
    contestMap,
    nomineesMap,
    editError: typeof req.query.editError === 'string' ? req.query.editError : null,
  });
});

module.exports = router;
