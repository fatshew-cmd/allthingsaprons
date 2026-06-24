const Contest             = require('../models/Contest');
const ContestVote         = require('../models/ContestVote');
const ContestContribution = require('../models/ContestContribution');
const ContestPayout       = require('../models/ContestPayout');
const Nomination          = require('../models/Nomination');
const Notification        = require('../models/Notification');
const User                = require('../models/User');
const notifyWatchers      = require('../utils/notifyWatchers');

async function voidExpiredContest(contestId) {
  const contest = await Contest.findOneAndUpdate(
    { _id: contestId, status: 'pending' },
    { $set: { status: 'void', voidReason: 'expired', lastActivityAt: new Date() } },
  ).lean();

  if (!contest) return; // Already resolved

  await Nomination.updateOne(
    { contestId: contest._id, status: 'pending' },
    { $set: { status: 'void' } },
  );

  const voidedPayload = { contestId: contest._id, url: '/contest/' + contest._id };
  Notification.create({
    userId:  contest.createdBy,
    type:    'contest_voided',
    payload: { ...voidedPayload, isParticipant: true },
  }).catch(() => {});
  notifyWatchers(contest._id, 'contest_voided', voidedPayload, [contest.createdBy]);
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
    { $set: { status: 'closed', winnerEntryId, lastActivityAt: new Date() } },
  ).lean();
  if (!contest) return; // Another job already closed it

  if (contest.entries.length < 2) return;

  const userIds = contest.entries.map(e => e.userId);
  const users   = await User.find({ _id: { $in: userIds } }).select('_id username displayName').lean();
  const userMap = {};
  for (const u of users) userMap[u._id.toString()] = { username: u.username?.value || 'your opponent', displayName: u.displayName?.value || u.username?.value || 'your opponent' };

  const winnerUserId = winnerEntryId
    ? contest.entries.find(e => e.entryId.toString() === winnerEntryId.toString())?.userId
    : null;

  // ── Participant and watcher notifications (fire before earnings so a payout error can't silence them) ──
  const notifications = contest.entries.map(e => {
    const uid           = e.userId.toString();
    const opponentEntry = contest.entries.find(oe => oe.userId.toString() !== uid);
    const opponentData  = opponentEntry ? (userMap[opponentEntry.userId.toString()] || {}) : {};
    const opponentUsername    = opponentData.username    || 'your opponent';
    const opponentDisplayName = opponentData.displayName || opponentUsername;
    const won = winnerUserId ? winnerUserId.toString() === uid : null;
    return {
      userId:  e.userId,
      type:    'contest_closed',
      payload: { contestId: contest._id, winnerEntryId, won, opponentUsername, opponentDisplayName, url: '/contest/' + contest._id, isParticipant: true },
    };
  });

  await Promise.all([
    Notification.insertMany(notifications, { ordered: false }).catch(() => {}),
    notifyWatchers(contest._id, 'contest_closed', {
      contestId:     contest._id,
      winnerEntryId: winnerEntryId || null,
      url:           '/contest/' + contest._id,
    }, userIds),
  ]);

  // ── Lock contributions and settle earnings ────────────────────────
  try {
    const EXCHANGE_RATE = 0.20;
    const now = new Date();

    // Aggregate first to capture totals, THEN lock — running concurrently risks
    // updateMany winning the race and flipping status before the aggregate reads.
    const contributionAgg = await ContestContribution.aggregate([
      { $match: { contestId: contest._id, status: 'active' } },
      { $group: { _id: '$entryId', totalCHL: { $sum: '$amountCHL' }, beneficiaryId: { $first: '$beneficiaryId' } } },
    ]);
    await ContestContribution.updateMany(
      { contestId: contest._id, status: 'active' },
      { $set: { status: 'locked', lockedAt: now } },
    );

    const earningRows = contributionAgg.filter(r => r.totalCHL > 0);
    await Promise.all(earningRows.map(async r => {
      try {
        const gross = r.totalCHL;
        const net   = Math.floor(gross * 0.75);
        const fee   = gross - net;

        const updatedUser = await User.findByIdAndUpdate(
          r.beneficiaryId,
          { $inc: { 'wallet.earnedCHL': net }, $set: { 'wallet.updatedAt': now } },
          { new: true, select: 'wallet' },
        );
        if (!updatedUser) return;

        const balanceAfter  = (updatedUser.wallet.purchasedCHL || 0) + (updatedUser.wallet.earnedCHL || 0);
        const balanceBefore = balanceAfter - net;

        await Promise.all([
          ContestPayout.create({
            contestId:             contest._id,
            entryId:               r._id,
            userId:                r.beneficiaryId,
            grossContributionsCHL: gross,
            netPayoutCHL:          net,
            platformFeeCHL:        fee,
            status:                'completed',
            paidAt:                now,
          }),
          require('../models/WalletTransaction').create({
            userId:        r.beneficiaryId,
            type:          'contest_payout_settled',
            direction:     'credit',
            amountCHL:     net,
            amountUSD:     +(net * EXCHANGE_RATE).toFixed(2),
            exchangeRate:  EXCHANGE_RATE,
            balanceBefore,
            balanceAfter,
            status:        'completed',
            source:        'contest_close',
            referenceId:   contest._id,
            referenceType: 'Contest',
          }),
          Notification.create({
            userId:  r.beneficiaryId,
            type:    'contest_payout_available',
            payload: {
              amountCHL: net,
              contestId: contest._id,
              url:       '/settings?tab=wallet',
            },
          }),
        ]);
      } catch (err) {
        console.error('[closeContest] payout failed for beneficiary', r.beneficiaryId, 'contest', contest._id, ':', err.message);
      }
    }));
  } catch (err) {
    console.error('[closeContest] earnings settlement failed for contest', contest._id, ':', err.message);
  }
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
