const mongoose = require('mongoose');

const profileShareSchema = new mongoose.Schema({
  sharerId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  profileUserId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  method:         { type: String, enum: ['clipboard', 'native'], required: true },
  userAgent:      { type: String, default: '' },
}, { timestamps: true });

profileShareSchema.index({ profileUserId: 1, createdAt: -1 });
profileShareSchema.index({ sharerId: 1, createdAt: -1 });

module.exports = mongoose.model('ProfileShare', profileShareSchema);
