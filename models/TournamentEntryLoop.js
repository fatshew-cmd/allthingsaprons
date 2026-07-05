const mongoose = require('mongoose');

const tournamentEntryLoopSchema = new mongoose.Schema({
  tournamentEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'TournamentEntry', required: true },
  tournamentId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  userId:            { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

tournamentEntryLoopSchema.index({ tournamentEntryId: 1, userId: 1 }, { unique: true });
tournamentEntryLoopSchema.index({ tournamentEntryId: 1 });
tournamentEntryLoopSchema.index({ tournamentId: 1, userId: 1 });

module.exports = mongoose.model('TournamentEntryLoop', tournamentEntryLoopSchema);
