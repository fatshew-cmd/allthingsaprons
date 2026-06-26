const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:      {
    type: String,
    enum: ['comment', 'reply', 'nomination_received', 'contest_started', 'contest_closed', 'contest_voided', 'contest_forfeited', 'nominee_accepted', 'nominee_declined', 'viewer_nomination', 'take_on_received', 'take_on_accepted', 'contest_contribution', 'payout_reminder', 'payout_processed', 'contest_payout_available', 'comment_removed', 'report_reviewed', 'contest_stalled', 'contest_resumed', 'entry_reported', 'entry_removed'],
    required: true,
  },
  read:      { type: Boolean, default: false },
  payload:   { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('Notification', notificationSchema);
