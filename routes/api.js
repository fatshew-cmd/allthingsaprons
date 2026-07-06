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
const Comment       = require('../models/Comment');
const CommentReport = require('../models/CommentReport');
const Notification  = require('../models/Notification');
const Announcement  = require('../models/Announcement');
const AnnouncementDismissal   = require('../models/AnnouncementDismissal');
const AnnouncementImpression  = require('../models/AnnouncementImpression');
const AnnouncementClick       = require('../models/AnnouncementClick');
const upload                  = require('../middleware/upload');
const checkContestEligibility = require('../utils/contestEligibility');
const ContestLoop              = require('../models/ContestLoop');
const ContestContribution     = require('../models/ContestContribution');
const WalletTransaction       = require('../models/WalletTransaction');
const notifyLoopedIn           = require('../utils/notifyLoopedIn');
const EntryReport             = require('../models/EntryReport');
const EntryBookmark           = require('../models/EntryBookmark');
const PlatformSettings        = require('../models/PlatformSettings');
const UserBlock               = require('../models/UserBlock');
const UserReport              = require('../models/UserReport');
const ProfileShare            = require('../models/ProfileShare');
const ProfileShareView        = require('../models/ProfileShareView');
const Tournament              = require('../models/Tournament');
const TournamentJury           = require('../models/TournamentJury');
const TournamentJuryVote       = require('../models/TournamentJuryVote');
const TournamentMatch          = require('../models/TournamentMatch');
const TournamentEntry          = require('../models/TournamentEntry');
const { activateTournament, autoAcceptPendingJury, MIN_JURY, resolveJuryVote, handleTournamentMatchClose } = require('../jobs/tournamentJobs');
const estimateParticipantPool = require('../utils/estimateParticipantPool');
const { submitEntryToTournament, checkTournamentPreflight, attemptTournamentAutoDraft } = require('../utils/tournamentSubmission');
const { updateAffinity, updateCreatorAffinity, updateStainAffinity, SIGNAL_ANNOUNCEMENT_DISMISS, SIGNAL_ANNOUNCEMENT_CLICK } = require('../utils/affinityUpdater');
const { getPeopleSubSections }         = require('./explore');

router.get('/me', (req, res) => {
  res.json({ authenticated: !!req.session.userId });
});

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function searchUsers(q, excludeUserId, limit) {
  const escaped = escapeRegex(q);
  const users = await User.find({
    $or: [
      { 'username.value':    { $regex: escaped, $options: 'i' } },
      { 'displayName.value': { $regex: escaped, $options: 'i' } },
    ],
    _id:  { $ne: excludeUserId },
    role: 'user',
  })
    .select('username displayName avatar')
    .limit(limit)
    .lean();
  return users.map(u => ({
    _id:         u._id,
    username:    u.username.value,
    displayName: u.displayName?.value || u.username.value,
    avatar:      u.avatar?.value || null,
  }));
}

router.get('/users/search', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const q = req.query.q?.trim().toLowerCase().replace(/^@/, '');
  if (!q || q.length < 1) return res.json([]);
  res.json(await searchUsers(q, req.session.userId, 6));
});

// Jury member typeahead — excludes the organizer and any banned/jury-banned users.
// Never expose juryBanned in the response.
router.post('/tournaments/search-users', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  let excludeIds = [req.session.userId];
  if (req.query.excludeTournamentId && mongoose.isValidObjectId(req.query.excludeTournamentId)) {
    const currentJury = await TournamentJury.find({ tournamentId: req.query.excludeTournamentId }).select('userId').lean();
    excludeIds = excludeIds.concat(currentJury.map(j => j.userId));
  }

  const escaped = escapeRegex(q);
  const users = await User.find({
    $or: [
      { 'username.value':    { $regex: escaped, $options: 'i' } },
      { 'displayName.value': { $regex: escaped, $options: 'i' } },
    ],
    _id:           { $nin: excludeIds },
    accountStatus: { $ne: 'banned' },
    juryBanned:    { $ne: true },
    role:          'user',
  })
    .select('username displayName avatar')
    .limit(10)
    .lean();

  res.json(users.map(u => ({
    _id:         u._id,
    username:    u.username?.value || '',
    displayName: u.displayName?.value || u.username?.value || '',
    avatar:      u.avatar?.value || null,
  })));
});

router.get('/tournaments/check-name', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const name = (req.query.name || '').trim();
  if (!name) return res.json({ available: true });

  const query = { name: { $regex: '^' + escapeRegex(name) + '$', $options: 'i' } };
  if (req.query.excludeId && mongoose.isValidObjectId(req.query.excludeId)) {
    query._id = { $ne: req.query.excludeId };
  }
  const existing = await Tournament.findOne(query).select('_id').lean();

  res.json({ available: !existing });
});

// Rounds to ~2 significant figures so the precision scales with the pool size — a platform
// with 4 matching users sees "4", not an inflated "~100"; a platform with 76,300 sees "~76,000".
// Never exposes the exact count for pools of 10+ (avoids an individually-identifying headcount).
function roundForDisplay(exact) {
  if (exact < 10) return { value: exact, exact: true };
  const magnitude = Math.pow(10, Math.floor(Math.log10(exact)) - 1);
  return { value: Math.round(exact / magnitude) * magnitude, exact: false };
}

router.post('/tournaments/estimate-pool', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  let criteria;
  try {
    criteria = JSON.parse(req.body.criteria || '[]');
    if (!Array.isArray(criteria)) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Invalid criteria.' });
  }

  const exactCount = await estimateParticipantPool(req.session.userId, criteria);
  const { value: approxCount, exact } = roundForDisplay(exactCount);
  res.json({ approxCount, exact });
});

// Pre-upload eligibility check — run before the "Enter Tournament" CTA sends a candidate to the
// upload page, so they never waste an upload only to be told at submit-time that they don't
// qualify. Entries are always submitted at the moment they're uploaded (see POST /entries), so
// there's no existing-entry picker here anymore — just a profile-level pass/fail.
router.get('/tournaments/:id/eligibility', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Tournament not found.' });

  const tournament = await Tournament.findById(req.params.id).lean();
  if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });

  const result = await checkTournamentPreflight(tournament, req.session.userId);
  res.json(result);
});

// Shared setup for the approve/reject routes: loads the tournament, checks organizer + phase,
// and loads the pending TournamentEntry. Review happens on a rolling basis during `open` as well
// as `cooldown`, so organizers of high-volume tournaments aren't stuck reviewing everything inside
// the 24h cooldown window alone.
async function loadPendingEntryForReview(req, res) {
  if (!req.session.userId) { res.status(401).json({ error: 'Not authenticated' }); return null; }
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.eid)) {
    res.status(404).json({ error: 'Not found.' });
    return null;
  }

  const tournament = await Tournament.findById(req.params.id).lean();
  if (!tournament) { res.status(404).json({ error: 'Tournament not found.' }); return null; }
  if (tournament.createdBy.toString() !== req.session.userId) {
    res.status(403).json({ error: 'Not authorized.' });
    return null;
  }
  if (tournament.status !== 'open' && tournament.status !== 'cooldown') {
    res.status(400).json({ error: 'Candidate review is only available during the open or cooldown phase.' });
    return null;
  }

  const entry = await TournamentEntry.findOne({ _id: req.params.eid, tournamentId: tournament._id });
  if (!entry) { res.status(404).json({ error: 'Entry not found.' }); return null; }
  if (entry.approvalStatus !== 'pending') {
    res.status(400).json({ error: 'This entry has already been reviewed.' });
    return null;
  }

  return { tournament, entry };
}

router.post('/tournaments/:id/entries/:eid/approve', async (req, res) => {
  const loaded = await loadPendingEntryForReview(req, res);
  if (!loaded) return;
  const { tournament, entry } = loaded;

  const approvedCount = await TournamentEntry.countDocuments({ tournamentId: tournament._id, approvalStatus: 'approved' });
  if (approvedCount >= tournament.size) {
    return res.status(400).json({ error: 'Tournament is already at capacity.' });
  }

  entry.approvalStatus = 'approved';
  entry.reviewedAt = new Date();
  await entry.save();

  await Notification.create({
    userId:  entry.userId,
    type:    'tournament_entry_approved',
    payload: { tournamentId: tournament._id, tournamentName: tournament.name, url: '/tournament/' + tournament._id },
  });

  // This approval fills the last open slot. Rather than silently skipping ahead, tell the
  // client so the organizer gets an explicit choice (see POST /tournaments/:id/advance-now):
  // go live right now, or leave it as-is — the phase resolves correctly either way, since the
  // open-phase clock and the cooldown sweeper both already check the approved count on their own.
  const capReached = approvedCount + 1 === tournament.size;

  res.json({ success: true, capReached });
});

// Sends a just-approved entry back to `pending` — the organizer's "actually, not yet" undo,
// distinct from reject (which notifies the submitter of a real decision). No new notification
// here, but the earlier "approved" notification is deleted so the submitter isn't left staring
// at a stale approval while their entry actually sits back at pending.
router.post('/tournaments/:id/entries/:eid/revert', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.eid)) {
    return res.status(404).json({ error: 'Not found.' });
  }

  const tournament = await Tournament.findById(req.params.id).lean();
  if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
  if (tournament.createdBy.toString() !== req.session.userId) {
    return res.status(403).json({ error: 'Not authorized.' });
  }
  if (tournament.status !== 'open' && tournament.status !== 'cooldown') {
    return res.status(400).json({ error: 'Candidate review is only available during the open or cooldown phase.' });
  }

  const entry = await TournamentEntry.findOne({ _id: req.params.eid, tournamentId: tournament._id });
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  if (entry.approvalStatus !== 'approved') {
    return res.status(400).json({ error: 'Only an approved entry can be reverted.' });
  }

  entry.approvalStatus = 'pending';
  entry.reviewedAt = null;
  await entry.save();

  await Notification.deleteMany({
    userId: entry.userId,
    type: 'tournament_entry_approved',
    'payload.tournamentId': tournament._id,
  });

  res.json({ success: true });
});

// Organizer-triggered early activation once the roster is exactly full — the counterpart to
// declining the cap-reached prompt. Works from either `open` (skips straight to `active`,
// bypassing cooldown entirely) or `cooldown` (skips whatever's left of the 24h window).
router.post('/tournaments/:id/advance-now', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Tournament not found.' });

  const tournament = await Tournament.findById(req.params.id).lean();
  if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
  if (tournament.createdBy.toString() !== req.session.userId) {
    return res.status(403).json({ error: 'Not authorized.' });
  }
  if (tournament.status !== 'open' && tournament.status !== 'cooldown') {
    return res.status(400).json({ error: 'This tournament cannot be started right now.' });
  }

  const approvedCount = await TournamentEntry.countDocuments({ tournamentId: tournament._id, approvalStatus: 'approved' });
  if (approvedCount !== tournament.size) {
    return res.status(400).json({ error: `You need exactly ${tournament.size} approved candidates before starting the tournament.` });
  }

  const agenda = require('../jobs/agenda'); // lazy — must load after mongoose.connect() in server.js

  if (tournament.status === 'open') {
    // Mirrors the jury-readiness bar tournament_open_expiry enforces before it would otherwise
    // transition onward — going live early must not skip that check.
    await autoAcceptPendingJury(tournament._id);
    const acceptedJuryCount = await TournamentJury.countDocuments({ tournamentId: tournament._id, status: 'accepted' });
    if (acceptedJuryCount < MIN_JURY) {
      return res.status(400).json({ error: 'This tournament does not have enough confirmed jury members yet.' });
    }
    await agenda.cancel({ name: 'tournament_open_expiry', 'data.tournamentId': tournament._id.toString() });
  } else {
    await agenda.cancel({ name: 'tournament_cooldown_expiry', 'data.tournamentId': tournament._id.toString() });
  }

  await activateTournament(tournament._id);
  res.json({ success: true });
});

router.post('/tournaments/:id/entries/:eid/reject', async (req, res) => {
  const loaded = await loadPendingEntryForReview(req, res);
  if (!loaded) return;
  const { tournament, entry } = loaded;

  const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 200) : null;

  entry.approvalStatus = 'rejected';
  entry.reviewedAt = new Date();
  await entry.save();

  await Notification.create({
    userId:  entry.userId,
    type:    'tournament_entry_rejected',
    payload: { tournamentId: tournament._id, tournamentName: tournament.name, note: note || null, url: '/tournament/' + tournament._id },
  });

  res.json({ success: true });
});

