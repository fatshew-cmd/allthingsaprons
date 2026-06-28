const express             = require('express');
const router              = express.Router();
const Entry               = require('../models/Entry');
const Rating              = require('../models/Rating');
const Comment             = require('../models/Comment');
const Contest             = require('../models/Contest');
const Follow              = require('../models/Follow');
const User                = require('../models/User');
const UserAffinity        = require('../models/UserAffinity');
const TournamentEntry     = require('../models/TournamentEntry');
const ContestContribution = require('../models/ContestContribution');
const ContestVote         = require('../models/ContestVote');
const requireAuth         = require('../middleware/requireAuth');
const requireApproved     = require('../middleware/requireApproved');
const { buildExploreEntryBlock, BLOCK_SIZE } = require('../utils/exploreScorer');
const { getTrendingStains }                  = require('../utils/stainPopularity');

router.use(requireAuth);
router.use(requireApproved);

const CANDIDATE_POOL    = 150;
const BLOCKS_PER_LOAD   = 5;
const MIN_SECTION_USERS = 3;

async function buildScoringContext(currentUserId, candidates, follows, affinityDoc) {
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

  return {
    followingSet, ratedMap,
    ratingVelocityMap, commentVelocityMap,
    activity24hMap, inActiveContestSet,
    stainScores, creatorScores,
  };
}

async function getPeopleSubSections(currentUserId, followingSet) {
  const twoDaysAgo  = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const excludeSet  = new Set([currentUserId.toString(), ...followingSet]);
  const FETCH_LIMIT = 20;

  const [
    trendingAgg,
    topRatedAgg,
    activeContests,
    tournamentIds,
    topContributorsAgg,
    mostVotedAgg,
  ] = await Promise.all([
    Follow.aggregate([
      { $match: { createdAt: { $gte: twoDaysAgo } } },
      { $group: { _id: '$followingId', newFollowers: { $sum: 1 } } },
      { $sort: { newFollowers: -1 } },
      { $limit: FETCH_LIMIT },
    ]),
    Entry.aggregate([
      { $match: { hidden: false, ratingCount: { $gte: 3 } } },
      { $group: { _id: '$userId', avgRating: { $avg: '$ratingAvg' }, entryCount: { $sum: 1 } } },
      { $match: { entryCount: { $gte: 3 } } },
      { $sort: { avgRating: -1 } },
      { $limit: FETCH_LIMIT },
    ]),
    Contest.find({
      updatedAt: { $gte: twoDaysAgo },
      status: { $in: ['active', 'closed'] },
    }).select('entries').lean(),
    TournamentEntry.distinct('userId', {
      createdAt:      { $gte: twoDaysAgo },
      approvalStatus: 'approved',
    }),
    ContestContribution.aggregate([
      { $match: { createdAt: { $gte: twoDaysAgo }, status: { $in: ['active', 'locked'] } } },
      { $group: { _id: '$contributorId', totalCHL: { $sum: '$amountCHL' } } },
      { $sort: { totalCHL: -1 } },
      { $limit: FETCH_LIMIT },
    ]),
    ContestVote.aggregate([
      { $match: { createdAt: { $gte: twoDaysAgo } } },
      { $group: { _id: '$entryId', voteCount: { $sum: 1 } } },
      { $lookup: { from: 'entries', localField: '_id', foreignField: '_id', as: 'entry' } },
      { $unwind: '$entry' },
      { $group: { _id: '$entry.userId', totalVotes: { $sum: '$voteCount' } } },
      { $sort: { totalVotes: -1 } },
      { $limit: FETCH_LIMIT },
    ]),
  ]);

  const contestParticipantIds = [];
  for (const c of activeContests) {
    for (const e of c.entries || []) contestParticipantIds.push(e.userId.toString());
  }
  const uniqueContestIds = [...new Set(contestParticipantIds)];

  const rawSections = [
    { label: 'Trending Profiles',       userIds: trendingAgg.map(r => r._id.toString()),         key: 'trending' },
    { label: 'Top Rated',               userIds: topRatedAgg.map(r => r._id.toString()),          key: 'top_rated' },
    { label: 'Active in Contests',      userIds: uniqueContestIds,                                key: 'active_contests' },
    { label: 'Tournament Participants', userIds: tournamentIds.map(id => id.toString()),           key: 'tournaments' },
    { label: 'Top Contributors',        userIds: topContributorsAgg.map(r => r._id.toString()),   key: 'contributors' },
    { label: 'Most Voted',              userIds: mostVotedAgg.map(r => r._id.toString()),         key: 'most_voted' },
  ];

  const allUserIds = [...new Set(rawSections.flatMap(s => s.userIds))].filter(id => !excludeSet.has(id));
  if (!allUserIds.length) return [];

  const users = await User.find({ _id: { $in: allUserIds }, accountStatus: 'active' })
    .select('username displayName avatar')
    .lean();

  const userMap = {};
  for (const u of users) userMap[u._id.toString()] = u;

  const sections = [];
  for (const section of rawSections) {
    const sectionUsers = section.userIds
      .filter(id => !excludeSet.has(id) && userMap[id])
      .slice(0, FETCH_LIMIT)
      .map(id => userMap[id]);

    if (sectionUsers.length >= MIN_SECTION_USERS) {
      sections.push({ ...section, users: sectionUsers.slice(0, 3), allCount: sectionUsers.length });
    }
  }

  return sections;
}

