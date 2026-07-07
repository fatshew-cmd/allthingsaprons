const Contest              = require('../models/Contest');
const Tournament           = require('../models/Tournament');
const TournamentMatch      = require('../models/TournamentMatch');
const TournamentGroup      = require('../models/TournamentGroup');
const { voidExpiredContest, closeContest } = require('./contestJobs');

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

async function runVoidSweeper(agenda) {
  const now     = new Date();
  const horizon = new Date(now.getTime() + WINDOW_MS);

  const contests = await Contest.find({
    status:       'pending',
    voidDeadline: { $lte: horizon },
  }).select('_id voidDeadline').lean();

  for (const c of contests) {
    if (c.voidDeadline <= now) {
      await voidExpiredContest(c._id);
    } else {
      const existing = await agenda.jobs({
        name:              'void_expired_contest',
        'data.contestId':  c._id.toString(),
        nextRunAt:         { $ne: null },
      });
      if (existing.length === 0) {
        await agenda.schedule(c.voidDeadline, 'void_expired_contest', { contestId: c._id.toString() });
      }
    }
  }
}

async function runCloseSweeper(agenda) {
  const now     = new Date();
  const horizon = new Date(now.getTime() + WINDOW_MS);

  const contests = await Contest.find({
    status:         'active',
    votingDeadline: { $lte: horizon },
  }).select('_id votingDeadline').lean();

  for (const c of contests) {
    if (c.votingDeadline <= now) {
      await closeContest(c._id);
    } else {
      const existing = await agenda.jobs({
        name:             'close_contest',
        'data.contestId': c._id.toString(),
        nextRunAt:        { $ne: null },
      });
      if (existing.length === 0) {
        await agenda.schedule(c.votingDeadline, 'close_contest', { contestId: c._id.toString() });
      }
    }
  }
}

// Shared by the four tournament sweeps below: find docs of `Model` matching `filter` whose
// `deadlineField` is within the horizon, then either fire the handler immediately (deadline
// already passed) or dedupe-and-schedule the one-time agenda job for it (deadline still ahead).
async function sweepDeadline(agenda, { Model, filter, deadlineField, jobName, dataKey, now, horizon, handler }) {
  const docs = await Model.find({ ...filter, [deadlineField]: { $lte: horizon } })
    .select('_id ' + deadlineField).lean();

  for (const doc of docs) {
    if (doc[deadlineField] <= now) {
      await handler(doc._id);
    } else {
      const existing = await agenda.jobs({
        name: jobName, ['data.' + dataKey]: doc._id.toString(), nextRunAt: { $ne: null },
      });
      if (existing.length === 0) {
        await agenda.schedule(doc[deadlineField], jobName, { [dataKey]: doc._id.toString() });
      }
    }
  }
}

// Recovery net for the four tournament-side one-time agenda jobs — mirrors runVoidSweeper/
// runCloseSweeper above. Each one-time job is already scheduled directly (at tournament
// creation, cooldown transition, or tie kickoff) via jobs/tournamentJobs.js, but this covers
// the case where that scheduled job doc was somehow lost (e.g. a redeploy that wiped the
// agenda collection) by reading the deadline straight off the source-of-truth document.
async function runTournamentSweeper(agenda) {
  const now     = new Date();
  const horizon = new Date(now.getTime() + WINDOW_MS);

  const {
    tournamentOpenExpiry, tournamentCooldownExpiry,
    tournamentJuryExpiry, tournamentOrganizerVoteExpiry,
    tournamentGroupJuryExpiry, tournamentGroupOrganizerVoteExpiry,
  } = require('./tournamentJobs');

  await sweepDeadline(agenda, {
    Model: Tournament, filter: { status: 'open' }, deadlineField: 'openDeadline',
    jobName: 'tournament_open_expiry', dataKey: 'tournamentId',
    now, horizon, handler: tournamentOpenExpiry,
  });

  await sweepDeadline(agenda, {
    Model: Tournament, filter: { status: 'cooldown' }, deadlineField: 'cooldownDeadline',
    jobName: 'tournament_cooldown_expiry', dataKey: 'tournamentId',
    now, horizon, handler: tournamentCooldownExpiry,
  });

  await sweepDeadline(agenda, {
    Model: TournamentMatch, filter: { tieStatus: 'jury_pending' }, deadlineField: 'tieDeadline',
    jobName: 'tournament_jury_expiry', dataKey: 'matchId',
    now, horizon, handler: tournamentJuryExpiry,
  });

  await sweepDeadline(agenda, {
    Model: TournamentMatch, filter: { tieStatus: 'organizer_pending' }, deadlineField: 'tieDeadline',
    jobName: 'tournament_organizer_vote_expiry', dataKey: 'matchId',
    now, horizon, handler: tournamentOrganizerVoteExpiry,
  });

  await sweepDeadline(agenda, {
    Model: TournamentGroup, filter: { tieStatus: 'jury_pending' }, deadlineField: 'tieDeadline',
    jobName: 'tournament_group_jury_expiry', dataKey: 'groupId',
    now, horizon, handler: tournamentGroupJuryExpiry,
  });

  await sweepDeadline(agenda, {
    Model: TournamentGroup, filter: { tieStatus: 'organizer_pending' }, deadlineField: 'tieDeadline',
    jobName: 'tournament_group_organizer_vote_expiry', dataKey: 'groupId',
    now, horizon, handler: tournamentGroupOrganizerVoteExpiry,
  });
}

// Recovery for jobs/contestJobs.js's fire-and-forget tournament hook: if the process
// crashed/restarted between a tournament Contest closing and handleTournamentMatchClose
// finishing, the TournamentMatch is left stranded (still 'scheduled'/'active') even though
// its Contest already has a final status. Re-run the hook for any such match.
async function runTournamentMatchReconcileSweeper() {
  const staleMatches = await TournamentMatch.find({
    status: { $in: ['scheduled', 'active'] },
  }).select('contestId').lean();
  if (!staleMatches.length) return;

  const contests = await Contest.find({
    _id: { $in: staleMatches.map(m => m.contestId) },
    status: 'closed',
  }).select('_id winnerEntryId').lean();
  if (!contests.length) return;

  const { handleTournamentMatchClose } = require('./tournamentJobs');
  for (const c of contests) {
    await handleTournamentMatchClose(c._id, c.winnerEntryId).catch(err => {
      console.error('[runTournamentMatchReconcileSweeper] failed for contest', c._id, ':', err.message);
    });
  }
}

async function startSweeper(agenda) {
  agenda.define('contest_sweeper', async () => {
    await Promise.all([
      runVoidSweeper(agenda),
      runCloseSweeper(agenda),
      runTournamentMatchReconcileSweeper(),
      runTournamentSweeper(agenda),
    ]);
  });

  await agenda.every('15 minutes', 'contest_sweeper');
  // Run once immediately on startup to catch any deadlines missed while the server was down
  await agenda.now('contest_sweeper');
}

module.exports = { startSweeper, runTournamentMatchReconcileSweeper };
