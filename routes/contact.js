const express        = require('express');
const router         = express.Router();
const { Resend }     = require('resend');
const User           = require('../models/User');
const SupportMessage = require('../models/SupportMessage');
const requireAuth    = require('../middleware/requireAuth');
const upload         = require('../middleware/upload');

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@allthingsaprons.com';

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

router.use(requireAuth);

// GET /contact — render chat page
router.get('/', async (req, res) => {
  const user = await User.findById(req.session.userId).select('idVerification');
  if (!user) { req.session.destroy(() => {}); return res.redirect('/signup'); }

  const claimNumber = user.idVerification?.claimNumber || null;

  res.render('contact', {
    title: 'Contact Support',
    claimNumber,
  });
});

// GET /contact/messages — load thread history for current user
router.get('/messages', async (req, res) => {
  try {
    const messages = await SupportMessage.find({ userId: req.session.userId })
      .sort({ createdAt: 1 })
      .lean();

    // Mark all support messages as read by the user
    await SupportMessage.updateMany(
      { userId: req.session.userId, from: 'support', readByUser: false },
      { $set: { readByUser: true } }
    );

    res.json({ messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// POST /contact/messages — user sends a message
router.post('/messages', upload.array('support', 5), async (req, res) => {
  try {
    const body = (req.body.body || '').trim().slice(0, 500);
    const attachments = (req.files || []).map(f => '/uploads/support/' + f.filename);

    if (!body && attachments.length === 0) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const msg = await SupportMessage.create({
      userId:        req.session.userId,
      from:          'user',
      body,
      attachments,
      readBySupport: false,
      readByUser:    true,
    });

    res.json({ message: msg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// GET /contact/unread — check for unread support replies (used for toast)
router.get('/unread', async (req, res) => {
  try {
    const count = await SupportMessage.countDocuments({
      userId:     req.session.userId,
      from:       'support',
      readByUser: false,
    });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check unread' });
  }
});

module.exports = router;
