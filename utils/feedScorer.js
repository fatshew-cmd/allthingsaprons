const LAMBDA = 0.1; // affinity decay rate — ~10 days half-life

function computeEffectiveAffinity(history) {
  const tagScores     = {};
  const creatorScores = {};
  const now           = Date.now();

  for (const snapshot of history) {
    const daysSince = (now - new Date(snapshot.timestamp).getTime()) / (1000 * 60 * 60 * 24);
    const decay     = Math.exp(-LAMBDA * daysSince);

    const tags     = snapshot.tagScores     instanceof Map ? snapshot.tagScores     : new Map(Object.entries(snapshot.tagScores     || {}));
    const creators = snapshot.creatorScores instanceof Map ? snapshot.creatorScores : new Map(Object.entries(snapshot.creatorScores || {}));

    for (const [tag, score] of tags)     tagScores[tag]     = (tagScores[tag]     || 0) + score * decay;
    for (const [cid, score] of creators) creatorScores[cid] = (creatorScores[cid] || 0) + score * decay;
  }

  return { tagScores, creatorScores };
}

function scoreEntry(entry, { followingSet, ratedMap, velocityMap, inActiveContestSet, affinity, now }) {
  const eid     = entry._id.toString();
  const ownerId = (entry.userId._id ?? entry.userId).toString();

  const hoursOld       = (now - new Date(entry.createdAt).getTime()) / (1000 * 60 * 60);
  const freshnessScore = 1 / Math.pow(hoursOld + 2, 1.5);
  const followBoost    = followingSet.has(ownerId) ? 2.0 : 1.0;
  const unratedBoost   = ratedMap[eid] ? 0.2 : 1.5;
  const coldStartBoost = (entry.ratingCount || 0) < 3 ? 1.8 : 1.0;
  const contestBoost   = inActiveContestSet.has(eid) ? 1.2 : 1.0;
  const velocityScore  = Math.log(1 + (velocityMap[eid] || 0)) * 0.5;

  const tagAffinityScore    = (entry.tags || []).reduce((s, t) => s + (affinity.tagScores[t] || 0), 0);
  const tagAffinityBoost    = Math.min(tagAffinityScore * 0.15, 0.6);
  const creatorAffinityBoost = Math.min((affinity.creatorScores[ownerId] || 0) * 0.2, 0.4);

  return freshnessScore
    * followBoost
    * unratedBoost
    * coldStartBoost
    * contestBoost
    * (1 + velocityScore)
    * (1 + tagAffinityBoost)
    * (1 + creatorAffinityBoost);
}

function buildFeedPage(candidates, context) {
  const { ratedMap } = context;
  const now = Date.now();

  const scored = candidates.map(e => ({
    ...e,
    owner:      e.userId,
    userRating: ratedMap[e._id.toString()] || null,
    _score:     scoreEntry(e, { ...context, now }),
  }));

  scored.sort((a, b) => b._score - a._score);

  const creatorCount = {};
  const page         = [];
  for (const e of scored) {
    const ownerId = (e.owner._id ?? e.owner).toString();
    creatorCount[ownerId] = (creatorCount[ownerId] || 0) + 1;
    if (creatorCount[ownerId] <= 2) page.push(e);
    if (page.length >= 20) break;
  }

  return page;
}

module.exports = { computeEffectiveAffinity, buildFeedPage };
