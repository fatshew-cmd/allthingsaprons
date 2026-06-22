const mongoose = require('mongoose');

const monthlySnapshotSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  month:        { type: String, required: true }, // "YYYY-MM"
  snapshotDate: { type: Date,   required: true }, // 1st of month 00:00 UTC

  balanceCHL: { type: Number, required: true },

  autoPayoutDate:   { type: Date, required: true }, // 30th of same month
  makeupPayoutDate: { type: Date, required: true }, // 15th of next month

  status: {
    type: String,
    enum: ['pending', 'paid', 'held', 'makeup_paid'],
    default: 'pending',
  },

  amountPaidCHL: { type: Number },
  heldAt:        { type: Date },
  paidAt:        { type: Date },
}, { timestamps: true });

monthlySnapshotSchema.index({ userId: 1, month: 1 }, { unique: true });
monthlySnapshotSchema.index({ status: 1, autoPayoutDate: 1 });
monthlySnapshotSchema.index({ status: 1, makeupPayoutDate: 1 });

module.exports = mongoose.model('MonthlySnapshot', monthlySnapshotSchema);
