const express    = require('express');
const router     = express.Router();
const mongoose   = require('mongoose');
const User       = require('../models/User');
const Entry      = require('../models/Entry');
const Rating     = require('../models/Rating');
const Follow     = require('../models/Follow');
const Nomination = require('../models/Nomination');
const Contest    = require('../models/Contest');
const ContestVote = require('../models/ContestVote');
const ContestComment = require('../models/ContestComment');
const ContestCommentReport = require('../models/ContestCommentReport');
const Comment       = require('../models/Comment');
const CommentReport = require('../models/CommentReport');
const Notification  = require('../models/Notification');
const Announcement  = require('../models/Announcement');
const AnnouncementDismissal = require('../models/AnnouncementDismissal');
const upload                  = require('../middleware/upload');
const checkContestEligibility = require('../utils/contestEligibility');
const ContestWatch            = require('../models/ContestWatch');
const notifyWatchers          = require('../utils/notifyWatchers');

router.get('/me', (req, res) => {
  res.json({ authenticated: !!req.session.userId });
});

router.get('/users/search', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const q = req.query.q?.trim().toLowerCase().replace(/^@/, '');
  if (!q || q.length < 1) return res.json([]);
  const users = await User.find({
    'username.value': { $regex: '^' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' },
    _id: { $ne: req.session.userId },
  })
    .select('username displayName avatar')
    .limit(6)
    .lean();
  res.json(users.map(u => ({
    _id:         u._id,
    username:    u.username.value,
    displayName: u.displayName?.value || u.username.value,
    avatar:      u.avatar?.value || null,
  })));
});

router.get('/users/lookup', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const username = req.query.username?.trim().toLowerCase().replace(/^@/, '');
  if (!username) return res.status(400).json({ error: 'Username required.' });
  const user = await User.findOne({ 'username.value': username })
    .select('username displayName avatar')
    .lean();
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user._id.toString() === req.session.userId.toString()) {
    return res.status(400).json({ error: 'You cannot challenge yourself.' });
  }
  res.json({
    _id:         user._id,
    username:    user.username.value,
    displayName: user.displayName?.value || user.username.value,
    avatar:      user.avatar?.value || null,
  });
});

router.get('/has-user', async (req, res) => {
  try {
    const count = await User.countDocuments();
    res.json({ exists: count > 0 });
  } catch {
    res.json({ exists: false });
  }
});

router.get('/check-signup', async (req, res) => {
  const { username, email } = req.query;
  const result = { usernameAvailable: true, emailAvailable: true };
  try {
    if (username) {
      const u = await User.findOne({ 'username.value': username.toLowerCase() });
      result.usernameAvailable = !u;
    }
    if (email) {
      const e = await User.findOne({ 'email.value': email.toLowerCase() });
      result.emailAvailable = !e;
    }
  } catch { /* if DB is down, report available — server will catch duplicate on submit */ }
  res.json(result);
});

