const express      = require('express');
const router       = express.Router();
const User         = require('../models/User');
const Follow       = require('../models/Follow');
const requireAuth  = require('../middleware/requireAuth');
const requireApproved = require('../middleware/requireApproved');

router.use(requireAuth);
router.use(requireApproved);

router.post('/follow/:username', async (req, res) => {
  try {
    const target = await User.findOne({ 'username.value': req.params.username.toLowerCase() }).select('_id').lean();
    if (!target) return res.status(404).json({ error: 'User not found' });

    const followerId  = req.session.userId;
    const followingId = target._id.toString();

    if (followerId === followingId) return res.status(400).json({ error: 'Cannot follow yourself' });

    await Follow.updateOne(
      { followerId, followingId },
      { followerId, followingId },
      { upsert: true }
    );

    const followerCount = await Follow.countDocuments({ followingId });
    res.json({ following: true, followerCount });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/unfollow/:username', async (req, res) => {
  try {
    const target = await User.findOne({ 'username.value': req.params.username.toLowerCase() }).select('_id').lean();
    if (!target) return res.status(404).json({ error: 'User not found' });

    const followerId  = req.session.userId;
    const followingId = target._id.toString();

    await Follow.deleteOne({ followerId, followingId });

    const followerCount = await Follow.countDocuments({ followingId });
    res.json({ following: false, followerCount });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
