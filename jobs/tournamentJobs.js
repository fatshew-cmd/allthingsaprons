const Tournament      = require('../models/Tournament');
const TournamentEntry = require('../models/TournamentEntry');
const TournamentJury  = require('../models/TournamentJury');
const Notification    = require('../models/Notification');
const { creditWallet } = require('../utils/wallet');

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
    // Bracket/group generation on success is a later phase — not built yet.
    const approvedCount = await TournamentEntry.countDocuments({ tournamentId: tournament._id, approvalStatus: 'approved' });
    if (approvedCount !== tournament.size) {
      await cancelTournament(tournament._id, 'cooldown_incomplete');
      return;
    }

    await Tournament.findOneAndUpdate(
      { _id: tournament._id, status: 'cooldown' },
      { $set: { status: 'active', activeAt: new Date() } },
    );
  });
}

module.exports = { registerTournamentJobs, cancelTournament, transitionToCooldown, autoAcceptPendingJury };
