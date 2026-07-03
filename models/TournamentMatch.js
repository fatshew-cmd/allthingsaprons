const mongoose = require('mongoose');

const tournamentMatchSchema = new mongoose.Schema({
  tournamentId:           { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  contestId:              { type: mongoose.Schema.Types.ObjectId, ref: 'Contest', required: true },
  stage:                  { type: String, enum: ['group', 'knockout'], required: true },
  groupId:                { type: mongoose.Schema.Types.ObjectId, ref: 'TournamentGroup', default: null },
  knockoutRound:          { type: String, enum: ['R16', 'QF', 'SF', '3rd', 'Final'], default: null },
  entryIdA:               { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', required: true },
  entryIdB:               { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', required: true },
  tournamentEntryIdA:     { type: mongoose.Schema.Types.ObjectId, ref: 'TournamentEntry', required: true },
  tournamentEntryIdB:     { type: mongoose.Schema.Types.ObjectId, ref: 'TournamentEntry', required: true },
  winnerId:               { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', default: null },
  loserTournamentEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'TournamentEntry', default: null },
  status:                 { type: String, enum: ['scheduled', 'active', 'tie', 'closed'], default: 'scheduled' },
  tieStatus:               { type: String, enum: ['jury_pending', 'organizer_pending', 'resolved'], default: null },
  isTiebreakerMatch:      { type: Boolean, default: false },
  scheduledAt:            { type: Date, required: true },
  openedAt:               { type: Date, default: null },
}, { timestamps: true });

tournamentMatchSchema.index({ tournamentId: 1, stage: 1 });
tournamentMatchSchema.index({ tournamentId: 1, groupId: 1 });
tournamentMatchSchema.index({ contestId: 1 }, { unique: true });
tournamentMatchSchema.index({ tournamentId: 1, status: 1 });
tournamentMatchSchema.index({ tournamentId: 1, knockoutRound: 1 });

module.exports = mongoose.model('TournamentMatch', tournamentMatchSchema);
