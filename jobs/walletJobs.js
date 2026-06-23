const { Resend }      = require('resend');
const User            = require('../models/User');
const MonthlySnapshot = require('../models/MonthlySnapshot');
const WalletTransaction = require('../models/WalletTransaction');
const Notification    = require('../models/Notification');

const FROM_EMAIL    = process.env.FROM_EMAIL || 'noreply@allthingsaprons.com';
const EXCHANGE_RATE = 0.20;

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

// ── Helpers ────────────────────────────────────────────────────────

function monthString(date) {
  return date.toISOString().slice(0, 7); // "YYYY-MM"
}

function firstOfMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0));
}

function thirtiethOfMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 30, 0, 0, 0));
}

function fifteenthOfNextMonth(date) {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 15, 0, 0, 0));
  return next;
}

// ── Job: snapshot_monthly_balances (runs 1st of each month) ───────

async function snapshotMonthlyBalances() {
  const now   = new Date();
  const month = monthString(now);

  const users = await User.find({ 'wallet.earnedCHL': { $gt: 0 } })
    .select('_id wallet')
    .lean();

  if (!users.length) return;

  // Only create snapshots for users who don't already have one this month
  const existingIds = await MonthlySnapshot.distinct('userId', { month });
  const existingSet = new Set(existingIds.map(id => id.toString()));

  const toCreate = users.filter(u => !existingSet.has(u._id.toString()));
  if (!toCreate.length) return;

  const snapshots = toCreate.map(u => ({
    userId:           u._id,
    month,
    snapshotDate:     firstOfMonth(now),
    earnedCHL:        u.wallet.earnedCHL,
    autoPayoutDate:   thirtiethOfMonth(now),
    makeupPayoutDate: fifteenthOfNextMonth(now),
    status:           'pending',
  }));

  await MonthlySnapshot.insertMany(snapshots, { ordered: false });
  console.log(`[walletJobs] Created ${snapshots.length} monthly snapshots for ${month}`);
}

// ── Job: payout_reminder (runs 25th of each month) ────────────────

async function payoutReminder() {
  const now   = new Date();
  const month = monthString(now);

  const snapshots = await MonthlySnapshot.find({ month, status: 'pending', earnedCHL: { $gt: 0 } })
    .populate('userId', 'email username displayName')
    .lean();

  if (!snapshots.length) return;

  const resend = getResend();

  for (const snap of snapshots) {
    const user        = snap.userId;
    const displayName = user?.displayName?.value || user?.username?.value || 'there';
    const email       = user?.email?.value;

    // In-app notification
    Notification.create({
      userId:  snap.userId._id || snap.userId,
      type:    'payout_reminder',
      payload: {
        amountCHL:      snap.earnedCHL,
        autoPayoutDate: snap.autoPayoutDate,
        url:           '/settings?tab=wallet',
      },
    }).catch(() => {});

    // Email
    if (resend && email) {
      resend.emails.send({
        from:    FROM_EMAIL,
        to:      email,
        subject: `Your ${snap.earnedCHL.toLocaleString()} 🌶️ auto-payout is in 5 days`,
        html: `<p>Hi ${displayName},</p>
<p>You have <strong>${snap.earnedCHL.toLocaleString()} chillies</strong> (≈ $${(snap.earnedCHL * EXCHANGE_RATE).toFixed(2)}) scheduled for automatic payout on the 30th.</p>
<p>If you'd like to keep them on your account a little longer, you can <a href="${process.env.APP_URL || 'https://allthingsaprons.com'}/settings?tab=wallet">visit your wallet settings</a> and tap "Hold until the 15th" before the 30th.</p>
<p>If you do nothing, the payout happens automatically.</p>`,
      }).catch(() => {});
    }
  }

  console.log(`[walletJobs] Sent payout reminders to ${snapshots.length} users`);
}

// ── Shared payout executor ─────────────────────────────────────────

