const mongoose = require('mongoose');

const tournamentReportSchema = new mongoose.Schema({
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  reportedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status:       { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
}, { timestamps: true });

tournamentReportSchema.index({ tournamentId: 1, reportedBy: 1 }, { unique: true });

module.exports = mongoose.model('TournamentReport', tournamentReportSchema);
