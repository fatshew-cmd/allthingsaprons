const mongoose = require('mongoose');

const contestContributionSchema = new mongoose.Schema({
  contestId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Contest', required: true },
  entryId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Entry',   required: true },
  beneficiaryId: { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
  contributorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },

  amountCHL: { type: Number, required: true, min: 1 },

  status: { type: String, enum: ['active', 'withdrawn', 'locked'], default: 'active' },
  lockedAt: { type: Date },
}, { timestamps: true });

// one contribution record per contributor per entry per contest — updated in place
contestContributionSchema.index({ contestId: 1, contributorId: 1, entryId: 1 }, { unique: true });
contestContributionSchema.index({ contestId: 1, beneficiaryId: 1 });
contestContributionSchema.index({ contributorId: 1, status: 1 });

module.exports = mongoose.model('ContestContribution', contestContributionSchema);