// ── POST /tournaments/:id/matches/:matchId/jury-vote — juror casts a tie-break vote ──
router.post('/tournaments/:id/matches/:matchId/jury-vote', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.matchId)) {
    return res.status(404).json({ error: 'Not found.' });
  }

  const match = await TournamentMatch.findOne({ _id: req.params.matchId, tournamentId: req.params.id });
  if (!match) return res.status(404).json({ error: 'Match not found.' });
  if (match.status !== 'tie' || match.tieStatus !== 'jury_pending') {
    return res.status(400).json({ error: 'No active jury vote for this match.' });
  }

  const jurorRecord = await TournamentJury.findOne({
    tournamentId: req.params.id, userId: req.session.userId, status: 'accepted',
  }).lean();
  if (!jurorRecord) return res.status(403).json({ error: 'You are not a jury member for this tournament.' });

  const votedForEntryId = req.body.votedForEntryId;
  if (![match.entryIdA.toString(), match.entryIdB.toString()].includes(votedForEntryId)) {
    return res.status(400).json({ error: 'Invalid entry selection.' });
  }

  try {
    await TournamentJuryVote.create({
      tournamentId: req.params.id, matchId: match._id, jurorId: req.session.userId, votedForEntryId,
    });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'You have already cast your vote for this tie.' });
    throw err;
  }

  // Tell each contestant how many votes they've received so far — never who voted or the count
  // for the other side, so the running tally can't be reconstructed from two notifications.
  const votes = await TournamentJuryVote.find({ matchId: match._id }).select('votedForEntryId').lean();
  const countA = votes.filter(v => v.votedForEntryId.toString() === match.entryIdA.toString()).length;
  const countB = votes.filter(v => v.votedForEntryId.toString() === match.entryIdB.toString()).length;

  // A contestant's TournamentEntry can be gone if they deleted their account mid-tournament —
  // don't let a missing side crash the vote that just succeeded; just skip notifying them.
  const [teA, teB] = await Promise.all([
    TournamentEntry.findById(match.tournamentEntryIdA).select('userId').lean(),
    TournamentEntry.findById(match.tournamentEntryIdB).select('userId').lean(),
  ]);
  const voteReceivedNotifications = [];
  if (teA) {
    voteReceivedNotifications.push({ userId: teA.userId, type: 'tournament_jury_vote_received', payload: {
        tournamentId: req.params.id, matchId: match._id, voteCount: countA, url: '/contest/' + match.contestId,
    } });
  }
  if (teB) {
    voteReceivedNotifications.push({ userId: teB.userId, type: 'tournament_jury_vote_received', payload: {
        tournamentId: req.params.id, matchId: match._id, voteCount: countB, url: '/contest/' + match.contestId,
    } });
  }
  if (voteReceivedNotifications.length > 0) {
    await Notification.insertMany(voteReceivedNotifications, { ordered: false }).catch(() => {});
  }

  if (votes.length >= 3) {
    await resolveJuryVote(match._id, votes);
  }

  res.json({ success: true });
});

// ── POST /tournaments/:id/matches/:matchId/organizer-vote — organizer breaks a tie the jury
// couldn't resolve by quorum within its 6h window ────────────────────────────────────────
router.post('/tournaments/:id/matches/:matchId/organizer-vote', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.matchId)) {
    return res.status(404).json({ error: 'Not found.' });
  }

  const tournament = await Tournament.findById(req.params.id).select('createdBy').lean();
  if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
  if (tournament.createdBy.toString() !== req.session.userId) {
    return res.status(403).json({ error: 'Not authorized.' });
  }

  const match = await TournamentMatch.findOne({ _id: req.params.matchId, tournamentId: req.params.id }).lean();
  if (!match) return res.status(404).json({ error: 'Match not found.' });
  if (match.tieStatus !== 'organizer_pending') {
    return res.status(400).json({ error: 'No active tie-break for this match.' });
  }

  const votedForEntryId = req.body.votedForEntryId;
  if (![match.entryIdA.toString(), match.entryIdB.toString()].includes(votedForEntryId)) {
    return res.status(400).json({ error: 'Invalid entry selection.' });
  }

  const claimed = await TournamentMatch.findOneAndUpdate(
    { _id: match._id, tieStatus: 'organizer_pending' },
    { $set: { tieStatus: 'resolved' } },
  );
  if (!claimed) return res.status(400).json({ error: 'This tie has already been resolved.' });

  const agenda = require('../jobs/agenda'); // lazy — must load after mongoose.connect() in server.js
  await agenda.cancel({ name: 'tournament_organizer_vote_expiry', 'data.matchId': match._id.toString() });

  await handleTournamentMatchClose(match.contestId, votedForEntryId);

  res.json({ success: true });
});

async function searchEntries(rawQ, currentUserId, blockedIds, limit) {
  let filter;
  if (rawQ.startsWith('#')) {
    const tag = rawQ.slice(1).trim().toLowerCase();
    if (!tag) return [];
    filter = { tags: tag };
  } else {
    const regex = { $regex: escapeRegex(rawQ), $options: 'i' };
    filter = { $or: [{ title: regex }, { caption: regex }, { tags: regex }] };
  }
  filter.hidden = { $ne: true };
  filter.userId = { $nin: blockedIds };

  const entries = await Entry.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('userId', 'username displayName avatar')
    .lean();

  return entries.map(e => ({
    _id:        e._id,
    mediaUrl:   e.mediaUrl,
    mediaType:  e.mediaType,
    title:      e.title,
    ratingAvg:  e.ratingAvg,
    ratingCount: e.ratingCount,
    owner: {
      _id:         e.userId?._id,
      username:    e.userId?.username?.value || '',
      displayName: e.userId?.displayName?.value || e.userId?.username?.value || '',
      avatar:      e.userId?.avatar?.value || null,
    },
  }));
}

async function searchTags(rawQ, limit) {
  if (rawQ.startsWith('#')) return [];
  const regex = new RegExp(escapeRegex(rawQ), 'i');
  const results = await Entry.aggregate([
    { $match: { hidden: { $ne: true }, tags: { $elemMatch: { $regex: regex } } } },
    { $unwind: '$tags' },
    { $match: { tags: { $regex: regex } } },
    { $group: { _id: '$tags', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]);
  return results.map(r => ({ tag: r._id, count: r.count }));
}

async function searchContests(rawQ, currentUserId, blockedIds, limit) {
  if (rawQ.startsWith('#')) return [];
  const regex = { $regex: escapeRegex(rawQ), $options: 'i' };

  const [matchingEntries, matchingUsers] = await Promise.all([
    Entry.find({ $or: [{ title: regex }, { caption: regex }, { tags: regex }], hidden: { $ne: true }, userId: { $nin: blockedIds } })
      .select('_id').limit(50).lean(),
    User.find({ $or: [{ 'username.value': regex }, { 'displayName.value': regex }] }).select('_id').limit(50).lean(),
  ]);

  const entryIds = matchingEntries.map(e => e._id);
  const userIds  = matchingUsers.map(u => u._id);
  if (!entryIds.length && !userIds.length) return [];

  const contests = await Contest.find({
    tournamentId: null,
    $and: [
      { $or: [{ 'entries.entryId': { $in: entryIds } }, { 'entries.userId': { $in: userIds } }] },
      { $or: [{ visibility: 'public' }, { 'entries.userId': currentUserId }] },
    ],
  })
    .sort({ lastActivityAt: -1 })
    .limit(limit)
    .populate('entries.entryId', 'title mediaType mediaUrl')
    .populate('entries.userId', 'username displayName avatar')
    .lean();

  return contests.map(c => {
    const title  = c.entries?.[0]?.entryId?.title || c.entries?.[1]?.entryId?.title || 'H2H Contest';
    const covers = (c.entries || []).slice(0, 2).map(e => ({
      mediaUrl:  e.entryId?.mediaUrl  || '',
      mediaType: e.entryId?.mediaType || 'photo',
    }));
    const contestants = (c.entries || []).map(e => ({
      userId:      e.userId?._id?.toString() || '',
      username:    e.userId?.username?.value || '',
      avatar:      e.userId?.avatar?.value || '',
      displayName: e.userId?.displayName?.value || ('@' + (e.userId?.username?.value || '')),
      isSelf:      e.userId?._id?.toString() === currentUserId.toString(),
    }));
    return {
      _id:            c._id,
      status:         c.status === 'pending' ? 'upcoming' : c.status,
      covers,
      title,
      contestants,
      votingDeadline: c.votingDeadline || null,
    };
  });
}

router.get('/search', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const currentUserId = req.session.userId;
  const rawQ           = (req.query.q || '').trim();
  const category        = ['people', 'entries', 'contests', 'tags'].includes(req.query.category) ? req.query.category : null;
  const filter          = req.query.filter || '';
  const isFullMode      = !!category;

  if (!rawQ && category !== 'people') return res.json({ users: [], entries: [], tags: [], contests: [] });

  const blockDocs   = await UserBlock.find({ blockerId: currentUserId }).select('blockedId').lean();
  const blockedIds  = blockDocs.map(b => b.blockedId);

  if (category === 'people') {
    const followDocs   = await Follow.find({ followerId: currentUserId }).select('followingId').lean();
    const followingSet = new Set(followDocs.map(f => f.followingId.toString()));
    const excludeSet    = new Set([...followingSet, ...blockedIds.map(id => id.toString())]);
    const sections      = await getPeopleSubSections(currentUserId, excludeSet, 20);
    const section       = sections.find(s => s.key === filter);
    return res.json({ users: section ? section.users : [] });
  }

  if (isFullMode) {
    const limit = 30;
    if (category === 'entries')  return res.json({ entries: await searchEntries(rawQ, currentUserId, blockedIds, limit) });
    if (category === 'tags')     return res.json({ tags: await searchTags(rawQ, limit) });
    if (category === 'contests') return res.json({ contests: await searchContests(rawQ, currentUserId, blockedIds, limit) });
  }

  if (rawQ.startsWith('#')) {
    return res.json({ users: [], entries: await searchEntries(rawQ, currentUserId, blockedIds, 20), tags: [], contests: [] });
  }

  const [users, entries, tags, contests] = await Promise.all([
    searchUsers(rawQ.toLowerCase().replace(/^@/, ''), currentUserId, 5),
    searchEntries(rawQ, currentUserId, blockedIds, 5),
    searchTags(rawQ, 6),
    searchContests(rawQ, currentUserId, blockedIds, 4),
  ]);

  res.json({ users, entries, tags, contests });
});

router.get('/users/:id/entries', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });
  const skip = Math.max(0, parseInt(req.query.skip) || 0);
  const entries = await Entry.find({ userId: req.params.id })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(12)
    .select('mediaUrl mediaType')
    .lean();
  res.json(entries.map(e => ({
    _id:       e._id,
    mediaUrl:  e.mediaUrl,
    mediaType: e.mediaType,
  })));
});

router.get('/users/:id/nomination-eligible', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.json({ allowed: false });

  const nominee = await User.findById(req.params.id).select('nominationSettings').lean();
  if (!nominee) return res.json({ allowed: false });

  const settings = nominee.nominationSettings || {};
  if (settings.allow === false) return res.json({ allowed: false });

  const who = settings.whoCanNominate || 'everyone';
  if (who === 'everyone') return res.json({ allowed: true });

  const nominatorId = req.session.userId.toString();
  const nomineeId   = req.params.id;

  if (who === 'followers_only') {
    const ok = await Follow.exists({ followerId: nominatorId, followingId: nomineeId });
    return res.json({ allowed: !!ok });
  }
  if (who === 'followees_only') {
    const ok = await Follow.exists({ followerId: nomineeId, followingId: nominatorId });
    return res.json({ allowed: !!ok });
  }
  if (who === 'mutual_follow') {
    const [a, b] = await Promise.all([
      Follow.exists({ followerId: nominatorId, followingId: nomineeId }),
      Follow.exists({ followerId: nomineeId,   followingId: nominatorId }),
    ]);
    return res.json({ allowed: !!(a && b) });
  }
  return res.json({ allowed: true });
});

