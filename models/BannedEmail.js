const mongoose = require('mongoose');

const bannedEmailSchema = new mongoose.Schema({
  email:      { type: String, required: true, unique: true, lowercase: true, trim: true },
  bannedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  caseRef:    { type: String },
  reason:     { type: String, default: 'max_verification_attempts' },
}, { timestamps: true });

module.exports = mongoose.model('BannedEmail', bannedEmailSchema);