router.post('/entries', upload.entry.fields([{ name: 'entryMedia', maxCount: 1 }]), async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  // TEMP: bypass idVerified for test accounts — remove before launch
  const TEST_BYPASS_USERNAMES = ['celuiqui', 'storiesbyshews'];
  const actor = await User.findById(req.session.userId).select('idVerified username avatar').lean();
  const isBypassUser = actor && TEST_BYPASS_USERNAMES.includes(actor.username?.value);
  if (!actor || (!actor.idVerified && !isBypassUser)) return res.status(403).json({ error: 'identity_required' });

  const file = req.files?.entryMedia?.[0];
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  const title = req.body.title?.trim();
  if (!title) return res.status(400).json({ error: 'Title is required.' });

  const isVideo = file.mimetype.startsWith('video/');
  if (!isVideo && file.size > 10 * 1024 * 1024) {
    return res.status(400).json({ error: 'Photo files must be under 10 MB.' });
  }

  let tags = [];
  if (req.body.tags) {
    const raw = Array.isArray(req.body.tags) ? req.body.tags : [req.body.tags];
    tags = raw.map(t => t.trim().toLowerCase()).filter(Boolean).slice(0, 6);
  }

  const nominationId = req.body.nominationId?.trim() || null;

  const rawUsernames = req.body.challengeUsername
    ? (Array.isArray(req.body.challengeUsername) ? req.body.challengeUsername : [req.body.challengeUsername])
    : [];
  const challengeUsernames = [...new Set(rawUsernames.map(u => u.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];

  let pendingNom      = null;
  let pendingTakeOn   = null;
  let nominees        = [];

  if (nominationId) {
    if (!mongoose.isValidObjectId(nominationId)) return res.status(400).json({ error: 'Invalid nomination.' });
    pendingNom = await Nomination.findById(nominationId).lean();
    if (!pendingNom)                                                       return res.status(404).json({ error: 'Nomination not found.' });
    if (pendingNom.nomineeId.toString() !== req.session.userId.toString()) return res.status(403).json({ error: 'This nomination is not for you.' });
    if (pendingNom.status !== 'pending')                                   return res.status(409).json({ error: 'This nomination has already been resolved.' });
  }

  const takeOnContestId = req.body.takeOnContestId?.trim() || null;
  if (takeOnContestId) {
    if (!mongoose.isValidObjectId(takeOnContestId)) return res.status(400).json({ error: 'Invalid take-on contest.' });
    const toc = await Contest.findOne({ _id: takeOnContestId, createdBy: req.session.userId, status: 'pending' }).select('_id windowHours').lean();
    const tocNom = toc ? await Nomination.findOne({ contestId: toc._id, nominatorId: req.session.userId, type: 'take_on', status: 'accepted' }).lean() : null;
    if (toc && tocNom) pendingTakeOn = { contest: toc, nomination: tocNom };
  }

  let designatedVoters = [];
  if (challengeUsernames.length) {
    nominees = await User.find({ 'username.value': { $in: challengeUsernames } }).select('_id').lean();
    if (nominees.length !== challengeUsernames.length) return res.status(404).json({ error: 'One or more nominees not found.' });
    if (nominees.some(n => n._id.toString() === req.session.userId.toString())) {
      return res.status(400).json({ error: 'You cannot challenge yourself.' });
    }
    const challengeVis = ['public', 'private'].includes(req.body.challengeVisibility) ? req.body.challengeVisibility : 'public';
    if (challengeVis === 'private') {
      const rawIds = Array.isArray(req.body.challengeVoterIds)
        ? req.body.challengeVoterIds
        : req.body.challengeVoterIds ? [req.body.challengeVoterIds] : [];
      designatedVoters = rawIds.filter(id => mongoose.isValidObjectId(id));
      if (designatedVoters.length < 5) return res.status(400).json({ error: 'Private contests require at least 5 designated voters.' });
    }
  }

  let contestEligibilityError = null;
  if (nominationId || challengeUsernames.length) {
    const eligibility = await checkContestEligibility(req.session.userId);
    if (!eligibility.eligible) contestEligibilityError = eligibility.reason;
  }

  try {
    const entry = await Entry.create({
      userId:          req.session.userId,
      mediaUrl:        `/uploads/entries/${file.filename}`,
      mediaType:       isVideo ? 'video' : 'photo',
      title,
      caption:         req.body.caption?.trim() || undefined,
      tags,
      visibility:      ['public', 'followers'].includes(req.body.visibility) ? req.body.visibility : 'public',
      commentsEnabled: req.body.commentsEnabled !== 'false',
      matureContent:   req.body.matureContent === 'true',
      aiGenerated:     req.body.aiGenerated === 'true',
      allowTakeOns:    req.body.allowTakeOns !== 'false',
    });

    if (contestEligibilityError) {
      return res.json({ entryId: entry._id, contestId: null, eligibilityError: contestEligibilityError });
    }

    let contestId = null;

    if (pendingNom) {
      const nomContest = await Contest.findById(pendingNom.contestId).select('windowHours').lean();
      const winHours   = nomContest?.windowHours || 72;
      await Promise.all([
        Nomination.findByIdAndUpdate(pendingNom._id, { status: 'accepted', nomineeEntryId: entry._id }),
        Contest.findByIdAndUpdate(pendingNom.contestId, {
          $push:  { entries: { entryId: entry._id, userId: req.session.userId, submittedAt: new Date() } },
          status: 'active',
          votingDeadline: new Date(Date.now() + winHours * 60 * 60 * 1000),
          lastActivityAt: new Date(),
        }),
        Notification.updateOne(
          { userId: req.session.userId, type: 'nomination_received', 'payload.contestId': pendingNom.contestId },
          { $set: { 'payload.url': '/contest/' + pendingNom.contestId } }
        ),
      ]);
      contestId = pendingNom.contestId;
      const nomAcceptPayload = {
        actorUsername: actor?.username?.value || 'Someone',
        actorAvatar:   actor?.avatar?.value   || null,
        contestId:     pendingNom.contestId,
        url:           '/contest/' + pendingNom.contestId,
      };
      Notification.create({
        userId:  pendingNom.nominatorId,
        type:    'nominee_accepted',
        payload: nomAcceptPayload,
      }).catch(() => {});
      notifyWatchers(pendingNom.contestId, 'nominee_accepted', nomAcceptPayload, [req.session.userId, pendingNom.nominatorId]);
    }

    if (pendingTakeOn) {
      const winHours = pendingTakeOn.contest.windowHours || 72;
      await Contest.findByIdAndUpdate(pendingTakeOn.contest._id, {
        $push:          { entries: { entryId: entry._id, userId: req.session.userId, submittedAt: new Date() } },
        status:         'active',
        votingDeadline: new Date(Date.now() + winHours * 60 * 60 * 1000),
        lastActivityAt: new Date(),
      });
      contestId = pendingTakeOn.contest._id;
      notifyWatchers(pendingTakeOn.contest._id, 'nominee_accepted', {
        actorUsername: actor?.username?.value || 'Someone',
        actorAvatar:   actor?.avatar?.value   || null,
        contestId:     pendingTakeOn.contest._id,
        url:           '/contest/' + pendingTakeOn.contest._id,
      }, [req.session.userId, pendingTakeOn.contest.createdBy]);
    }

    if (nominees.length) {
      const hideEntry   = req.body.challengeHideEntry === 'true';
      const visibility  = ['public', 'private'].includes(req.body.challengeVisibility) ? req.body.challengeVisibility : 'public';
      const rawWin      = parseInt(req.body.challengeWindowHours, 10);
      const windowHours = [24, 48, 72, 168].includes(rawWin) ? rawWin : 72;
      const expiry      = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const nominator   = await User.findById(req.session.userId).select('username avatar').lean();
      const contests    = await Promise.all(nominees.map(nom =>
        Contest.create({
          createdBy:        req.session.userId,
          visibility,
          windowHours,
          status:           'pending',
          voidDeadline:     expiry,
          entries:          [{ entryId: entry._id, userId: req.session.userId, submittedAt: new Date(), hidden: hideEntry }],
          designatedVoters,
        }).then(c => Nomination.create({
          contestId:   c._id,
          nominatorId: req.session.userId,
          nomineeId:   nom._id,
          expiresAt:   expiry,
          status:      'pending',
        }).then(nomination => {
          Notification.create({
            userId:  nom._id,
            type:    'nomination_received',
            payload: {
              actorUsername: nominator?.username?.value || 'Someone',
              actorAvatar:   nominator?.avatar?.value || null,
              contestId:     c._id,
              url:           '/submit?nomination=' + nomination._id,
            },
          }).catch(() => {});
          return c._id;
        }))
      ));
      contestId = contests.length === 1 ? contests[0] : null;
    }

    res.json({ entryId: entry._id, contestId });
  } catch (err) {
    console.error('Entry create error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/nominations/:id/accept', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { entryId } = req.body;
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(entryId)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }
  const [nom, entry] = await Promise.all([
    Nomination.findById(req.params.id).lean(),
    Entry.findById(entryId).select('userId').lean(),
  ]);
  if (!nom)                                                                  return res.status(404).json({ error: 'Nomination not found.' });
  if (nom.nomineeId.toString() !== req.session.userId.toString())            return res.status(403).json({ error: 'Not your nomination.' });
  if (nom.status !== 'pending')                                              return res.status(409).json({ error: 'Nomination already resolved.' });
  if (nom.expiresAt < new Date())                                            return res.status(410).json({ error: 'This nomination has expired.' });
  if (!entry)                                                                return res.status(404).json({ error: 'Entry not found.' });
  if (entry.userId.toString() !== req.session.userId.toString())            return res.status(403).json({ error: 'Not your entry.' });
  const eligibility = await checkContestEligibility(req.session.userId);
  if (!eligibility.eligible) return res.status(403).json({ error: eligibility.reason });
  const nomContest = await Contest.findById(nom.contestId).select('windowHours').lean();
  const winHours   = nomContest?.windowHours || 72;
  const [,,, nominee] = await Promise.all([
    Nomination.findByIdAndUpdate(req.params.id, { status: 'accepted', nomineeEntryId: entryId }),
    Contest.findByIdAndUpdate(nom.contestId, {
      $push:          { entries: { entryId, userId: req.session.userId, submittedAt: new Date() } },
      status:         'active',
      votingDeadline: new Date(Date.now() + winHours * 60 * 60 * 1000),
      lastActivityAt: new Date(),
    }),
    Notification.updateOne(
      { userId: req.session.userId, type: 'nomination_received', 'payload.contestId': nom.contestId },
      { $set: { 'payload.url': '/contest/' + nom.contestId } }
    ),
    User.findById(req.session.userId).select('username avatar').lean(),
  ]);
  const acceptPayload = {
    actorUsername: nominee?.username?.value || 'Someone',
    actorAvatar:   nominee?.avatar?.value   || null,
    contestId:     nom.contestId,
    url:           '/contest/' + nom.contestId,
  };
  Notification.create({
    userId:  nom.nominatorId,
    type:    'nominee_accepted',
    payload: acceptPayload,
  }).catch(() => {});
  notifyWatchers(nom.contestId, 'nominee_accepted', acceptPayload, [req.session.userId, nom.nominatorId]);
  res.json({ ok: true, contestId: nom.contestId });
});

router.post('/nominations/:id/decline', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });
  const nom = await Nomination.findById(req.params.id).lean();
  if (!nom)                                                         return res.status(404).json({ error: 'Nomination not found.' });
  if (nom.nomineeId.toString() !== req.session.userId.toString())  return res.status(403).json({ error: 'Not your nomination.' });
  if (nom.status !== 'pending')                                     return res.status(409).json({ error: 'Nomination already resolved.' });
  if (nom.expiresAt < new Date())                                   return res.status(410).json({ error: 'This nomination has expired.' });
  const [,, decliner] = await Promise.all([
    Nomination.findByIdAndUpdate(req.params.id, { status: 'void' }),
    Contest.findByIdAndUpdate(nom.contestId, { $set: { status: 'void', voidReason: 'declined', lastActivityAt: new Date() } }),
    User.findById(req.session.userId).select('username avatar').lean(),
  ]);
  notifyWatchers(nom.contestId, 'nominee_declined', {
    actorUsername: decliner?.username?.value || 'Someone',
    actorAvatar:   decliner?.avatar?.value   || null,
    contestId:     nom.contestId,
    url:           '/contest/' + nom.contestId,
  }, [req.session.userId]);
  res.json({ ok: true });
});

