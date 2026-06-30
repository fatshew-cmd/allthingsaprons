const mongoose = require('mongoose');

const userBlockSchema = new mongoose.Schema({
  blockerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  blockedId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

userBlockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
userBlockSchema.index({ blockedId: 1 });

module.exports = mongoose.model('UserBlock', userBlockSchema);
