const mongoose = require('mongoose');

const supportMessageSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  from:        { type: String, enum: ['user', 'support'], required: true },
  body:        { type: String, default: '' },
  attachments: [{ type: String }],
  readByUser:    { type: Boolean, default: false },
  readBySupport: { type: Boolean, default: false },
}, { timestamps: true });

supportMessageSchema.index({ userId: 1, createdAt: 1 });

module.exports = mongoose.model('SupportMessage', supportMessageSchema);
