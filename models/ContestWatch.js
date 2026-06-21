const mongoose = require('mongoose');

const contestWatchSchema = new mongoose.Schema({
  contestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contest', required: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

contestWatchSchema.index({ contestId: 1, userId: 1 }, { unique: true });
contestWatchSchema.index({ contestId: 1 });

module.exports = mongoose.model('ContestWatch', contestWatchSchema);
