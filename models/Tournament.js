const mongoose = require('mongoose');

const prizeSlotSchema = new mongoose.Schema({
  amountCents: { type: Number, required: true },
  entryId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', default: null },
}, { _id: false });

const tournamentSchema = new mongoose.Schema({
  createdBy:              { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:                   { type: String, enum: ['platform', 'user_organized'], required: true },
  name:                   { type: String, required: true },
  description:            { type: String },
  participantCount:       { type: Number, required: true },

  entryWindowHours:       { type: Number, default: 72 },
  cooldownHours:          { type: Number, default: 3 },
  roundWindowHours:       { type: Number, default: 72 },

  entryDeadline:          { type: Date },
  roundsStartAt:          { type: Date },

  prizes: {
    first:  { type: prizeSlotSchema, required: true },
    second: { type: prizeSlotSchema, required: true },
    third:  { type: prizeSlotSchema, required: true },
  },

  fundsHeld:     { type: Boolean, default: false },
  reviewStatus:  { type: String, enum: ['pending_review', 'approved', 'rejected'] },
  missedReviews: { type: Number, default: 0 },
  status:        { type: String, enum: ['pending_funds', 'pending_review', 'open', 'cooldown', 'active', 'closed', 'canceled'], required: true },
}, { timestamps: true });

tournamentSchema.index({ status: 1 });
tournamentSchema.index({ createdBy: 1 });

module.exports = mongoose.model('Tournament', tournamentSchema);
