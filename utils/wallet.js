const User             = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');

const EXCHANGE_RATE = 0.20;

// Credits `amountCHL` to a user's wallet pool ('purchasedCHL' or 'earnedCHL') and writes the
// matching WalletTransaction audit record. Returns the updated user (wallet only) or null if
// the user no longer exists.
async function creditWallet(userId, amountCHL, { pool = 'purchasedCHL', type, source, referenceId, referenceType }) {
  const updatedUser = await User.findByIdAndUpdate(
    userId,
    { $inc: { ['wallet.' + pool]: amountCHL }, $set: { 'wallet.updatedAt': new Date() } },
    { new: true, select: 'wallet' },
  );
  if (!updatedUser) return null;

  const balanceAfter  = (updatedUser.wallet.purchasedCHL || 0) + (updatedUser.wallet.earnedCHL || 0);
  const balanceBefore = balanceAfter - amountCHL;

  await WalletTransaction.create({
    userId,
    type,
    direction:    'credit',
    amountCHL,
    amountUSD:    +(amountCHL * EXCHANGE_RATE).toFixed(2),
    exchangeRate: EXCHANGE_RATE,
    balanceBefore,
    balanceAfter,
    status:       'completed',
    source,
    referenceId,
    referenceType,
  });

  return updatedUser;
}

module.exports = { creditWallet, EXCHANGE_RATE };
