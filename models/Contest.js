const mongoose = require('mongoose');

const contestEntrySchema = new mongoose.Schema({
  entryId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', required: true },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  submittedAt: { type: Date, required: true },
  hidden:      { type: Boolean, default: false },
}, { _id: false });

const contestSchema = new mongoose.Schema({
  createdBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  visibility:      { type: String, enum: ['public', 'private'], required: true },
  status:          { type: String, enum: ['pending', 'active', 'void', 'closed'], default: 'pending' },
  tournamentId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', default: null },
  parentContestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contest', default: null },
  windowHours:     { type: Number, default: 72 },
  voidDeadline:    { type: Date },
  votingDeadline:  { type: Date },
  winnerEntryId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', default: null },
  voidReason:      { type: String, enum: ['expired', 'declined', 'canceled', 'nominee_forfeit', 'nominator_forfeit'], default: null },
  entries:         [contestEntrySchema],
  designatedVoters: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { timestamps: true });

contestSchema.index({ tournamentId: 1 });
contestSchema.index({ status: 1 });
contestSchema.index({ voidDeadline: 1 });
contestSchema.index({ votingDeadline: 1 });

// Normalize expired-pending contests to void at read time (until the background job runs in Phase 5)
function applyVoidDeadline(doc) {
  if (doc && doc.status === 'pending' && doc.voidDeadline && new Date() > new Date(doc.voidDeadline)) {
    doc.status = 'void';
    if (!doc.voidReason) doc.voidReason = 'expired';
  }
}
contestSchema.post('find',      function(docs) { docs.forEach(applyVoidDeadline); });
contestSchema.post('findOne',   function(doc)  { applyVoidDeadline(doc); });

module.exports = mongoose.model('Contest', contestSchema);