router.post('/contests/challenge', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { entryId, challengeUsername, visibility, hideEntry, voterIds, windowHours: rawWinHours } = req.body;
  if (!mongoose.isValidObjectId(entryId)) return res.status(400).json({ error: 'Invalid entry ID.' });
  if (!challengeUsername)                 return res.status(400).json({ error: 'Username required.' });
  const [entry, nominee] = await Promise.all([
    Entry.findById(entryId).select('userId').lean(),
    User.findOne({ 'username.value': challengeUsername.trim().toLowerCase().replace(/^@/, '') }).select('_id').lean(),
  ]);
  if (!entry)                                                                return res.status(404).json({ error: 'Entry not found.' });
  if (entry.userId.toString() !== req.session.userId.toString())            return res.status(403).json({ error: 'Not your entry.' });
  if (!nominee)                                                              return res.status(404).json({ error: 'User not found.' });
  if (nominee._id.toString() === req.session.userId.toString())             return res.status(400).json({ error: 'You cannot challenge yourself.' });
  const eligibility = await checkContestEligibility(req.session.userId);
  if (!eligibility.eligible) return res.status(400).json({ error: eligibility.reason });
  const vis         = ['public', 'private'].includes(visibility) ? visibility : 'public';
  const hide        = hideEntry === 'true';
  const expiry      = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const rawWin      = parseInt(rawWinHours, 10);
  const windowHours = [24, 48, 72, 168].includes(rawWin) ? rawWin : 72;
  let designatedVoters = [];
  if (vis === 'private') {
    const rawIds = Array.isArray(voterIds) ? voterIds : (voterIds ? [voterIds] : []);
    designatedVoters = rawIds.filter(id => mongoose.isValidObjectId(id));
    if (designatedVoters.length < 5) return res.status(400).json({ error: 'Private contests require at least 5 designated voters.' });
  }
  const contest = await Contest.create({
    createdBy:        req.session.userId,
    visibility:       vis,
    status:           'pending',
    voidDeadline:     expiry,
    windowHours,
    entries:          [{ entryId, userId: req.session.userId, submittedAt: new Date(), hidden: hide }],
    designatedVoters,
  });
  const nomination = await Nomination.create({
    contestId:   contest._id,
    nominatorId: req.session.userId,
    nomineeId:   nominee._id,
    expiresAt:   expiry,
    status:      'pending',
  });

  const nominator = await User.findById(req.session.userId).select('username avatar').lean();
  Notification.create({
    userId:  nominee._id,
    type:    'nomination_received',
    payload: {
      actorUsername: nominator?.username?.value || 'Someone',
      actorAvatar:   nominator?.avatar?.value || null,
      contestId:     contest._id,
      url:           '/submit?nomination=' + nomination._id,
    },
  }).catch(() => {});

  Follow.find({ followingId: req.session.userId }).select('followerId').lean()
    .then(follows => {
      if (!follows.length) return;
      const excludeStrs = new Set([nominee._id.toString(), req.session.userId.toString()]);
      const docs = follows
        .filter(f => !excludeStrs.has(f.followerId.toString()))
        .map(f => ({
          userId:  f.followerId,
          type:    'contest_started',
          payload: {
            actorUsername: nominator?.username?.value || 'Someone',
            actorAvatar:   nominator?.avatar?.value || null,
            contestId:     contest._id,
            url:           '/contest/' + contest._id,
          },
          read: false,
        }));
      if (docs.length) return Notification.insertMany(docs, { ordered: false });
    })
    .catch(() => {});

  res.json({ ok: true, contestId: contest._id });
});