router.post('/contests/viewer-nominate', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const { nominee1Id, nominee2Id, message, nominee1EntryId, nominee2EntryId } = req.body;

  if (!mongoose.isValidObjectId(nominee1Id) || !mongoose.isValidObjectId(nominee2Id)) {
    return res.status(400).json({ error: 'Invalid user IDs.' });
  }
  if (nominee1Id === nominee2Id) {
    return res.status(400).json({ error: 'Cannot nominate the same user twice.' });
  }
  if (nominee1Id === req.session.userId.toString() || nominee2Id === req.session.userId.toString()) {
    return res.status(400).json({ error: 'You cannot nominate yourself.' });
  }
  if (nominee1EntryId && !mongoose.isValidObjectId(nominee1EntryId)) {
    return res.status(400).json({ error: 'Invalid entry ID for nominee 1.' });
  }
  if (nominee2EntryId && !mongoose.isValidObjectId(nominee2EntryId)) {
    return res.status(400).json({ error: 'Invalid entry ID for nominee 2.' });
  }

  const [nominee1, nominee2] = await Promise.all([
    User.findById(nominee1Id).select('username displayName avatar nominationSettings').lean(),
    User.findById(nominee2Id).select('username displayName avatar nominationSettings').lean(),
  ]);
  if (!nominee1 || !nominee2) return res.status(404).json({ error: 'One or more users not found.' });

  // Validate pre-selected entries belong to the correct nominees
  if (nominee1EntryId) {
    const e = await Entry.findById(nominee1EntryId).select('userId').lean();
    if (!e || e.userId.toString() !== nominee1Id) {
      return res.status(400).json({ error: 'Selected entry does not belong to nominee 1.' });
    }
  }
  if (nominee2EntryId) {
    const e = await Entry.findById(nominee2EntryId).select('userId').lean();
    if (!e || e.userId.toString() !== nominee2Id) {
      return res.status(400).json({ error: 'Selected entry does not belong to nominee 2.' });
    }
  }

  async function canBeNominated(nominee) {
    const settings = nominee.nominationSettings || {};
    if (settings.allow === false) return false;
    const who = settings.whoCanNominate || 'everyone';
    if (who === 'everyone') return true;
    const nominatorId = req.session.userId.toString();
    const nomineeId   = nominee._id.toString();
    if (who === 'followers_only') {
      return !!(await Follow.exists({ followerId: nominatorId, followingId: nomineeId }));
    }
    if (who === 'followees_only') {
      return !!(await Follow.exists({ followerId: nomineeId, followingId: nominatorId }));
    }
    if (who === 'mutual_follow') {
      const [a, b] = await Promise.all([
        Follow.exists({ followerId: nominatorId, followingId: nomineeId }),
        Follow.exists({ followerId: nomineeId,   followingId: nominatorId }),
      ]);
      return !!(a && b);
    }
    return true;
  }

  const [can1, can2] = await Promise.all([canBeNominated(nominee1), canBeNominated(nominee2)]);
  if (!can1 || !can2) {
    return res.status(403).json({ error: "One or more users don't accept nominations from you." });
  }

  const expiry    = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const nominator = await User.findById(req.session.userId).select('username displayName avatar').lean();

  const contest = await Contest.create({
    createdBy:    req.session.userId,
    visibility:   'public',
    status:       'pending',
    windowHours:  72,
    voidDeadline: expiry,
    entries:      [],
  });

  const [nom1, nom2] = await Promise.all([
    Nomination.create({
      contestId:          contest._id,
      nominatorId:        req.session.userId,
      nomineeId:          nominee1Id,
      message:            message?.trim() || undefined,
      expiresAt:          expiry,
      status:             'pending',
      type:               'viewer_nomination',
      preSelectedEntryId: nominee1EntryId || undefined,
    }),
    Nomination.create({
      contestId:          contest._id,
      nominatorId:        req.session.userId,
      nomineeId:          nominee2Id,
      message:            message?.trim() || undefined,
      expiresAt:          expiry,
      status:             'pending',
      type:               'viewer_nomination',
      preSelectedEntryId: nominee2EntryId || undefined,
    }),
  ]);

  const actorDisplayName = nominator?.displayName?.value || nominator?.username?.value || 'Someone';
  const actorHandle      = nominator?.username?.value || '';
  const actorAvatar      = nominator?.avatar?.value || null;

  await Promise.all([
    Notification.create({
      userId:  nominee1Id,
      type:    'viewer_nomination',
      payload: {
        actorDisplayName,
        actorHandle,
        actorAvatar,
        opponentDisplayName: nominee2.displayName?.value || nominee2.username?.value,
        opponentHandle:      nominee2.username?.value,
        contestId:           contest._id,
        url:                 '/submit?nomination=' + nom1._id,
      },
    }),
    Notification.create({
      userId:  nominee2Id,
      type:    'viewer_nomination',
      payload: {
        actorDisplayName,
        actorHandle,
        actorAvatar,
        opponentDisplayName: nominee1.displayName?.value || nominee1.username?.value,
        opponentHandle:      nominee1.username?.value,
        contestId:           contest._id,
        url:                 '/submit?nomination=' + nom2._id,
      },
    }),
  ]);

  res.json({ ok: true, contestId: contest._id });
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

router.post('/entries', upload.entry.fields([{ name: 'entryMedia', maxCount: 1 }]), async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  // TEMP: bypass idVerified for test accounts — remove before launch
  const TEST_BYPASS_USERNAMES = ['celuiqui', 'storiesbyshews'];
  const actor = await User.findById(req.session.userId).select('idVerified username displayName avatar').lean();
  const isBypassUser = actor && TEST_BYPASS_USERNAMES.includes(actor.username?.value);
  if (!actor || (!actor.idVerified && !isBypassUser)) return res.status(403).json({ error: 'identity_required' });

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

  let pendingNom      = null;
  let pendingTakeOn   = null;
  let nominees        = [];

  if (nominationId) {
    if (!mongoose.isValidObjectId(nominationId)) return res.status(400).json({ error: 'Invalid nomination.' });
    pendingNom = await Nomination.findById(nominationId).lean();
    if (!pendingNom)                                                       return res.status(404).json({ error: 'Nomination not found.' });
    if (pendingNom.nomineeId.toString() !== req.session.userId.toString()) return res.status(403).json({ error: 'This nomination is not for you.' });
    if (pendingNom.status !== 'pending')                                   return res.status(409).json({ error: 'This nomination has already been resolved.' });
  }

  const takeOnContestId = req.body.takeOnContestId?.trim() || null;
  if (takeOnContestId) {
    if (!mongoose.isValidObjectId(takeOnContestId)) return res.status(400).json({ error: 'Invalid take-on contest.' });
    const toc = await Contest.findOne({ _id: takeOnContestId, createdBy: req.session.userId, status: 'pending' }).select('_id windowHours').lean();
    const tocNom = toc ? await Nomination.findOne({ contestId: toc._id, nominatorId: req.session.userId, type: 'take_on', status: 'accepted' }).lean() : null;
    if (toc && tocNom) pendingTakeOn = { contest: toc, nomination: tocNom };
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

  let contestEligibilityError = null;
  if (nominationId || challengeUsernames.length) {
    const eligibility = await checkContestEligibility(req.session.userId);
    if (!eligibility.eligible) contestEligibilityError = eligibility.reason;
  }

  const tournamentId = req.body.tournamentId?.trim() || null;
  let targetTournament = null;
  if (tournamentId && mongoose.isValidObjectId(tournamentId)) {
    targetTournament = await Tournament.findById(tournamentId).lean();
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
      allowTakeOns:    req.body.allowTakeOns !== 'false',
    });

    // Tournament candidacy is always resolved at upload time — either an explicit tournament
    // the uploader targeted, or an automatic stain-match draft into any other open tournament.
    let tournamentSubmission = null;
    if (targetTournament) {
      tournamentSubmission = await submitEntryToTournament({ tournament: targetTournament, entry, actor, autoSubmitted: false });
    }
    attemptTournamentAutoDraft(entry, actor).catch(() => {});

    if (contestEligibilityError) {
      return res.json({ entryId: entry._id, contestId: null, eligibilityError: contestEligibilityError, tournamentSubmission });
    }

    let contestId = null;

    if (pendingNom) {
      const nomContest = await Contest.findById(pendingNom.contestId).select('entries windowHours').lean();
      const winHours   = nomContest?.windowHours || 72;
      contestId = pendingNom.contestId;

      if (pendingNom.type === 'viewer_nomination') {
        const isSecond      = (nomContest?.entries?.length || 0) === 1;
        const contestUpdate = {
          $push:         { entries: { entryId: entry._id, userId: req.session.userId, submittedAt: new Date() } },
          lastActivityAt: new Date(),
        };
        if (isSecond) {
          contestUpdate.status         = 'active';
          contestUpdate.votingDeadline = new Date(Date.now() + winHours * 3600000);
        }
        await Promise.all([
          Nomination.findByIdAndUpdate(pendingNom._id, { status: 'accepted', nomineeEntryId: entry._id }),
          Contest.findByIdAndUpdate(pendingNom.contestId, contestUpdate),
        ]);
        if (isSecond) {
          const sibling = await Nomination.findOne({ contestId: pendingNom.contestId, _id: { $ne: pendingNom._id } }).lean();
          const acceptPayload = {
            actorUsername:    actor?.username?.value    || 'Someone',
            actorDisplayName: actor?.displayName?.value || actor?.username?.value || 'Someone',
            actorAvatar:      actor?.avatar?.value      || null,
            contestId:        pendingNom.contestId,
            url:              '/contest/' + pendingNom.contestId,
          };
          if (sibling) {
            Notification.create({ userId: sibling.nomineeId, type: 'nominee_accepted', payload: acceptPayload }).catch(() => {});
          }
          notifyLoopedIn(pendingNom.contestId, 'nominee_accepted', acceptPayload, [req.session.userId]);
        }
      } else {
        await Promise.all([
          Nomination.findByIdAndUpdate(pendingNom._id, { status: 'accepted', nomineeEntryId: entry._id }),
          Contest.findByIdAndUpdate(pendingNom.contestId, {
            $push:  { entries: { entryId: entry._id, userId: req.session.userId, submittedAt: new Date() } },
            status: 'active',
            votingDeadline: new Date(Date.now() + winHours * 60 * 60 * 1000),
            lastActivityAt: new Date(),
          }),
          Notification.updateOne(
            { userId: req.session.userId, type: 'nomination_received', 'payload.contestId': pendingNom.contestId },
            { $set: { 'payload.url': '/contest/' + pendingNom.contestId } }
          ),
        ]);
        const nomAcceptPayload = {
          actorUsername:    actor?.username?.value    || 'Someone',
          actorDisplayName: actor?.displayName?.value || actor?.username?.value || 'Someone',
          actorAvatar:      actor?.avatar?.value      || null,
          contestId:        pendingNom.contestId,
          url:              '/contest/' + pendingNom.contestId,
        };
        Notification.create({
          userId:  pendingNom.nominatorId,
          type:    'nominee_accepted',
          payload: nomAcceptPayload,
        }).catch(() => {});
        notifyLoopedIn(pendingNom.contestId, 'nominee_accepted', nomAcceptPayload, [req.session.userId, pendingNom.nominatorId]);
      }
    }

    if (pendingTakeOn) {
      const winHours = pendingTakeOn.contest.windowHours || 72;
      await Promise.all([
        Contest.findByIdAndUpdate(pendingTakeOn.contest._id, {
          $push:          { entries: { entryId: entry._id, userId: req.session.userId, submittedAt: new Date() } },
          status:         'active',
          votingDeadline: new Date(Date.now() + winHours * 60 * 60 * 1000),
          lastActivityAt: new Date(),
        }),
      ]);
      contestId = pendingTakeOn.contest._id;
      notifyLoopedIn(pendingTakeOn.contest._id, 'nominee_accepted', {
        actorUsername:    actor?.username?.value    || 'Someone',
        actorDisplayName: actor?.displayName?.value || actor?.username?.value || 'Someone',
        actorAvatar:      actor?.avatar?.value      || null,
        contestId:        pendingTakeOn.contest._id,
        url:              '/contest/' + pendingTakeOn.contest._id,
      }, [req.session.userId, pendingTakeOn.contest.createdBy]);
    }

    if (nominees.length) {
      const hideEntry   = req.body.challengeHideEntry === 'true';
      const visibility  = ['public', 'private'].includes(req.body.challengeVisibility) ? req.body.challengeVisibility : 'public';
      const rawWin      = parseInt(req.body.challengeWindowHours, 10);
      const windowHours = [24, 48, 72, 168].includes(rawWin) ? rawWin : 72;
      const expiry      = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const nominator   = await User.findById(req.session.userId).select('username displayName avatar').lean();
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
        }).then(nomination => {
          Notification.create({
            userId:  nom._id,
            type:    'nomination_received',
            payload: {
              actorUsername:    nominator?.username?.value    || 'Someone',
              actorDisplayName: nominator?.displayName?.value || nominator?.username?.value || 'Someone',
              actorAvatar:      nominator?.avatar?.value      || null,
              contestId:        c._id,
              url:              '/submit?nomination=' + nomination._id,
            },
          }).catch(() => {});
          return c._id;
        }))
      ));
      contestId = contests.length === 1 ? contests[0] : null;
    }

    res.json({ entryId: entry._id, contestId, tournamentSubmission });
  } catch (err) {
    console.error('Entry create error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/nominations/:id/accept', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid nomination ID.' });

  const nom = await Nomination.findById(req.params.id).lean();
  if (!nom)                                                         return res.status(404).json({ error: 'Nomination not found.' });
  if (nom.nomineeId.toString() !== req.session.userId.toString())   return res.status(403).json({ error: 'Not your nomination.' });
  if (nom.status !== 'pending')                                     return res.status(409).json({ error: 'Nomination already resolved.' });
  if (nom.expiresAt < new Date())                                   return res.status(410).json({ error: 'This nomination has expired.' });

  // Locked-in viewer nomination: entry was pre-selected by the nominator
  const isLocked = nom.type === 'viewer_nomination' && !!nom.preSelectedEntryId;
  const entryId  = isLocked ? nom.preSelectedEntryId.toString() : req.body.entryId;

  if (!mongoose.isValidObjectId(entryId)) return res.status(400).json({ error: 'Invalid entry ID.' });

  const entry = await Entry.findById(entryId).select('userId').lean();
  if (!entry)                                                        return res.status(404).json({ error: 'Entry not found.' });
  if (entry.userId.toString() !== req.session.userId.toString())    return res.status(403).json({ error: 'Not your entry.' });

  const eligibility = await checkContestEligibility(req.session.userId);
  if (!eligibility.eligible) return res.status(403).json({ error: eligibility.reason });

  const [nomContest, nominee] = await Promise.all([
    Contest.findById(nom.contestId).select('entries windowHours').lean(),
    User.findById(req.session.userId).select('username displayName avatar').lean(),
  ]);
  const winHours = nomContest?.windowHours || 72;

  if (nom.type === 'viewer_nomination') {
    const isSecond  = (nomContest?.entries?.length || 0) === 1;
    const contestUpdate = {
      $push:         { entries: { entryId, userId: req.session.userId, submittedAt: new Date() } },
      lastActivityAt: new Date(),
    };
    if (isSecond) {
      contestUpdate.status         = 'active';
      contestUpdate.votingDeadline = new Date(Date.now() + winHours * 3600000);
    }
    await Promise.all([
      Nomination.findByIdAndUpdate(req.params.id, { status: 'accepted', nomineeEntryId: entryId }),
      Contest.findByIdAndUpdate(nom.contestId, contestUpdate),
    ]);
    const sibling     = await Nomination.findOne({ contestId: nom.contestId, _id: { $ne: req.params.id } }).lean();
    const basePayload = {
      actorUsername:    nominee?.username?.value    || 'Someone',
      actorDisplayName: nominee?.displayName?.value || nominee?.username?.value || 'Someone',
      actorAvatar:      nominee?.avatar?.value      || null,
      contestId:        nom.contestId,
    };

    if (isSecond) {
      const livePayload = { ...basePayload, contestIsLive: true, url: '/contest/' + nom.contestId };
      if (sibling) {
        Notification.create({ userId: sibling.nomineeId, type: 'nominee_accepted', payload: livePayload }).catch(() => {});
      }
      Notification.create({ userId: nom.nominatorId, type: 'nominee_accepted', payload: livePayload }).catch(() => {});
      notifyLoopedIn(nom.contestId, 'nominee_accepted', livePayload, [req.session.userId]);
    } else {
      const siblingUrl    = sibling ? '/submit?nomination=' + sibling._id : '/contest/' + nom.contestId;
      const waitPayload   = { ...basePayload, contestIsLive: false, url: siblingUrl };
      const nominatorUrl  = '/contest/' + nom.contestId;
      const nominatorWait = { ...basePayload, contestIsLive: false, url: nominatorUrl };
      if (sibling) {
        Notification.create({ userId: sibling.nomineeId, type: 'nominee_accepted', payload: waitPayload }).catch(() => {});
      }
      Notification.create({ userId: nom.nominatorId, type: 'nominee_accepted', payload: nominatorWait }).catch(() => {});
    }
    return res.json({ ok: true, contestId: nom.contestId });
  }

  await Promise.all([
    Nomination.findByIdAndUpdate(req.params.id, { status: 'accepted', nomineeEntryId: entryId }),
    Contest.findByIdAndUpdate(nom.contestId, {
      $push:          { entries: { entryId, userId: req.session.userId, submittedAt: new Date() } },
      status:         'active',
      votingDeadline: new Date(Date.now() + winHours * 60 * 60 * 1000),
      lastActivityAt: new Date(),
    }),
    Notification.updateOne(
      { userId: req.session.userId, type: 'nomination_received', 'payload.contestId': nom.contestId },
      { $set: { 'payload.url': '/contest/' + nom.contestId } }
    ),
  ]);
  const acceptPayload = {
    actorUsername:    nominee?.username?.value    || 'Someone',
    actorDisplayName: nominee?.displayName?.value || nominee?.username?.value || 'Someone',
    actorAvatar:      nominee?.avatar?.value      || null,
    contestId:        nom.contestId,
    url:              '/contest/' + nom.contestId,
  };
  Notification.create({
    userId:  nom.nominatorId,
    type:    'nominee_accepted',
    payload: acceptPayload,
  }).catch(() => {});
  notifyLoopedIn(nom.contestId, 'nominee_accepted', acceptPayload, [req.session.userId, nom.nominatorId]);
  res.json({ ok: true, contestId: nom.contestId });
});

