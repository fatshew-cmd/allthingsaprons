const { computeSurgeMultiplier } = require('./surgeScorer');

const BLOCK_SIZE      = 8;
const MAX_PER_CREATOR = 2;

function entryStainAffinity(entry, stainScores) {
  const tags = entry.tags || [];
  if (!tags.length) return 0;
  const total = tags.reduce((sum, t) => sum + (stainScores.get(t) || 0), 0);
  return total / tags.length;
}

function stainCountBonus(entry) {
  return (entry.tags?.length || 0) / 6; // 6 = max stains per entry
}

function normalizeVelocity(count) {
  return Math.min(Math.log(1 + count) / Math.log(51), 1.0);
}

function recencyDecay(createdAt, now) {
  const hoursOld = (now - new Date(createdAt).getTime()) / (1000 * 60 * 60);
  return Math.exp(-hoursOld / 48);
}

function applyExplorePreFilters(candidates, currentUser) {
  const { showMatureContent = true, showAiContent = true } = currentUser.privacySettings || {};
  return candidates.filter(e => {
    if (!e.tags || e.tags.length === 0) return false;
    if (e.matureContent && !showMatureContent) return false;
    if (e.aiGenerated   && !showAiContent)     return false;
    return true;
  });
}

function scoreT2Entry(entry, context) {
  const {
    stainScores, creatorScores,
    ratingVelocityMap, commentVelocityMap,
    activity24hMap, ratedMap,
    inActiveContestSet, now,
  } = context;

  const eid     = entry._id.toString();
  const ownerId = (entry.userId._id ?? entry.userId).toString();

  const stainAffinity   = entryStainAffinity(entry, stainScores);
  const creatorAffinity = creatorScores.get(ownerId) || 0;
  const ratingVelocity  = normalizeVelocity(ratingVelocityMap[eid]  || 0);
  const commentVelocity = normalizeVelocity(commentVelocityMap[eid] || 0);
  const decay           = recencyDecay(entry.createdAt, now);
  const stainBonus      = stainCountBonus(entry);

  const baseScore = (entry.ratingAvg || 0) / 10 * 0.35
    + stainAffinity   * 0.25
    + ratingVelocity  * 0.20
    + creatorAffinity * 0.12
    + commentVelocity * 0.05
    + decay           * 0.03;

  const hoursAlive              = (now - new Date(entry.createdAt).getTime()) / (1000 * 60 * 60);
  const daysAlive               = Math.max(hoursAlive / 24, 1);
  const totalHistoricalActivity = (entry.ratingCount || 0) + (entry.commentCount || 0);
  const historicalDailyBaseline = totalHistoricalActivity / daysAlive;
  const surgeMultiplier         = computeSurgeMultiplier(activity24hMap[eid] || 0, historicalDailyBaseline);

  const unratedBoost   = ratedMap[eid] ? 0.8 : 1.5;
  const coldStartBoost = (entry.ratingCount || 0) < 3 ? 1.8 : 1.0;
  const contestBoost   = inActiveContestSet.has(eid) ? 1.2 : 1.0;

  return (baseScore + stainBonus) * surgeMultiplier * unratedBoost * coldStartBoost * contestBoost;
}

function scoreT1Entry(entry, context) {
  const { now } = context;
  return (entry.ratingAvg || 0) / 10 * 0.6 + recencyDecay(entry.createdAt, now) * 0.4;
}

function buildExploreEntryBlock(candidates, context, currentUser, count = BLOCK_SIZE) {
  const { followingSet, ratedMap, stainScores, creatorScores } = context;
  const now = Date.now();

  const filtered = applyExplorePreFilters(candidates, currentUser);
  const ctx      = { ...context, now };

  const isFollowed = e => followingSet.has((e.userId._id ?? e.userId).toString());

  const t2Scored = filtered
    .filter(e => !isFollowed(e))
    .map(e => ({ ...e, _score: scoreT2Entry(e, ctx) }))
    .sort((a, b) => b._score - a._score);

  const t1Scored = filtered
    .filter(e => isFollowed(e))
    .map(e => ({ ...e, _score: scoreT1Entry(e, ctx) }))
    .sort((a, b) => b._score - a._score);

  const block        = [];
  const creatorCount = {};

  const addEntry = (e) => {
    const ownerId = (e.userId._id ?? e.userId).toString();
    creatorCount[ownerId] = (creatorCount[ownerId] || 0) + 1;
    if (creatorCount[ownerId] > MAX_PER_CREATOR) return false;
    block.push({
      ...e,
      owner:       e.userId,
      userRating:  ratedMap[e._id.toString()] || null,
      isFollowing: followingSet.has(ownerId),
    });
    return true;
  };

  for (const e of t2Scored) {
    if (block.length >= count) break;
    addEntry(e);
  }
  for (const e of t1Scored) {
    if (block.length >= count) break;
    addEntry(e);
  }

  return block;
}

module.exports = { buildExploreEntryBlock, BLOCK_SIZE };
