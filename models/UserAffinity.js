const mongoose = require('mongoose');

const snapshotSchema = new mongoose.Schema({
  timestamp:     { type: Date, default: Date.now },
  tagScores:     { type: Map, of: Number, default: {} },
  creatorScores: { type: Map, of: Number, default: {} },
  source:        { type: String, default: 'job_run' },
}, { _id: false });

const userAffinitySchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  history: [snapshotSchema],
}, { timestamps: true });

module.exports = mongoose.model('UserAffinity', userAffinitySchema);
