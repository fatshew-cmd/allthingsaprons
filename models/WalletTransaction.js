const mongoose = require('mongoose');

const walletTransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  type: {
    type: String,
    enum: [
      'top_up',
      'contribution',
      'contribution_adjustment',
      'contribution_withdrawal',
      'contest_payout_settled',
      'platform_fee',
      'admin_grant',
      'auto_payout',
      'makeup_payout',
      'manual_correction',
    ],
    required: true,
  },

  direction: { type: String, enum: ['credit', 'debit'], required: true },

  amountCHL:    { type: Number, required: true },
  amountUSD:    { type: Number, required: true },
  exchangeRate: { type: Number, required: true, default: 0.20 },

  balanceBefore: { type: Number, required: true },
  balanceAfter:  { type: Number, required: true },

  status: { type: String, enum: ['completed', 'pending', 'reversed'], default: 'completed' },

  source: {
    type: String,
    enum: ['package', 'custom', 'admin', 'contest_close', 'system', 'auto_payout', 'makeup_payout', 'manual_correction'],
  },

  packageName: { type: String },

  referenceId:   { type: mongoose.Schema.Types.ObjectId },
  referenceType: { type: String, enum: ['Contest', 'ContestContribution', 'ContestPayout', 'MonthlySnapshot'] },

  metadata: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

walletTransactionSchema.index({ userId: 1, createdAt: -1 });
walletTransactionSchema.index({ referenceId: 1, referenceType: 1 });
walletTransactionSchema.index({ type: 1, status: 1 });

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
