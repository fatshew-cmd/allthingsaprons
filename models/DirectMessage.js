const mongoose = require('mongoose');

const directMessageSchema = new mongoose.Schema({
  conversationId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  senderId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  body:            { type: String, required: true, maxlength: 500 },
  readByRecipient: { type: Boolean, default: false },
}, { timestamps: true });

directMessageSchema.index({ conversationId: 1, createdAt: 1 });

module.exports = mongoose.model('DirectMessage', directMessageSchema);
