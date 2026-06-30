const mongoose = require('mongoose');

const historyEntry = {
  _id:    false,
  value:  mongoose.Schema.Types.Mixed,
  setAt:  Date,
  source: String,
};

const userSchema = new mongoose.Schema({
  password:    { type: String, required: true },
  role:        { type: String, enum: ['user', 'moderator', 'supervisor', 'superadmin', 'founder'], default: 'user' },
  permissions: {
    type: [{
      type: String,
      enum: ['content', 'chat', 'comments', 'financial', 'support'],
    }],
    default: [],
    validate: {
      validator: function (perms) {
        if (this.role === 'moderator') return perms.length === 1;
        if (this.role === 'supervisor') return perms.length >= 1;
        return true;
      },
      message: 'Moderators must have exactly 1 permission; supervisors must have at least 1.',
    },
  },

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
    value:   { type: String, trim: true, maxlength: 50, index: true },
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
    posX:    { type: Number, default: 0.5 },
    posY:    { type: Number, default: 0.5 },
    zoom:    { type: Number, default: 1 },
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

  accountStatus: { type: String, enum: ['active', 'invited', 'banned'], default: 'active' },

  idVerified:                     { type: Boolean, default: false },
  idVerificationStatus:           { type: String, enum: ['none', 'pending', 'closed'], default: 'none' },
  idSelfieUrl:                    { type: String },
  idDocUrl:                       { type: String },
  idVerificationCode:             { type: String },
  idVerifyFailedAttempts:         { type: Number, default: 0 },
  idVerifyBlockedUntil:           { type: Date },
  idVerificationSubmittedAt:      { type: Date },
  idVerificationReviewedAt:       { type: Date },
  idVerificationClaimNumber:      { type: String },
  idVerificationRejectionReasons: [{ type: String }],
  idVerificationCaseRef:          { type: String },
  idVerificationEscalated:        { type: Boolean, default: false },
  idDocHash:                      { type: String, index: true },

  ageAcknowledged:            { type: Boolean, default: false },
  ageAcknowledgedAt:          { type: Date },
  adultContentAcknowledged:   { type: Boolean, default: false },
  adultContentAcknowledgedAt: { type: Date },

  wallet: {
    purchasedCHL: { type: Number, default: 0 },
    earnedCHL:    { type: Number, default: 0 },
    updatedAt:    { type: Date },
  },

  supportFirstReplyEmailSent: { type: Boolean, default: false },

  adminInviteToken:  { type: String },
  adminInviteExpiry: { type: Date },
  isTemporary:       { type: Boolean, default: false },
  temporaryUntil:    { type: Date },

  pinnedEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', default: null },

  nominationSettings: {
    allow:          { type: Boolean, default: true },
    whoCanNominate: {
      type:    String,
      enum:    ['everyone', 'followers_only', 'followees_only', 'mutual_follow'],
      default: 'everyone',
    },
  },

  privacySettings: {
    whoCanDm:            { type: String, enum: ['everyone', 'followers_only', 'mutual_follow'], default: 'everyone' },
    whoCanComment:       { type: String, enum: ['everyone', 'followers_only', 'contributors_only'], default: 'everyone' },
    showMatureContent:   { type: Boolean, default: true },
    showAiContent:       { type: Boolean, default: true },
    defaultAllowTakeOns: { type: Boolean, default: true },
    bookmarksPrivate:    { type: Boolean, default: false },
  },

  notificationSettings: {
    inAppComments:    { type: Boolean, default: true },
    inAppNominations: { type: Boolean, default: true },
    inAppContests:    { type: Boolean, default: true },
    inAppPayouts:     { type: Boolean, default: true },
    emailComments:    { type: Boolean, default: true },
    emailNominations: { type: Boolean, default: true },
    emailContests:    { type: Boolean, default: true },
    emailPayouts:     { type: Boolean, default: true },
  },

  adminFlags: {
    type: [{
      _id:   false,
      key:   { type: String, required: true, trim: true },
      setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      setAt: { type: Date, default: Date.now },
    }],
    default: [],
  },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
