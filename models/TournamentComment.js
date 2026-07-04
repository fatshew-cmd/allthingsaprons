const mongoose = require('mongoose');

const tournamentCommentSchema = new mongoose.Schema({
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  parentId:     { type: mongoose.Schema.Types.ObjectId, ref: 'TournamentComment', default: null },
  body:         { type: String, required: true, maxlength: 1000 },
  hidden:       { type: Boolean, default: false },
  editedAt:     { type: Date, default: null },
  likes:        [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  dislikes:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { timestamps: true });

tournamentCommentSchema.index({ tournamentId: 1 });
tournamentCommentSchema.index({ parentId: 1 });

module.exports = mongoose.model('TournamentComment', tournamentCommentSchema);
