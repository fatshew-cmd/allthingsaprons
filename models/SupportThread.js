const mongoose = require('mongoose');

const TOPICS = ['general', 'id_verification', 'billing', 'moderation'];

const TOPIC_LABELS = {
  general:         'General',
  id_verification: 'Identity Verification',
  billing:         'Billing & Transactions',
  moderation:      'Moderation Dispute',
};

const supportThreadSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  topic:  { type: String, enum: TOPICS, required: true, default: 'general' },
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
}, { timestamps: true });

supportThreadSchema.index({ userId: 1, topic: 1 });
supportThreadSchema.index({ status: 1, updatedAt: -1 });

const SupportThread = mongoose.model('SupportThread', supportThreadSchema);
SupportThread.TOPICS       = TOPICS;
SupportThread.TOPIC_LABELS = TOPIC_LABELS;

module.exports = SupportThread;
