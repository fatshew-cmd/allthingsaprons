const mongoose = require('mongoose');

const ratingSchema = new mongoose.Schema({
  entryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', required: true },
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  score:   { type: Number, required: true, min: 1, max: 10 },
}, { timestamps: true });

ratingSchema.index({ entryId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('Rating', ratingSchema);
