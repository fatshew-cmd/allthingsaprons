const mongoose = require('mongoose');

const contestVoteSchema = new mongoose.Schema({
  contestId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Contest', required: true },
  entryId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', required: true },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  valueCents:  { type: Number, required: true, default: 0 },
}, { timestamps: true });

contestVoteSchema.index({ contestId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('ContestVote', contestVoteSchema);
