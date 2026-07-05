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
const Notification          = require('../models/Notification');
const TournamentEntry       = require('../models/TournamentEntry');
const Tournament            = require('../models/Tournament');
const Follow                = require('../models/Follow');
const ContestWatch          = require('../models/ContestWatch');
const UserAffinity          = require('../models/UserAffinity');
const WalletTransaction     = require('../models/WalletTransaction');
const ContestPayout         = require('../models/ContestPayout');
const MonthlySnapshot       = require('../models/MonthlySnapshot');
const ContestContribution   = require('../models/ContestContribution');
const EntryBookmark         = require('../models/EntryBookmark');
const UserBlock             = require('../models/UserBlock');
const ProfileShareView      = require('../models/ProfileShareView');
const { buildFeedPage }                        = require('../utils/feedScorer');
const { updateAffinity, updateCreatorAffinity } = require('../utils/affinityUpdater');
const { submitEntryToTournament, checkTournamentPreflight, attemptTournamentAutoDraft } = require('../utils/tournamentSubmission');
const requireAuth   = require('../middleware/requireAuth');
const requireApproved = require('../middleware/requireApproved');
const upload        = require('../middleware/upload');

router.get('/guidelines', (req, res) => {
  res.render('guidelines', { title: 'Community Guidelines' });
});

router.get('/s/:id', async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.redirect('/');
  await Entry.findByIdAndUpdate(req.params.id, { $inc: { shareCount: 1 } }).catch(() => {});
  res.redirect('/entry/' + req.params.id);
});

router.use(requireAuth);
router.use(requireApproved);

router.get('/', (req, res) => res.redirect('/feed'));

const FEED_CANDIDATE_POOL = 150;

async function buildFeedScoringContext(currentUserId, candidates, follows, affinityDoc) {
  const ids         = candidates.map(e => e._id);
  const sixHoursAgo = new Date(Date.now() - 6  * 60 * 60 * 1000);
  const oneDayAgo   = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const followingSet = new Set(follows.map(f => f.followingId.toString()));

  const [myRatings, ratingVelocityAgg, commentVelocityAgg, activity24hAgg, activeContests] = await Promise.all([
    Rating.find({ userId: currentUserId, entryId: { $in: ids } }).select('entryId score').lean(),
    Rating.aggregate([
      { $match: { entryId: { $in: ids }, createdAt: { $gte: sixHoursAgo } } },
      { $group: { _id: '$entryId', count: { $sum: 1 } } },
    ]),
    Comment.aggregate([
      { $match: { entryId: { $in: ids }, createdAt: { $gte: sixHoursAgo } } },
      { $group: { _id: '$entryId', count: { $sum: 1 } } },
    ]),
    Promise.all([
      Rating.aggregate([
        { $match: { entryId: { $in: ids }, createdAt: { $gte: oneDayAgo } } },
        { $group: { _id: '$entryId', count: { $sum: 1 } } },
      ]),
      Comment.aggregate([
        { $match: { entryId: { $in: ids }, createdAt: { $gte: oneDayAgo } } },
        { $group: { _id: '$entryId', count: { $sum: 1 } } },
      ]),
    ]),
    Contest.find({ 'entries.entryId': { $in: ids }, status: 'active' }).select('entries').lean(),
  ]);

  const ratedMap = {};
  for (const r of myRatings) ratedMap[r.entryId.toString()] = r.score;

  const ratingVelocityMap = {};
  for (const v of ratingVelocityAgg) ratingVelocityMap[v._id.toString()] = v.count;

  const commentVelocityMap = {};
  for (const v of commentVelocityAgg) commentVelocityMap[v._id.toString()] = v.count;

  const activity24hMap = {};
  const [ratings24h, comments24h] = activity24hAgg;
  for (const v of ratings24h)  activity24hMap[v._id.toString()] = (activity24hMap[v._id.toString()] || 0) + v.count;
  for (const v of comments24h) activity24hMap[v._id.toString()] = (activity24hMap[v._id.toString()] || 0) + v.count;

  const inActiveContestSet = new Set();
  for (const c of activeContests) {
    for (const e of c.entries) inActiveContestSet.add(e.entryId.toString());
  }

  const stainScores   = affinityDoc?.stainScores   instanceof Map ? affinityDoc.stainScores   : new Map(Object.entries(affinityDoc?.stainScores   || {}));
  const creatorScores = affinityDoc?.creatorScores instanceof Map ? affinityDoc.creatorScores : new Map(Object.entries(affinityDoc?.creatorScores || {}));

  return { followingSet, ratedMap, ratingVelocityMap, commentVelocityMap, activity24hMap, inActiveContestSet, stainScores, creatorScores };
}

async function buildFeedAnnotations(feedEntries, currentUserId) {
  const feedIds = feedEntries.map(e => e._id);
  if (!feedIds.length) return { nomineesMap: {}, contestInfoMap: {}, bookmarkedIds: new Set() };

  const feedContests = await Contest.find({ 'entries.entryId': { $in: feedIds } })
    .select('entries status votingDeadline winnerEntryId voidReason').lean();

  const feedContestIds = feedContests.map(c => c._id);
  const feedNominations = feedContestIds.length
    ? await Nomination.find({ contestId: { $in: feedContestIds } })
        .populate('nomineeId', 'username avatar')
        .populate('nominatorId', 'username avatar')
        .lean()
    : [];

  const feedIdSet = new Set(feedIds.map(id => id.toString()));

  const nominationsByContest = {};
  for (const n of feedNominations) {
    const cid = n.contestId.toString();
    if (!nominationsByContest[cid]) nominationsByContest[cid] = [];
    nominationsByContest[cid].push(n);
  }

  const contestInfoMap = {};
  const nomineesMap = {};
  for (const c of feedContests) {
    const cid   = c._id.toString();
    const effSt = (c.status === 'active' && c.votingDeadline && c.votingDeadline < new Date())
      ? 'closed' : c.status;
    const nominations = nominationsByContest[cid] || [];

    for (const ce of c.entries) {
      const eid = ce.entryId?.toString();
      if (!eid || !feedIdSet.has(eid)) continue;

      if (!contestInfoMap[eid]) {
        contestInfoMap[eid] = { contestId: cid, status: effSt };
      }

      for (const n of nominations) {
        const isNominator = n.nominatorId?._id?.toString() === ce.userId?.toString();
        const opponent    = isNominator ? n.nomineeId : n.nominatorId;
        if (!opponent?.username?.value) continue;
        if (!nomineesMap[eid]) nomineesMap[eid] = [];
        nomineesMap[eid].push({
          contestId:        cid,
          username:         opponent.username?.value,
          avatar:           opponent.avatar?.value || null,
          status:           effSt === 'void' ? 'void' : n.status,
          contestStatus:    effSt,
          voteCountMine:    0,
          voteCountNominee: 0,
          contribution:     0,
          isWinner:         !!(c.winnerEntryId && c.winnerEntryId.toString() === eid),
          voidReason:       n.voidReason || null,
        });
      }
    }
  }

  const chipRankFeed = s => s === 'active' ? 0 : s === 'pending' ? 1 : s === 'closed' ? 2 : 3;
  for (const eid of Object.keys(nomineesMap)) {
    nomineesMap[eid].sort((a, b) => chipRankFeed(a.contestStatus) - chipRankFeed(b.contestStatus));
  }

  const feedBookmarks = await EntryBookmark.find({ userId: currentUserId, entryId: { $in: feedIds } }).select('entryId').lean();
  const bookmarkedIds = new Set(feedBookmarks.map(b => b.entryId.toString()));

  return { nomineesMap, contestInfoMap, bookmarkedIds };
}

