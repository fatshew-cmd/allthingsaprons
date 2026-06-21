const Contest              = require('../models/Contest');
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

async function startSweeper(agenda) {
  agenda.define('contest_sweeper', async () => {
    await Promise.all([runVoidSweeper(agenda), runCloseSweeper(agenda)]);
  });

  await agenda.every('15 minutes', 'contest_sweeper');
  // Run once immediately on startup to catch any deadlines missed while the server was down
  await agenda.now('contest_sweeper');
}

module.exports = { startSweeper };
