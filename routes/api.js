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
const upload     = require('../middleware/upload');

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

router.post('/entries', upload.fields([{ name: 'entryMedia', maxCount: 1 }]), async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const actor = await User.findById(req.session.userId).select('idVerified').lean();
  if (!actor || !actor.idVerified) return res.status(403).json({ error: 'identity_required' });

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

  let pendingNom  = null;
  let nominees    = [];

  if (nominationId) {
    if (!mongoose.isValidObjectId(nominationId)) return res.status(400).json({ error: 'Invalid nomination.' });
    pendingNom = await Nomination.findById(nominationId).lean();
    if (!pendingNom)                                                       return res.status(404).json({ error: 'Nomination not found.' });
    if (pendingNom.nomineeId.toString() !== req.session.userId.toString()) return res.status(403).json({ error: 'This nomination is not for you.' });
    if (pendingNom.status !== 'pending')                                   return res.status(409).json({ error: 'This nomination has already been resolved.' });
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
    });

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
        }),
      ]);
      contestId = pendingNom.contestId;
    }

    if (nominees.length) {
      const hideEntry   = req.body.challengeHideEntry === 'true';
      const visibility  = ['public', 'private'].includes(req.body.challengeVisibility) ? req.body.challengeVisibility : 'public';
      const rawWin      = parseInt(req.body.challengeWindowHours, 10);
      const windowHours = [24, 48, 72, 168].includes(rawWin) ? rawWin : 72;
      const expiry      = new Date(Date.now() + 24 * 60 * 60 * 1000);
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
        }).then(() => c._id))
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
  if (!entry)                                                                return res.status(404).json({ error: 'Entry not found.' });
  if (entry.userId.toString() !== req.session.userId.toString())            return res.status(403).json({ error: 'Not your entry.' });
  const nomContest = await Contest.findById(nom.contestId).select('windowHours').lean();
  const winHours   = nomContest?.windowHours || 72;
  await Promise.all([
    Nomination.findByIdAndUpdate(req.params.id, { status: 'accepted', nomineeEntryId: entryId }),
    Contest.findByIdAndUpdate(nom.contestId, {
      $push:          { entries: { entryId, userId: req.session.userId, submittedAt: new Date() } },
      status:         'active',
      votingDeadline: new Date(Date.now() + winHours * 60 * 60 * 1000),
    }),
  ]);
  res.json({ ok: true, contestId: nom.contestId });
});

router.post('/nominations/:id/decline', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });
  const nom = await Nomination.findById(req.params.id).lean();
  if (!nom)                                                         return res.status(404).json({ error: 'Nomination not found.' });
  if (nom.nomineeId.toString() !== req.session.userId.toString())  return res.status(403).json({ error: 'Not your nomination.' });
  if (nom.status !== 'pending')                                     return res.status(409).json({ error: 'Nomination already resolved.' });
  await Nomination.findByIdAndUpdate(req.params.id, { status: 'void' });
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
  await Nomination.create({
    contestId:   contest._id,
    nominatorId: req.session.userId,
    nomineeId:   nominee._id,
    expiresAt:   expiry,
    status:      'pending',
  });
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

  // TEMP: participant check disabled for testing — re-enable before launch
  // const isParticipant =
  //   contest.createdBy.toString() === req.session.userId.toString() ||
  //   contest.entries.some(e => e.userId.toString() === req.session.userId.toString());
  // if (isParticipant) return res.status(403).json({ error: "Contest participants can't vote." });

  try {
    await ContestVote.create({ contestId: contest._id, entryId, userId: req.session.userId });
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
    Contest.findByIdAndUpdate(req.params.id, { $set: { status: 'void' } }),
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

module.exports = router;
