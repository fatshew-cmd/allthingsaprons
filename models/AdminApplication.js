const mongoose = require('mongoose');

const adminApplicationSchema = new mongoose.Schema({
  name:       { type: String, required: true, trim: true, maxlength: 100 },
  email:      { type: String, required: true, trim: true, lowercase: true },
  linkedin:   { type: String, trim: true, maxlength: 300 },
  message:    { type: String, required: true, trim: true, maxlength: 3000 },
  status:     { type: String, enum: ['pending', 'reviewed', 'hired', 'rejected'], default: 'pending' },
}, { timestamps: true });

adminApplicationSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('AdminApplication', adminApplicationSchema);
