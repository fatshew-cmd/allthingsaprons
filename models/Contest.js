const mongoose = require('mongoose');

const contestSchema = new mongoose.Schema({
  title:          { type: String, required: true },
  theme:          { type: String, required: true },
  description:    { type: String },
  organizer:      { type: String, required: true },
  coverUrl:       { type: String },

  status:         { type: String, enum: ['upcoming', 'active', 'ended'], default: 'upcoming' },
  endDate:        { type: Date },

  visibility:     { type: String, enum: ['public', 'private'], default: 'public' },
  accessToken:    { type: String },

  jury:           [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  voteAccess:     { type: String, enum: ['anyone', 'subscribers'], default: 'anyone' },
  enterAccess:    { type: String, enum: ['anyone', 'subscribers'], default: 'anyone' },

  submissionCount: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Contest', contestSchema);