router.get('/feed', async (req, res) => {
  const currentUserId = req.session.userId;

  const [blockDocs, follows, affinityDoc] = await Promise.all([
    UserBlock.find({ blockerId: currentUserId }).select('blockedId').lean(),
    Follow.find({ followerId: currentUserId }).select('followingId').lean(),
    UserAffinity.findOne({ userId: currentUserId }).lean(),
  ]);

  const blockedIds = blockDocs.map(b => b.blockedId);

  const candidates = await Entry.find({ userId: { $ne: currentUserId, $nin: blockedIds } })
    .sort({ createdAt: -1 })
    .limit(FEED_CANDIDATE_POOL)
    .populate('userId', 'username displayName avatar')
    .lean();

  if (!candidates.length) {
    return res.render('feed', {
      title: 'Feed', activePage: 'feed', currentUser: req.currentUser, feedEntries: [],
    });
  }

  const scoringContext = await buildFeedScoringContext(currentUserId, candidates, follows, affinityDoc);
  const feedEntries    = buildFeedPage(candidates, scoringContext, req.currentUser);
  const { nomineesMap, contestInfoMap, bookmarkedIds } = await buildFeedAnnotations(feedEntries, currentUserId);

  res.render('feed', {
    title:      'Feed',
    activePage: 'feed',
    currentUser: req.currentUser,
    feedEntries,
    nomineesMap,
    contestInfoMap,
    bookmarkedIds,
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
    initialQuery:    req.query.q || '',
    initialCategory: ['people', 'entries', 'contests', 'tags'].includes(req.query.category) ? req.query.category : '',
    initialFilter:   req.query.filter || '',
  });
});

