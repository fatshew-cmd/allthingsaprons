const User             = require('../models/User');
const Entry            = require('../models/Entry');
const PlatformSettings = require('../models/PlatformSettings');

// TEMP: bypass eligibility for these usernames during local testing — remove before launch
const TEST_BYPASS_USERNAMES = ['celuiqui', 'storiesbyshews'];

async function checkContestEligibility(userId) {
  const user = await User.findById(userId).select('username').lean();
  if (user && TEST_BYPASS_USERNAMES.includes(user.username?.value)) return { eligible: true };
  const settings   = await PlatformSettings.findOne({ key: 'global' }).lean();
  const thresholds = settings?.contestEligibility || {};
  const minEntries     = thresholds.minEntries     ?? 5;
  const minRatingCount = thresholds.minRatingCount ?? 250;
  const minWeightedAvg = thresholds.minWeightedAvg ?? 7.4;

  const entries      = await Entry.find({ userId }).select('ratingCount ratingAvg').lean();
  const ratedEntries = entries.filter(e => e.ratingCount > 0);

  if (ratedEntries.length < minEntries) {
    return { eligible: false, reason: `You need at least ${minEntries} rated entries to participate in contests.` };
  }

  const totalRatings = ratedEntries.reduce((s, e) => s + e.ratingCount, 0);
  if (totalRatings < minRatingCount) {
    return { eligible: false, reason: `Your entries need at least ${minRatingCount} total ratings to participate in contests.` };
  }

  const weightedAvg = ratedEntries.reduce((s, e) => s + e.ratingAvg * e.ratingCount, 0) / totalRatings;
  if (weightedAvg < minWeightedAvg) {
    return { eligible: false, reason: `Your weighted rating average must be at least ${minWeightedAvg} to participate in contests.` };
  }

  return { eligible: true };
}

module.exports = checkContestEligibility;
