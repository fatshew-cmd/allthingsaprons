const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema({
  mediaUrl:     { type: String, required: true },
  mediaType:    { type: String, enum: ['image', 'video'], default: 'image' },
  title:        { type: String, required: true },
  description:  String,
  tags:         [String],
  creator:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  contest:      { type: mongoose.Schema.Types.ObjectId, ref: 'Contest' },
  ratingScore:  { type: Number, default: 0 },
  ratingCount:  { type: Number, default: 0 },
  price:        Number,
  isListed:     { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('Item', itemSchema);
