const express  = require('express');
const router   = express.Router();
const mongoose = require('mongoose');
const User     = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');
const ContestPayout     = require('../models/ContestPayout');
const MonthlySnapshot   = require('../models/MonthlySnapshot');
const Notification      = require('../models/Notification');

const EXCHANGE_RATE = 0.20;

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
} // 1 🌶️ = $0.20

const PACKAGES = [
  { name: 'Chill Vibes', usd: 20,  chl: 100  },
  { name: 'After Hours', usd: 50,  chl: 250  },
  { name: 'Milky Way',   usd: 100, chl: 500  },
  { name: 'Inferno',     usd: 200, chl: 1000 },
];

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/signup');
  next();
}

// GET /wallet/topup
router.get('/topup', requireAuth, async (req, res) => {
  const user = await User.findById(req.session.userId).select('wallet').lean();
  res.render('wallet/topup', {
    title:      'Top Up',
    activePage: 'wallet',
    packages:   PACKAGES,
    balance:    (user?.wallet?.purchasedCHL || 0) + (user?.wallet?.earnedCHL || 0),
  });
});

// GET /wallet/checkout
router.get('/checkout', requireAuth, async (req, res) => {
  const { amount, package: pkgName, custom } = req.query;
  const amountCHL = parseInt(amount, 10);

  if (!amountCHL || amountCHL < 100) return res.redirect('/wallet/topup');

  const amountUSD = +(amountCHL * EXCHANGE_RATE).toFixed(2);
  const packageName = custom === 'true' ? null : (pkgName || null);

  const user = await User.findById(req.session.userId).select('wallet').lean();

  res.render('wallet/checkout', {
    title:       'Checkout',
    activePage:  'wallet',
    amountCHL,
    amountUSD,
    packageName,
    balance:     (user?.wallet?.purchasedCHL || 0) + (user?.wallet?.earnedCHL || 0),
  });
});

// POST /wallet/checkout — fake payment processing (CCBill stub)
router.post('/checkout', requireAuth, async (req, res) => {
  const { amountCHL: rawAmount, packageName } = req.body;
  const amountCHL = parseInt(rawAmount, 10);

  if (!amountCHL || amountCHL < 100) return res.redirect('/wallet/topup');

  const amountUSD = +(amountCHL * EXCHANGE_RATE).toFixed(2);
  const userId    = req.session.userId;

  try {
    await withTxnOrFallback(async (session) => {
      const updatedUser = await User.findByIdAndUpdate(
        userId,
        { $inc: { 'wallet.purchasedCHL': amountCHL }, $set: { 'wallet.updatedAt': new Date() } },
        { new: true, select: 'wallet', session }
      );
      if (!updatedUser) throw new Error('User not found.');

      const balanceAfter  = (updatedUser.wallet.purchasedCHL || 0) + (updatedUser.wallet.earnedCHL || 0);
      const balanceBefore = balanceAfter - amountCHL;

      await WalletTransaction.create([{
        userId,
        type:          'top_up',
        direction:     'credit',
        amountCHL,
        amountUSD,
        exchangeRate:  EXCHANGE_RATE,
        balanceBefore,
        balanceAfter,
        status:        'completed',
        source:        packageName ? 'package' : 'custom',
        packageName:   packageName || undefined,
        metadata:      { userAgent: req.headers['user-agent'] },
      }], { session });
    });
  } catch (err) {
    console.error('Top-up transaction error:', err);
    return res.redirect('/wallet/topup?error=failed');
  }

  res.redirect('/settings?tab=wallet&success=topup');
});

// GET /wallet/transaction/:id — transaction detail page
router.get('/transaction/:id', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.redirect('/settings?tab=wallet');

  const tx = await WalletTransaction.findOne({ _id: req.params.id, userId: req.session.userId }).lean();
  if (!tx) return res.redirect('/settings?tab=wallet');

  let reference = null;
  if (tx.referenceId && tx.referenceType === 'Contest') {
    const Contest = require('../models/Contest');
    reference = await Contest.findById(tx.referenceId).select('entries status').lean();
  } else if (tx.referenceId && tx.referenceType === 'ContestContribution') {
    const ContestContribution = require('../models/ContestContribution');
    const contrib = await ContestContribution.findById(tx.referenceId)
      .select('contestId entryId amountCHL status')
      .lean();
    if (contrib) reference = { ...contrib, _type: 'ContestContribution' };
  }

  res.render('wallet/transaction', {
    title:      'Transaction Detail',
    activePage: 'settings',
    tx,
    reference,
  });
});

// POST /wallet/hold-payout — hold current month's auto-payout until the 15th
router.post('/hold-payout', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const today  = new Date().getDate();

  if (today < 25 || today > 29) return res.redirect('/settings?tab=wallet');

  const currentMonth = new Date().toISOString().slice(0, 7);
  const snapshot = await MonthlySnapshot.findOne({ userId, month: currentMonth, status: 'pending' });
  if (!snapshot) return res.redirect('/settings?tab=wallet');

  snapshot.status = 'held';
  snapshot.heldAt = new Date();
  await snapshot.save();

  res.redirect('/settings?tab=wallet');
});

module.exports = router;
