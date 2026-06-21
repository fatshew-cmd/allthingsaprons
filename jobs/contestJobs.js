const Contest      = require('../models/Contest');
const ContestVote  = require('../models/ContestVote');
const Nomination   = require('../models/Nomination');
const Notification = require('../models/Notification');
const User         = require('../models/User');

async function voidExpiredContest(contestId) {
  const contest = await Contest.findOneAndUpdate(
    { _id: contestId, status: 'pending' },
    { $set: { status: 'void', voidReason: 'expired' } },
  ).lean();

  if (!contest) return; // Already resolved

  await Nomination.updateOne(
    { contestId: contest._id, status: 'pending' },
    { $set: { status: 'void' } },
  );

  Notification.create({
    userId:  contest.createdBy,
    type:    'contest_voided',
    payload: { contestId: contest._id, url: '/contest/' + contest._id },
  }).catch(() => {});
}

async function closeContest(contestId) {
  // Read votes and compute winner before writing — votes won't change once the deadline passes.
  const liveContest = await Contest.findOne({ _id: contestId, status: 'active' }).lean();
  if (!liveContest) return; // Already closed/voided

  const agg = await ContestVote.aggregate([
    { $match: { contestId: liveContest._id } },
    { $group: { _id: '$entryId', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  let winnerEntryId = null;
  if (agg.length >= 2 && agg[0].count > agg[1].count) {
    winnerEntryId = agg[0]._id;
  } else if (agg.length === 1) {
    winnerEntryId = agg[0]._id;
  }
  // Tie (agg.length >= 2, counts equal): winnerEntryId stays null

  // Atomic gate: only proceed (and send notifications) if we are the job that actually closes it.
  // If two close_contest jobs race, only the first findOneAndUpdate call matches status: 'active'.
  const contest = await Contest.findOneAndUpdate(
    { _id: contestId, status: 'active' },
    { $set: { status: 'closed', winnerEntryId } },
  ).lean();
  if (!contest) return; // Another job already closed it

  if (contest.entries.length < 2) return;

  const userIds = contest.entries.map(e => e.userId);
  const users   = await User.find({ _id: { $in: userIds } }).select('_id username').lean();
  const userMap = {};
  for (const u of users) userMap[u._id.toString()] = u.username?.value || 'your opponent';

  const winnerUserId = winnerEntryId
    ? contest.entries.find(e => e.entryId.toString() === winnerEntryId.toString())?.userId
    : null;

  const notifications = contest.entries.map(e => {
    const uid           = e.userId.toString();
    const opponentEntry = contest.entries.find(oe => oe.userId.toString() !== uid);
    const opponentUsername = opponentEntry ? (userMap[opponentEntry.userId.toString()] || 'your opponent') : 'your opponent';
    const won = winnerUserId ? winnerUserId.toString() === uid : null;
    return {
      userId:  e.userId,
      type:    'contest_closed',
      payload: { contestId: contest._id, winnerEntryId, won, opponentUsername, url: '/contest/' + contest._id },
    };
  });

  Notification.insertMany(notifications).catch(() => {});
}

function registerContestJobs(agenda) {
  agenda.define('void_expired_contest', async job => {
    await voidExpiredContest(job.attrs.data.contestId);
  });

  agenda.define('close_contest', async job => {
    await closeContest(job.attrs.data.contestId);
  });
}

module.exports = { registerContestJobs, voidExpiredContest, closeContest };
