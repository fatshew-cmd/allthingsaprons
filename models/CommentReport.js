const mongoose = require('mongoose');

const commentReportSchema = new mongoose.Schema({
  commentId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', required: true },
  reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status:     { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
}, { timestamps: true });

commentReportSchema.index({ commentId: 1, reportedBy: 1 }, { unique: true });

module.exports = mongoose.model('CommentReport', commentReportSchema);
