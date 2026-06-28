const { computeSurgeMultiplier } = require('./surgeScorer');

const LEARNING_RATE   = 0.3;
const PAGE_SIZE       = 30;
const MAX_PER_CREATOR = 2;

function entryStainAffinity(entry, stainScores) {
  const tags = entry.tags || [];
  if (!tags.length) return 0;
  const total = tags.reduce((sum, t) => sum + (stainScores.get(t) || 0), 0);
  return total / tags.length;
}

function normalizeVelocity(count) {
  return Math.min(Math.log(1 + count) / Math.log(51), 1.0);
}

function recencyDecay(createdAt, now) {
  const hoursOld = (now - new Date(createdAt).getTime()) / (1000 * 60 * 60);
  return Math.exp(-hoursOld / 48);
}

function applyPreFilters(candidates, currentUser) {
  const { showMatureContent = true, showAiContent = true } = currentUser.privacySettings || {};
  return candidates.filter(e => {
    if (e.matureContent && !showMatureContent) return false;
    if (e.aiGenerated   && !showAiContent)     return false;
    return true;
  });
}

function scoreT1Entry(entry, { ratingVelocityMap, now }) {
  const ratingVelocity = normalizeVelocity(ratingVelocityMap[entry._id.toString()] || 0);
  const decay          = recencyDecay(entry.createdAt, now);
  return decay + (entry.ratingAvg || 0) / 10 + ratingVelocity;
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

  const baseScore = (entry.ratingAvg || 0) / 10 * 0.35
    + stainAffinity   * 0.25
    + creatorAffinity * 0.20
    + ratingVelocity  * 0.12
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

  return baseScore * surgeMultiplier * unratedBoost * coldStartBoost * contestBoost;
}

function addToPage(e, page, creatorCount, ratedMap) {
  const ownerId = (e.userId._id ?? e.userId).toString();
  creatorCount[ownerId] = (creatorCount[ownerId] || 0) + 1;
  if (creatorCount[ownerId] > MAX_PER_CREATOR) return false;
  page.push({ ...e, owner: e.userId, userRating: ratedMap[e._id.toString()] || null });
  return true;
}

function buildColdStartPage(candidates, ratedMap, now) {
  const scored = candidates
    .map(e => ({
      ...e,
      owner:      e.userId,
      userRating: ratedMap[e._id.toString()] || null,
      _score:     (e.ratingAvg || 0) / 10 + recencyDecay(e.createdAt, now),
    }))
    .sort((a, b) => b._score - a._score);

  const page         = [];
  const creatorCount = {};
  for (const e of scored) {
    const ownerId = (e.userId._id ?? e.userId).toString();
    creatorCount[ownerId] = (creatorCount[ownerId] || 0) + 1;
    if (creatorCount[ownerId] <= MAX_PER_CREATOR) page.push(e);
    if (page.length >= PAGE_SIZE) break;
  }
  return page;
}

function buildFeedPage(candidates, context, currentUser) {
  const { followingSet, ratedMap, stainScores, creatorScores } = context;
  const now = Date.now();

  const filtered = applyPreFilters(candidates, currentUser);

  if (!followingSet.size && (!stainScores || !stainScores.size)) {
    return buildColdStartPage(filtered, ratedMap, now);
  }

  const isFollowed = e => followingSet.has((e.userId._id ?? e.userId).toString());

  // T1 selector — stain affinity acts as a filter, not a ranking signal.
  // If the user has stain affinity, only entries matching those stains are admitted.
  // If none match (or user has no affinity yet), fall back to all followed-creator entries.
  const t1Pool         = filtered.filter(e => isFollowed(e));
  const t1WithAffinity = t1Pool.filter(e => entryStainAffinity(e, stainScores) > 0);
  const t1Candidates   = t1WithAffinity.length > 0 ? t1WithAffinity : t1Pool;

  const t1Scored = t1Candidates
    .map(e => ({ ...e, _score: scoreT1Entry(e, { ...context, now }) }))
    .sort((a, b) => b._score - a._score);

  const t2Scored = filtered
    .filter(e => !isFollowed(e))
    .map(e => ({ ...e, _score: scoreT2Entry(e, { ...context, now }) }))
    .sort((a, b) => b._score - a._score);

  const page         = [];
  const creatorCount = {};

  for (const e of t1Scored) {
    if (page.length >= PAGE_SIZE) break;
    addToPage(e, page, creatorCount, ratedMap);
  }
  for (const e of t2Scored) {
    if (page.length >= PAGE_SIZE) break;
    addToPage(e, page, creatorCount, ratedMap);
  }

  return page;
}

module.exports = { buildFeedPage, LEARNING_RATE };
