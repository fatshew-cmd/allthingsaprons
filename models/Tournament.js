const mongoose = require('mongoose');

const criteriaSchema = new mongoose.Schema({
  field:    { type: String, enum: ['ratingAvg', 'ratingCount', 'followerCount', 'age', 'sex', 'entryCount', 'accountAgeDays'], required: true },
  operator: { type: String, enum: ['gte', 'lte', 'eq'], required: true },
  value:    { type: mongoose.Schema.Types.Mixed, required: true },
}, { _id: false });

const tournamentSchema = new mongoose.Schema({
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:        { type: String, required: true },
  description: { type: String },
  thumbnailUrl: { type: String, required: true },
  visibility:  { type: String, enum: ['public', 'private'], default: 'public' },

  size:        { type: Number, enum: [4, 8, 12, 16, 24], required: true },
  groupSize:   { type: Number, required: true },
  groupCount:  { type: Number, required: true },

  eligibilityCriteria: { type: [criteriaSchema], default: [] },

  prizes: {
    first:  { type: Number, required: true, min: 350 },
    second: { type: Number, required: true, min: 100 },
    // No 3rd-place match exists for a 4-player tournament (Final only) — never required for size 4.
    third:  { type: Number, required: function () { return this.size !== 4; }, min: 50 },
    funded:     { type: Boolean, default: false },
    winnersSet: { type: Boolean, default: false },
  },

  status: { type: String, enum: ['open', 'cooldown', 'active', 'closed', 'canceled'], required: true },

  openDeadline:     { type: Date, required: true },
  cooldownDeadline: { type: Date },
  activeAt:         { type: Date },

  cancelReason: { type: String, default: null },
}, { timestamps: true });

tournamentSchema.index({ status: 1 });
tournamentSchema.index({ createdBy: 1 });
tournamentSchema.index({ openDeadline: 1, status: 1 });
tournamentSchema.index({ cooldownDeadline: 1, status: 1 });

module.exports = mongoose.model('Tournament', tournamentSchema);