// ── Initial page load ──────────────────────────────────────────────────────────
router.get('/explore', async (req, res) => {
  const currentUserId = req.session.userId;

  const [candidates, follows, affinityDoc] = await Promise.all([
    Entry.find({ userId: { $ne: currentUserId }, hidden: false })
      .sort({ createdAt: -1 })
      .limit(CANDIDATE_POOL)
      .populate('userId', 'username displayName avatar')
      .lean(),
    Follow.find({ followerId: currentUserId }).select('followingId').lean(),
    UserAffinity.findOne({ userId: currentUserId }).lean(),
  ]);

  const scoringContext = await buildScoringContext(currentUserId, candidates, follows, affinityDoc);

  const [trendingStains, peopleSections] = await Promise.all([
    getTrendingStains({ limit: 30 }),
    getPeopleSubSections(currentUserId, scoringContext.followingSet),
  ]);

  const servedIds   = new Set();
  const stainQueue  = [...trendingStains];
  const peopleQueue = [...peopleSections];
  const sections    = [];

  for (let i = 0; i < BLOCKS_PER_LOAD; i++) {
    const remaining = candidates.filter(e => !servedIds.has(e._id.toString()));
    const block     = buildExploreEntryBlock(remaining, scoringContext, req.currentUser, BLOCK_SIZE);

    if (block.length) {
      block.forEach(e => servedIds.add(e._id.toString()));
      sections.push({ type: 'entries', entries: block });
    }

    if (i % 2 === 0 && stainQueue.length) {
      sections.push({ type: 'stains', stains: stainQueue.splice(0, 10) });
    } else if (peopleQueue.length) {
      sections.push({ type: 'people', ...peopleQueue.shift() });
    } else if (stainQueue.length) {
      sections.push({ type: 'stains', stains: stainQueue.splice(0, 10) });
    }
  }

  res.render('explore', {
    title:       'Explore',
    activePage:  'explore',
    currentUser: req.currentUser,
    sections,
  });
});

// ── Infinite scroll — next block of entries ────────────────────────────────────
router.get('/api/explore/entries', async (req, res) => {
  const page          = Math.max(1, parseInt(req.query.page, 10) || 1);
  const currentUserId = req.session.userId;

  const [candidates, follows, affinityDoc] = await Promise.all([
    Entry.find({ userId: { $ne: currentUserId }, hidden: false })
      .sort({ createdAt: -1 })
      .skip(page * CANDIDATE_POOL)
      .limit(CANDIDATE_POOL)
      .populate('userId', 'username displayName avatar')
      .lean(),
    Follow.find({ followerId: currentUserId }).select('followingId').lean(),
    UserAffinity.findOne({ userId: currentUserId }).lean(),
  ]);

  if (!candidates.length) return res.json({ html: '', hasMore: false });

  const scoringContext = await buildScoringContext(currentUserId, candidates, follows, affinityDoc);
  const block          = buildExploreEntryBlock(candidates, scoringContext, req.currentUser, BLOCK_SIZE);

  if (!block.length) return res.json({ html: '', hasMore: false });

  res.render('partials/exploreEntryBlock', { entries: block, currentUser: req.currentUser }, (err, html) => {
    if (err) return res.json({ html: '', hasMore: false });
    res.json({ html, hasMore: block.length >= BLOCK_SIZE });
  });
});

module.exports = router;