router.get('/profile/:username/entries', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 12;
  const skip  = (page - 1) * limit;

  try {
    const user = await User.findOne({ 'username.value': req.params.username.toLowerCase() }).select('_id');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [entries, total] = await Promise.all([
      Entry.find({ userId: user._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('mediaUrl mediaType caption tags ratingAvg ratingCount')
        .lean(),
      Entry.countDocuments({ userId: user._id }),
    ]);

    res.json({ entries, hasMore: skip + entries.length < total });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/entries/:id', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Entry not found' });

  try {
    const entry = await Entry.findById(req.params.id).select('userId').lean();
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    if (entry.userId.toString() !== req.session.userId.toString()) {
      return res.status(403).json({ error: 'Not your entry' });
    }

    const activeContest = await Contest.findOne({
      'entries.entryId': new mongoose.Types.ObjectId(req.params.id),
      status: 'active',
    }).select('_id').lean();
    if (activeContest) return res.status(403).json({ error: 'Cannot edit an entry in an active contest.' });

    const title = req.body.title?.trim();
    if (!title) return res.status(400).json({ error: 'Title is required.' });

    const rawTags = Array.isArray(req.body.tags) ? req.body.tags : [];
    const updates = {
      title,
      caption:         req.body.caption?.trim() ?? '',
      visibility:      ['public', 'followers'].includes(req.body.visibility) ? req.body.visibility : 'public',
      commentsEnabled: req.body.commentsEnabled !== 'false' && req.body.commentsEnabled !== false,
      matureContent:   req.body.matureContent === 'true'  || req.body.matureContent === true,
      aiGenerated:     req.body.aiGenerated === 'true'    || req.body.aiGenerated === true,
      tags:            rawTags.map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 6),
    };

    await Entry.findByIdAndUpdate(req.params.id, { $set: updates });
    res.json({ ok: true });
  } catch (err) {
    console.error('Entry update error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.post('/entries/:eid/rate', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const { eid } = req.params;
  const score   = parseInt(req.body.score, 10);

  if (!mongoose.isValidObjectId(eid))      return res.status(404).json({ error: 'Entry not found' });
  if (isNaN(score) || score < 1 || score > 10) return res.status(400).json({ error: 'Score must be between 1 and 10' });

  try {
    const entry = await Entry.findById(eid).select('userId ratingCount ratingAvg').lean();
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    if (entry.userId.toString() === req.session.userId.toString()) {
      return res.status(400).json({ error: "You can't rate your own entry" });
    }

    await Rating.create({ entryId: eid, userId: req.session.userId, score });

    const [stats] = await Rating.aggregate([
      { $match: { entryId: new mongoose.Types.ObjectId(eid) } },
      { $group: { _id: null, avg: { $avg: '$score' }, count: { $sum: 1 } } },
    ]);

    await Entry.updateOne({ _id: eid }, { ratingAvg: stats.avg, ratingCount: stats.count });

    res.json({ ratingAvg: stats.avg, ratingCount: stats.count });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "You've already rated this entry" });
    console.error('Rate entry error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

router.post('/contests/:id/vote', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { entryId } = req.body;
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(entryId)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }
  const contest = await Contest.findById(req.params.id).lean();
  if (!contest)                    return res.status(404).json({ error: 'Contest not found.' });
  // TEMP: status check disabled for testing — re-enable before launch
  // if (contest.status !== 'active') return res.status(409).json({ error: 'Contest is not active.' });

  const ce = contest.entries.find(e => e.entryId.toString() === entryId);
  if (!ce) return res.status(400).json({ error: 'Entry not in this contest.' });

  const isOwnEntry = contest.entries.some(
    e => e.userId.toString() === req.session.userId.toString() && e.entryId.toString() === entryId
  );
  if (isOwnEntry) return res.status(403).json({ error: "You can't vote for your own entry." });

  try {
    await ContestVote.create({ contestId: contest._id, entryId, userId: req.session.userId });
    Contest.updateOne({ _id: contest._id }, { $set: { lastActivityAt: new Date() } }).catch(() => {});
    const agg = await ContestVote.aggregate([
      { $match: { contestId: contest._id } },
      { $group: { _id: '$entryId', count: { $sum: 1 } } },
    ]);
    const voteCounts = {};
    let total = 0;
    for (const r of agg) { voteCounts[r._id.toString()] = r.count; total += r.count; }
    res.json({ ok: true, votedFor: entryId, voteCounts, total });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "You've already voted in this contest." });
    console.error('Contest vote error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.delete('/contests/:id', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });
  const contest = await Contest.findById(req.params.id).select('status createdBy').lean().catch(() => null);
  if (!contest) return res.status(404).json({ error: 'Contest not found.' });
  if (contest.createdBy.toString() !== req.session.userId.toString()) return res.status(403).json({ error: 'Not your contest.' });
  if (contest.status !== 'pending') return res.status(409).json({ error: 'Contest can only be voided while pending.' });
  await Promise.all([
    Contest.findByIdAndUpdate(req.params.id, { $set: { status: 'void', voidReason: 'canceled' } }),
    Nomination.findOneAndUpdate({ contestId: req.params.id, status: 'pending' }, { $set: { status: 'void' } }),
  ]);
  res.json({ ok: true });
});

router.delete('/contests/:id/vote', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });
  const contest = await Contest.findById(req.params.id).select('status').lean().catch(() => null);
  if (!contest) return res.status(404).json({ error: 'Contest not found.' });
  if (contest.status === 'closed') return res.status(409).json({ error: 'Contest is already closed.' });
  const result = await ContestVote.deleteOne({ contestId: req.params.id, userId: req.session.userId });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'No vote to remove.' });
  res.json({ ok: true });
});

