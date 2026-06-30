const UserAffinity = require('../models/UserAffinity');

const LEARNING_RATE            = 0.3;
const SESSION_INACTIVITY_HOURS = 6;
const SESSION_REFRESH_HOURS    = 3;
const SIGNAL_ANNOUNCEMENT_DISMISS = 0.1;
const SIGNAL_ANNOUNCEMENT_CLICK   = 0.7;

const SOURCE_MULTIPLIERS = {
  search: 1.3,
  share:  1.15,
  feed:   1.0,
};

function lerp(current, signal, rate) {
  return current * (1 - rate) + signal * rate;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function _accumulateSession(doc, now) {
  if (doc.lastActivityAt) {
    const hoursSince = (now - doc.lastActivityAt) / (1000 * 60 * 60);
    if (hoursSince >= SESSION_INACTIVITY_HOURS) {
      doc.cumulativeSessionHours = 0;
    } else {
      doc.cumulativeSessionHours = (doc.cumulativeSessionHours || 0) + hoursSince;
    }
  }

  if ((doc.cumulativeSessionHours || 0) >= SESSION_REFRESH_HOURS) {
    doc.history.push({
      timestamp:     now,
      stainScores:   Object.fromEntries(doc.stainScores),
      creatorScores: Object.fromEntries(doc.creatorScores),
      source:        'session_refresh',
    });
    doc.lastRefreshedAt        = now;
    doc.cumulativeSessionHours = 0;
  }
}

async function updateAffinity(userId, entry, { signal, source = 'feed' }) {
  if (!signal) return;

  const multiplier      = SOURCE_MULTIPLIERS[source] || 1.0;
  const effectiveSignal = clamp01(signal * multiplier);

  const tags    = entry.tags || [];
  const ownerId = (entry.userId?._id ?? entry.userId).toString();
  const now     = new Date();

  let doc = await UserAffinity.findOne({ userId });
  if (!doc) doc = new UserAffinity({ userId });

  _accumulateSession(doc, now);

  for (const tag of tags) {
    const current = doc.stainScores.get(tag) || 0;
    doc.stainScores.set(tag, clamp01(lerp(current, effectiveSignal, LEARNING_RATE)));
  }

  const currentCreator = doc.creatorScores.get(ownerId) || 0;
  doc.creatorScores.set(ownerId, clamp01(lerp(currentCreator, effectiveSignal, LEARNING_RATE)));

  doc.lastActivityAt = now;
  doc.markModified('stainScores');
  doc.markModified('creatorScores');
  await doc.save();
}

async function _updateSingleScore(userId, mapName, key, signal) {
  const effectiveSignal = clamp01(signal);
  const now             = new Date();

  let doc = await UserAffinity.findOne({ userId });
  if (!doc) doc = new UserAffinity({ userId });

  _accumulateSession(doc, now);

  const current = doc[mapName].get(key) || 0;
  doc[mapName].set(key, clamp01(lerp(current, effectiveSignal, LEARNING_RATE)));

  doc.lastActivityAt = now;
  doc.markModified(mapName);
  await doc.save();
}

async function updateStainAffinity(userId, stain, signal) {
  if (!stain || signal == null) return;
  return _updateSingleScore(userId, 'stainScores', stain, signal);
}

async function updateCreatorAffinity(userId, creatorId, signal) {
  if (signal == null) return;
  return _updateSingleScore(userId, 'creatorScores', creatorId.toString(), signal);
}

module.exports = { updateAffinity, updateCreatorAffinity, updateStainAffinity, LEARNING_RATE, SIGNAL_ANNOUNCEMENT_DISMISS, SIGNAL_ANNOUNCEMENT_CLICK };
