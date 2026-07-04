const mongoose = require('mongoose');

const tournamentCommentReportSchema = new mongoose.Schema({
  tournamentCommentId: { type: mongoose.Schema.Types.ObjectId, ref: 'TournamentComment', required: true },
  reportedBy:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status:              { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
}, { timestamps: true });

tournamentCommentReportSchema.index({ tournamentCommentId: 1, reportedBy: 1 }, { unique: true });

module.exports = mongoose.model('TournamentCommentReport', tournamentCommentReportSchema);
