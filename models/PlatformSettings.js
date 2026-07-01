const mongoose = require('mongoose');

const PlatformSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'global', unique: true },
  contestEligibility: {
    minEntries:     { type: Number, default: 3 },
    minRatingCount: { type: Number, default: 25 },
    minWeightedAvg: { type: Number, default: 7.4 },
  },
  entryReportThresholds: {
    type: [{
      count:         { type: Number, required: true },
      windowMinutes: { type: Number, required: true },
    }],
    default: [
      { count: 3,  windowMinutes: 60  },
      { count: 5,  windowMinutes: 360 },
      { count: 10, windowMinutes: 1440 },
    ],
  },
}, { timestamps: true });

module.exports = mongoose.model('PlatformSettings', PlatformSettingsSchema);
