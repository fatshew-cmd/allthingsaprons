const mongoose = require('mongoose');

const contestPayoutSchema = new mongoose.Schema({
  contestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contest', required: true },
  entryId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Entry',   required: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },

  grossContributionsCHL: { type: Number, required: true, default: 0 },
  netPayoutCHL:          { type: Number, required: true, default: 0 },
  platformFeeCHL:        { type: Number, required: true, default: 0 },

  status: { type: String, enum: ['completed'], default: 'completed' },
  paidAt: { type: Date },
}, { timestamps: true });

contestPayoutSchema.index({ userId: 1 });
contestPayoutSchema.index({ contestId: 1 });

module.exports = mongoose.model('ContestPayout', contestPayoutSchema);
