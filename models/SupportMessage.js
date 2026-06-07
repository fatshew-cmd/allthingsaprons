const mongoose = require('mongoose');

const supportMessageSchema = new mongoose.Schema({
  threadId:    { type: mongoose.Schema.Types.ObjectId, ref: 'SupportThread', required: true },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  from:        { type: String, enum: ['user', 'support'], required: true },
  body:        { type: String, default: '' },
  attachments: [{ type: String }],
  readByUser:    { type: Boolean, default: false },
  readBySupport: { type: Boolean, default: false },
}, { timestamps: true });

supportMessageSchema.index({ threadId: 1, createdAt: 1 });
supportMessageSchema.index({ userId: 1, from: 1, readByUser: 1 });

module.exports = mongoose.model('SupportMessage', supportMessageSchema);
