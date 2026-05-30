const mongoose = require('mongoose');

const ratingsChallengeVoteSchema = new mongoose.Schema({
  challengeId: { type: mongoose.Schema.Types.ObjectId, ref: 'RatingsChallenge', required: true },
  entryId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', required: true },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  score:       { type: Number, required: true, min: 1, max: 10 },
}, { timestamps: true });

ratingsChallengeVoteSchema.index({ challengeId: 1, entryId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('RatingsChallengeVote', ratingsChallengeVoteSchema);
