const mongoose = require('mongoose');

const entryReportSchema = new mongoose.Schema({
  entryId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', required: true },
  reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status:     { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
}, { timestamps: true });

entryReportSchema.index({ entryId: 1, reportedBy: 1 }, { unique: true });

module.exports = mongoose.model('EntryReport', entryReportSchema);
