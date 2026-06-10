const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema({
  participants:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  lastMessageAt:   { type: Date, default: Date.now },
  lastMessageBody: { type: String, default: '' },
  lastSenderId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// participants always stored sorted (ascending string) — enables deterministic findOne
conversationSchema.index({ 'participants.0': 1, 'participants.1': 1 }, { unique: true });
conversationSchema.index({ participants: 1, lastMessageAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
