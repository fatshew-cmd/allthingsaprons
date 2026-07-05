const Entry = require('../models/Entry');

// Curator-level rating reputation: weighted average across all of a user's entries,
// plus total ratings received. Weighted (not a plain mean of per-entry averages) so an
// entry with 100 ratings counts for more than one with 2.
async function getUserRatingStats(userId) {
  const entries = await Entry.find({ userId }).select('ratingCount ratingAvg').lean();
  const rated = entries.filter(e => e.ratingCount > 0);
  const totalRatingCount = rated.reduce((s, e) => s + e.ratingCount, 0);
  const weightedAvg = totalRatingCount
    ? rated.reduce((s, e) => s + e.ratingAvg * e.ratingCount, 0) / totalRatingCount
    : 0;
  return { weightedAvg, totalRatingCount, ratedEntryCount: rated.length };
}

module.exports = { getUserRatingStats };
