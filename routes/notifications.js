const express      = require('express');
const router       = express.Router();
const mongoose     = require('mongoose');
const requireAuth  = require('../middleware/requireAuth');
const requireApproved = require('../middleware/requireApproved');
const Notification = require('../models/Notification');
const Nomination   = require('../models/Nomination');
const Entry        = require('../models/Entry');

router.use(requireAuth);
router.use(requireApproved);

router.get('/', async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 30;
  const skip  = (page - 1) * limit;

  const [notifications, total] = await Promise.all([
    Notification.find({ userId: req.session.userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Notification.countDocuments({ userId: req.session.userId }),
  ]);

  // Enrich take_on_received notifications that predate the media URL payload fields
  const stale = notifications.filter(n => n.type === 'take_on_received' && n.payload?.nominationId && !n.payload.challengerEntryUrl);
  if (stale.length) {
    const nomIds = stale.map(n => n.payload.nominationId).filter(Boolean);
    const noms   = await Nomination.find({ _id: { $in: nomIds } })
      .select('_id challengerEntryId nomineeEntryId').lean().catch(() => []);
    const nomMap = {};
    noms.forEach(nom => { nomMap[nom._id.toString()] = nom; });

    const entryIds = noms.flatMap(nom => [nom.challengerEntryId, nom.nomineeEntryId]).filter(Boolean);
    const entries  = entryIds.length
      ? await Entry.find({ _id: { $in: entryIds } }).select('_id mediaUrl mediaType').lean().catch(() => [])
      : [];
    const entryMap = {};
    entries.forEach(e => { entryMap[e._id.toString()] = e; });

    for (const n of stale) {
      const nom = nomMap[n.payload.nominationId?.toString()];
      if (!nom) continue;
      const ce = nom.challengerEntryId ? entryMap[nom.challengerEntryId.toString()] : null;
      const ne = nom.nomineeEntryId    ? entryMap[nom.nomineeEntryId.toString()]    : null;
      if (ce) { n.payload.challengerEntryUrl  = ce.mediaUrl;  n.payload.challengerEntryType = ce.mediaType; }
      if (ne) { n.payload.nomineeEntryUrl     = ne.mediaUrl;  n.payload.nomineeEntryType    = ne.mediaType; }
    }
  }

  res.render('notifications', {
    title: 'Notifications',
    activePage: 'notifications',
    currentUser: req.currentUser,
    notifications,
    page,
    hasMore: skip + notifications.length < total,
  });
});

router.post('/:id/read', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }
  const notif = await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.session.userId },
    { read: true },
    { new: true },
  ).lean();

  if (!notif) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true, url: notif.payload?.url || '/notifications' });
});

router.post('/read-all', async (req, res) => {
  await Notification.updateMany({ userId: req.session.userId, read: false }, { read: true });
  res.json({ ok: true });
});

module.exports = router;
