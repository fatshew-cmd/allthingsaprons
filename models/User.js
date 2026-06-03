const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email:            { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:         { type: String, required: true },
  username:         { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  displayName:      { type: String, trim: true, maxlength: 50 },
  bio:              { type: String },
  avatar:           { type: String },
  banner:           { type: String },
  sex:              { type: String, enum: ['male', 'female', 'other', 'prefer-not-to-say'] },
  orientation:      { type: String },
  location:         { type: String },
  url:              { type: String, trim: true, maxlength: 200 },
  birthdate:        { type: Date },
  role:             { type: String, enum: ['user', 'admin'], default: 'user' },
  accountStatus:    { type: String, enum: ['onboarding', 'active'], default: 'onboarding' },
  onboardingStatus: { type: String, enum: ['pending_id_verification', 'pending_submission', 'pending_approval', 'approved', 'rejected'], default: 'pending_id_verification' },
  emailConfirmed:   { type: Boolean, default: false },
  idVerified:             { type: Boolean, default: false },
  idVerificationStatus:   { type: String, enum: ['none', 'pending'], default: 'none' },
  idSelfieUrl:            { type: String },
  idDocUrl:               { type: String },
  idVerificationCode:     { type: String },
  idVerifyFailedAttempts: { type: Number, default: 0 },
  idVerifyBlockedUntil:   { type: Date },
  wallet: {
    balanceCents: { type: Number, default: 0 },
    updatedAt:    { type: Date },
  },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
