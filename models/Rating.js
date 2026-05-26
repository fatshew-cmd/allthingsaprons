const mongoose = require('mongoose');

const ratingSchema = new mongoose.Schema({
  user:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  item:  { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
  mode:  { type: String, enum: ['rate', 'compare'], required: true },
  score: { type: Number, required: true },
}, { timestamps: true });

ratingSchema.index({ user: 1, item: 1 });

module.exports = mongoose.model('Rating', ratingSchema);
