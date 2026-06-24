const express  = require('express');
const router   = express.Router();
const mongoose = require('mongoose');
const XLSX     = require('xlsx');
const User     = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');
const ContestPayout     = require('../models/ContestPayout');
const MonthlySnapshot   = require('../models/MonthlySnapshot');
const Notification      = require('../models/Notification');

const EXCHANGE_RATE = 0.20;

const TX_LABELS = {
  top_up:                  'Top Up',
  contribution:            'Contribution',
  contribution_adjustment: 'Contribution Adjusted',
  contribution_withdrawal: 'Contribution Withdrawn',
  contest_payout_settled:  'Contest Payout',
  auto_payout:             'Auto-Payout',
  makeup_payout:           'Makeup Payout',
  admin_grant:             'Admin Grant',
  platform_fee:            'Platform Fee',
  manual_correction:       'Manual Correction',
};

function buildTxFilter(userId, month, type, months, types) {
  const filter = { userId };
  const monthList = months
    ? months.split(',').map(m => m.trim()).filter(m => /^\d{4}-\d{2}$/.test(m))
    : (month && /^\d{4}-\d{2}$/.test(month) ? [month] : []);
  if (monthList.length === 1) {
    const [y, m] = monthList[0].split('-').map(Number);
    filter.createdAt = { $gte: new Date(y, m - 1, 1), $lt: new Date(y, m, 1) };
  } else if (monthList.length > 1) {
    filter.$or = monthList.map(mo => {
      const [y, m] = mo.split('-').map(Number);
      return { createdAt: { $gte: new Date(y, m - 1, 1), $lt: new Date(y, m, 1) } };
    });
  }
  if (types) {
    const typeList = types.split(',').map(t => t.trim()).filter(Boolean);
    if (typeList.length === 1) filter.type = typeList[0];
    else if (typeList.length > 1) filter.type = { $in: typeList };
  } else if (type && type !== 'all') {
    filter.type = type;
  }
  return filter;
}

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

// GET /wallet/transactions — full paginated transaction history
router.get('/transactions', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const { month, type, months, types } = req.query;
  const filter = buildTxFilter(userId, month, type, months, types);

  const [transactions, transactionMonthsRaw] = await Promise.all([
    WalletTransaction.find(filter).sort({ createdAt: -1 }).lean(),
    WalletTransaction.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } } } },
      { $sort: { _id: -1 } },
    ]),
  ]);

  res.render('wallet/transactions', {
    title:      'Transaction History',
    activePage: 'settings',
    transactions,
    totalCount:        transactions.length,
    transactionMonths: transactionMonthsRaw.map(r => r._id),
    txLabels:          TX_LABELS,
    filterMonth:       month || '',
    filterType:        type  || '',
  });
});

// GET /wallet/transactions/download — Excel export of filtered transactions
router.get('/transactions/download', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const { month, type, months, types } = req.query;
  const filter = buildTxFilter(userId, month, type, months, types);

  const transactions = await WalletTransaction.find(filter).sort({ createdAt: -1 }).lean();

  const rows = transactions.map(tx => ({
    Date:              new Date(tx.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    Type:              TX_LABELS[tx.type] || tx.type,
    Direction:         tx.direction === 'credit' ? 'Credit' : 'Debit',
    'Amount (CHL)':    tx.direction === 'credit' ? tx.amountCHL : -tx.amountCHL,
    'Amount (USD)':    tx.direction === 'credit' ? tx.amountUSD : -tx.amountUSD,
    'Balance After (CHL)': tx.balanceAfter,
    Status:            tx.status,
    Package:           tx.packageName || '',
  }));

  const ws  = XLSX.utils.json_to_sheet(rows);
  const wb  = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Transactions');

  const buf      = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `transactions${month ? '-' + month : ''}${type && type !== 'all' ? '-' + type : ''}.xlsx`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
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
