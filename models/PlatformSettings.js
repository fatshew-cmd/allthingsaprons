const mongoose = require('mongoose');

const PlatformSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'global', unique: true },
  contestEligibility: {
    minEntries:     { type: Number, default: 5 },
    minRatingCount: { type: Number, default: 250 },
    minWeightedAvg: { type: Number, default: 7.4 },
  },
}, { timestamps: true });

module.exports = mongoose.model('PlatformSettings', PlatformSettingsSchema);