router.post('/contests/:id/forfeit', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const contest = await Contest.findById(req.params.id).lean().catch(() => null);
  if (!contest)                    return res.status(404).json({ error: 'Contest not found.' });
  if (contest.status !== 'active') return res.status(409).json({ error: 'Contest is not active.' });

  const uid         = req.session.userId.toString();
  const isNominator = contest.createdBy.toString() === uid;
  const nomineeEntry = contest.entries.find(e => e.userId.toString() !== contest.createdBy.toString());
  const isNominee   = nomineeEntry && nomineeEntry.userId.toString() === uid;

  if (!isNominator && !isNominee) return res.status(403).json({ error: 'You are not a participant in this contest.' });

  let winnerEntryId, voidReason;
  if (isNominee) {
    // Nominee forfeits — nominator wins, keeps their accumulated votes
    const nominatorEntry = contest.entries.find(e => e.userId.toString() === contest.createdBy.toString());
    winnerEntryId = nominatorEntry.entryId;
    voidReason    = 'nominee_forfeit';
  } else {
    // Nominator forfeits — nominee wins, gets their accumulated votes
    winnerEntryId = nomineeEntry.entryId;
    voidReason    = 'nominator_forfeit';
  }

  const [, forfeiter] = await Promise.all([
    Contest.findByIdAndUpdate(req.params.id, { $set: { status: 'void', voidReason, winnerEntryId, lastActivityAt: new Date() } }),
    User.findById(req.session.userId).select('username avatar').lean(),
  ]);
  notifyWatchers(req.params.id, 'contest_forfeited', {
    actorUsername: forfeiter?.username?.value || 'Someone',
    actorAvatar:   forfeiter?.avatar?.value   || null,
    contestId:     req.params.id,
    voidReason,
    url:           '/contest/' + req.params.id,
  }, [req.session.userId]);
  res.json({ ok: true, voidReason });
});

// ── Take On ───────────────────────────────────────────────────────


router.patch('/entries/:id/allow-take-ons', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Entry not found.' });
  const entry = await Entry.findById(req.params.id).select('userId').lean().catch(() => null);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  if (entry.userId.toString() !== req.session.userId) return res.status(403).json({ error: 'Not your entry.' });
  const allow = req.body.allow === true || req.body.allow === 'true';
  await Entry.findByIdAndUpdate(req.params.id, { allowTakeOns: allow });
  res.json({ ok: true, allowTakeOns: allow });
});

router.post('/entries/:id/take-on', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Entry not found.' });

  const { challengerEntryId } = req.body;
  if (!challengerEntryId || !mongoose.isValidObjectId(challengerEntryId)) {
    return res.status(400).json({ error: 'Select an entry to challenge with.' });
  }
  if (challengerEntryId === req.params.id) {
    return res.status(400).json({ error: 'You cannot challenge an entry with itself.' });
  }

  const [targetEntry, challengerEntry, actor] = await Promise.all([
    Entry.findById(req.params.id).select('userId allowTakeOns mediaUrl mediaType').lean().catch(() => null),
    Entry.findById(challengerEntryId).select('userId mediaUrl mediaType').lean().catch(() => null),
    User.findById(req.session.userId).select('username avatar idVerified').lean(),
  ]);

  if (!targetEntry)    return res.status(404).json({ error: 'Entry not found.' });
  if (!challengerEntry) return res.status(404).json({ error: 'Challenger entry not found.' });
  if (!actor)          return res.status(401).json({ error: 'Not authenticated.' });
  if (targetEntry.userId.toString() === req.session.userId) return res.status(400).json({ error: 'You cannot take on your own entry.' });
  if (challengerEntry.userId.toString() !== req.session.userId) return res.status(403).json({ error: 'Not your entry.' });
  if (targetEntry.allowTakeOns === false) return res.status(403).json({ error: 'This entry is not accepting take-ons.' });
  if (!actor.idVerified) return res.status(403).json({ error: 'identity_required' });

  const eligibility = await checkContestEligibility(req.session.userId);
  if (!eligibility.eligible) return res.status(403).json({ error: eligibility.reason });

  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const [contest] = await Promise.all([
    Contest.create({
      createdBy:    req.session.userId,
      visibility:   'public',
      status:       'pending',
      voidDeadline: expiry,
      windowHours:  72,
      entries:      [{ entryId: challengerEntry._id, userId: req.session.userId, submittedAt: new Date() }],
    }),
    Entry.findByIdAndUpdate(targetEntry._id, { $inc: { takeOnCount: 1 } }),
  ]);

  const nomination = await Nomination.create({
    contestId:         contest._id,
    nominatorId:       req.session.userId,
    nomineeId:         targetEntry.userId,
    expiresAt:         expiry,
    status:            'pending',
    type:              'take_on',
    challengerEntryId: challengerEntry._id,
    nomineeEntryId:    targetEntry._id,
  });

  Notification.create({
    userId:  targetEntry.userId,
    type:    'take_on_received',
    payload: {
      actorUsername:       actor.username?.value || 'Someone',
      actorAvatar:         actor.avatar?.value || null,
      contestId:           contest._id,
      nominationId:        nomination._id,
      entryId:             targetEntry._id,
      challengerEntryId:   challengerEntry._id,
      challengerEntryUrl:  challengerEntry.mediaUrl,
      challengerEntryType: challengerEntry.mediaType,
      nomineeEntryUrl:     targetEntry.mediaUrl,
      nomineeEntryType:    targetEntry.mediaType,
      url:                 '/contest/' + contest._id,
    },
  }).catch(() => {});

  res.json({ ok: true, contestId: contest._id, nominationId: nomination._id });
});

