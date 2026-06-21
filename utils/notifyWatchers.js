const ContestWatch = require('../models/ContestWatch');
const Notification  = require('../models/Notification');

async function notifyWatchers(contestId, type, payload, excludeUserIds = []) {
  try {
    const watches = await ContestWatch.find({ contestId }).lean();
    if (!watches.length) return;

    const excludeSet = new Set(excludeUserIds.map(id => id.toString()));
    const docs = watches
      .filter(w => !excludeSet.has(w.userId.toString()))
      .map(w => ({ userId: w.userId, type, payload, read: false }));

    if (!docs.length) return;
    await Notification.insertMany(docs, { ordered: false });
  } catch (err) {
    console.error('[notifyWatchers] failed:', err.message);
  }
}

module.exports = notifyWatchers;