router.post('/nominations/:id/decline', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });
  const nom = await Nomination.findById(req.params.id).lean();
  if (!nom)                                                         return res.status(404).json({ error: 'Nomination not found.' });
  if (nom.nomineeId.toString() !== req.session.userId.toString())  return res.status(403).json({ error: 'Not your nomination.' });
  if (nom.status !== 'pending')                                     return res.status(409).json({ error: 'Nomination already resolved.' });
  if (nom.expiresAt < new Date())                                   return res.status(410).json({ error: 'This nomination has expired.' });

  const decliner = await User.findById(req.session.userId).select('username displayName avatar').lean();
  const declinedPayload = {
    actorUsername:    decliner?.username?.value    || 'Someone',
    actorDisplayName: decliner?.displayName?.value || decliner?.username?.value || 'Someone',
    actorAvatar:      decliner?.avatar?.value      || null,
    contestId:        nom.contestId,
    url:              '/contest/' + nom.contestId,
  };

  if (nom.type === 'viewer_nomination') {
    // Find sibling regardless of status — they may have already accepted
    const sibling = await Nomination.findOne({ contestId: nom.contestId, _id: { $ne: req.params.id } }).lean();
    const updates = [
      Nomination.findByIdAndUpdate(req.params.id, { status: 'void' }),
      Contest.findByIdAndUpdate(nom.contestId, { $set: { status: 'void', voidReason: 'declined', lastActivityAt: new Date() } }),
    ];
    if (sibling && sibling.status === 'pending') {
      updates.push(Nomination.findByIdAndUpdate(sibling._id, { status: 'void' }));
    }
    await Promise.all(updates);
    // Notify sibling nominee (whether pending or already accepted)
    if (sibling) {
      Notification.create({ userId: sibling.nomineeId, type: 'nominee_declined', payload: declinedPayload }).catch(() => {});
    }
    // Notify the nominator (User C) who set up the contest
    Notification.create({ userId: nom.nominatorId, type: 'nominee_declined', payload: declinedPayload }).catch(() => {});
    notifyLoopedIn(nom.contestId, 'nominee_declined', declinedPayload, [req.session.userId]);
    return res.json({ ok: true });
  }

  await Promise.all([
    Nomination.findByIdAndUpdate(req.params.id, { status: 'void' }),
    Contest.findByIdAndUpdate(nom.contestId, { $set: { status: 'void', voidReason: 'declined', lastActivityAt: new Date() } }),
  ]);
  // Notify the challenger that their nomination was declined
  Notification.create({ userId: nom.nominatorId, type: 'nominee_declined', payload: declinedPayload }).catch(() => {});
  notifyLoopedIn(nom.contestId, 'nominee_declined', declinedPayload, [req.session.userId]);
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
  const eligibility = await checkContestEligibility(req.session.userId);
  if (!eligibility.eligible) return res.status(400).json({ error: eligibility.reason });
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
  const nomination = await Nomination.create({
    contestId:   contest._id,
    nominatorId: req.session.userId,
    nomineeId:   nominee._id,
    expiresAt:   expiry,
    status:      'pending',
  });

  const nominator = await User.findById(req.session.userId).select('username displayName avatar').lean();
  Notification.create({
    userId:  nominee._id,
    type:    'nomination_received',
    payload: {
      actorUsername:    nominator?.username?.value    || 'Someone',
      actorDisplayName: nominator?.displayName?.value || nominator?.username?.value || 'Someone',
      actorAvatar:      nominator?.avatar?.value      || null,
      contestId:        contest._id,
      url:              '/submit?nomination=' + nomination._id,
    },
  }).catch(() => {});

  Follow.find({ followingId: req.session.userId }).select('followerId').lean()
    .then(follows => {
      if (!follows.length) return;
      const excludeStrs = new Set([nominee._id.toString(), req.session.userId.toString()]);
      const docs = follows
        .filter(f => !excludeStrs.has(f.followerId.toString()))
        .map(f => ({
          userId:  f.followerId,
          type:    'contest_started',
          payload: {
            actorUsername:    nominator?.username?.value    || 'Someone',
            actorDisplayName: nominator?.displayName?.value || nominator?.username?.value || 'Someone',
            actorAvatar:      nominator?.avatar?.value      || null,
            contestId:        contest._id,
            url:              '/contest/' + contest._id,
          },
          read: false,
        }));
      if (docs.length) return Notification.insertMany(docs, { ordered: false });
    })
    .catch(() => {});

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

