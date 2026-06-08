const mongoose = require('mongoose');

const bannedDocHashSchema = new mongoose.Schema({
  hash:     { type: String, required: true, unique: true },
  bannedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  caseRef:  { type: String },
  reason:   { type: String, default: 'max_verification_attempts' },
}, { timestamps: true });

module.exports = mongoose.model('BannedDocHash', bannedDocHashSchema);