router.get('/contests', async (req, res) => {
  const currentUserId = req.currentUser._id;
  const now = new Date();

  const [rawNominations, rawContests, watchDocs] = await Promise.all([
    Nomination.find({ nomineeId: currentUserId, status: 'pending' })
      .populate('nominatorId', 'username displayName')
      .populate({
        path: 'contestId',
        populate: { path: 'entries.entryId', select: 'mediaType mediaUrl', model: 'Entry' },
      })
      .sort({ expiresAt: 1 })
      .lean(),

    Contest.find({
      tournamentId: null,
      $or: [
        { visibility: 'public' },
        { 'entries.userId': currentUserId },
      ],
      status: 'active',
      votingDeadline: { $gt: now },
    })
      .populate('entries.entryId', 'title mediaType mediaUrl')
      .populate('entries.userId', 'username displayName avatar')
      .sort({ createdAt: -1 })
      .lean(),

    ContestWatch.find({ userId: currentUserId }).select('contestId').lean(),
  ]);

  const watchedContestIds = watchDocs.map(w => w.contestId);

  const rawWatched = watchedContestIds.length
    ? await Contest.find({ _id: { $in: watchedContestIds } })
        .populate('entries.entryId', 'title mediaType mediaUrl')
        .populate('entries.userId', 'username displayName avatar')
        .sort({ lastActivityAt: -1 })
        .lean()
    : [];

  // Build follow set across all contestant IDs from both sections
  const allContestantIds = [];
  for (const c of [...rawContests, ...rawWatched]) {
    for (const e of (c.entries || [])) {
      if (e.userId?._id) allContestantIds.push(e.userId._id);
    }
  }
  const followDocs = allContestantIds.length
    ? await Follow.find({ followerId: currentUserId, followingId: { $in: allContestantIds } }).select('followingId').lean()
    : [];
  const followingSet = new Set(followDocs.map(f => f.followingId.toString()));

  const panelPendingNominations = rawNominations
    .filter(nom => nom.expiresAt > now)
    .map(nom => {
      const firstEntry = nom.contestId?.entries?.[0];
      return {
        _id:      nom._id,
        entry:    firstEntry?.entryId || null,
        nominator: {
          displayName: nom.nominatorId?.displayName?.value || nom.nominatorId?.username?.value || 'Unknown',
          username:    nom.nominatorId?.username?.value || '',
        },
        message:   nom.message,
        expiresAt: nom.expiresAt,
      };
    });

  function buildContestShape(c, statusOverride) {
    const title       = c.entries?.[0]?.entryId?.title || c.entries?.[1]?.entryId?.title || 'H2H Contest';
    const covers      = (c.entries || []).slice(0, 2).map(e => ({
      mediaUrl:  e.entryId?.mediaUrl  || '',
      mediaType: e.entryId?.mediaType || 'photo',
    }));
    const contestants = (c.entries || []).map(e => {
      const uid = e.userId?._id?.toString();
      return {
        userId:      uid || '',
        username:    e.userId?.username?.value || '',
        avatar:      e.userId?.avatar?.value || '',
        displayName: e.userId?.displayName?.value || ('@' + (e.userId?.username?.value || '')),
        isFollowing: uid ? followingSet.has(uid) : false,
        isSelf:      uid === currentUserId.toString(),
      };
    });
    return {
      _id:            c._id,
      status:         statusOverride || (c.status === 'pending' ? 'upcoming' : c.status),
      covers,
      title,
      contestants,
      votingDeadline: c.votingDeadline || null,
      visibility:     c.visibility,
    };
  }

  const contests        = rawContests.map(c => buildContestShape(c, c.status === 'pending' ? 'upcoming' : 'active'));
  const watchedContests = rawWatched.map(c => buildContestShape(c));

  res.render('contests', {
    title:      'Contests',
    activePage: 'contests',
    currentUser: req.currentUser,
    panelPendingNominations,
    contests,
    watchedContests,
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
  const [followDoc, activeContest, rawEntryContests, myRating, takeOnNomContestIds, entryBookmarkDoc] = await Promise.all([
    (!isOwn && req.session.userId)
      ? Follow.findOne({ followerId: req.session.userId, followingId: ownerId }).lean()
      : Promise.resolve(null),
    Contest.findOne({ 'entries.entryId': entry._id, status: { $in: ['pending', 'active'] } })
      .select('_id status voidDeadline votingDeadline').lean().catch(() => null),
    Contest.find({ 'entries.entryId': entry._id }).select('_id status entries voidDeadline votingDeadline winnerEntryId voidReason').lean(),
    (!isOwn && req.session.userId)
      ? Rating.findOne({ entryId: entry._id, userId: req.session.userId }).select('score').lean()
      : Promise.resolve(null),
    // Take-on contests where this entry is the nominee but not yet in contest.entries
    Nomination.find({ nomineeEntryId: entry._id, type: 'take_on' }).select('contestId').lean().catch(() => []),
    req.session.userId
      ? EntryBookmark.findOne({ entryId: entry._id, userId: req.session.userId }).select('_id').lean()
      : Promise.resolve(null),
  ]);

  const existingContestIds = new Set(rawEntryContests.map(c => c._id.toString()));
  const missingContestIds  = takeOnNomContestIds
    .map(n => n.contestId).filter(id => id && !existingContestIds.has(id.toString()));
  const extraContests = missingContestIds.length
    ? await Contest.find({ _id: { $in: missingContestIds } })
        .select('_id status entries voidDeadline votingDeadline winnerEntryId voidReason').lean().catch(() => [])
    : [];
  const entryContests = [...rawEntryContests, ...extraContests];

  // Resolve activeContest blind spot: pending take-ons where entry is the nominee
  const resolvedActiveContest = activeContest
    || (missingContestIds.length ? (extraContests.find(c => c.status === 'pending' || c.status === 'active') || null) : null);

  const nominations = entryContests.length
    ? await Nomination.find({
        contestId: { $in: entryContests.map(c => c._id) },
        status:    { $in: ['pending', 'accepted', 'void'] },
      })
      .populate('nomineeId', 'username displayName avatar')
      .populate('nominatorId', 'username displayName avatar')
      .sort({ createdAt: -1 })
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
  const seenContests = new Set();
  for (const n of nominations) {
    const cid = n.contestId.toString();
    if (seenContests.has(cid)) continue;
    seenContests.add(cid);
    const contest = entryContestById[cid];
    const voidRsn = contest?.voidReason || null;
    if (voidRsn === 'canceled') continue;
    const isNominator = n.nominatorId?._id?.toString() === ownerId.toString();
    const opponent    = isNominator ? n.nomineeId : n.nominatorId;
    const uname       = opponent?.username?.value;
    if (!uname) continue;
    const cvotes  = entryVoteMap[cid] || {};
    const oppEid  = contest?.entries?.find(e => e.entryId?.toString() !== myEid)?.entryId?.toString();
    const rawStatus = contest?.status || null;
    const effContestStatus = (rawStatus === 'active' && contest?.votingDeadline && contest.votingDeadline < new Date())
      ? 'closed' : rawStatus;
    nominees.push({
      contestId:        cid,
      username:         uname,
      displayName:      opponent.displayName?.value || uname,
      avatar:           opponent.avatar?.value || null,
      status:           effContestStatus === 'void' ? 'void' : n.status,
      voidReason:       voidRsn,
      contestStatus:    effContestStatus,
      voteCountMine:    cvotes[myEid]  || 0,
      voteCountNominee: oppEid ? (cvotes[oppEid] || 0) : 0,
      contribution:     0,
      isWinner:         !!(contest?.winnerEntryId && contest.winnerEntryId.toString() === myEid),
    });
  }

  const chipRank = s => s === 'active' ? 0 : s === 'pending' ? 1 : s === 'closed' ? 2 : 3;
  nominees.sort((a, b) => chipRank(a.contestStatus) - chipRank(b.contestStatus));

  const topLevelComments = await Comment.find({ entryId: entry._id, parentId: null, hidden: false })
    .populate('userId', 'username displayName avatar')
    .sort({ createdAt: -1 })
    .lean();

  const ratingDocs = await Rating.find({ entryId: entry._id }).sort({ createdAt: -1 }).lean();
  const raterIds = ratingDocs.map(r => r.userId);
  const raterUsers = await User.find({ _id: { $in: raterIds } }).select('username displayName avatar').lean();
  const raterMap = Object.fromEntries(raterUsers.map(u => [u._id.toString(), u]));
  const raterFollowSet = new Set();
  if (req.session.userId && raterIds.length) {
    const myFollows = await Follow.find({ followerId: req.session.userId, followingId: { $in: raterIds } }).select('followingId').lean();
    myFollows.forEach(f => raterFollowSet.add(f.followingId.toString()));
  }
  const entryRatings = ratingDocs.map(r => ({
    ...r,
    userId: raterMap[r.userId.toString()] || null,
    isFollowing: raterFollowSet.has(r.userId.toString()),
  }));

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

  const _now = Date.now();
  const _scoreComment = c => {
    const ownNet     = (c.likes?.length || 0) - (c.dislikes?.length || 0);
    const hoursOld   = (_now - new Date(c.createdAt).getTime()) / 3600000;
    const recency    = 1 / Math.pow(hoursOld + 2, 1.5);
    const replyBoost = (c.replies || []).reduce((sum, r) => {
      const rNet   = (r.likes?.length || 0) - (r.dislikes?.length || 0);
      const rHours = (_now - new Date(r.createdAt).getTime()) / 3600000;
      return sum + rNet * (1 / Math.pow(rHours + 2, 1.5));
    }, 0);
    return ownNet + replyBoost * 0.25 + recency;
  };
  comments.sort((a, b) => _scoreComment(b) - _scoreComment(a));
  const _pinned   = comments.filter(c => c.pinnedAt).sort((a, b) => new Date(a.pinnedAt) - new Date(b.pinnedAt));
  const _unpinned = comments.filter(c => !c.pinnedAt);
  comments.splice(0, comments.length, ..._pinned, ..._unpinned);

  res.render('entry', {
    title:       entry.title || entry.caption?.slice(0, 60) || 'Entry',
    activePage:  '',
    currentUser: req.currentUser,
    entry,
    isFollowing:    !!followDoc,
    isBookmarked:   !!entryBookmarkDoc,
    currentUserId:  req.session.userId || null,
    userRating:     myRating?.score || null,
    contestInfo: (() => {
      if (!resolvedActiveContest) return null;
      const effSt = (resolvedActiveContest.status === 'active' && resolvedActiveContest.votingDeadline && resolvedActiveContest.votingDeadline < new Date())
        ? 'closed' : resolvedActiveContest.status;
      if (effSt === 'void' || effSt === 'closed') return null;
      return { contestId: resolvedActiveContest._id.toString(), status: effSt };
    })(),
    nominees,
    comments,
    ratings: entryRatings,
  });

  // Fire-and-forget visit signal — only for other users' entries
  if (!isOwn && req.session.userId) {
    updateAffinity(req.session.userId, entry, { signal: 0.1 }).catch(() => {});
  }
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
  const userId = req.session.userId;
  const user = await User.findById(userId).select(
    'username displayName bio avatar banner location url sex birthdate email nominationSettings privacySettings notificationSettings wallet'
  );

  const currentMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  const today        = new Date().getDate();

  const [monthlySnapshot, recentTransactions, totalTransactions, txMonthsRaw] = await Promise.all([
    MonthlySnapshot.findOne({ userId, month: currentMonth }).lean(),
    WalletTransaction.find({ userId }).sort({ createdAt: -1 }).limit(12).lean(),
    WalletTransaction.countDocuments({ userId }),
    WalletTransaction.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } } } },
      { $sort: { _id: -1 } },
    ]),
  ]);

  const successParam = req.query.success || req.query.saved || null;
  const successMsg = successParam === 'topup' ? 'Your chillies have been added to your wallet.'
                   : successParam             ? 'Settings saved.'
                   : null;

  const errorMsg = null;

  res.render('settings', {
    title:      'Settings',
    activePage: 'settings',
    currentUser: req.currentUser,
    user,
    nominationSettings: user?.nominationSettings || { allow: true, whoCanNominate: 'everyone' },
    privacySettings: user?.privacySettings || { whoCanDm: 'everyone', whoCanComment: 'everyone', showMatureContent: true, showAiContent: true, defaultAllowTakeOns: true, bookmarksPrivate: false },
    notifSettings: user?.notificationSettings || { inAppComments: true, inAppNominations: true, inAppContests: true, inAppPayouts: true, emailComments: true, emailNominations: true, emailContests: true, emailPayouts: true },
    wallet: {
      purchasedCHL:     user?.wallet?.purchasedCHL || 0,
      earnedCHL:        user?.wallet?.earnedCHL    || 0,
      monthlySnapshot,
      recentTransactions,
      totalTransactions,
      transactionMonths: txMonthsRaw.map(r => r._id),
      showHoldBtn:      today >= 25 && today <= 29 && monthlySnapshot?.status === 'pending',
    },
    activeTab: req.query.tab || 'profile',
    success: successMsg,
    error:   errorMsg,
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

// ── Take On ───────────────────────────────────────────────────────

router.get('/take-on/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser });
  }
  const nom = await Nomination.findById(req.params.id).select('contestId type').lean().catch(() => null);
  if (!nom || nom.type !== 'take_on' || !nom.contestId) {
    return res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser });
  }
  return res.redirect('/contest/' + nom.contestId);
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
      if (nom.type === 'viewer_nomination') {
        const [sibling, preSelectedEntry] = await Promise.all([
          Nomination.findOne({ contestId: nom.contestId, _id: { $ne: nom._id } })
            .populate('nomineeId', 'username displayName avatar')
            .lean(),
          nom.preSelectedEntryId
            ? Entry.findById(nom.preSelectedEntryId).select('mediaUrl mediaType caption title').lean()
            : Promise.resolve(null),
        ]);
        acceptingNomination = {
          _id:                nom._id,
          nominator:          nom.nominatorId,
          opponent:           sibling?.nomineeId || null,
          entry:              null,
          expiresAt:          nom.expiresAt,
          message:            nom.message || null,
          contestId:          nom.contestId,
          isViewerNomination: true,
          preSelectedEntry:   preSelectedEntry || null,
          isLocked:           !!preSelectedEntry,
        };
      } else {
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
  }

  let challengeEntry = null;
  if (req.query.challenge && mongoose.isValidObjectId(req.query.challenge)) {
    challengeEntry = await Entry.findById(req.query.challenge)
      .populate('userId', 'username displayName avatar')
      .select('mediaUrl mediaType title caption tags userId')
      .lean()
      .catch(() => null);
  }

  let takeOnContest = null;
  if (req.query.takeOn && mongoose.isValidObjectId(req.query.takeOn)) {
    const toc = await Contest.findById(req.query.takeOn)
      .populate('entries.entryId', 'mediaUrl mediaType title caption tags')
      .lean()
      .catch(() => null);
    const tocNom = toc ? await Nomination.findOne({
      contestId:   toc._id,
      nominatorId: req.session.userId,
      type:        'take_on',
      status:      'accepted',
    }).populate('nomineeId', 'username displayName avatar').lean().catch(() => null) : null;
    if (toc && tocNom && toc.status === 'pending') {
      const opponentEntry = toc.entries?.[0]?.entryId || null;
      takeOnContest = {
        contestId:     toc._id,
        opponent:      tocNom.nomineeId,
        opponentEntry,
        voidDeadline:  toc.voidDeadline,
      };
    }
  }

  let takeOnTargetEntry = null;
  if (req.query.takeOnTargetId && mongoose.isValidObjectId(req.query.takeOnTargetId)) {
    const tote = await Entry.findById(req.query.takeOnTargetId)
      .populate('userId', 'username displayName avatar')
      .select('mediaUrl mediaType title caption userId allowTakeOns')
      .lean()
      .catch(() => null);
    if (tote && tote.allowTakeOns !== false && tote.userId._id.toString() !== req.session.userId) {
      takeOnTargetEntry = tote;
    }
  }

  let targetTournament = null;
  if (req.query.tournamentId && mongoose.isValidObjectId(req.query.tournamentId)) {
    const tournament = await Tournament.findById(req.query.tournamentId).lean();
    if (tournament) {
      const preflight = await checkTournamentPreflight(tournament, userId);
      targetTournament = { tournament, eligible: preflight.eligible, reason: preflight.reason || null };
    }
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
    takeOnContest,
    takeOnTargetEntry,
    targetTournament,
  });
});

