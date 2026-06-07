const express        = require('express');
const router         = express.Router();
const { Resend }     = require('resend');
const User           = require('../models/User');
const SupportThread  = require('../models/SupportThread');
const SupportMessage = require('../models/SupportMessage');
const { supportUpload } = require('../middleware/upload');

const FROM_EMAIL   = process.env.FROM_EMAIL || 'noreply@allthingsaprons.com';
const { TOPIC_LABELS } = SupportThread;

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

// GET /admin/support — render messenger UI
router.get('/', (req, res) => {
  res.render('admin/support', { title: 'Messages', currentPage: 'support' });
});

// GET /admin/support/threads — list all threads with last message + unread count
router.get('/threads', async (req, res) => {
  try {
    const threads = await SupportThread.find()
      .sort({ updatedAt: -1 })
      .lean();

    const threadIds = threads.map(t => t._id);
    const userIds   = [...new Set(threads.map(t => String(t.userId)))];

    const [lastMessages, unreadCounts, users] = await Promise.all([
      SupportMessage.aggregate([
        { $match: { threadId: { $in: threadIds } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$threadId', lastMessage: { $first: '$$ROOT' } } },
      ]),
      SupportMessage.aggregate([
        { $match: { threadId: { $in: threadIds }, from: 'user', readBySupport: false } },
        { $group: { _id: '$threadId', count: { $sum: 1 } } },
      ]),
      User.find({ _id: { $in: userIds } }).select('username displayName avatar email').lean(),
    ]);

    const lastMsgMap = {};
    lastMessages.forEach(m => { lastMsgMap[String(m._id)] = m.lastMessage; });
    const unreadMap = {};
    unreadCounts.forEach(u => { unreadMap[String(u._id)] = u.count; });
    const userMap = {};
    users.forEach(u => { userMap[String(u._id)] = u; });

    const result = threads
      .filter(t => lastMsgMap[String(t._id)])
      .map(t => ({
        threadId:    String(t._id),
        topic:       t.topic,
        topicLabel:  TOPIC_LABELS[t.topic] || t.topic,
        status:      t.status,
        user:        userMap[String(t.userId)] || null,
        lastMessage: lastMsgMap[String(t._id)],
        unreadCount: unreadMap[String(t._id)] || 0,
      }));

    res.json({ threads: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load threads' });
  }
});

// GET /admin/support/thread/:threadId — load full message history
router.get('/thread/:threadId', async (req, res) => {
  try {
    const thread = await SupportThread.findById(req.params.threadId).lean();
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const messages = await SupportMessage.find({ threadId: thread._id })
      .sort({ createdAt: 1 })
      .lean();

    await SupportMessage.updateMany(
      { threadId: thread._id, from: 'user', readBySupport: false },
      { $set: { readBySupport: true } }
    );

    const user = await User.findById(thread.userId)
      .select('username displayName avatar email')
      .lean();

    res.json({
      messages,
      user,
      thread: { ...thread, topicLabel: TOPIC_LABELS[thread.topic] || thread.topic },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

// POST /admin/support/thread/:threadId/reply — send reply
router.post('/thread/:threadId/reply', supportUpload.array('support', 5), async (req, res) => {
  try {
    const thread = await SupportThread.findById(req.params.threadId);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const body        = (req.body.body || '').trim().slice(0, 2000);
    const attachments = (req.files || []).map(f => '/uploads/support/' + f.filename);

    if (!body && attachments.length === 0) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const user = await User.findById(thread.userId).select('email supportFirstReplyEmailSent');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const msg = await SupportMessage.create({
      threadId:      thread._id,
      userId:        thread.userId,
      from:          'support',
      body,
      attachments,
      readByUser:    false,
      readBySupport: true,
    });

    await SupportThread.findByIdAndUpdate(thread._id, { updatedAt: new Date() });

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
      await User.findByIdAndUpdate(thread.userId, { supportFirstReplyEmailSent: true });
    }

    res.json({ message: msg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// PATCH /admin/support/thread/:threadId/close — close a thread
router.patch('/thread/:threadId/close', async (req, res) => {
  try {
    const thread = await SupportThread.findByIdAndUpdate(
      req.params.threadId,
      { status: 'closed' },
      { new: true }
    );
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to close thread' });
  }
});

module.exports = router;
