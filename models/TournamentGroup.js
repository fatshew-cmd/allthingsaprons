const mongoose = require('mongoose');

const tournamentGroupSchema = new mongoose.Schema({
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  label:        { type: String, required: true },
  memberIds:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'TournamentEntry' }],
  status:       { type: String, enum: ['active', 'complete'], default: 'active' },
}, { timestamps: true });

tournamentGroupSchema.index({ tournamentId: 1 });
tournamentGroupSchema.index({ tournamentId: 1, status: 1 });

module.exports = mongoose.model('TournamentGroup', tournamentGroupSchema);
