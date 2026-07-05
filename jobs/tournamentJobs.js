const Tournament      = require('../models/Tournament');
const TournamentEntry = require('../models/TournamentEntry');
const TournamentJury  = require('../models/TournamentJury');
const TournamentMatch = require('../models/TournamentMatch');
const Contest         = require('../models/Contest');
const Notification    = require('../models/Notification');
const { creditWallet } = require('../utils/wallet');
const notifyEntryLoopedIn = require('../utils/tournamentEntryLoop');

const MIN_JURY = 5;

async function autoAcceptPendingJury(tournamentId) {
  await TournamentJury.updateMany(
    { tournamentId, status: 'pending' },
    { $set: { status: 'accepted', respondedAt: new Date() } },
  );
}

async function cancelTournament(tournamentId, reason) {
  const tournament = await Tournament.findOneAndUpdate(
    { _id: tournamentId, status: { $in: ['open', 'cooldown'] } },
    { $set: { status: 'canceled', cancelReason: reason } },
  ).lean();

  if (!tournament) return; // already handled

  // Tournament never reached the point of jurors actually voting, so releasing them
  // outright (rather than marking declined/missed) is correct — no penalty is owed.
  await TournamentJury.deleteMany({ tournamentId });

  // Refund prize pool to organizer's purchasedCHL
  const total = tournament.prizes.first + tournament.prizes.second + (tournament.prizes.third || 0);

  await creditWallet(tournament.createdBy, total, {
    type:          'tournament_prize_refund',
    source:        'tournament_cancel',
    referenceId:   tournamentId,
    referenceType: 'Tournament',
  });

  // Notify organizer
  await Notification.create({
    userId:  tournament.createdBy,
    type:    'tournament_canceled',
    payload: { tournamentId, reason, url: '/tournament/' + tournamentId },
  });

  // Notify all approved + pending contestants
  const entries = await TournamentEntry.find({
    tournamentId,
    approvalStatus: { $in: ['approved', 'pending'] },
  }).select('userId').lean();

  const contestantNotifications = entries
    .filter(e => e.userId.toString() !== tournament.createdBy.toString())
    .map(e => ({
      userId:  e.userId,
      type:    'tournament_canceled',
      payload: { tournamentId, reason, url: '/tournaments' },
    }));

  if (contestantNotifications.length > 0) {
    await Notification.insertMany(contestantNotifications, { ordered: false });
  }
}

// Status-filtered so a concurrent job run / cap-reached route call can't double-activate.
async function activateTournament(tournamentId) {
  const tournament = await Tournament.findOneAndUpdate(
    { _id: tournamentId, status: 'cooldown' },
    { $set: { status: 'active', activeAt: new Date(), stage: 'group' } },
    { new: true },
  );
  if (!tournament) return; // already activated/canceled by a concurrent call

  const { generateGroups, generateGroupMatches } = require('../utils/tournamentScheduler');
  const groups = await generateGroups(tournament._id);
  for (const group of groups) {
    await generateGroupMatches(group._id);
  }

  const entries = await TournamentEntry.find({ tournamentId: tournament._id, approvalStatus: 'approved' })
    .select('userId').lean();
  const notifications = entries.map(e => ({
    userId:  e.userId,
    type:    'tournament_live',
    payload: { tournamentId: tournament._id, url: '/tournament/' + tournament._id },
  }));
  if (notifications.length > 0) {
    await Notification.insertMany(notifications, { ordered: false }).catch(() => {});
  }
}

async function transitionToCooldown(tournamentId) {
  const cooldownDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000); // now + 24h

  // Status-filtered so a concurrent/retried job run can't double-transition this tournament.
  const tournament = await Tournament.findOneAndUpdate(
    { _id: tournamentId, status: 'open' },
    { $set: { status: 'cooldown', cooldownDeadline } },
    { new: true, select: 'createdBy name' },
  ).lean();
  if (!tournament) return; // already transitioned/canceled by another run

  const agenda = require('./agenda');
  await agenda.schedule(cooldownDeadline, 'tournament_cooldown_expiry', {
    tournamentId: tournamentId.toString(),
  });

  await Notification.create({
    userId:  tournament.createdBy,
    type:    'tournament_cooldown_started',
    payload: { tournamentId, cooldownDeadline, url: '/tournament/' + tournamentId },
  });
}

