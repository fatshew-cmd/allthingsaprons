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
}, { timestamps: true });

tournamentEntrySchema.index({ tournamentId: 1, entryId: 1 }, { unique: true });
tournamentEntrySchema.index({ tournamentId: 1, approvalStatus: 1 });

module.exports = mongoose.model('TournamentEntry', tournamentEntrySchema);
