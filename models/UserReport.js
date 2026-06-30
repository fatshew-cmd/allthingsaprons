const mongoose = require('mongoose');

const userReportSchema = new mongoose.Schema({
  reportedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reportedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reasons:        { type: [String], default: [] },
  status:         { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
}, { timestamps: true });

userReportSchema.index({ reportedUserId: 1, reportedBy: 1 }, { unique: true });

module.exports = mongoose.model('UserReport', userReportSchema);
