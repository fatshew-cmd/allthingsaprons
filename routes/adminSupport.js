const express        = require('express');
const router         = express.Router();
const { Resend }     = require('resend');
const User           = require('../models/User');
const SupportMessage = require('../models/SupportMessage');
const upload         = require('../middleware/upload');

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@allthingsaprons.com';

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

// GET /admin/support — render messenger UI
router.get('/', (req, res) => {
  res.render('admin/support', {
    title: 'Messages',
    currentPage: 'support',
  });
});

// GET /admin/support/threads — list all user threads (JSON)
router.get('/threads', async (req, res) => {
  try {
    // Get the most recent message per user
    const threads = await SupportMessage.aggregate([
      { $sort: { createdAt: -1 } },
      { $group: {
        _id: '$userId',
        lastMessage: { $first: '$$ROOT' },
        unreadCount: { $sum: { $cond: [{ $and: [{ $eq: ['$from', 'user'] }, { $eq: ['$readBySupport', false] }] }, 1, 0] } },
      }},
      { $sort: { 'lastMessage.createdAt': -1 } },
    ]);

    // Populate user info
    const userIds = threads.map(t => t._id);
    const users = await User.find({ _id: { $in: userIds } })
      .select('username displayName avatar email')
      .lean();
    const userMap = {};
    users.forEach(u => { userMap[String(u._id)] = u; });

    const result = threads.map(t => ({
      userId:      String(t._id),
      user:        userMap[String(t._id)] || null,
      lastMessage: t.lastMessage,
      unreadCount: t.unreadCount,
    }));

    res.json({ threads: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load threads' });
  }
});

// GET /admin/support/thread/:userId — load full message history (JSON)
router.get('/thread/:userId', async (req, res) => {
  try {
    const messages = await SupportMessage.find({ userId: req.params.userId })
      .sort({ createdAt: 1 })
      .lean();

    // Mark all user messages as read by support
    await SupportMessage.updateMany(
      { userId: req.params.userId, from: 'user', readBySupport: false },
      { $set: { readBySupport: true } }
    );

    const user = await User.findById(req.params.userId)
      .select('username displayName avatar email')
      .lean();

    res.json({ messages, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

// POST /admin/support/thread/:userId/reply — send a reply
router.post('/thread/:userId/reply', upload.array('support', 5), async (req, res) => {
  try {
    const body = (req.body.body || '').trim().slice(0, 2000);
    const attachments = (req.files || []).map(f => '/uploads/support/' + f.filename);

    if (!body && attachments.length === 0) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const user = await User.findById(req.params.userId).select('email supportFirstReplyEmailSent');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const msg = await SupportMessage.create({
      userId:        req.params.userId,
      from:          'support',
      body,
      attachments,
      readByUser:    false,
      readBySupport: true,
    });

    // First reply email — fires once only
    if (!user.supportFirstReplyEmailSent) {
      const resend = getResend();
      if (resend) {
        try {
          await resend.emails.send({
            from:    FROM_EMAIL,
            to:      user.email.value,
            subject: 'Support has replied to your message',
            html: `<p style="font-family:sans-serif">Our support team has responded to your message on AllThingsAprons.</p><p style="font-family:sans-serif"><a href="${process.env.APP_URL || 'http://localhost:3000'}/contact" style="color:#c45c7a">View the message</a></p>`,
          });
        } catch (emailErr) {
          console.error('Support reply email failed:', emailErr.message);
        }
      }
      await User.findByIdAndUpdate(req.params.userId, { supportFirstReplyEmailSent: true });
    }

    res.json({ message: msg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

module.exports = router;
