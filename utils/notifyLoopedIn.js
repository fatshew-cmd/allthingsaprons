const ContestLoop = require('../models/ContestLoop');
const Notification = require('../models/Notification');

async function notifyLoopedIn(contestId, type, payload, excludeUserIds = []) {
  try {
    const loops = await ContestLoop.find({ contestId }).lean();
    if (!loops.length) return;

    const excludeSet = new Set(excludeUserIds.map(id => id.toString()));
    const docs = loops
      .filter(w => !excludeSet.has(w.userId.toString()))
      .map(w => ({ userId: w.userId, type, payload, read: false }));

    if (!docs.length) return;
    await Notification.insertMany(docs, { ordered: false });
  } catch (err) {
    console.error('[notifyLoopedIn] failed:', err.message);
  }
}

module.exports = notifyLoopedIn;
