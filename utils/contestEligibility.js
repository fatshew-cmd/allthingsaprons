const User             = require('../models/User');
const PlatformSettings = require('../models/PlatformSettings');
const { getUserRatingStats } = require('./weightedRating');

// TEMP: bypass eligibility for these usernames during local testing — remove before launch
const TEST_BYPASS_USERNAMES = ['celuiqui', 'storiesbyshews'];

async function checkContestEligibility(userId) {
  const user = await User.findById(userId).select('username').lean();
  if (user && TEST_BYPASS_USERNAMES.includes(user.username?.value)) return { eligible: true };
  const settings   = await PlatformSettings.findOne({ key: 'global' }).lean();
  const thresholds = settings?.contestEligibility || {};
  const minEntries     = thresholds.minEntries     ?? 3;
  const minRatingCount = thresholds.minRatingCount ?? 25;
  const minWeightedAvg = thresholds.minWeightedAvg ?? 7.4;

  const { weightedAvg, totalRatingCount, ratedEntryCount } = await getUserRatingStats(userId);

  if (ratedEntryCount < minEntries) {
    return { eligible: false, reason: `You need at least ${minEntries} rated entries to participate in contests.` };
  }

  if (totalRatingCount < minRatingCount) {
    return { eligible: false, reason: `Your entries need at least ${minRatingCount} total ratings to participate in contests.` };
  }

  if (weightedAvg < minWeightedAvg) {
    return { eligible: false, reason: `Your weighted rating average must be at least ${minWeightedAvg} to participate in contests.` };
  }

  return { eligible: true };
}

module.exports = checkContestEligibility;
