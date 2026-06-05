const mongoose = require('mongoose');

const historyEntry = {
  _id:    false,
  value:  mongoose.Schema.Types.Mixed,
  setAt:  Date,
  source: String,
};

const userSchema = new mongoose.Schema({
  password: { type: String, required: true },
  role:     { type: String, enum: ['user', 'admin'], default: 'user' },

  email: {
    value:     { type: String, required: true, unique: true, lowercase: true, trim: true },
    confirmed: { type: Boolean, default: false },
    history:   [historyEntry],
  },

  username: {
    value:   { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    history: [historyEntry],
  },

  displayName: {
    value:   { type: String, trim: true, maxlength: 50 },
    history: [historyEntry],
  },

  bio: {
    value:   { type: String },
    history: [historyEntry],
  },

  avatar: {
    value:   { type: String },
    history: [historyEntry],
  },

  banner: {
    value:   { type: String },
    history: [historyEntry],
  },

  sex: {
    value:   { type: String, enum: ['male', 'female', 'other', 'prefer-not-to-say'] },
    history: [historyEntry],
  },

  orientation: {
    value:   { type: String },
    history: [historyEntry],
  },

  location: {
    value:   { type: String },
    history: [historyEntry],
  },

  url: {
    value:   { type: String, trim: true, maxlength: 200 },
    history: [historyEntry],
  },

  birthdate: {
    value:   { type: Date },
    history: [historyEntry],
  },

  accountStatus:    { type: String, enum: ['onboarding', 'active'], default: 'onboarding' },
  onboardingStatus: {
    type:    String,
    enum:    ['pending_id_verification', 'pending_submission', 'pending_approval', 'approved', 'rejected'],
    default: 'pending_id_verification',
  },

  idVerified:                     { type: Boolean, default: false },
  idVerificationStatus:           { type: String, enum: ['none', 'pending'], default: 'none' },
  idSelfieUrl:                    { type: String },
  idDocUrl:                       { type: String },
  idVerificationCode:             { type: String },
  idVerifyFailedAttempts:         { type: Number, default: 0 },
  idVerifyBlockedUntil:           { type: Date },
  idVerificationSubmittedAt:      { type: Date },
  idVerificationReviewedAt:       { type: Date },
  idVerificationClaimNumber:      { type: String },
  idVerificationRejectionReasons: [{ type: String }],

  wallet: {
    balanceCents: { type: Number, default: 0 },
    updatedAt:    { type: Date },
  },

  supportFirstReplyEmailSent: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
