const mongoose = require('mongoose');

const tournamentJuryVoteSchema = new mongoose.Schema({
  tournamentId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  matchId:         { type: mongoose.Schema.Types.ObjectId, ref: 'TournamentMatch', required: true },
  jurorId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  votedForEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', required: true },
}, { timestamps: true });

tournamentJuryVoteSchema.index({ matchId: 1, jurorId: 1 }, { unique: true });
tournamentJuryVoteSchema.index({ matchId: 1 });

module.exports = mongoose.model('TournamentJuryVote', tournamentJuryVoteSchema);