function registerTournamentJobs(agenda) {
  agenda.define('tournament_open_expiry', async job => {
    const { tournamentId } = job.attrs.data;
    const tournament = await Tournament.findOne({ _id: tournamentId, status: 'open' });
    if (!tournament) return; // already transitioned

    // Anyone who never responded to their jury invite is auto-accepted.
    await autoAcceptPendingJury(tournamentId);

    const acceptedJuryCount = await TournamentJury.countDocuments({ tournamentId, status: 'accepted' });
    if (acceptedJuryCount < MIN_JURY) {
      await cancelTournament(tournamentId, 'insufficient_jury');
      return;
    }

    // Organizer review (approve/reject) happens during cooldown, not open — nothing
    // is 'approved' yet at this point, so gate on how many candidates submitted at all.
    const submittedCount = await TournamentEntry.countDocuments({ tournamentId: tournament._id });

    if (submittedCount < tournament.size) {
      await cancelTournament(tournament._id, 'insufficient_candidates');
      return;
    }

    await transitionToCooldown(tournament._id);
  });

  agenda.define('tournament_cooldown_expiry', async job => {
    const { tournamentId } = job.attrs.data;
    const tournament = await Tournament.findOne({ _id: tournamentId, status: 'cooldown' });
    if (!tournament) return; // already transitioned/canceled

    // Organizer must land on exactly `size` approved candidates during cooldown (no byes).
    const approvedCount = await TournamentEntry.countDocuments({ tournamentId: tournament._id, approvalStatus: 'approved' });
    if (approvedCount !== tournament.size) {
      await cancelTournament(tournament._id, 'cooldown_incomplete');
      return;
    }

    await activateTournament(tournament._id);
  });

  agenda.define('open_tournament_match', async job => {
    const { matchId } = job.attrs.data;
    const match = await TournamentMatch.findOneAndUpdate(
      { _id: matchId, status: 'scheduled' },
      { $set: { status: 'active', openedAt: new Date() } },
    );
    if (!match) return; // already opened/handled

    const votingDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await Contest.findByIdAndUpdate(match.contestId, { $set: { status: 'active', votingDeadline } });
    // No explicit close_contest scheduling — the existing 15-min sweeper (jobs/sweeper.js)
    // picks up any active contest nearing its votingDeadline, same as every other contest.

    const [entryA, entryB] = await Promise.all([
      TournamentEntry.findById(match.tournamentEntryIdA).populate('userId', 'username displayName').lean(),
      TournamentEntry.findById(match.tournamentEntryIdB).populate('userId', 'username displayName').lean(),
    ]);
    await notifyEntryLoopedIn([
      { tournamentEntryId: match.tournamentEntryIdA, type: 'tournament_entry_match_live', payload: {
          tournamentId: match.tournamentId, tournamentEntryId: match.tournamentEntryIdA, matchId: match._id, contestId: match.contestId,
          opponentUsername: entryB.userId.username?.value, opponentDisplayName: entryB.userId.displayName?.value || entryB.userId.username?.value,
          url: '/contest/' + match.contestId,
      } },
      { tournamentEntryId: match.tournamentEntryIdB, type: 'tournament_entry_match_live', payload: {
          tournamentId: match.tournamentId, tournamentEntryId: match.tournamentEntryIdB, matchId: match._id, contestId: match.contestId,
          opponentUsername: entryA.userId.username?.value, opponentDisplayName: entryA.userId.displayName?.value || entryA.userId.username?.value,
          url: '/contest/' + match.contestId,
      } },
    ], [entryA.userId._id, entryB.userId._id]);
  });
}

module.exports = { registerTournamentJobs, cancelTournament, transitionToCooldown, activateTournament, autoAcceptPendingJury, MIN_JURY };
