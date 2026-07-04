const mongoose = require('mongoose');

// NOTE: never populate userId in any API response — jury identity must stay hidden
// (except to the organizer, who already knows who they picked — e.g. the jury-manage page)
const tournamentJurySchema = new mongoose.Schema({
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  missedVotes:  { type: Number, default: 0 },
  status:       { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' },
  respondedAt:  { type: Date, default: null },
}, { timestamps: true });

tournamentJurySchema.index({ tournamentId: 1, userId: 1 }, { unique: true });
tournamentJurySchema.index({ tournamentId: 1 });
tournamentJurySchema.index({ tournamentId: 1, status: 1 });

module.exports = mongoose.model('TournamentJury', tournamentJurySchema);
