const mongoose = require('mongoose');

const tournamentEntrySchema = new mongoose.Schema({
  tournamentId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  entryId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Entry', required: true },
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected', 'timed_out'], default: 'pending' },
  wins:           { type: Number, default: 0 },
  losses:         { type: Number, default: 0 },
  totalVotes:     { type: Number, default: 0 },
  eliminated:     { type: Boolean, default: false },
  submittedAt:    { type: Date, required: true },
  reviewedAt:     { type: Date, default: null },
  autoSubmitted:  { type: Boolean, default: false },

  groupId:       { type: mongoose.Schema.Types.ObjectId, ref: 'TournamentGroup', default: null },
  groupPoints:   { type: Number, default: 0 },
  groupWins:     { type: Number, default: 0 },
  groupLosses:   { type: Number, default: 0 },
  groupRank:     { type: Number, default: null },
  knockoutRound: { type: String, enum: ['R16', 'QF', 'SF', '3rd', 'Final'], default: null },
}, { timestamps: true });

tournamentEntrySchema.index({ tournamentId: 1, entryId: 1 }, { unique: true });
tournamentEntrySchema.index({ tournamentId: 1, approvalStatus: 1 });
tournamentEntrySchema.index({ tournamentId: 1, groupId: 1 });
tournamentEntrySchema.index({ tournamentId: 1, eliminated: 1 });
tournamentEntrySchema.index({ userId: 1, submittedAt: -1 });

module.exports = mongoose.model('TournamentEntry', tournamentEntrySchema);
