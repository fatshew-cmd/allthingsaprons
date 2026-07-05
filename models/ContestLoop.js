const mongoose = require('mongoose');

const contestLoopSchema = new mongoose.Schema({
  contestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contest', required: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

contestLoopSchema.index({ contestId: 1, userId: 1 }, { unique: true });
contestLoopSchema.index({ contestId: 1 });

module.exports = mongoose.model('ContestLoop', contestLoopSchema);
