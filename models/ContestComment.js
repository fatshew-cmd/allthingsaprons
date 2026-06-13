const mongoose = require('mongoose');

const contestCommentSchema = new mongoose.Schema({
  contestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contest', required: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  parentId:  { type: mongoose.Schema.Types.ObjectId, ref: 'ContestComment', default: null },
  body:      { type: String, required: true, maxlength: 1000 },
  hidden:    { type: Boolean, default: false },
  editedAt:  { type: Date, default: null },
}, { timestamps: true });

contestCommentSchema.index({ contestId: 1 });
contestCommentSchema.index({ parentId: 1 });

module.exports = mongoose.model('ContestComment', contestCommentSchema);
