const express      = require('express');
const router       = express.Router();
const mongoose     = require('mongoose');
const requireAuth  = require('../middleware/requireAuth');
const requireApproved = require('../middleware/requireApproved');
const Notification = require('../models/Notification');

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
