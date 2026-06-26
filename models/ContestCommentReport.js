const mongoose = require('mongoose');

const contestCommentReportSchema = new mongoose.Schema({
  contestCommentId: { type: mongoose.Schema.Types.ObjectId, ref: 'ContestComment', required: true },
  reportedBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status:           { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
}, { timestamps: true });

contestCommentReportSchema.index({ contestCommentId: 1, reportedBy: 1 }, { unique: true });

module.exports = mongoose.model('ContestCommentReport', contestCommentReportSchema);