router.post('/submit', upload.entry.fields([{ name: 'entryMedia', maxCount: 1 }]), async (req, res) => {
  if (!req.currentUser.idVerified) return res.redirect('/verify-identity?reason=entry');
  const renderError = (msg) => res.render('submit', {
    title: 'Submit Entry', activePage: 'submit', currentUser: req.currentUser, error: msg,
    pendingNominations: [], userEntries: [], acceptingNomination: null, challengeEntry: null, takeOnContest: null,
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

  const takeOnContestId = req.body.takeOnContestId?.trim() || null;

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

    // Tournament candidacy is always resolved at upload time — either an explicit tournament
    // the uploader targeted, or an automatic stain-match draft into any other open tournament.
    const tournamentId = req.body.tournamentId?.trim() || null;
    const uploader = await User.findById(req.session.userId).select('idVerified username displayName avatar').lean();
    if (tournamentId && mongoose.isValidObjectId(tournamentId)) {
      const targetTournament = await Tournament.findById(tournamentId).lean();
      if (targetTournament) {
        await submitEntryToTournament({ tournament: targetTournament, entry, actor: uploader, autoSubmitted: false });
      }
    }
    attemptTournamentAutoDraft(entry, uploader).catch(() => {});

    const takeOnTargetId = req.body.takeOnTargetId?.trim() || null;
    if (takeOnTargetId && mongoose.isValidObjectId(takeOnTargetId)) {
      const targetEntry = await Entry.findById(takeOnTargetId).select('userId allowTakeOns').lean().catch(() => null);
      const actor = await User.findById(req.session.userId).select('username displayName avatar').lean();
      if (targetEntry && targetEntry.allowTakeOns && targetEntry.userId.toString() !== req.session.userId) {
        const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const contest = await Contest.create({
          createdBy:    req.session.userId,
          visibility:   'public',
          status:       'pending',
          voidDeadline: expiry,
          windowHours:  72,
          entries:      [{ entryId: entry._id, userId: req.session.userId, submittedAt: new Date() }],
        });
        const nomination = await Nomination.create({
          contestId:         contest._id,
          nominatorId:       req.session.userId,
          nomineeId:         targetEntry.userId,
          expiresAt:         expiry,
          status:            'pending',
          type:              'take_on',
          challengerEntryId: entry._id,
          nomineeEntryId:    targetEntry._id,
        });
        Notification.create({
          userId:  targetEntry.userId,
          type:    'take_on_received',
          payload: {
            actorUsername:    actor?.username?.value    || 'Someone',
            actorDisplayName: actor?.displayName?.value || actor?.username?.value || 'Someone',
            actorAvatar:      actor?.avatar?.value      || null,
            contestId:        contest._id,
            nominationId:     nomination._id,
            entryId:          targetEntry._id,
            url:              '/contest/' + contest._id,
          },
        }).catch(() => {});
        return res.redirect(`/contest/${contest._id}`);
      }
    }

    res.redirect(`/entry/${entry._id}`);
  } catch (err) {
    console.error('Entry submit error:', err);
    renderError('Something went wrong. Please try again.');
  }
});

// ── Profile settings update ───────────────────────────────────────

router.post('/settings/profile', upload.profile.fields([{ name: 'avatar', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), async (req, res) => {
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

// ── Privacy settings update ───────────────────────────────────────

router.post('/settings/privacy', async (req, res) => {
  const allow          = req.body.nominationAllow === 'true';
  const validWho       = ['everyone', 'followers_only', 'followees_only', 'mutual_follow'];
  const whoCanNominate = validWho.includes(req.body.whoCanNominate) ? req.body.whoCanNominate : 'everyone';

  const validDmScope = ['everyone', 'followers_only', 'mutual_follow'];
  const whoCanDm = validDmScope.includes(req.body.whoCanDm) ? req.body.whoCanDm : 'everyone';

  const validCommentScope = ['everyone', 'followers_only', 'contributors_only'];
  const whoCanComment = validCommentScope.includes(req.body.whoCanComment) ? req.body.whoCanComment : 'everyone';

  await User.findByIdAndUpdate(req.session.userId, {
    $set: {
      'nominationSettings.allow':            allow,
      'nominationSettings.whoCanNominate':   whoCanNominate,
      'privacySettings.whoCanDm':            whoCanDm,
      'privacySettings.whoCanComment':       whoCanComment,
      'privacySettings.showMatureContent':   req.body.showMatureContent   === 'true',
      'privacySettings.showAiContent':       req.body.showAiContent       === 'true',
      'privacySettings.defaultAllowTakeOns': req.body.defaultAllowTakeOns === 'true',
      'privacySettings.bookmarksPrivate':    req.body.bookmarksPrivate    === 'true',
    },
  });
  res.redirect('/settings?tab=privacy&saved=privacy');
});

// ── Notification settings update ──────────────────────────────────

router.post('/settings/notifications', async (req, res) => {
  await User.findByIdAndUpdate(req.session.userId, {
    $set: {
      'notificationSettings.inAppComments':    req.body.inAppComments    === 'true',
      'notificationSettings.inAppNominations': req.body.inAppNominations === 'true',
      'notificationSettings.inAppContests':    req.body.inAppContests    === 'true',
      'notificationSettings.inAppPayouts':     req.body.inAppPayouts     === 'true',
      'notificationSettings.emailComments':    req.body.emailComments    === 'true',
      'notificationSettings.emailNominations': req.body.emailNominations === 'true',
      'notificationSettings.emailContests':    req.body.emailContests    === 'true',
      'notificationSettings.emailPayouts':     req.body.emailPayouts     === 'true',
    },
  });
  res.redirect('/settings?tab=notifications&saved=1');
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

  const effectiveStatus = (contest.status === 'active' && contest.votingDeadline && contest.votingDeadline < new Date())
    ? 'closed'
    : contest.status;

  const canVote = effectiveStatus === 'active' && !myVote;
  const isNominator = !!(myId && contest.createdBy?._id?.toString() === myId);
  const isNominee   = !!(myId && resCE && resCE.userId.toString() === myId);

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
      votePct:   totalVotes > 0 ? Math.round(((voteCounts[eid] || 0) / totalVotes) * 100) : 0,
      isWinner:  !!(contest.winnerEntryId && eid && contest.winnerEntryId.toString() === eid),
      isMine:    uid === myId,
      iVotedFor: !!(myVote && eid && myVote.entryId.toString() === eid),
    };
  }

  const left  = buildSide(nomCE);
  const right = resCE ? buildSide(resCE) : null;

  let nomineeUser = null;
  let nomineeEntry = null;
  let pendingTakeOnNomId = null;
  if (!right && contest.status === 'pending') {
    const nom = await Nomination.findOne({ contestId: contest._id, status: 'pending' })
      .select('nomineeId nominatorId type _id nomineeEntryId').lean().catch(() => null);
    if (nom) {
      nomineeUser = await User.findById(nom.nomineeId).select('username displayName avatar').lean().catch(() => null);
      if (nom.type === 'take_on' && myId && nom.nomineeId.toString() === myId) {
        pendingTakeOnNomId = nom._id.toString();
      }
      if (nom.type === 'take_on' && nom.nomineeEntryId) {
        nomineeEntry = await Entry.findById(nom.nomineeEntryId)
          .select('mediaUrl mediaType title caption tags aiGenerated').lean().catch(() => null);
      }
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

  const isWatching = req.session.userId
    ? !!(await ContestWatch.exists({ contestId: contest._id, userId: req.session.userId }))
    : false;

  const voidLabelMap = { expired: 'No Response', declined: 'Denied', canceled: 'Canceled', nominee_forfeit: 'Forfeited', nominator_forfeit: 'Forfeit Win' };
  const statusLabel = effectiveStatus === 'void'
    ? (voidLabelMap[contest.voidReason] || 'No Response')
    : ({ pending: 'Pending', active: 'Live', closed: 'Contest has ended' }[effectiveStatus] || effectiveStatus);

  const topLevelComments = await ContestComment.find({ contestId: contest._id, parentId: null, hidden: false })
    .populate('userId', 'username displayName avatar')
    .sort({ createdAt: -1 })
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

  const _nowCC = Date.now();
  const _scoreCC = c => {
    const ownNet     = (c.likes?.length || 0) - (c.dislikes?.length || 0);
    const hoursOld   = (_nowCC - new Date(c.createdAt).getTime()) / 3600000;
    const recency    = 1 / Math.pow(hoursOld + 2, 1.5);
    const replyBoost = (c.replies || []).reduce((sum, r) => {
      const rNet   = (r.likes?.length || 0) - (r.dislikes?.length || 0);
      const rHours = (_nowCC - new Date(r.createdAt).getTime()) / 3600000;
      return sum + rNet * (1 / Math.pow(rHours + 2, 1.5));
    }, 0);
    return ownNet + replyBoost * 0.25 + recency;
  };
  comments.sort((a, b) => _scoreCC(b) - _scoreCC(a));

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
      .select('_id status entries createdAt votingDeadline')
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

  // Contribution data
  const contestEntryIds = contest.entries.map(e => e.entryId?._id || e.entryId).filter(Boolean);
  const [contributionAgg, myContributions, viewerUser, allContributions] = await Promise.all([
    ContestContribution.aggregate([
      { $match: { contestId: contest._id, status: { $ne: 'withdrawn' } } },
      { $group: { _id: '$entryId', totalCHL: { $sum: '$amountCHL' } } },
    ]),
    req.session.userId
      ? ContestContribution.find({ contestId: contest._id, contributorId: req.session.userId, status: { $ne: 'withdrawn' } })
          .select('entryId amountCHL status').lean().catch(() => [])
      : Promise.resolve([]),
    req.session.userId
      ? User.findById(req.session.userId).select('wallet').lean().catch(() => null)
      : Promise.resolve(null),
    ContestContribution.find({ contestId: contest._id, status: { $ne: 'withdrawn' } })
      .select('entryId contributorId amountCHL')
      .populate('contributorId', 'username displayName avatar')
      .lean().catch(() => []),
  ]);

  const grossByEntry = {};
  for (const r of contributionAgg) { grossByEntry[r._id.toString()] = r.totalCHL; }

  const myContribMap = {};
  for (const c of myContributions) { myContribMap[c.entryId.toString()] = c; }

  const topContributionEntryId = contestEntryIds.length
    ? contestEntryIds.reduce((best, eid) => {
        const id = eid.toString();
        return (grossByEntry[id] || 0) > (grossByEntry[best?.toString()] || 0) ? eid : best;
      }, null)
    : null;

  const leftEntryId  = left?.entryId  ? left.entryId.toString()  : null;
  const rightEntryId = right?.entryId ? right.entryId.toString() : null;
  const sortByAmount = (a, b) => b.amountCHL - a.amountCHL;
  const contribRankLeft  = leftEntryId
    ? allContributions.filter(c => c.entryId.toString() === leftEntryId).sort(sortByAmount)
    : [];
  const contribRankRight = rightEntryId
    ? allContributions.filter(c => c.entryId.toString() === rightEntryId).sort(sortByAmount)
    : [];

  res.render('contest', {
    title:      'H2H Contest',
    activePage: '',
    currentUser: req.currentUser,
    contest,
    left,
    right,
    nomineeUser,
    nomineeEntry,
    followingIds,
    myVote,
    canVote,
    isNominator,
    isNominee,
    isWatching,
    pendingTakeOnNomId,
    totalVotes,
    showVotes:   !!(myVote || effectiveStatus === 'closed'),
    effectiveStatus,
    statusLabel,
    topContributionEntryId,
    grossByEntry,
    myContribMap,
    contribRankLeft,
    contribRankRight,
    viewerBalanceCHL: (viewerUser?.wallet?.purchasedCHL || 0) + (viewerUser?.wallet?.earnedCHL || 0),
    canContribute:    effectiveStatus === 'active',
    comments,
    relatedContests,
    relatedUserMap,
  });
});

// ── Public profile — must be last to avoid swallowing other routes ─

router.get('/:username', async (req, res) => {
  const user = await User.findOne({ 'username.value': req.params.username.toLowerCase() })
    .select('username displayName bio avatar banner location sex birthdate url createdAt nominationSettings privacySettings wallet pinnedEntryId');

  if (!user) return res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser });

  const isOwn   = user._id.toString() === req.session.userId;
  const entries = await Entry.find({ userId: user._id }).sort({ createdAt: -1 });

  const pinnedEntryId = user.pinnedEntryId?.toString() || null;
  if (pinnedEntryId) {
    const idx = entries.findIndex(e => e._id.toString() === pinnedEntryId);
    if (idx > 0) entries.unshift(entries.splice(idx, 1)[0]);
  }

  const entryIds = entries.map(e => e._id);

  const showBookmarksTab = isOwn || !(user.privacySettings?.bookmarksPrivate);

  const [followerCount, followingCount, nominationsAccepted, userContests, userTournamentEntries, followDoc, blockDoc, viewerBookmarkDocs, profileBookmarkDocs] = await Promise.all([
    Follow.countDocuments({ followingId: user._id }),
    Follow.countDocuments({ followerId: user._id }),
    Nomination.countDocuments({ nomineeId: user._id, status: 'accepted' }),
    Contest.find({ 'entries.userId': user._id }).sort({ createdAt: -1 }).select('_id status voidReason entries votingDeadline winnerEntryId createdAt').populate('entries.entryId', 'mediaUrl caption').populate('entries.userId', 'username displayName avatar').lean(),
    TournamentEntry.find({ userId: user._id }).sort({ submittedAt: -1 }).populate('tournamentId', 'name status prizes').populate('entryId', 'mediaUrl caption').lean(),
    (!isOwn && req.session.userId) ? Follow.findOne({ followerId: req.session.userId, followingId: user._id }).lean() : Promise.resolve(null),
    (!isOwn && req.session.userId) ? UserBlock.findOne({ blockerId: req.session.userId, blockedId: user._id }).lean() : Promise.resolve(null),
    (entryIds.length && req.session.userId) ? EntryBookmark.find({ userId: req.session.userId, entryId: { $in: entryIds } }).select('entryId').lean() : Promise.resolve([]),
    showBookmarksTab ? EntryBookmark.find({ userId: user._id }).sort({ createdAt: -1 }).populate('entryId', 'mediaUrl mediaType ratingAvg ratingCount').lean() : Promise.resolve([]),
  ]);

  let firstPrizes = 0, secondPrizes = 0, thirdPrizes = 0;
  for (const te of userTournamentEntries) {
    if (!te.tournamentId || te.tournamentId.status !== 'closed') continue;
    if (!te.eliminated && te.knockoutRound === 'Final') firstPrizes++;
    else if (te.eliminated && te.knockoutRound === 'Final') secondPrizes++;
    else if (!te.eliminated && te.knockoutRound === '3rd') thirdPrizes++;
  }

  const isFollowing = !!followDoc;
  const isBlocked   = !!blockDoc;
  const viewerBookmarkedIdSet = new Set(viewerBookmarkDocs.map(b => b.entryId.toString()));
  const bookmarkedEntries = profileBookmarkDocs.filter(b => b.entryId).map(b => b.entryId);

  const contestStatusPriority = { active: 0, pending: 1, closed: 2, void: 3 };
  userContests.sort((a, b) => {
    const pa = contestStatusPriority[a.status] ?? 3;
    const pb = contestStatusPriority[b.status] ?? 3;
    return pa !== pb ? pa - pb : new Date(b.createdAt) - new Date(a.createdAt);
  });

  // Build a follow-status set for H2H opponent users
  let h2hFollowedIdSet = new Set();
  if (req.session.userId) {
    const oppIds = [];
    for (const c of userContests) {
      const opp = c.entries.find(e => {
        const uid = e.userId?._id ? e.userId._id.toString() : e.userId?.toString();
        return uid !== user._id.toString();
      });
      const oppId = opp?.userId?._id ?? opp?.userId;
      if (oppId) oppIds.push(oppId);
    }
    if (oppIds.length) {
      const h2hFollowDocs = await Follow.find({ followerId: req.session.userId, followingId: { $in: oppIds } }).select('followingId').lean();
      h2hFollowedIdSet = new Set(h2hFollowDocs.map(f => f.followingId.toString()));
    }
  }

  const contestMap = {};
  for (const c of userContests) {
    const effSt = (c.status === 'active' && c.votingDeadline && c.votingDeadline < new Date())
      ? 'closed' : c.status;
    if (effSt === 'void') continue;
    for (const ce of c.entries) {
      const eid = ce.entryId?._id?.toString();
      if (eid && !contestMap[eid]) {
        contestMap[eid] = { contestId: c._id.toString(), status: effSt };
      }
    }
  }

  const contestToEntryId = {};
  for (const c of userContests) {
    for (const ce of c.entries) {
      const eid = ce.entryId?._id?.toString();
      const uid = ce.userId?._id?.toString() ?? ce.userId?.toString();
      if (eid && uid === user._id.toString()) contestToEntryId[c._id.toString()] = eid;
    }
  }
  const profileNominations = userContests.length
    ? await Nomination.find({
        contestId:   { $in: userContests.map(c => c._id) },
        nominatorId: user._id,
        status:      { $in: ['pending', 'accepted', 'void'] },
      }).populate('nomineeId', 'username displayName avatar').lean()
    : [];

  profileNominations.sort((a, b) => {
    const rank = s => s === 'accepted' ? 0 : s === 'pending' ? 1 : 2;
    return rank(a.status) - rank(b.status);
  });

  // Nominations where this user is the NOMINEE and submitted an entry — shows nominator's info
  const receivedNominations = await Nomination.find({
    nomineeId:      user._id,
    status:         { $in: ['accepted', 'void'] },
    nomineeEntryId: { $ne: null },
  }).populate('nominatorId', 'username displayName avatar').lean().catch(() => []);

  const profileContestById = {};
  for (const c of userContests) profileContestById[c._id.toString()] = c;

  const profileLiveCIds = userContests
    .filter(c => c.status === 'active' || c.status === 'closed')
    .map(c => c._id);
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

  const profileContribAggs = profileLiveCIds.length
    ? await ContestContribution.aggregate([
        { $match: { contestId: { $in: profileLiveCIds }, status: { $ne: 'withdrawn' } } },
        { $group: { _id: { contestId: '$contestId', entryId: '$entryId' }, total: { $sum: '$amountCHL' } } },
      ])
    : [];
  const profileContribMap = {};
  for (const a of profileContribAggs) {
    const cid = a._id.contestId.toString();
    if (!profileContribMap[cid]) profileContribMap[cid] = {};
    profileContribMap[cid][a._id.entryId.toString()] = a.total;
  }

  const nomineesMap = {};
  const seenContestsPerEntry = {};
  for (const n of profileNominations) {
    const eid = contestToEntryId[n.contestId.toString()];
    if (!eid) continue;
    const uname = n.nomineeId?.username?.value;
    if (!uname) continue;
    const cid = n.contestId.toString();
    if (!seenContestsPerEntry[eid]) seenContestsPerEntry[eid] = new Set();
    if (seenContestsPerEntry[eid].has(cid)) continue;
    seenContestsPerEntry[eid].add(cid);
    if (!nomineesMap[eid]) nomineesMap[eid] = [];
    const pContest = profileContestById[cid];
    const rawSt    = pContest?.status || null;
    const effSt    = (rawSt === 'active' && pContest?.votingDeadline && pContest.votingDeadline < new Date())
      ? 'closed' : rawSt;
    const cvotes   = profileVoteMap[cid] || {};
    const oppEid   = pContest?.entries?.find(e => e.entryId?._id?.toString() !== eid)?.entryId?._id?.toString();
    nomineesMap[eid].push({
      contestId:         cid,
      username:          uname,
      avatar:            n.nomineeId.avatar?.value || null,
      status:            effSt === 'void' ? 'void' : n.status,
      contestStatus:     effSt,
      voteCountMine:     cvotes[eid]    || 0,
      voteCountNominee:  oppEid ? (cvotes[oppEid] || 0) : 0,
      contribution:      0,
      isWinner:          !!(pContest?.winnerEntryId && pContest.winnerEntryId.toString() === eid),
    });
  }

  // Entries where user was the nominee — show the nominator's badge
  for (const n of receivedNominations) {
    const eid   = n.nomineeEntryId?.toString();
    const uname = n.nominatorId?.username?.value;
    if (!eid || !uname) continue;
    const cid = n.contestId.toString();
    if (!seenContestsPerEntry[eid]) seenContestsPerEntry[eid] = new Set();
    if (seenContestsPerEntry[eid].has(cid)) continue;
    seenContestsPerEntry[eid].add(cid);
    if (!nomineesMap[eid]) nomineesMap[eid] = [];
    const pContest = profileContestById[cid];
    const rawSt    = pContest?.status || null;
    const effSt    = (rawSt === 'active' && pContest?.votingDeadline && pContest.votingDeadline < new Date())
      ? 'closed' : rawSt;
    const cvotes   = profileVoteMap[cid] || {};
    const oppEid   = pContest?.entries?.find(e => e.entryId?._id?.toString() !== eid)?.entryId?._id?.toString();
    nomineesMap[eid].push({
      contestId:        cid,
      username:         uname,
      avatar:           n.nominatorId?.avatar?.value || null,
      status:           effSt === 'void' ? 'void' : n.status,
      contestStatus:    effSt,
      voteCountMine:    cvotes[eid]   || 0,
      voteCountNominee: oppEid ? (cvotes[oppEid] || 0) : 0,
      contribution:     0,
      isWinner:         !!(pContest?.winnerEntryId && pContest.winnerEntryId.toString() === eid),
    });
  }

  const chipRankProfile = s => s === 'active' ? 0 : s === 'pending' ? 1 : s === 'closed' ? 2 : 3;
  for (const eid of Object.keys(nomineesMap)) {
    nomineesMap[eid].sort((a, b) => chipRankProfile(a.contestStatus) - chipRankProfile(b.contestStatus));
  }

  const ratedEntries = entries.filter(e => e.ratingCount > 0);
  const overallRank = ratedEntries.length
    ? (ratedEntries.reduce((s, e) => s + e.ratingAvg, 0) / ratedEntries.length).toFixed(1)
    : null;
  const totalRatingCount = ratedEntries.reduce((s, e) => s + e.ratingCount, 0);

  const title = user.displayName?.value
    ? `${user.displayName.value} - @${user.username.value} on AllThingsAprons.com`
    : `@${user.username.value} on AllThingsAprons.com`;

  let canNominate = false;
  if (!isOwn && req.session.userId && !isBlocked) {
    const ns  = user.nominationSettings;
    const who = ns?.whoCanNominate || 'everyone';
    if (ns?.allow !== false) {
      if (who === 'everyone') {
        canNominate = true;
      } else if (who === 'followers_only') {
        canNominate = isFollowing;
      } else if (who === 'followees_only') {
        const rev = await Follow.exists({ followerId: user._id, followingId: req.session.userId });
        canNominate = !!rev;
      } else if (who === 'mutual_follow') {
        const rev = await Follow.exists({ followerId: user._id, followingId: req.session.userId });
        canNominate = isFollowing && !!rev;
      }
    }
  }

  if (!isOwn && req.session.userId && req.query.ref === 'share') {
    ProfileShareView.create({
      viewerId:      req.session.userId,
      profileUserId: user._id,
      referer:       req.headers.referer || req.headers.referrer || '',
      userAgent:     req.headers['user-agent'] || '',
    }).catch(() => {});
  }

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
    totalRatingCount,
    isOwn,
    isFollowing,
    isBlocked,
    canNominate,
    userContests,
    h2hFollowedIdSet: [...h2hFollowedIdSet],
    profileVoteMap,
    profileContribMap,
    userTournamentEntries,
    contestMap,
    nomineesMap,
    pinnedEntryId,
    showBookmarksTab,
    bookmarkedEntries,
    viewerBookmarkedIdSet,
    editError: typeof req.query.editError === 'string' ? req.query.editError : null,
  });

  // Fire-and-forget creator affinity signal — viewing someone else's profile
  if (!isOwn && req.session.userId) {
    updateCreatorAffinity(req.session.userId, user._id, 0.05).catch(() => {});
  }
});

router.get('/api/feed/entries', async (req, res) => {
  const page          = Math.max(1, parseInt(req.query.page, 10) || 1);
  const currentUserId = req.session.userId;

  const [blockDocs, follows, affinityDoc] = await Promise.all([
    UserBlock.find({ blockerId: currentUserId }).select('blockedId').lean(),
    Follow.find({ followerId: currentUserId }).select('followingId').lean(),
    UserAffinity.findOne({ userId: currentUserId }).lean(),
  ]);

  const blockedIds = blockDocs.map(b => b.blockedId);

  const candidates = await Entry.find({ userId: { $ne: currentUserId, $nin: blockedIds } })
    .sort({ createdAt: -1 })
    .skip(page * FEED_CANDIDATE_POOL)
    .limit(FEED_CANDIDATE_POOL)
    .populate('userId', 'username displayName avatar')
    .lean();

  if (!candidates.length) return res.json({ html: '', hasMore: false });

  const scoringContext = await buildFeedScoringContext(currentUserId, candidates, follows, affinityDoc);
  const feedEntries    = buildFeedPage(candidates, scoringContext, req.currentUser);

  if (!feedEntries.length) return res.json({ html: '', hasMore: false });

  const { nomineesMap, contestInfoMap, bookmarkedIds } = await buildFeedAnnotations(feedEntries, currentUserId);

  res.render('partials/feedEntryBlock', {
    entries: feedEntries,
    nomineesMap,
    contestInfoMap,
    bookmarkedIds,
    currentUser: req.currentUser,
  }, (err, html) => {
    if (err) return res.json({ html: '', hasMore: false });
    res.json({ html, hasMore: candidates.length >= FEED_CANDIDATE_POOL });
  });
});

module.exports = router;
