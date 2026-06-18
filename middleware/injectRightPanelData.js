const mongoose = require('mongoose');
const Announcement = require('../models/Announcement');
const AnnouncementDismissal = require('../models/AnnouncementDismissal');
const Follow = require('../models/Follow');
const User = require('../models/User');

function announcementMatchesUser(ann, user) {
  const f = ann.filters;
  if (!f) return true;
  if (f.sex && user?.sex !== f.sex) return false;
  if (f.orientation && user?.orientation !== f.orientation) return false;
  if (f.ageMin && user?.birthdate) {
    const ageDays = (Date.now() - new Date(user.birthdate).getTime()) / 86400000;
    if (ageDays / 365.25 < f.ageMin) return false;
  }
  // Remaining filters (follower count, aprons, contest/tournament history) require
  // denormalized fields not yet on User — skipped until those fields land.
  return true;
}

module.exports = async function injectRightPanelData(req, res, next) {
  res.locals.panelAnnouncement = null;
  res.locals.panelSuggestedUsers = [];

  if (!req.session?.userId) return next();

  const currentUserId = new mongoose.Types.ObjectId(req.session.userId);

  try {
    // ── Announcement ─────────────────────────────────────────────────────────
    const now = new Date();
    const dismissed = await AnnouncementDismissal.distinct('announcementId', { userId: currentUserId });
    const candidates = await Announcement.find({
      status: 'active',
      _id: { $nin: dismissed },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    }).sort({ publishedAt: -1 }).lean();

    const user = req.currentUser;
    for (const ann of candidates) {
      if (announcementMatchesUser(ann, user)) {
        res.locals.panelAnnouncement = ann;
        break;
      }
    }
  } catch { /* non-fatal */ }

  try {
    // ── People to Follow ──────────────────────────────────────────────────────
    const alreadyFollowing = await Follow.distinct('followingId', { followerId: currentUserId });
    const excludedIds = [...alreadyFollowing, currentUserId];

    // Rank by follower count via aggregation
    let suggestions = await Follow.aggregate([
      { $group: { _id: '$followingId', followerCount: { $sum: 1 } } },
      { $match: { _id: { $nin: excludedIds } } },
      { $sort: { followerCount: -1 } },
      { $limit: 3 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      {
        $project: {
          _id: 1,
          followerCount: 1,
          'user.username': 1,
          'user.displayName': 1,
          'user.avatar': 1,
        },
      },
    ]);

    // Fall back to recently created users if aggregation yields nothing
    if (suggestions.length === 0) {
      const fallback = await User.find({
        _id: { $nin: excludedIds },
        role: 'user',
        accountStatus: { $ne: 'banned' },
      })
        .select('username displayName avatar')
        .sort({ createdAt: -1 })
        .limit(3)
        .lean();

      suggestions = fallback.map(u => ({ _id: u._id, followerCount: 0, user: u }));
    }

    res.locals.panelSuggestedUsers = suggestions.map(s => ({
      _id:          s._id,
      username:     s.user.username?.value || '',
      displayName:  s.user.displayName?.value || s.user.username?.value || '',
      avatar:       s.user.avatar?.value || null,
      followerCount: s.followerCount,
    }));
  } catch { /* non-fatal */ }

  next();
};
