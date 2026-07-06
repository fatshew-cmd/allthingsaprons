const Contest              = require('../models/Contest');
const TournamentMatch      = require('../models/TournamentMatch');
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
    await Promise.all([runVoidSweeper(agenda), runCloseSweeper(agenda), runTournamentMatchReconcileSweeper()]);
  });

  await agenda.every('15 minutes', 'contest_sweeper');
  // Run once immediately on startup to catch any deadlines missed while the server was down
  await agenda.now('contest_sweeper');
}

module.exports = { startSweeper, runTournamentMatchReconcileSweeper };
