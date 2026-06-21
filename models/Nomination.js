const mongoose = require('mongoose');

const nominationSchema = new mongoose.Schema({
  contestId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Contest', required: true },
  nominatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  nomineeId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message:     { type: String },
  expiresAt:   { type: Date, required: true },
  status:          { type: String, enum: ['pending', 'accepted', 'void'], default: 'pending' },
  nomineeEntryId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', default: null },
  challengerEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', default: null },
  type:              { type: String, enum: ['standard', 'take_on'], default: 'standard' },
}, { timestamps: true });

nominationSchema.index({ contestId: 1 });
nominationSchema.index({ nomineeId: 1 });
nominationSchema.index({ expiresAt: 1 });

module.exports = mongoose.model('Nomination', nominationSchema);