async function executePayout(snapshot, paidBy) {
  const user = await User.findById(snapshot.userId).select('wallet');
  if (!user) return;

  const currentEarned  = user.wallet?.earnedCHL    || 0;
  const currentPurchased = user.wallet?.purchasedCHL || 0;
  const amountPaid     = Math.min(snapshot.earnedCHL, currentEarned);

  if (amountPaid <= 0) {
    await MonthlySnapshot.updateOne(
      { _id: snapshot._id },
      { $set: { status: paidBy === 'auto_30d' ? 'paid' : 'makeup_paid', amountPaidCHL: 0, paidAt: new Date() } },
    );
    return;
  }

  const balanceBefore = currentPurchased + currentEarned;
  const balanceAfter  = balanceBefore - amountPaid;

  await User.findByIdAndUpdate(
    snapshot.userId,
    { $inc: { 'wallet.earnedCHL': -amountPaid }, $set: { 'wallet.updatedAt': new Date() } },
  );

  const txType = paidBy === 'auto_30d' ? 'auto_payout' : 'makeup_payout';
  await WalletTransaction.create({
    userId:        snapshot.userId,
    type:          txType,
    direction:     'debit',
    amountCHL:     amountPaid,
    amountUSD:     +(amountPaid * EXCHANGE_RATE).toFixed(2),
    exchangeRate:  EXCHANGE_RATE,
    balanceBefore,
    balanceAfter,
    status:        'completed',
    source:        txType === 'auto_payout' ? 'auto_payout' : 'makeup_payout',
    referenceId:   snapshot._id,
    referenceType: 'MonthlySnapshot',
  });

  const newStatus = paidBy === 'auto_30d' ? 'paid' : 'makeup_paid';
  await MonthlySnapshot.updateOne(
    { _id: snapshot._id },
    { $set: { status: newStatus, amountPaidCHL: amountPaid, paidAt: new Date() } },
  );

  Notification.create({
    userId:  snapshot.userId,
    type:    'payout_processed',
    payload: {
      amountCHL: amountPaid,
      paidBy,
      url:       '/settings?tab=wallet',
    },
  }).catch(() => {});
}

// ── Job: auto_payout_30 (runs 30th of each month) ─────────────────

async function autoPayoutThirtieth() {
  const now   = new Date();
  const month = monthString(now);

  const snapshots = await MonthlySnapshot.find({
    month,
    status:        'pending',
    autoPayoutDate: { $lte: now },
    earnedCHL:     { $gt: 0 },
  }).lean();

  for (const snap of snapshots) {
    await executePayout(snap, 'auto_30d');
  }

  if (snapshots.length) console.log(`[walletJobs] Auto-payout processed for ${snapshots.length} users`);
}

// ── Job: makeup_payout_15 (runs 15th of each month) ───────────────

async function makeupPayoutFifteenth() {
  const now = new Date();

  const snapshots = await MonthlySnapshot.find({
    status:          'held',
    makeupPayoutDate: { $lte: now },
    earnedCHL:       { $gt: 0 },
  }).lean();

  for (const snap of snapshots) {
    await executePayout(snap, 'makeup_15d');
  }

  if (snapshots.length) console.log(`[walletJobs] Makeup payout processed for ${snapshots.length} users`);
}

// ── Register with agenda ───────────────────────────────────────────

function registerWalletJobs(agenda) {
  agenda.define('snapshot_monthly_balances', async () => {
    await snapshotMonthlyBalances();
  });

  agenda.define('payout_reminder', async () => {
    await payoutReminder();
  });

  agenda.define('auto_payout_30', async () => {
    await autoPayoutThirtieth();
  });

  agenda.define('makeup_payout_15', async () => {
    await makeupPayoutFifteenth();
  });
}

async function startWalletJobs(agenda) {
  // 1st of month at 00:05 UTC (small offset so DB is settled)
  await agenda.every('5 0 1 * *', 'snapshot_monthly_balances');
  // 25th of month at 09:00 UTC
  await agenda.every('0 9 25 * *', 'payout_reminder');
  // 30th of month at 00:05 UTC
  await agenda.every('5 0 30 * *', 'auto_payout_30');
  // 15th of month at 00:05 UTC
  await agenda.every('5 0 15 * *', 'makeup_payout_15');

  // On startup: catch any payout_30 or makeup_15 that fired while server was down
  const now = new Date();
  if (now.getDate() >= 30) await autoPayoutThirtieth();
  if (now.getDate() >= 15) await makeupPayoutFifteenth();
}

module.exports = { registerWalletJobs, startWalletJobs };