router.post('/entries/:id/pin', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Entry not found' });

  try {
    const entry = await Entry.findById(req.params.id).select('userId').lean();
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    if (entry.userId.toString() !== req.session.userId.toString()) {
      return res.status(403).json({ error: 'Not your entry' });
    }

    const user = await User.findById(req.session.userId).select('pinnedEntryId');
    const alreadyPinned = user.pinnedEntryId?.toString() === req.params.id;
    user.pinnedEntryId = alreadyPinned ? null : new mongoose.Types.ObjectId(req.params.id);
    await user.save();

    res.json({ ok: true, pinned: !alreadyPinned });
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
    const entry = await Entry.findById(eid).select('userId ratingCount ratingAvg tags').lean();
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

    const _source = ['search', 'share', 'feed'].includes(req.body.source) ? req.body.source : 'feed';
    updateAffinity(req.session.userId, entry, { signal: score / 10, source: _source }).catch(() => {});
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

  const isOwnEntry = contest.entries.some(
    e => e.userId.toString() === req.session.userId.toString() && e.entryId.toString() === entryId
  );
  if (isOwnEntry) return res.status(403).json({ error: "You can't vote for your own entry." });

  // Organizers and jury are barred from voting in *regular* H2H contests while any tournament
  // they organize/serve on is in progress — contest.tournamentId is only set on a contest that
  // is itself a tournament match, which is unaffected (that's how group/knockout matches are
  // normally decided, jury tie-break votes are a separate TournamentJuryVote mechanism).
  if (!contest.tournamentId) {
    const juryTournamentIds = await TournamentJury.distinct('tournamentId', { userId: req.session.userId });
    const [isActiveOrganizer, isActiveJuror] = await Promise.all([
      Tournament.exists({ createdBy: req.session.userId, status: { $in: ['open', 'cooldown', 'active'] } }),
      juryTournamentIds.length
        ? Tournament.exists({ _id: { $in: juryTournamentIds }, status: { $in: ['open', 'cooldown', 'active'] } })
        : Promise.resolve(false),
    ]);
    if (isActiveOrganizer || isActiveJuror) {
      return res.status(403).json({ error: 'Tournament organizers and jury cannot vote in regular contests while a tournament is in progress.' });
    }
  }

  try {
    await ContestVote.create({ contestId: contest._id, entryId, userId: req.session.userId });
    Contest.updateOne({ _id: contest._id }, { $set: { lastActivityAt: new Date() } }).catch(() => {});
    const agg = await ContestVote.aggregate([
      { $match: { contestId: contest._id } },
      { $group: { _id: '$entryId', count: { $sum: 1 } } },
    ]);
    const voteCounts = {};
    let total = 0;
    for (const r of agg) { voteCounts[r._id.toString()] = r.count; total += r.count; }
    res.json({ ok: true, votedFor: entryId, voteCounts, total });

    // Fire-and-forget affinity signals — voted-for entry (0.9), voted-against (0.1)
    const otherEntry = contest.entries.find(e => e.entryId.toString() !== entryId);
    if (otherEntry) {
      Promise.all([
        Entry.findById(entryId).select('tags userId').lean(),
        Entry.findById(otherEntry.entryId).select('tags userId').lean(),
      ]).then(([eFor, eAgainst]) => {
        if (eFor)     updateAffinity(req.session.userId, eFor,     { signal: 0.9 }).catch(() => {});
        if (eAgainst) updateAffinity(req.session.userId, eAgainst, { signal: 0.1 }).catch(() => {});
      }).catch(() => {});
    }
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "You've already voted in this contest." });
    console.error('Contest vote error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.delete('/contests/:id', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });
  const contest = await Contest.findById(req.params.id).select('status createdBy entries').lean().catch(() => null);
  if (!contest) return res.status(404).json({ error: 'Contest not found.' });

  const uid = req.session.userId.toString();

  if (contest.status === 'pending') {
    if (contest.createdBy.toString() !== uid) return res.status(403).json({ error: 'Not your contest.' });
    await Promise.all([
      Contest.findByIdAndUpdate(req.params.id, { $set: { status: 'void', voidReason: 'canceled' } }),
      Nomination.findOneAndUpdate({ contestId: req.params.id, status: 'pending' }, { $set: { status: 'void' } }),
    ]);
    return res.json({ ok: true });
  }

  if (contest.status === 'void') {
    const isParticipant = contest.entries.some(e => e.userId.toString() === uid);
    if (!isParticipant) return res.status(403).json({ error: 'Not a participant in this contest.' });

    const cid = req.params.id;

    // Refund any unsettled active contributions before wiping records.
    // Credit wallets first — if that fails, contributions stay 'active' and retry is clean.
    // Mark withdrawn only after all credits succeed, so a retry cannot double-credit.
    const activeContribs = await ContestContribution.find({ contestId: cid, status: 'active' }).lean();
    if (activeContribs.length > 0) {
      const refundByContributor = {};
      for (const c of activeContribs) {
        const cuid = c.contributorId.toString();
        refundByContributor[cuid] = (refundByContributor[cuid] || 0) + c.amountCHL;
      }

      try {
        await Promise.all(Object.entries(refundByContributor).map(async ([cuid, amount]) => {
          const updatedUser = await User.findByIdAndUpdate(
            cuid,
            { $inc: { 'wallet.purchasedCHL': amount }, $set: { 'wallet.updatedAt': new Date() } },
            { new: true, select: 'wallet' },
          );
          if (!updatedUser) return;
          const balanceAfter  = (updatedUser.wallet.purchasedCHL || 0) + (updatedUser.wallet.earnedCHL || 0);
          const balanceBefore = balanceAfter - amount;
          await WalletTransaction.create({
            userId:        cuid,
            type:          'contribution_withdrawal',
            direction:     'credit',
            amountCHL:     amount,
            amountUSD:     +(amount * EXCHANGE_RATE).toFixed(2),
            exchangeRate:  EXCHANGE_RATE,
            balanceBefore,
            balanceAfter,
            status:        'completed',
            source:        'system',
            referenceId:   new mongoose.Types.ObjectId(cid),
            referenceType: 'Contest',
          });
        }));
        await ContestContribution.updateMany(
          { contestId: cid, status: 'active' },
          { $set: { status: 'withdrawn' } },
        );
      } catch (err) {
        console.error('Contest scrub: contribution refund failed:', err);
        return res.status(500).json({ error: 'Could not refund contributions. Please try again.' });
      }
    }

    try {
      const commentIds = await ContestComment.find({ contestId: cid }, '_id').lean().then(docs => docs.map(d => d._id));
      await Promise.all([
        Contest.deleteOne({ _id: cid }),
        Nomination.deleteMany({ contestId: cid }),
        ContestVote.deleteMany({ contestId: cid }),
        ContestLoop.deleteMany({ contestId: cid }),
        ContestComment.deleteMany({ contestId: cid }),
        ContestContribution.deleteMany({ contestId: cid }),
        commentIds.length > 0
          ? ContestCommentReport.deleteMany({ contestCommentId: { $in: commentIds } })
          : Promise.resolve(),
      ]);
    } catch (err) {
      console.error('Contest scrub: delete phase failed:', err);
      return res.status(500).json({ error: 'Could not remove the contest. Please try again.' });
    }
    return res.json({ ok: true, deleted: true });
  }

  return res.status(409).json({ error: 'Contest can only be canceled while pending, or removed when voided.' });
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

router.post('/contests/:id/forfeit', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const contest = await Contest.findById(req.params.id).lean().catch(() => null);
  if (!contest)                    return res.status(404).json({ error: 'Contest not found.' });
  if (contest.status !== 'active') return res.status(409).json({ error: 'Contest is not active.' });

  const uid         = req.session.userId.toString();
  const isNominator = contest.createdBy.toString() === uid;
  const nomineeEntry = contest.entries.find(e => e.userId.toString() !== contest.createdBy.toString());
  const isNominee   = nomineeEntry && nomineeEntry.userId.toString() === uid;

  if (!isNominator && !isNominee) return res.status(403).json({ error: 'You are not a participant in this contest.' });

  let winnerEntryId, voidReason;
  if (isNominee) {
    // Nominee forfeits — nominator wins, keeps their accumulated votes
    const nominatorEntry = contest.entries.find(e => e.userId.toString() === contest.createdBy.toString());
    winnerEntryId = nominatorEntry.entryId;
    voidReason    = 'nominee_forfeit';
  } else {
    // Nominator forfeits — nominee wins, gets their accumulated votes
    winnerEntryId = nomineeEntry.entryId;
    voidReason    = 'nominator_forfeit';
  }

  const [, forfeiter] = await Promise.all([
    Contest.findByIdAndUpdate(req.params.id, { $set: { status: 'void', voidReason, winnerEntryId, lastActivityAt: new Date() } }),
    User.findById(req.session.userId).select('username displayName avatar').lean(),
  ]);
  notifyLoopedIn(req.params.id, 'contest_forfeited', {
    actorUsername:    forfeiter?.username?.value    || 'Someone',
    actorDisplayName: forfeiter?.displayName?.value || forfeiter?.username?.value || 'Someone',
    actorAvatar:      forfeiter?.avatar?.value      || null,
    contestId:        req.params.id,
    voidReason,
    url:              '/contest/' + req.params.id,
  }, [req.session.userId]);
  res.json({ ok: true, voidReason });
});

// ── Take On ───────────────────────────────────────────────────────


router.patch('/entries/:id/allow-take-ons', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Entry not found.' });
  const entry = await Entry.findById(req.params.id).select('userId').lean().catch(() => null);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  if (entry.userId.toString() !== req.session.userId) return res.status(403).json({ error: 'Not your entry.' });
  const allow = req.body.allow === true || req.body.allow === 'true';
  await Entry.findByIdAndUpdate(req.params.id, { allowTakeOns: allow });
  res.json({ ok: true, allowTakeOns: allow });
});

router.post('/entries/:id/take-on', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Entry not found.' });

  const { challengerEntryId } = req.body;
  if (!challengerEntryId || !mongoose.isValidObjectId(challengerEntryId)) {
    return res.status(400).json({ error: 'Select an entry to challenge with.' });
  }
  if (challengerEntryId === req.params.id) {
    return res.status(400).json({ error: 'You cannot challenge an entry with itself.' });
  }

  const [targetEntry, challengerEntry, actor] = await Promise.all([
    Entry.findById(req.params.id).select('userId allowTakeOns mediaUrl mediaType').lean().catch(() => null),
    Entry.findById(challengerEntryId).select('userId mediaUrl mediaType').lean().catch(() => null),
    User.findById(req.session.userId).select('username displayName avatar idVerified').lean(),
  ]);

  if (!targetEntry)    return res.status(404).json({ error: 'Entry not found.' });
  if (!challengerEntry) return res.status(404).json({ error: 'Challenger entry not found.' });
  if (!actor)          return res.status(401).json({ error: 'Not authenticated.' });
  if (targetEntry.userId.toString() === req.session.userId) return res.status(400).json({ error: 'You cannot take on your own entry.' });
  if (challengerEntry.userId.toString() !== req.session.userId) return res.status(403).json({ error: 'Not your entry.' });
  if (targetEntry.allowTakeOns === false) return res.status(403).json({ error: 'This entry is not accepting take-ons.' });
  if (!actor.idVerified) return res.status(403).json({ error: 'identity_required' });

  const eligibility = await checkContestEligibility(req.session.userId);
  if (!eligibility.eligible) return res.status(403).json({ error: eligibility.reason });

  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const contest = await Contest.create({
    createdBy:    req.session.userId,
    visibility:   'public',
    status:       'pending',
    voidDeadline: expiry,
    windowHours:  72,
    entries:      [{ entryId: challengerEntry._id, userId: req.session.userId, submittedAt: new Date() }],
  });

  const nomination = await Nomination.create({
    contestId:         contest._id,
    nominatorId:       req.session.userId,
    nomineeId:         targetEntry.userId,
    expiresAt:         expiry,
    status:            'pending',
    type:              'take_on',
    challengerEntryId: challengerEntry._id,
    nomineeEntryId:    targetEntry._id,
  });

  Notification.create({
    userId:  targetEntry.userId,
    type:    'take_on_received',
    payload: {
      actorUsername:       actor.username?.value    || 'Someone',
      actorDisplayName:    actor.displayName?.value || actor.username?.value || 'Someone',
      actorAvatar:         actor.avatar?.value      || null,
      contestId:           contest._id,
      nominationId:        nomination._id,
      entryId:             targetEntry._id,
      challengerEntryId:   challengerEntry._id,
      challengerEntryUrl:  challengerEntry.mediaUrl,
      challengerEntryType: challengerEntry.mediaType,
      nomineeEntryUrl:     targetEntry.mediaUrl,
      nomineeEntryType:    targetEntry.mediaType,
      url:                 '/contest/' + contest._id,
    },
  }).catch(() => {});

  res.json({ ok: true, contestId: contest._id, nominationId: nomination._id });
});

