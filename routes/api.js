const express = require('express');
const router = express.Router();
const User  = require('../models/User');
const Entry = require('../models/Entry');
const upload = require('../middleware/upload');

router.get('/me', (req, res) => {
  res.json({ authenticated: !!req.session.userId });
});

router.get('/has-user', async (req, res) => {
  try {
    const count = await User.countDocuments();
    res.json({ exists: count > 0 });
  } catch {
    res.json({ exists: false });
  }
});

router.get('/check-signup', async (req, res) => {
  const { username, email } = req.query;
  const result = { usernameAvailable: true, emailAvailable: true };
  try {
    if (username) {
      const u = await User.findOne({ username: username.toLowerCase() });
      result.usernameAvailable = !u;
    }
    if (email) {
      const e = await User.findOne({ email: email.toLowerCase() });
      result.emailAvailable = !e;
    }
  } catch { /* if DB is down, report available — server will catch duplicate on submit */ }
  res.json(result);
});

router.post('/entries', upload.fields([{ name: 'entryMedia', maxCount: 1 }]), async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const file = req.files?.entryMedia?.[0];
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  const isVideo = file.mimetype.startsWith('video/');
  if (!isVideo && file.size > 10 * 1024 * 1024) {
    return res.status(400).json({ error: 'Photo files must be under 10 MB.' });
  }

  let tags = [];
  if (req.body.tags) {
    const raw = Array.isArray(req.body.tags) ? req.body.tags : [req.body.tags];
    tags = raw.map(t => t.trim().toLowerCase()).filter(Boolean).slice(0, 6);
  }

  try {
    const entry = await Entry.create({
      userId:    req.session.userId,
      mediaUrl:  `/uploads/entries/${file.filename}`,
      mediaType: isVideo ? 'video' : 'photo',
      caption:   req.body.caption?.trim() || undefined,
      tags,
    });
    res.json({ entryId: entry._id });
  } catch (err) {
    console.error('Entry create error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.get('/profile/:username/entries', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 12;
  const skip  = (page - 1) * limit;

  try {
    const user = await User.findOne({ username: req.params.username.toLowerCase() }).select('_id');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [entries, total] = await Promise.all([
      Entry.find({ userId: user._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('mediaUrl mediaType caption tags ratingAvg ratingCount')
        .lean(),
      Entry.countDocuments({ userId: user._id }),
    ]);

    res.json({ entries, hasMore: skip + entries.length < total });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
