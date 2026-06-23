require('dotenv').config();
const mongoose          = require('mongoose');
const User              = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');

const EXCHANGE_RATE   = 0.20;
const TARGET_USERNAME = process.argv[2];

if (!TARGET_USERNAME) {
  console.error('Usage: node scripts/correctWalletBalance.js <username>');
  process.exit(1);
}

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/allthingsaprons').then(async () => {
  const user = await User.findOne({ 'username.value': TARGET_USERNAME }).select('username wallet');
  if (!user) {
    console.error(`User "@${TARGET_USERNAME}" not found.`);
    process.exit(1);
  }

  const currentBalance = (user.wallet?.purchasedCHL ?? 0) + (user.wallet?.earnedCHL ?? 0);
  console.log(`User:            @${user.username.value} (${user._id})`);
  console.log(`Balance in DB:   ${currentBalance} 🌶️`);

  const transactions = await WalletTransaction.find({ userId: user._id }).sort({ createdAt: 1 }).lean();
  let computedBalance = 0;
  for (const tx of transactions) {
    if (tx.direction === 'credit') computedBalance += tx.amountCHL;
    else                           computedBalance -= tx.amountCHL;
  }

  console.log(`Computed from ${transactions.length} transactions: ${computedBalance} 🌶️`);
  console.log(`Discrepancy:   ${computedBalance - currentBalance} 🌶️`);

  if (computedBalance === currentBalance) {
    console.log('✓ Balance is already correct — no correction needed.');
    await mongoose.disconnect();
    process.exit(0);
  }

  const correctionAmount = Math.abs(computedBalance - currentBalance);
  const direction        = computedBalance > currentBalance ? 'credit' : 'debit';

  await User.findByIdAndUpdate(
    user._id,
    { $set: { 'wallet.purchasedCHL': computedBalance, 'wallet.earnedCHL': 0, 'wallet.updatedAt': new Date() } }
  );

  await WalletTransaction.create({
    userId:        user._id,
    type:          'manual_correction',
    direction,
    amountCHL:     correctionAmount,
    amountUSD:     +(correctionAmount * EXCHANGE_RATE).toFixed(2),
    exchangeRate:  EXCHANGE_RATE,
    balanceBefore: currentBalance,
    balanceAfter:  computedBalance,
    status:        'completed',
    source:        'manual_correction',
    metadata:      { reason: 'Balance correction via correctWalletBalance script' },
  });

  console.log(`✓ Balance corrected: ${currentBalance} → ${computedBalance} 🌶️`);

  await mongoose.disconnect();
  process.exit(0);
}).catch(err => {
  console.error('DB connection error:', err.message);
  process.exit(1);
});
