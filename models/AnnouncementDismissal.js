const mongoose = require('mongoose');

const dismissalSchema = new mongoose.Schema({
  announcementId: { type: mongoose.Schema.Types.ObjectId, ref: 'Announcement', required: true },
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  dismissedAt:    { type: Date, default: Date.now },
});

dismissalSchema.index({ announcementId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('AnnouncementDismissal', dismissalSchema);
