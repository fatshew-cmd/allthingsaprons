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
  // Deadline for the current tieStatus phase (6h for jury, 3h for organizer) — stored so the
  // sweeper (jobs/sweeper.js) can recover it directly if the one-time agenda job is ever lost,
  // same pattern as Tournament.openDeadline/cooldownDeadline.
  tieDeadline:             { type: Date, default: null },
  // Stamped once initiateTieResolution's juror notifications actually go out — lets
  // tournamentJuryExpiry (jobs/tournamentJobs.js) tell "jurors were notified but didn't vote"
  // apart from "the process crashed between the tie claim and the notify step", so a crash
  // there triggers a retry instead of penalizing jurors for a vote they never knew about.
  juryNotifiedAt:          { type: Date, default: null },
  isTiebreakerMatch:      { type: Boolean, default: false },
  scheduledAt:            { type: Date, required: true },
  openedAt:               { type: Date, default: null },
}, { timestamps: true });

tournamentMatchSchema.index({ tournamentId: 1, stage: 1 });
tournamentMatchSchema.index({ tournamentId: 1, groupId: 1 });
tournamentMatchSchema.index({ contestId: 1 }, { unique: true });
tournamentMatchSchema.index({ tournamentId: 1, status: 1 });
tournamentMatchSchema.index({ tournamentId: 1, knockoutRound: 1 });
// At most one tiebreaker match per group — guards against two concurrent resolveGroup
// calls (jobs/tournamentJobs.js) both creating one for the same boundary tie.
tournamentMatchSchema.index({ groupId: 1 }, { unique: true, partialFilterExpression: { isTiebreakerMatch: true } });
tournamentMatchSchema.index({ tieStatus: 1, tieDeadline: 1 });

module.exports = mongoose.model('TournamentMatch', tournamentMatchSchema);
