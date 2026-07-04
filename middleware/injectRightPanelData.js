const mongoose = require('mongoose');
const Announcement = require('../models/Announcement');
const AnnouncementDismissal = require('../models/AnnouncementDismissal');
const Follow = require('../models/Follow');
const User = require('../models/User');
const Nomination = require('../models/Nomination');
const Entry = require('../models/Entry');
const Tournament = require('../models/Tournament');

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
  res.locals.panelAnnouncements = [];
  res.locals.panelSuggestedUsers = [];
  res.locals.panelPendingNominations = [];
  res.locals.activeTournaments = [];

  if (!req.session?.userId) return next();

  const currentUserId = new mongoose.Types.ObjectId(req.session.userId);
  const now = new Date();

  try {
    // ── Pending Nominations ───────────────────────────────────────────────────
    const nominations = await Nomination.find({
      nomineeId: currentUserId,
      status: 'pending',
      expiresAt: { $gt: now },
    })
      .populate('nominatorId', 'username displayName avatar')
      .populate('contestId', 'entries')
      .sort({ createdAt: -1 })
      .lean();

    // Collect nominator entry IDs so we can fetch media in one query
    const nominatorEntryMeta = nominations.map(n => {
      const match = n.contestId?.entries?.find(
        e => e.userId.toString() === n.nominatorId?._id?.toString()
      );
      return { nomId: n._id, entryId: match?.entryId || null, hidden: match?.hidden || false };
    });

    const entryIds = nominatorEntryMeta.map(m => m.entryId).filter(Boolean);
    const entries  = entryIds.length
      ? await Entry.find({ _id: { $in: entryIds } }).select('mediaUrl mediaType').lean()
      : [];
    const entryMap = Object.fromEntries(entries.map(e => [e._id.toString(), e]));

    res.locals.panelPendingNominations = nominations.map((n, i) => {
      const meta  = nominatorEntryMeta[i];
      const media = !meta.hidden && meta.entryId ? entryMap[meta.entryId.toString()] : null;
      return {
        _id:       n._id,
        message:   n.message || null,
        expiresAt: n.expiresAt,
        nominator: {
          username:    n.nominatorId?.username?.value    || '',
          displayName: n.nominatorId?.displayName?.value || n.nominatorId?.username?.value || '',
        },
        entry: media ? { mediaUrl: media.mediaUrl, mediaType: media.mediaType } : null,
      };
    });
  } catch { /* non-fatal */ }

  try {
    // ── Announcement ─────────────────────────────────────────────────────────
    const dismissed = await AnnouncementDismissal.distinct('announcementId', { userId: currentUserId });
    const candidates = await Announcement.find({
      status: 'active',
      _id: { $nin: dismissed },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    }).sort({ publishedAt: -1 }).lean();

    const user = req.currentUser;
    res.locals.panelAnnouncements = candidates.filter(ann => announcementMatchesUser(ann, user));
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

  try {
    // ── Ongoing Tournaments ───────────────────────────────────────────────────
    res.locals.activeTournaments = await Tournament.find({ status: 'active' })
      .sort({ activeAt: -1 })
      .limit(5)
      .select('name prizes status activeAt thumbnailUrl')
      .lean();
  } catch { /* non-fatal */ }

  next();
};
