const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema({
  createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:        { type: String, required: true, trim: true },
  description:  { type: String, trim: true },
  thumbnailUrl: { type: String },
  redirectUrl:  { type: String },
  filters: {
    sex:                  { type: String },
    ageMin:               { type: Number },
    orientation:          { type: String },
    followerCountMin:     { type: Number },
    followerCountMax:     { type: Number },
    apronTier:            { type: String, enum: ['flannel', 'denim', 'velvet'] },
    apronCountMin:        { type: Number },
    hasContestHistory:    { type: Boolean },
    hasTournamentHistory: { type: Boolean },
  },
  status:      { type: String, enum: ['draft', 'active', 'expired'], default: 'draft' },
  publishedAt: { type: Date },
  expiresAt:   { type: Date },
}, { timestamps: true });

announcementSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model('Announcement', announcementSchema);
