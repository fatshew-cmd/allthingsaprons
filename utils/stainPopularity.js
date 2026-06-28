const mongoose = require('mongoose');
const Entry   = require('../models/Entry');
const Rating  = require('../models/Rating');
const Comment = require('../models/Comment');

async function getTrendingStains({ limit = 15 } = {}) {
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

  const [recentRatings, recentComments] = await Promise.all([
    Rating.aggregate([
      { $match: { createdAt: { $gte: twoDaysAgo } } },
      { $group: { _id: '$entryId', count: { $sum: 1 } } },
    ]),
    Comment.aggregate([
      { $match: { createdAt: { $gte: twoDaysAgo } } },
      { $group: { _id: '$entryId', count: { $sum: 1 } } },
    ]),
  ]);

  const activityMap = {};
  for (const r of recentRatings)  activityMap[r._id.toString()] = (activityMap[r._id.toString()] || 0) + r.count;
  for (const c of recentComments) activityMap[c._id.toString()] = (activityMap[c._id.toString()] || 0) + c.count;

  const activeEntryIds = Object.keys(activityMap).map(id => new mongoose.Types.ObjectId(id));
  if (!activeEntryIds.length) return [];

  const entries = await Entry.find({
    _id:    { $in: activeEntryIds },
    tags:   { $exists: true, $not: { $size: 0 } },
    hidden: false,
  }).select('tags ratingAvg').lean();

  const stainScores = {};
  for (const entry of entries) {
    const activity      = activityMap[entry._id.toString()] || 0;
    const qualityWeight = Math.max((entry.ratingAvg || 0) / 10, 0.1);
    const contribution  = activity * qualityWeight;
    for (const tag of entry.tags) {
      stainScores[tag] = (stainScores[tag] || 0) + contribution;
    }
  }

  return Object.entries(stainScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag, score]) => ({ tag, score }));
}

module.exports = { getTrendingStains };