router.post('/nominations/:id/take-on-accept', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const nom = await Nomination.findById(req.params.id).lean();
  if (!nom)                                                        return res.status(404).json({ error: 'Nomination not found.' });
  if (nom.type !== 'take_on')                                      return res.status(400).json({ error: 'Not a take-on nomination.' });
  if (nom.nomineeId.toString() !== req.session.userId.toString()) return res.status(403).json({ error: 'Not your take-on.' });
  if (nom.status !== 'pending')                                    return res.status(409).json({ error: 'Nomination already resolved.' });
  if (nom.expiresAt < new Date())                                  return res.status(410).json({ error: 'This take-on has expired.' });
  if (!nom.nomineeEntryId)                                         return res.status(400).json({ error: 'No target entry on this nomination.' });

  const acceptor = await User.findById(req.session.userId).select('username displayName avatar').lean();
  const votingDeadline = new Date(Date.now() + 72 * 60 * 60 * 1000);

  await Promise.all([
    Nomination.findByIdAndUpdate(req.params.id, { status: 'accepted' }),
    Contest.findByIdAndUpdate(nom.contestId, {
      $push:  { entries: { entryId: nom.nomineeEntryId, userId: req.session.userId, submittedAt: new Date() } },
      status: 'active',
      votingDeadline,
      lastActivityAt: new Date(),
    }),
    Entry.findByIdAndUpdate(nom.nomineeEntryId, { $inc: { takeOnCount: 1 } }),
  ]);

  Notification.create({
    userId:  nom.nominatorId,
    type:    'take_on_accepted',
    payload: {
      actorUsername:    acceptor?.username?.value    || 'Someone',
      actorDisplayName: acceptor?.displayName?.value || acceptor?.username?.value || 'Someone',
      actorAvatar:      acceptor?.avatar?.value      || null,
      contestId:        nom.contestId,
      url:              '/contest/' + nom.contestId,
    },
  }).catch(() => {});
  notifyLoopedIn(nom.contestId, 'nominee_accepted', {
    actorUsername:    acceptor?.username?.value    || 'Someone',
    actorDisplayName: acceptor?.displayName?.value || acceptor?.username?.value || 'Someone',
    actorAvatar:      acceptor?.avatar?.value      || null,
    contestId:        nom.contestId,
    url:              '/contest/' + nom.contestId,
  }, [req.session.userId, nom.nominatorId]);

  res.json({ ok: true, contestId: nom.contestId });
});

// ── Contest loop-in ────────────────────────────────────────────────

router.post('/contests/:id/loop-in', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const existing = await ContestLoop.findOne({ contestId: req.params.id, userId: req.session.userId });
  if (existing) {
    await existing.deleteOne();
    return res.json({ loopedIn: false });
  }

  const [, contest] = await Promise.all([
    ContestLoop.create({ contestId: req.params.id, userId: req.session.userId }),
    Contest.findById(req.params.id).select('entries').lean(),
  ]);
  res.json({ loopedIn: true });

  // Fire-and-forget creator affinity for both contestants — looping in signals interest in the creators
  if (contest?.entries?.length) {
    for (const e of contest.entries) {
      updateCreatorAffinity(req.session.userId, e.userId, 0.3).catch(() => {});
    }
  }
});

// ── Entry bookmark ────────────────────────────────────────────────

router.post('/entries/:id/bookmark', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const entry = await Entry.findById(req.params.id).select('userId tags').lean();
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  if (entry.userId.toString() === req.session.userId) return res.status(403).json({ error: 'You cannot bookmark your own entry.' });

  const existing = await EntryBookmark.findOne({ entryId: req.params.id, userId: req.session.userId });
  if (existing) {
    await existing.deleteOne();
    await Entry.findByIdAndUpdate(req.params.id, { $inc: { bookmarkCount: -1 } });
    return res.json({ bookmarked: false });
  }

  await EntryBookmark.create({ entryId: req.params.id, userId: req.session.userId });
  await Entry.findByIdAndUpdate(req.params.id, { $inc: { bookmarkCount: 1 } });
  res.json({ bookmarked: true });

  const _source = ['search', 'share', 'feed'].includes(req.body.source) ? req.body.source : 'feed';
  updateAffinity(req.session.userId, entry, { signal: 1.0, source: _source }).catch(() => {});
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

  let effectiveParentIdCC = null;
  if (parentId) {
    const parent = await ContestComment.findById(parentId).select('contestId parentId').lean().catch(() => null);
    if (!parent || parent.contestId.toString() !== req.params.id) {
      return res.status(400).json({ error: 'Invalid parent comment.' });
    }
    effectiveParentIdCC = parent.parentId || parent._id;
  }

  try {
    const comment = await ContestComment.create({
      contestId: contest._id,
      userId:    req.session.userId,
      parentId:  effectiveParentIdCC,
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

  const MOD_ROLES_CC = new Set(['moderator', 'supervisor', 'superadmin', 'founder']);
  const myId   = req.session.userId.toString();
  const isOwn  = comment.userId.toString() === myId;
  const isMod  = MOD_ROLES_CC.has(req.currentUser?.role);
  if (!isOwn && !isMod) return res.status(403).json({ error: 'Not authorized.' });

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

  const existingCC = await ContestCommentReport.findOne({ contestCommentId: comment._id, reportedBy: req.session.userId }).lean();
  if (existingCC) {
    if (existingCC.status !== 'rejected') return res.status(409).json({ error: "You've already reported this comment." });
    // Admin dismissed the previous report — allow re-report
    await ContestCommentReport.updateOne({ _id: existingCC._id }, { $set: { status: 'pending' } });
    await ContestComment.updateOne({ _id: comment._id }, { $set: { hidden: true } });
    return res.json({ ok: true });
  }

  try {
    await ContestCommentReport.create({
      contestCommentId: comment._id,
      reportedBy:       req.session.userId,
    });
    await ContestComment.updateOne({ _id: comment._id }, { $set: { hidden: true } });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "You've already reported this comment." });
    console.error('Contest comment report error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.post('/contests/:id/comments/:cid/react', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }
  const { type } = req.body;
  if (!['like', 'dislike'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });
  const comment = await ContestComment.findById(req.params.cid).select('contestId likes dislikes').catch(() => null);
  if (!comment || comment.contestId.toString() !== req.params.id) return res.status(404).json({ error: 'Comment not found.' });
  const uid = req.session.userId.toString();
  const hasLiked    = comment.likes.some(id => id.toString() === uid);
  const hasDisliked = comment.dislikes.some(id => id.toString() === uid);
  let update;
  if (type === 'like') {
    if (hasLiked)         update = { $pull: { likes: req.session.userId } };
    else if (hasDisliked) update = { $pull: { dislikes: req.session.userId }, $addToSet: { likes: req.session.userId } };
    else                  update = { $addToSet: { likes: req.session.userId } };
  } else {
    if (hasDisliked)   update = { $pull: { dislikes: req.session.userId } };
    else if (hasLiked) update = { $pull: { likes: req.session.userId }, $addToSet: { dislikes: req.session.userId } };
    else               update = { $addToSet: { dislikes: req.session.userId } };
  }
  const updated = await ContestComment.findByIdAndUpdate(comment._id, update, { new: true }).select('likes dislikes');
  const userLiked    = updated.likes.some(id => id.toString() === uid);
  const userDisliked = updated.dislikes.some(id => id.toString() === uid);
  res.json({ likes: updated.likes.length, dislikes: updated.dislikes.length, userLiked, userDisliked });
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

// ── Entry comments ────────────────────────────────────────────────

router.post('/entries/:eid/comments', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.eid)) return res.status(400).json({ error: 'Invalid ID.' });

  const body = req.body.body?.trim();
  if (!body) return res.status(400).json({ error: 'Comment body is required.' });
  if (body.replace(/\s/g, '').length > 280) return res.status(400).json({ error: 'Comment cannot exceed 280 characters (spaces not counted).' });

  const parentId = req.body.parentId || null;
  if (parentId && !mongoose.isValidObjectId(parentId)) return res.status(400).json({ error: 'Invalid parentId.' });

  const entry = await Entry.findById(req.params.eid).select('userId commentsEnabled tags').lean().catch(() => null);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  if (!entry.commentsEnabled) return res.status(403).json({ error: 'Comments are disabled for this entry.' });

  const commenterId = req.session.userId.toString();
  const entryOwnerId = entry.userId.toString();

  if (commenterId !== entryOwnerId) {
    const owner = await User.findById(entry.userId).select('privacySettings').lean().catch(() => null);
    const rule  = owner?.privacySettings?.whoCanComment || 'everyone';

    if (rule === 'followers_only') {
      const follows = await Follow.exists({ followerId: commenterId, followingId: entryOwnerId });
      if (!follows) return res.status(403).json({ error: 'Only followers can comment on this entry.' });
    } else if (rule === 'contributors_only') {
      const contestIds = await Contest.find({ 'entries.entryId': entry._id }).select('_id').lean().catch(() => []);
      if (!contestIds.length) return res.status(403).json({ error: 'Only contest contributors can comment on this entry.' });
      const isContributor = await ContestContribution.exists({
        contestId: { $in: contestIds.map(c => c._id) },
        contributorId: commenterId,
      });
      if (!isContributor) return res.status(403).json({ error: 'Only contest contributors can comment on this entry.' });
    }
  }

  let parentComment = null;
  let effectiveParentId = null;
  if (parentId) {
    parentComment = await Comment.findById(parentId).select('entryId parentId userId').lean().catch(() => null);
    if (!parentComment || parentComment.entryId.toString() !== req.params.eid) {
      return res.status(400).json({ error: 'Invalid parent comment.' });
    }
    effectiveParentId = parentComment.parentId || parentComment._id;
  }

  try {
    const comment = await Comment.create({
      entryId:  req.params.eid,
      userId:   req.session.userId,
      parentId: effectiveParentId,
      body,
    });
    await Entry.updateOne({ _id: req.params.eid }, { $inc: { commentCount: 1 } });
    const user = await User.findById(req.session.userId).select('username displayName avatar').lean();

    const actorUsername    = user.username?.value    || 'Someone';
    const actorDisplayName = user.displayName?.value || user.username?.value || 'Someone';
    const actorAvatar      = user.avatar?.value      || null;
    const preview       = body.length > 80 ? body.slice(0, 80) + '…' : body;
    const entryUrl      = '/entry/' + req.params.eid;
    const myId          = req.session.userId.toString();
    const notifPromises = [];

    if (!parentId) {
      // Top-level comment — notify entry owner
      if (entry.userId.toString() !== myId) {
        notifPromises.push(Notification.create({
          userId:  entry.userId,
          type:    'comment',
          payload: { actorUsername, actorDisplayName, actorAvatar, preview, url: entryUrl },
        }));
      }
    } else {
      // Reply — notify parent comment author
      if (parentComment.userId.toString() !== myId) {
        notifPromises.push(Notification.create({
          userId:  parentComment.userId,
          type:    'reply',
          payload: { actorUsername, actorDisplayName, actorAvatar, preview, url: entryUrl },
        }));
      }
    }

    await Promise.allSettled(notifPromises);

    res.json({
      _id:       comment._id,
      entryId:   comment.entryId,
      parentId:  comment.parentId,
      body:      comment.body,
      createdAt: comment.createdAt,
      user: {
        username:    user.username?.value,
        displayName: user.displayName?.value || null,
        avatar:      user.avatar?.value || null,
      },
    });

    if (entry.userId.toString() !== req.session.userId.toString()) {
      const _source = ['search', 'share', 'feed'].includes(req.body.source) ? req.body.source : 'feed';
      updateAffinity(req.session.userId, entry, { signal: 0.7, source: _source }).catch(() => {});
    }
  } catch (err) {
    console.error('Entry comment create error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.patch('/entries/:eid/comments/:cid', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.eid) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }
  const body = req.body.body?.trim();
  if (!body) return res.status(400).json({ error: 'Comment body is required.' });
  if (body.replace(/\s/g, '').length > 280) return res.status(400).json({ error: 'Comment cannot exceed 280 characters (spaces not counted).' });

  const comment = await Comment.findById(req.params.cid).catch(() => null);
  if (!comment || comment.entryId.toString() !== req.params.eid) return res.status(404).json({ error: 'Comment not found.' });
  if (comment.userId.toString() !== req.session.userId.toString()) return res.status(403).json({ error: 'Not your comment.' });

  comment.body     = body;
  comment.editedAt = new Date();
  await comment.save();
  res.json({ ok: true, body: comment.body, editedAt: comment.editedAt });
});

router.delete('/entries/:eid/comments/:cid', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.eid) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }
  const [comment, entry] = await Promise.all([
    Comment.findById(req.params.cid).select('entryId userId parentId').lean().catch(() => null),
    Entry.findById(req.params.eid).select('userId').lean().catch(() => null),
  ]);
  if (!comment || comment.entryId.toString() !== req.params.eid) return res.status(404).json({ error: 'Comment not found.' });
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });

  const MOD_ROLES    = new Set(['moderator', 'supervisor', 'superadmin', 'founder']);
  const isOwn        = comment.userId.toString() === req.session.userId.toString();
  const isEntryOwner = entry.userId.toString() === req.session.userId.toString();
  const isMod        = MOD_ROLES.has(req.currentUser?.role);
  if (!isOwn && !isEntryOwner && !isMod) return res.status(403).json({ error: 'Not authorized.' });

  let deletedCount = 1;
  if (!comment.parentId) {
    const replies = await Comment.find({ parentId: comment._id }).select('_id').lean();
    if (replies.length) {
      await CommentReport.deleteMany({ commentId: { $in: replies.map(r => r._id) } });
      await Comment.deleteMany({ parentId: comment._id });
      deletedCount += replies.length;
    }
    await CommentReport.deleteMany({ commentId: comment._id });
  } else {
    await CommentReport.deleteMany({ commentId: comment._id });
  }
  await Comment.deleteOne({ _id: comment._id });
  await Entry.updateOne({ _id: req.params.eid }, { $inc: { commentCount: -deletedCount } });
  res.json({ ok: true, deletedCount });
});