router.post('/nominations/:id/take-on-accept', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const nom = await Nomination.findById(req.params.id).lean();
  if (!nom)                                                        return res.status(404).json({ error: 'Nomination not found.' });
  if (nom.type !== 'take_on')                                      return res.status(400).json({ error: 'Not a take-on nomination.' });
  if (nom.nomineeId.toString() !== req.session.userId.toString()) return res.status(403).json({ error: 'Not your take-on.' });
  if (nom.status !== 'pending')                                    return res.status(409).json({ error: 'Nomination already resolved.' });
  if (nom.expiresAt < new Date())                                  return res.status(410).json({ error: 'This take-on has expired.' });
  if (!nom.nomineeEntryId)                                         return res.status(400).json({ error: 'No target entry on this nomination.' });

  const acceptor = await User.findById(req.session.userId).select('username avatar').lean();
  const votingDeadline = new Date(Date.now() + 72 * 60 * 60 * 1000);

  await Promise.all([
    Nomination.findByIdAndUpdate(req.params.id, { status: 'accepted' }),
    Contest.findByIdAndUpdate(nom.contestId, {
      $push:  { entries: { entryId: nom.nomineeEntryId, userId: req.session.userId, submittedAt: new Date() } },
      status: 'active',
      votingDeadline,
      lastActivityAt: new Date(),
    }),
  ]);

  Notification.create({
    userId:  nom.nominatorId,
    type:    'take_on_accepted',
    payload: {
      actorUsername: acceptor?.username?.value || 'Someone',
      actorAvatar:   acceptor?.avatar?.value || null,
      contestId:     nom.contestId,
      url:           '/contest/' + nom.contestId,
    },
  }).catch(() => {});
  notifyWatchers(nom.contestId, 'nominee_accepted', {
    actorUsername: acceptor?.username?.value || 'Someone',
    actorAvatar:   acceptor?.avatar?.value   || null,
    contestId:     nom.contestId,
    url:           '/contest/' + nom.contestId,
  }, [req.session.userId, nom.nominatorId]);

  res.json({ ok: true, contestId: nom.contestId });
});

// ── Contest watch ─────────────────────────────────────────────────

router.post('/contests/:id/watch', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const existing = await ContestWatch.findOne({ contestId: req.params.id, userId: req.session.userId });
  if (existing) {
    await existing.deleteOne();
    return res.json({ watching: false });
  }

  await ContestWatch.create({ contestId: req.params.id, userId: req.session.userId });
  res.json({ watching: true });
});

// ── Contest comments ──────────────────────────────────────────────

function canAccessPrivateContest(contest, userId) {
  if (!userId) return false;
  const uid = userId.toString();
  if (contest.designatedVoters?.some(v => v.toString() === uid)) return true;
  if (contest.entries?.some(e => e.userId.toString() === uid)) return true;
  return false;
}

