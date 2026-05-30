const mongoose = require('mongoose');

const challengeEntrySchema = new mongoose.Schema({
  entryId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', required: true },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  submittedAt: { type: Date, required: true },
}, { _id: false });

const ratingsChallengeSchema = new mongoose.Schema({
  contestId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Contest', required: true },
  windowHours:   { type: Number, required: true },
  deadline:      { type: Date, required: true },
  status:        { type: String, enum: ['active', 'closed'], default: 'active' },
  winnerUserId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  entries:       [challengeEntrySchema],
}, { timestamps: true });

module.exports = mongoose.model('RatingsChallenge', ratingsChallengeSchema);
