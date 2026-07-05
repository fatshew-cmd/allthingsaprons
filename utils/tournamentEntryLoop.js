const TournamentEntryLoop = require('../models/TournamentEntryLoop');
const Notification        = require('../models/Notification');

// entries: [{ tournamentEntryId, type, payload }, ...] — one object per side of a match,
// each with its own already-composed, side-specific payload (a match's two entries can have
// different loop-ins and need "opponent" framing relative to whichever entry is being followed).
async function notifyEntryLoopedIn(entries, excludeUserIds = []) {
  try {
    if (!entries?.length) return;

    const ids = entries.map(e => e.tournamentEntryId);
    const loopDocs = await TournamentEntryLoop.find({ tournamentEntryId: { $in: ids } }).lean();
    if (!loopDocs.length) return;

    const excludeSet = new Set(excludeUserIds.map(id => id.toString()));
    const loopedInByEntry = {};
    for (const w of loopDocs) {
      const key = w.tournamentEntryId.toString();
      if (!loopedInByEntry[key]) loopedInByEntry[key] = [];
      loopedInByEntry[key].push(w.userId);
    }

    const docs = [];
    for (const { tournamentEntryId, type, payload } of entries) {
      const loopedIn = loopedInByEntry[tournamentEntryId.toString()] || [];
      for (const userId of loopedIn) {
        if (excludeSet.has(userId.toString())) continue;
        docs.push({ userId, type, payload });
      }
    }
    if (!docs.length) return;

    await Notification.insertMany(docs, { ordered: false }).catch(() => {});
  } catch (err) {
    console.error('[notifyEntryLoopedIn] failed:', err.message);
  }
}

module.exports = notifyEntryLoopedIn;
