const mongoose = require('mongoose');

const tournamentGroupSchema = new mongoose.Schema({
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  label:        { type: String, required: true },
  memberIds:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'TournamentEntry' }],
  status:       { type: String, enum: ['active', 'complete'], default: 'active' },

  // 3+-way boundary tie resolution (jobs/tournamentJobs.js's resolveGroup/resolveGroupTieCluster)
  // — mirrors TournamentMatch's tieStatus/tieDeadline/juryNotifiedAt fields, but for a group's
  // ranking dispute rather than a single H2H match result.
  tieStatus:          { type: String, enum: ['jury_pending', 'organizer_pending', 'resolved'], default: null },
  tieDeadline:        { type: Date, default: null },
  juryNotifiedAt:     { type: Date, default: null },
  // The tied cluster in dispute (a contiguous slice of the group's ranking, all sharing the
  // same groupPoints/ratingAvg/ratingCount/totalVotesInGroup) and how many of them ultimately
  // advance — the rest are eliminated regardless of their resolved order within the cluster.
  tiedEntryIds:       [{ type: mongoose.Schema.Types.ObjectId, ref: 'TournamentEntry' }],
  tieSlotsForCluster: { type: Number, default: null },
  tieResolvedOrder:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'TournamentEntry' }],
}, { timestamps: true });

tournamentGroupSchema.index({ tournamentId: 1 });
tournamentGroupSchema.index({ tournamentId: 1, status: 1 });
tournamentGroupSchema.index({ tieStatus: 1, tieDeadline: 1 });

module.exports = mongoose.model('TournamentGroup', tournamentGroupSchema);