router.post('/entries/:eid/comments/:cid/report', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.eid) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }
  const comment = await Comment.findById(req.params.cid).select('userId entryId').lean().catch(() => null);
  if (!comment || comment.entryId.toString() !== req.params.eid) return res.status(404).json({ error: 'Comment not found.' });
  if (comment.userId.toString() === req.session.userId.toString()) return res.status(400).json({ error: "You can't report your own comment." });

  const reasons = Array.isArray(req.body.reasons)
    ? req.body.reasons.filter(r => typeof r === 'string').slice(0, 10)
    : [];

  const existing = await CommentReport.findOne({ commentId: comment._id, reportedBy: req.session.userId }).lean();
  if (existing) {
    if (existing.status !== 'rejected') return res.status(409).json({ error: "You've already reported this comment." });
    // Admin dismissed the previous report — allow re-report
    await CommentReport.updateOne({ _id: existing._id }, { $set: { status: 'pending', reasons } });
    await Comment.updateOne({ _id: comment._id }, { $set: { hidden: true } });
    return res.json({ ok: true });
  }

  try {
    await CommentReport.create({ commentId: comment._id, reportedBy: req.session.userId, reasons });
    await Comment.updateOne({ _id: comment._id }, { $set: { hidden: true } });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "You've already reported this comment." });
    console.error('Comment report error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.post('/entries/:eid/comments/:cid/pin', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.eid) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }
  const entry = await Entry.findById(req.params.eid).select('userId').lean().catch(() => null);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  if (entry.userId.toString() !== req.session.userId.toString()) {
    return res.status(403).json({ error: 'Only the entry owner can pin comments.' });
  }
  const comment = await Comment.findById(req.params.cid).select('entryId pinnedAt').catch(() => null);
  if (!comment || comment.entryId.toString() !== req.params.eid) {
    return res.status(404).json({ error: 'Comment not found.' });
  }
  if (comment.pinnedAt) {
    await Comment.updateOne({ _id: comment._id }, { $set: { pinnedAt: null } });
    return res.json({ pinned: false });
  }
  const pinnedCount = await Comment.countDocuments({ entryId: comment.entryId, pinnedAt: { $ne: null } });
  if (pinnedCount >= 2) return res.status(400).json({ error: 'You can only pin up to 2 comments.' });
  await Comment.updateOne({ _id: comment._id }, { $set: { pinnedAt: new Date() } });
  res.json({ pinned: true });
});

router.post('/entries/:eid/comments/:cid/react', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.eid) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }
  const { type } = req.body;
  if (!['like', 'dislike'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });
  const comment = await Comment.findById(req.params.cid).select('entryId likes dislikes').catch(() => null);
  if (!comment || comment.entryId.toString() !== req.params.eid) return res.status(404).json({ error: 'Comment not found.' });
  const uid = req.session.userId.toString();
  const hasLiked    = comment.likes.some(id => id.toString() === uid);
  const hasDisliked = comment.dislikes.some(id => id.toString() === uid);
  let update;
  if (type === 'like') {
    if (hasLiked)         update = { $pull: { likes: req.session.userId } };
    else if (hasDisliked) update = { $pull: { dislikes: req.session.userId }, $addToSet: { likes: req.session.userId } };
    else                  update = { $addToSet: { likes: req.session.userId } };
  } else {
    if (hasDisliked)   update = { $pull: { dislikes: req.session.userId } };
    else if (hasLiked) update = { $pull: { likes: req.session.userId }, $addToSet: { dislikes: req.session.userId } };
    else               update = { $addToSet: { dislikes: req.session.userId } };
  }
  const updated = await Comment.findByIdAndUpdate(comment._id, update, { new: true }).select('likes dislikes');
  const userLiked    = updated.likes.some(id => id.toString() === uid);
  const userDisliked = updated.dislikes.some(id => id.toString() === uid);
  res.json({ likes: updated.likes.length, dislikes: updated.dislikes.length, userLiked, userDisliked });
});

// ── Entry report ──────────────────────────────────────────────────────────────
router.post('/entries/:eid/report', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!mongoose.isValidObjectId(req.params.eid)) return res.status(400).json({ error: 'Invalid ID.' });

  const entry = await Entry.findById(req.params.eid).select('userId hidden').lean().catch(() => null);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  if (entry.userId.toString() === req.session.userId.toString()) {
    return res.status(400).json({ error: "You can't report your own entry." });
  }

  try {
    await EntryReport.create({ entryId: req.params.eid, reportedBy: req.session.userId });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "You've already reported this entry." });
    console.error('Entry report error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }

  // Check thresholds only if entry isn't already hidden
  if (!entry.hidden) {
    const settings = await PlatformSettings.findOne({ key: 'global' }).lean();
    const thresholds = settings?.entryReportThresholds || [
      { count: 3,  windowMinutes: 60   },
      { count: 5,  windowMinutes: 360  },
      { count: 10, windowMinutes: 1440 },
    ];

    const now = new Date();
    let shouldHide = false;
    for (const { count, windowMinutes } of thresholds) {
      const since = new Date(now - windowMinutes * 60 * 1000);
      const windowCount = await EntryReport.countDocuments({
        entryId: req.params.eid,
        status: 'pending',
        createdAt: { $gte: since },
      });
      if (windowCount >= count) { shouldHide = true; break; }
    }

    if (shouldHide) {
      await Entry.updateOne({ _id: req.params.eid }, { $set: { hidden: true } });
      await Notification.create({
        userId: entry.userId,
        type: 'entry_reported',
        payload: { entryId: req.params.eid },
      });

      // Stall any active contests containing this entry
      const stalledContests = await Contest.find({
        status: 'active',
        stalled: false,
        'entries.entryId': new mongoose.Types.ObjectId(req.params.eid),
      }).select('_id entries').lean();

      for (const contest of stalledContests) {
        await Contest.updateOne({ _id: contest._id }, { $set: { stalled: true, stalledAt: now } });

        const contestantUserIds = contest.entries.map(e => e.userId);
        const stalledPayload = { contestId: contest._id.toString(), entryId: req.params.eid };

        await Notification.insertMany(
          contestantUserIds.map(uid => ({ userId: uid, type: 'contest_stalled', payload: stalledPayload, read: false })),
          { ordered: false }
        );

        await notifyLoopedIn(contest._id, 'contest_stalled', stalledPayload, contestantUserIds);
      }
    }
  }

  res.json({ ok: true });
});

// ── User block / report ───────────────────────────────────────────────────────
router.post('/users/:username/block', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const target = await User.findOne({ 'username.value': req.params.username.toLowerCase() }).select('_id').lean();
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (target._id.toString() === req.session.userId) {
    return res.status(400).json({ error: 'Cannot block yourself' });
  }

  const existing = await UserBlock.findOne({ blockerId: req.session.userId, blockedId: target._id }).lean();
  if (existing) {
    await UserBlock.deleteOne({ _id: existing._id });
    return res.json({ blocked: false });
  }

  try {
    await UserBlock.create({ blockerId: req.session.userId, blockedId: target._id });
  } catch (err) {
    if (err.code === 11000) return res.json({ blocked: true });
    return res.status(500).json({ error: 'Something went wrong.' });
  }

  // Silently remove any follow relationship in both directions
  await Promise.all([
    Follow.deleteOne({ followerId: req.session.userId, followingId: target._id }),
    Follow.deleteOne({ followerId: target._id, followingId: req.session.userId }),
  ]);

  return res.json({ blocked: true });
});

router.post('/users/:username/report', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const target = await User.findOne({ 'username.value': req.params.username.toLowerCase() }).select('_id').lean();
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (target._id.toString() === req.session.userId) {
    return res.status(400).json({ error: "You can't report yourself." });
  }

  const reasons = Array.isArray(req.body.reasons)
    ? req.body.reasons.filter(r => typeof r === 'string').slice(0, 10)
    : [];

  try {
    await UserReport.create({ reportedUserId: target._id, reportedBy: req.session.userId, reasons });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "You've already reported this user." });
    console.error('User report error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }

  res.json({ ok: true });
});

// ── Profile share tracking ────────────────────────────────────────────────────
router.post('/users/:username/share', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const target = await User.findOne({ 'username.value': req.params.username.toLowerCase() }).select('_id').lean();
  if (!target) return res.status(404).json({ error: 'User not found' });

  const method = req.body.method === 'native' ? 'native' : 'clipboard';
  const userAgent = req.headers['user-agent'] || '';

  ProfileShare.create({
    sharerId:      req.session.userId,
    profileUserId: target._id,
    method,
    userAgent,
  }).catch(() => {});

  res.json({ ok: true });
});

// ── Announcement dismiss ──────────────────────────────────────────────────────
router.post('/announcements/:id/dismiss', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid ID' });

  try {
    await AnnouncementDismissal.create({ announcementId: id, userId: req.session.userId });
  } catch (err) {
    if (err.code !== 11000) {
      console.error('Dismiss error:', err);
      return res.status(500).json({ error: 'Something went wrong.' });
    }
    // Already dismissed — continue to find next
  }

  // Stain affinity: dismissal = low interest signal
  const userId = req.session.userId;
  const { stain } = req.body;
  if (stain) updateStainAffinity(userId, stain, SIGNAL_ANNOUNCEMENT_DISMISS).catch(() => {});

  // Return next matching, non-dismissed announcement
  const now = new Date();
  const dismissed = await AnnouncementDismissal.distinct('announcementId', { userId });
  const candidates = await Announcement.find({
    status: 'active',
    _id: { $nin: dismissed },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).sort({ publishedAt: -1 }).lean();

  // Basic filter pass — same logic as middleware (filters requiring missing User fields skipped)
  const next = candidates[0] || null;
  res.json({ next });
});

// ── Announcement impression ───────────────────────────────────────────────────
router.post('/announcements/:id/impression', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).end();
  try {
    await AnnouncementImpression.create({ announcementId: id, userId: req.session.userId });
  } catch (err) {
    if (err.code !== 11000) console.error('Impression error:', err);
    // 11000 = already logged for this user — silently ignore
  }
  res.json({ ok: true });
});

// ── Announcement click ────────────────────────────────────────────────────────
router.post('/announcements/:id/click', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).end();
  try {
    await AnnouncementClick.create({ announcementId: id, userId: req.session.userId });
  } catch (err) {
    if (err.code !== 11000) console.error('Click error:', err);
  }

  // Stain affinity: click = strong positive interest signal
  const { stain: clickStain } = req.body;
  if (clickStain) updateStainAffinity(req.session.userId, clickStain, SIGNAL_ANNOUNCEMENT_CLICK).catch(() => {});

  res.json({ ok: true });
});

// ── Contest Contributions ──────────────────────────────────────────

const EXCHANGE_RATE = 0.20;

// Runs fn(session) inside a MongoDB multi-document transaction when the deployment
// supports it (Atlas / replica set). Falls back to fn(null) on standalone dev MongoDB.
// The fallback is safe because: (a) the "no replica set" error fires before any fn
// operations execute, and (b) each individual write already uses $inc (atomic).
async function withTxnOrFallback(fn) {
  const session = await mongoose.startSession();
  let needsFallback = false;
  try {
    await session.withTransaction(() => fn(session));
  } catch (err) {
    const noReplicaSet =
      (err?.message || '').includes('retryable writes') ||
      (err?.message || '').includes('Transaction numbers') ||
      (err?.message || '').includes('replica set');
    if (!noReplicaSet) throw err;
    needsFallback = true;
  } finally {
    await session.endSession();
  }
  if (needsFallback) await fn(null);
}

