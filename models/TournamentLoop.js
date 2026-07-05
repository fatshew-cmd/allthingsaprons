const mongoose = require('mongoose');

const tournamentLoopSchema = new mongoose.Schema({
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

tournamentLoopSchema.index({ tournamentId: 1, userId: 1 }, { unique: true });
tournamentLoopSchema.index({ tournamentId: 1 });

module.exports = mongoose.model('TournamentLoop', tournamentLoopSchema);
