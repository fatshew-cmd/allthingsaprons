const mongoose = require('mongoose');

// NOTE: never populate userId in any API response — jury identity must stay hidden
const tournamentJurySchema = new mongoose.Schema({
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  missedVotes:  { type: Number, default: 0 },
}, { timestamps: true });

tournamentJurySchema.index({ tournamentId: 1, userId: 1 }, { unique: true });
tournamentJurySchema.index({ tournamentId: 1 });

module.exports = mongoose.model('TournamentJury', tournamentJurySchema);
