const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  announcementId: { type: mongoose.Schema.Types.ObjectId, ref: 'Announcement', required: true },
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  seenAt:         { type: Date, default: Date.now },
});

schema.index({ announcementId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('AnnouncementImpression', schema);
