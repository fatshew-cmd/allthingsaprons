const mongoose = require('mongoose');

// A juror's single top-pick vote in a 3+-way group-ranking boundary tie (see
// jobs/tournamentJobs.js's resolveGroup/resolveGroupJuryVote). Distinct from
// TournamentJuryVote, which is scoped to a single H2H match tie, not a group's ranking.
const tournamentGroupTieVoteSchema = new mongoose.Schema({
  tournamentId:              { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  groupId:                   { type: mongoose.Schema.Types.ObjectId, ref: 'TournamentGroup', required: true },
  jurorId:                   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  votedForTournamentEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'TournamentEntry', required: true },
}, { timestamps: true });

tournamentGroupTieVoteSchema.index({ groupId: 1, jurorId: 1 }, { unique: true });
tournamentGroupTieVoteSchema.index({ groupId: 1 });

module.exports = mongoose.model('TournamentGroupTieVote', tournamentGroupTieVoteSchema);
