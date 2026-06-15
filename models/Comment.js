const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  entryId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', required: true },
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
  body:     { type: String, required: true },
  hidden:   { type: Boolean, default: false },
  editedAt: { type: Date, default: null },
}, { timestamps: true });

commentSchema.index({ entryId: 1 });
commentSchema.index({ parentId: 1 });

module.exports = mongoose.model('Comment', commentSchema);
