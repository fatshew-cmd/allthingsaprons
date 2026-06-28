const SURGE_CAP = 10;

function computeSurgeMultiplier(currentActivity, historicalDailyBaseline) {
  const surge = currentActivity / Math.max(historicalDailyBaseline, 1);
  return Math.min(Math.log(1 + surge), SURGE_CAP);
}

module.exports = { computeSurgeMultiplier };
