const mongoose = require('mongoose');

const entrySchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  mediaUrl:    { type: String, required: true },
  mediaType:   { type: String, enum: ['photo', 'video'], required: true },
  title:       { type: String, required: true },
  caption:     { type: String },
  tags:        { type: [String], default: [], validate: { validator: v => v.length <= 6, message: 'Maximum 6 tags allowed' } },
  ratingCount:     { type: Number, default: 0 },
  ratingAvg:       { type: Number, default: 0 },
  commentCount:    { type: Number, default: 0 },
  visibility:      { type: String, enum: ['public', 'followers'], default: 'public' },
  commentsEnabled: { type: Boolean, default: true },
  matureContent:   { type: Boolean, default: false },
  aiGenerated:     { type: Boolean, default: false },
}, { timestamps: true });

entrySchema.index({ userId: 1 });

module.exports = mongoose.model('Entry', entrySchema);
