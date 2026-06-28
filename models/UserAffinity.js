const mongoose = require('mongoose');

const snapshotSchema = new mongoose.Schema({
  timestamp:     { type: Date, default: Date.now },
  stainScores:   { type: Map, of: Number, default: {} },
  creatorScores: { type: Map, of: Number, default: {} },
  source:        { type: String, default: 'session_refresh' },
}, { _id: false });

const userAffinitySchema = new mongoose.Schema({
  userId:                 { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  stainScores:            { type: Map, of: Number, default: {} },
  creatorScores:          { type: Map, of: Number, default: {} },
  lastActivityAt:         { type: Date },
  cumulativeSessionHours: { type: Number, default: 0 },
  lastRefreshedAt:        { type: Date },
  history:                [snapshotSchema],
}, { timestamps: true });

module.exports = mongoose.model('UserAffinity', userAffinitySchema);
