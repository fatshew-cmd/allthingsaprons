const mongoose = require('mongoose');

const profileShareViewSchema = new mongoose.Schema({
  viewerId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  profileUserId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  referer:        { type: String, default: '' },
  userAgent:      { type: String, default: '' },
}, { timestamps: true });

profileShareViewSchema.index({ profileUserId: 1, createdAt: -1 });
profileShareViewSchema.index({ viewerId: 1, createdAt: -1 });

module.exports = mongoose.model('ProfileShareView', profileShareViewSchema);