router.post('/contests/:id/comments', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const body = req.body.body?.trim();
  if (!body || body.length === 0) return res.status(400).json({ error: 'Comment body is required.' });
  if (body.replace(/\s/g, '').length > 280) return res.status(400).json({ error: 'Comment cannot exceed 280 characters (spaces not counted).' });

  const parentId = req.body.parentId || null;
  if (parentId && !mongoose.isValidObjectId(parentId)) return res.status(400).json({ error: 'Invalid parentId.' });

  const contest = await Contest.findById(req.params.id).select('visibility entries designatedVoters status').lean().catch(() => null);
  if (!contest) return res.status(404).json({ error: 'Contest not found.' });
  if (contest.visibility === 'private' && !canAccessPrivateContest(contest, req.session.userId)) {
    return res.status(403).json({ error: 'Not authorized.' });
  }

  if (parentId) {
    const parent = await ContestComment.findById(parentId).select('contestId parentId').lean().catch(() => null);
    if (!parent || parent.contestId.toString() !== req.params.id) {
      return res.status(400).json({ error: 'Invalid parent comment.' });
    }
    if (parent.parentId) return res.status(400).json({ error: 'Replies cannot be nested further.' });
  }

  try {
    const comment = await ContestComment.create({
      contestId: contest._id,
      userId:    req.session.userId,
      parentId:  parentId || null,
      body,
    });

    const user = await User.findById(req.session.userId).select('username displayName avatar').lean();
    res.json({
      _id:       comment._id,
      contestId: comment.contestId,
      userId:    comment.userId,
      parentId:  comment.parentId,
      body:      comment.body,
      editedAt:  comment.editedAt,
      createdAt: comment.createdAt,
      user: {
        username:    user.username?.value,
        displayName: user.displayName?.value || null,
        avatar:      user.avatar?.value || null,
      },
    });
  } catch (err) {
    console.error('Contest comment create error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.patch('/contests/:id/comments/:cid', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }

  const body = req.body.body?.trim();
  if (!body || body.length === 0) return res.status(400).json({ error: 'Comment body is required.' });
  if (body.replace(/\s/g, '').length > 280) return res.status(400).json({ error: 'Comment cannot exceed 280 characters (spaces not counted).' });

  const comment = await ContestComment.findById(req.params.cid).catch(() => null);
  if (!comment || comment.contestId.toString() !== req.params.id) {
    return res.status(404).json({ error: 'Comment not found.' });
  }
  if (comment.userId.toString() !== req.session.userId.toString()) {
    return res.status(403).json({ error: 'Not your comment.' });
  }

  comment.body     = body;
  comment.editedAt = new Date();
  await comment.save();

  res.json({ ok: true, body: comment.body, editedAt: comment.editedAt });
});

router.delete('/contests/:id/comments/:cid', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }

  const comment = await ContestComment.findById(req.params.cid).catch(() => null);
  if (!comment || comment.contestId.toString() !== req.params.id) {
    return res.status(404).json({ error: 'Comment not found.' });
  }

  const myId   = req.session.userId.toString();
  const isOwn  = comment.userId.toString() === myId;
  const isAdmin = req.currentUser?.role === 'admin';
  if (!isOwn && !isAdmin) return res.status(403).json({ error: 'Not authorized.' });

  await Promise.all([
    ContestComment.deleteOne({ _id: comment._id }),
    ContestComment.deleteMany({ parentId: comment._id }),
    ContestCommentReport.deleteMany({ contestCommentId: comment._id }),
  ]);

  res.json({ ok: true });
});

router.post('/contests/:id/comments/:cid/report', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }

  const comment = await ContestComment.findById(req.params.cid).select('userId contestId').lean().catch(() => null);
  if (!comment || comment.contestId.toString() !== req.params.id) {
    return res.status(404).json({ error: 'Comment not found.' });
  }
  if (comment.userId.toString() === req.session.userId.toString()) {
    return res.status(400).json({ error: "You can't report your own comment." });
  }

  try {
    await ContestCommentReport.create({
      contestCommentId: comment._id,
      reportedBy:       req.session.userId,
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "You've already reported this comment." });
    console.error('Contest comment report error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// GET /api/similar-accounts/:username — followers + following of the profile, for follow suggestions
router.get('/similar-accounts/:username', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ accounts: [] });

  try {
    const profileUser = await User.findOne({ 'username.value': req.params.username.toLowerCase() })
      .select('_id').lean();
    if (!profileUser) return res.json({ accounts: [] });

    const [followerDocs, followingDocs] = await Promise.all([
      Follow.find({ followingId: profileUser._id }).select('followerId').limit(30).lean(),
      Follow.find({ followerId:  profileUser._id }).select('followingId').limit(30).lean(),
    ]);

    const seen = new Set([req.session.userId, profileUser._id.toString()]);
    const candidates = [];
    for (const d of followerDocs)  { const id = d.followerId.toString();  if (!seen.has(id)) { seen.add(id); candidates.push(id); } }
    for (const d of followingDocs) { const id = d.followingId.toString(); if (!seen.has(id)) { seen.add(id); candidates.push(id); } }

    if (!candidates.length) return res.json({ accounts: [] });

    const pick = candidates.sort(() => 0.5 - Math.random()).slice(0, 3);

    const [users, myFollowing] = await Promise.all([
      User.find({ _id: { $in: pick } }).select('username displayName avatar').lean(),
      Follow.find({ followerId: req.session.userId, followingId: { $in: pick } })
        .select('followingId').lean(),
    ]);

    const followingSet = new Set(myFollowing.map(f => f.followingId.toString()));

    const accounts = users.map(u => ({
      username:    u.username?.value,
      displayName: u.displayName?.value || null,
      avatar:      u.avatar?.value || null,
      isFollowing: followingSet.has(u._id.toString()),
    }));

    res.json({ accounts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ accounts: [] });
  }
});

// ── Entry comments ────────────────────────────────────────────────