// POST /api/contests/:id/contribute
router.post('/contests/:id/contribute', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const { entryId, amountCHL: rawAmount } = req.body;
  const amountCHL = parseInt(rawAmount, 10);

  if (!mongoose.isValidObjectId(entryId)) return res.status(400).json({ error: 'Invalid entry ID.' });
  if (!amountCHL || amountCHL < 1) return res.status(400).json({ error: 'Amount must be at least 1 chilli.' });

  const contest = await Contest.findById(req.params.id).select('entries status').lean();
  if (!contest) return res.status(404).json({ error: 'Contest not found.' });
  if (contest.status !== 'active') return res.status(400).json({ error: 'Contest is not active.' });

  const entry = contest.entries.find(e => e.entryId.toString() === entryId);
  if (!entry) return res.status(400).json({ error: 'Entry not part of this contest.' });
  if (entry.userId.toString() === req.session.userId.toString()) {
    return res.status(403).json({ error: 'You cannot contribute to your own entry.' });
  }

  const existing = await ContestContribution.findOne({
    contestId:     contest._id,
    contributorId: req.session.userId,
    entryId,
  });

  const beneficiaryEntry = contest.entries.find(e => e.entryId.toString() === entryId);

  let contribution, balanceBefore, balanceAfter;
  try {
    await withTxnOrFallback(async (session) => {
      // Read wallet to compute two-pool debit (purchasedCHL first, then earnedCHL)
      const userWallet = await User.findById(req.session.userId).select('wallet').session(session).lean();
      if (!userWallet) { const err = new Error('User not found.'); err.statusCode = 404; throw err; }
      const purchased = userWallet.wallet?.purchasedCHL || 0;
      const earned    = userWallet.wallet?.earnedCHL    || 0;
      if (purchased + earned < amountCHL) {
        const err = new Error('Insufficient chilli balance.'); err.statusCode = 400; throw err;
      }
      const fromPurchased = Math.min(purchased, amountCHL);
      const fromEarned    = amountCHL - fromPurchased;
      const walletInc = {};
      if (fromPurchased > 0) walletInc['wallet.purchasedCHL'] = -fromPurchased;
      if (fromEarned    > 0) walletInc['wallet.earnedCHL']    = -fromEarned;
      await User.findByIdAndUpdate(req.session.userId, { $inc: walletInc, $set: { 'wallet.updatedAt': new Date() } }, { session });
      balanceBefore = purchased + earned;
      balanceAfter  = balanceBefore - amountCHL;

      if (existing && existing.status === 'active') {
        // Additive: amountCHL is the additional amount on top of existing total
        existing.amountCHL += amountCHL;
        await existing.save({ session });
        contribution = existing;
      } else if (existing) {
        // Re-activate a withdrawn contribution from scratch
        existing.amountCHL = amountCHL;
        existing.status    = 'active';
        await existing.save({ session });
        contribution = existing;
      } else {
        [contribution] = await ContestContribution.create([{
          contestId:     contest._id,
          entryId,
          beneficiaryId: beneficiaryEntry.userId,
          contributorId: req.session.userId,
          amountCHL,
          status:        'active',
        }], { session });
      }

      await WalletTransaction.create([{
        userId:        req.session.userId,
        type:          'contribution',
        direction:     'debit',
        amountCHL,
        amountUSD:     +(amountCHL * EXCHANGE_RATE).toFixed(2),
        exchangeRate:  EXCHANGE_RATE,
        balanceBefore,
        balanceAfter,
        status:        'completed',
        source:        'contest_close',
        referenceId:   contribution._id,
        referenceType: 'ContestContribution',
      }], { session });
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error('Contribute transaction error:', err);
    return res.status(500).json({ error: 'Transaction failed. Please try again.' });
  }

  // Notify the entry owner of the contribution (fire-and-forget)
  User.findById(req.session.userId).select('username displayName avatar').lean().then(contributor => {
    if (!contributor) return;
    Notification.create({
      userId:  beneficiaryEntry.userId,
      type:    'contest_contribution',
      payload: {
        actorUsername:    contributor.username?.value    || contributor.username    || 'Someone',
        actorDisplayName: contributor.displayName?.value || contributor.displayName || null,
        actorAvatar:      contributor.avatar?.value      || contributor.avatar      || null,
        amountCHL,
        contestId:        contest._id,
        url:              '/contest/' + contest._id,
      },
    });
  }).catch(() => {});

  const agg = await ContestContribution.aggregate([
    { $match: { contestId: contest._id, status: { $ne: 'withdrawn' } } },
    { $group: { _id: '$entryId', totalCHL: { $sum: '$amountCHL' } } },
  ]);
  const grossByEntry = {};
  for (const r of agg) { grossByEntry[r._id.toString()] = r.totalCHL; }

  res.json({ ok: true, newBalance: balanceAfter, grossByEntry, myAmountCHL: amountCHL });

  // Fire-and-forget affinity signal — financial backing = strong creator + stain endorsement
  Entry.findById(entryId).select('tags userId').lean()
    .then(e => { if (e) updateAffinity(req.session.userId, e, { signal: 0.6 }).catch(() => {}); })
    .catch(() => {});
});

// PATCH /api/contests/:id/contribute/:entryId — adjust contribution amount
router.patch('/contests/:id/contribute/:entryId', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const { amountCHL: rawAmount } = req.body;
  const newAmount = parseInt(rawAmount, 10);
  if (!newAmount || newAmount < 1) return res.status(400).json({ error: 'Amount must be at least 1 chilli.' });

  const contest = await Contest.findById(req.params.id).select('status').lean();
  if (!contest || contest.status !== 'active') return res.status(400).json({ error: 'Contest is not active.' });

  const contribution = await ContestContribution.findOne({
    contestId:     contest._id,
    entryId:       req.params.entryId,
    contributorId: req.session.userId,
    status:        'active',
  });
  if (!contribution) return res.status(404).json({ error: 'No active contribution found.' });

  const delta = newAmount - contribution.amountCHL;
  if (delta === 0) return res.json({ ok: true, newBalance: null, myAmountCHL: newAmount });

  let balanceBefore, balanceAfter;
  try {
    await withTxnOrFallback(async (session) => {
      if (delta > 0) {
        // Debit: purchasedCHL first, then earnedCHL
        const userWallet = await User.findById(req.session.userId).select('wallet').session(session).lean();
        if (!userWallet) { const err = new Error('User not found.'); err.statusCode = 404; throw err; }
        const purchased = userWallet.wallet?.purchasedCHL || 0;
        const earned    = userWallet.wallet?.earnedCHL    || 0;
        if (purchased + earned < delta) {
          const err = new Error('Insufficient chilli balance.'); err.statusCode = 400; throw err;
        }
        const fromPurchased = Math.min(purchased, delta);
        const fromEarned    = delta - fromPurchased;
        const walletInc = {};
        if (fromPurchased > 0) walletInc['wallet.purchasedCHL'] = -fromPurchased;
        if (fromEarned    > 0) walletInc['wallet.earnedCHL']    = -fromEarned;
        await User.findByIdAndUpdate(req.session.userId, { $inc: walletInc, $set: { 'wallet.updatedAt': new Date() } }, { session });
        balanceBefore = purchased + earned;
        balanceAfter  = balanceBefore - delta;
      } else {
        // Refund goes back to purchasedCHL
        const updatedUser = await User.findByIdAndUpdate(
          req.session.userId,
          { $inc: { 'wallet.purchasedCHL': -delta }, $set: { 'wallet.updatedAt': new Date() } },
          { new: true, select: 'wallet', session }
        );
        balanceAfter  = (updatedUser.wallet.purchasedCHL || 0) + (updatedUser.wallet.earnedCHL || 0);
        balanceBefore = balanceAfter + delta;
      }

      contribution.amountCHL = newAmount;
      await contribution.save({ session });

      await WalletTransaction.create([{
        userId:        req.session.userId,
        type:          'contribution_adjustment',
        direction:     delta > 0 ? 'debit' : 'credit',
        amountCHL:     Math.abs(delta),
        amountUSD:     +(Math.abs(delta) * EXCHANGE_RATE).toFixed(2),
        exchangeRate:  EXCHANGE_RATE,
        balanceBefore,
        balanceAfter,
        status:        'completed',
        source:        'contest_close',
        referenceId:   contribution._id,
        referenceType: 'ContestContribution',
      }], { session });
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error('Adjust contribution transaction error:', err);
    return res.status(500).json({ error: 'Transaction failed. Please try again.' });
  }

  const agg = await ContestContribution.aggregate([
    { $match: { contestId: contest._id, status: { $ne: 'withdrawn' } } },
    { $group: { _id: '$entryId', totalCHL: { $sum: '$amountCHL' } } },
  ]);
  const grossByEntry = {};
  for (const r of agg) { grossByEntry[r._id.toString()] = r.totalCHL; }

  res.json({ ok: true, newBalance: balanceAfter, grossByEntry, myAmountCHL: newAmount });
});

// DELETE /api/contests/:id/contribute/:entryId — withdraw contribution
router.delete('/contests/:id/contribute/:entryId', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const contest = await Contest.findById(req.params.id).select('status').lean();
  if (!contest || contest.status !== 'active') return res.status(400).json({ error: 'Contest is not active.' });

  const contribution = await ContestContribution.findOne({
    contestId:     contest._id,
    entryId:       req.params.entryId,
    contributorId: req.session.userId,
    status:        'active',
  });
  if (!contribution) return res.status(404).json({ error: 'No active contribution found.' });

  const refundAmount = contribution.amountCHL;

  let balanceBefore, balanceAfter;
  try {
    await withTxnOrFallback(async (session) => {
      contribution.status = 'withdrawn';
      await contribution.save({ session });

      const updatedUser = await User.findByIdAndUpdate(
        req.session.userId,
        { $inc: { 'wallet.purchasedCHL': refundAmount }, $set: { 'wallet.updatedAt': new Date() } },
        { new: true, select: 'wallet', session }
      );
      if (!updatedUser) throw new Error('User not found during withdrawal.');
      balanceAfter  = (updatedUser.wallet.purchasedCHL || 0) + (updatedUser.wallet.earnedCHL || 0);
      balanceBefore = balanceAfter - refundAmount;

      await WalletTransaction.create([{
        userId:        req.session.userId,
        type:          'contribution_withdrawal',
        direction:     'credit',
        amountCHL:     refundAmount,
        amountUSD:     +(refundAmount * EXCHANGE_RATE).toFixed(2),
        exchangeRate:  EXCHANGE_RATE,
        balanceBefore,
        balanceAfter,
        status:        'completed',
        source:        'contest_close',
        referenceId:   contribution._id,
        referenceType: 'ContestContribution',
      }], { session });
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error('Withdraw contribution transaction error:', err);
    return res.status(500).json({ error: 'Transaction failed. Please try again.' });
  }

  const agg = await ContestContribution.aggregate([
    { $match: { contestId: contest._id, status: { $ne: 'withdrawn' } } },
    { $group: { _id: '$entryId', totalCHL: { $sum: '$amountCHL' } } },
  ]);
  const grossByEntry = {};
  for (const r of agg) { grossByEntry[r._id.toString()] = r.totalCHL; }

  res.json({ ok: true, newBalance: balanceAfter, grossByEntry, myAmountCHL: 0 });
});

// GET /api/wallet/transactions — filtered list for settings tab AJAX
router.get('/wallet/transactions', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const userId = req.session.userId;
  const { months, types } = req.query;
  const filter = { userId };

  if (months) {
    const monthList = months.split(',').map(m => m.trim()).filter(m => /^\d{4}-\d{2}$/.test(m));
    if (monthList.length === 1) {
      const [y, m] = monthList[0].split('-').map(Number);
      filter.createdAt = { $gte: new Date(y, m - 1, 1), $lt: new Date(y, m, 1) };
    } else if (monthList.length > 1) {
      filter.$or = monthList.map(mo => {
        const [y, m] = mo.split('-').map(Number);
        return { createdAt: { $gte: new Date(y, m - 1, 1), $lt: new Date(y, m, 1) } };
      });
    }
  }

  if (types) {
    const typeList = types.split(',').map(t => t.trim()).filter(Boolean);
    if (typeList.length === 1) filter.type = typeList[0];
    else if (typeList.length > 1) filter.type = { $in: typeList };
  }

  const [transactions, total] = await Promise.all([
    WalletTransaction.find(filter).sort({ createdAt: -1 }).limit(12).lean(),
    WalletTransaction.countDocuments(filter),
  ]);

  res.json({ transactions, total });
});

module.exports = router;
