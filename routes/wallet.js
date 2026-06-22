const express  = require('express');
const router   = express.Router();
const User     = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');
const ContestPayout     = require('../models/ContestPayout');
const MonthlySnapshot   = require('../models/MonthlySnapshot');
const Notification      = require('../models/Notification');

const EXCHANGE_RATE = 0.20; // 1 🌶️ = $0.20

const PACKAGES = [
  { name: 'Starter',  usd: 20,  chl: 100  },
  { name: 'Medium',   usd: 50,  chl: 250  },
  { name: 'Hot',      usd: 100, chl: 500  },
  { name: 'Inferno',  usd: 200, chl: 1000 },
];

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/signup');
  next();
}

// GET /wallet/topup
router.get('/topup', requireAuth, async (req, res) => {
  const user = await User.findById(req.session.userId).select('wallet').lean();
  res.render('wallet/topup', {
    title:    'Top Up',
    packages: PACKAGES,
    balance:  user?.wallet?.balanceCHL || 0,
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
    amountCHL,
    amountUSD,
    packageName,
    balance:     user?.wallet?.balanceCHL || 0,
  });
});

// POST /wallet/checkout — fake payment processing (CCBill stub)
router.post('/checkout', requireAuth, async (req, res) => {
  const { amountCHL: rawAmount, packageName } = req.body;
  const amountCHL = parseInt(rawAmount, 10);

  if (!amountCHL || amountCHL < 100) return res.redirect('/wallet/topup');

  const amountUSD = +(amountCHL * EXCHANGE_RATE).toFixed(2);

  const user = await User.findById(req.session.userId).select('wallet');
  if (!user) return res.redirect('/signup');

  const balanceBefore = user.wallet?.balanceCHL || 0;
  const balanceAfter  = balanceBefore + amountCHL;

  user.wallet = { balanceCHL: balanceAfter, updatedAt: new Date() };
  await user.save();

  await WalletTransaction.create({
    userId:        user._id,
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
  });

  res.redirect('/settings?section=wallet&success=topup');
});

// POST /wallet/cashout/:contestPayoutId — manual cashout of pending contest earnings
router.post('/cashout/:contestPayoutId', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const payout = await ContestPayout.findOne({ _id: req.params.contestPayoutId, userId, status: 'pending' });
  if (!payout) return res.redirect('/settings?section=wallet&error=notfound');

  if (payout.netPayoutCHL < 100) return res.redirect('/settings?section=wallet&error=minimum');

  const user = await User.findById(userId).select('wallet');
  if (!user) return res.redirect('/signup');

  const balanceBefore = user.wallet?.balanceCHL || 0;
  const balanceAfter  = balanceBefore + payout.netPayoutCHL;

  user.wallet = { balanceCHL: balanceAfter, updatedAt: new Date() };
  await user.save();

  payout.status = 'paid';
  payout.paidAt = new Date();
  payout.paidBy = 'manual';
  await payout.save();

  await WalletTransaction.create({
    userId,
    type:          'manual_cashout',
    direction:     'credit',
    amountCHL:     payout.netPayoutCHL,
    amountUSD:     +(payout.netPayoutCHL * EXCHANGE_RATE).toFixed(2),
    exchangeRate:  EXCHANGE_RATE,
    balanceBefore,
    balanceAfter,
    status:        'completed',
    source:        'manual_cashout',
    referenceId:   payout._id,
    referenceType: 'ContestPayout',
  });

  await Notification.create({
    userId,
    type:    'cashout_success',
    payload: {
      amountCHL:  payout.netPayoutCHL,
      contestId:  payout.contestId,
      url:        '/settings?section=wallet',
    },
  });

  res.redirect('/settings?section=wallet&success=cashout');
});

// POST /wallet/hold-payout — hold current month's auto-payout until the 15th
router.post('/hold-payout', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const today  = new Date().getDate();

  if (today < 25 || today > 29) return res.redirect('/settings?section=wallet');

  const currentMonth = new Date().toISOString().slice(0, 7);
  const snapshot = await MonthlySnapshot.findOne({ userId, month: currentMonth, status: 'pending' });
  if (!snapshot) return res.redirect('/settings?section=wallet');

  snapshot.status = 'held';
  snapshot.heldAt = new Date();
  await snapshot.save();

  res.redirect('/settings?section=wallet');
});

module.exports = router;