router.post('/entries/:eid/comments', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.eid)) return res.status(400).json({ error: 'Invalid ID.' });

  const body = req.body.body?.trim();
  if (!body) return res.status(400).json({ error: 'Comment body is required.' });
  if (body.replace(/\s/g, '').length > 280) return res.status(400).json({ error: 'Comment cannot exceed 280 characters (spaces not counted).' });

  const parentId = req.body.parentId || null;
  if (parentId && !mongoose.isValidObjectId(parentId)) return res.status(400).json({ error: 'Invalid parentId.' });

  const entry = await Entry.findById(req.params.eid).select('userId commentsEnabled').lean().catch(() => null);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  if (!entry.commentsEnabled) return res.status(403).json({ error: 'Comments are disabled for this entry.' });

  let parentComment = null;
  if (parentId) {
    parentComment = await Comment.findById(parentId).select('entryId parentId userId').lean().catch(() => null);
    if (!parentComment || parentComment.entryId.toString() !== req.params.eid) {
      return res.status(400).json({ error: 'Invalid parent comment.' });
    }
    if (parentComment.parentId) return res.status(400).json({ error: 'Replies cannot be nested further.' });
  }

  try {
    const comment = await Comment.create({
      entryId:  req.params.eid,
      userId:   req.session.userId,
      parentId: parentId || null,
      body,
    });
    await Entry.updateOne({ _id: req.params.eid }, { $inc: { commentCount: 1 } });
    const user = await User.findById(req.session.userId).select('username displayName avatar').lean();

    const actorUsername = user.username?.value || 'Someone';
    const actorAvatar   = user.avatar?.value || null;
    const preview       = body.length > 80 ? body.slice(0, 80) + '…' : body;
    const entryUrl      = '/entry/' + req.params.eid;
    const myId          = req.session.userId.toString();
    const notifPromises = [];

    if (!parentId) {
      // Top-level comment — notify entry owner
      if (entry.userId.toString() !== myId) {
        notifPromises.push(Notification.create({
          userId:  entry.userId,
          type:    'comment',
          payload: { actorUsername, actorAvatar, preview, url: entryUrl },
        }));
      }
    } else {
      // Reply — notify parent comment author
      if (parentComment.userId.toString() !== myId) {
        notifPromises.push(Notification.create({
          userId:  parentComment.userId,
          type:    'reply',
          payload: { actorUsername, actorAvatar, preview, url: entryUrl },
        }));
      }
    }

    await Promise.allSettled(notifPromises);

    res.json({
      _id:       comment._id,
      entryId:   comment.entryId,
      parentId:  comment.parentId,
      body:      comment.body,
      createdAt: comment.createdAt,
      user: {
        username:    user.username?.value,
        displayName: user.displayName?.value || null,
        avatar:      user.avatar?.value || null,
      },
    });
  } catch (err) {
    console.error('Entry comment create error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.patch('/entries/:eid/comments/:cid', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.eid) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }
  const body = req.body.body?.trim();
  if (!body) return res.status(400).json({ error: 'Comment body is required.' });
  if (body.replace(/\s/g, '').length > 280) return res.status(400).json({ error: 'Comment cannot exceed 280 characters (spaces not counted).' });

  const comment = await Comment.findById(req.params.cid).catch(() => null);
  if (!comment || comment.entryId.toString() !== req.params.eid) return res.status(404).json({ error: 'Comment not found.' });
  if (comment.userId.toString() !== req.session.userId.toString()) return res.status(403).json({ error: 'Not your comment.' });

  comment.body     = body;
  comment.editedAt = new Date();
  await comment.save();
  res.json({ ok: true, body: comment.body, editedAt: comment.editedAt });
});

router.delete('/entries/:eid/comments/:cid', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.eid) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }
  const [comment, entry] = await Promise.all([
    Comment.findById(req.params.cid).select('entryId userId parentId').lean().catch(() => null),
    Entry.findById(req.params.eid).select('userId').lean().catch(() => null),
  ]);
  if (!comment || comment.entryId.toString() !== req.params.eid) return res.status(404).json({ error: 'Comment not found.' });
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });

  const isOwn        = comment.userId.toString() === req.session.userId.toString();
  const isEntryOwner = entry.userId.toString() === req.session.userId.toString();
  if (!isOwn && !isEntryOwner) return res.status(403).json({ error: 'Not authorized.' });

  let deletedCount = 1;
  if (!comment.parentId) {
    const replies = await Comment.find({ parentId: comment._id }).select('_id').lean();
    if (replies.length) {
      await CommentReport.deleteMany({ commentId: { $in: replies.map(r => r._id) } });
      await Comment.deleteMany({ parentId: comment._id });
      deletedCount += replies.length;
    }
    await CommentReport.deleteMany({ commentId: comment._id });
  } else {
    await CommentReport.deleteMany({ commentId: comment._id });
  }
  await Comment.deleteOne({ _id: comment._id });
  await Entry.updateOne({ _id: req.params.eid }, { $inc: { commentCount: -deletedCount } });
  res.json({ ok: true, deletedCount });
});

router.post('/entries/:eid/comments/:cid/hide', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.eid) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }
  const [comment, entry] = await Promise.all([
    Comment.findById(req.params.cid).catch(() => null),
    Entry.findById(req.params.eid).select('userId').lean().catch(() => null),
  ]);
  if (!comment || comment.entryId.toString() !== req.params.eid) return res.status(404).json({ error: 'Comment not found.' });
  if (!entry || entry.userId.toString() !== req.session.userId.toString()) return res.status(403).json({ error: 'Not your entry.' });

  comment.hidden = !comment.hidden;
  await comment.save();
  res.json({ ok: true, hidden: comment.hidden });
});

router.post('/entries/:eid/comments/:cid/report', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.eid) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }
  const comment = await Comment.findById(req.params.cid).select('userId entryId').lean().catch(() => null);
  if (!comment || comment.entryId.toString() !== req.params.eid) return res.status(404).json({ error: 'Comment not found.' });
  if (comment.userId.toString() === req.session.userId.toString()) return res.status(400).json({ error: "You can't report your own comment." });

  try {
    await CommentReport.create({ commentId: comment._id, reportedBy: req.session.userId });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "You've already reported this comment." });
    console.error('Comment report error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ── Announcement dismiss ──────────────────────────────────────────────────────
router.post('/announcements/:id/dismiss', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid ID' });

  try {
    await AnnouncementDismissal.create({ announcementId: id, userId: req.session.userId });
  } catch (err) {
    if (err.code !== 11000) {
      console.error('Dismiss error:', err);
      return res.status(500).json({ error: 'Something went wrong.' });
    }
    // Already dismissed — continue to find next
  }

  // Return next matching, non-dismissed announcement
  const now = new Date();
  const dismissed = await AnnouncementDismissal.distinct('announcementId', { userId: req.session.userId });
  const candidates = await Announcement.find({
    status: 'active',
    _id: { $nin: dismissed },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).sort({ publishedAt: -1 }).lean();

  // Basic filter pass — same logic as middleware (filters requiring missing User fields skipped)
  const next = candidates[0] || null;
  res.json({ next });
});

module.exports = router;
