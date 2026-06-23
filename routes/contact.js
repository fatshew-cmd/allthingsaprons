const express            = require('express');
const router             = express.Router();
const User               = require('../models/User');
const SupportThread      = require('../models/SupportThread');
const SupportMessage     = require('../models/SupportMessage');
const WalletTransaction  = require('../models/WalletTransaction');
const requireAuth        = require('../middleware/requireAuth');
const upload             = require('../middleware/upload');

const { TOPIC_LABELS } = SupportThread;

router.use(requireAuth);

// GET /contact — thread list
router.get('/', async (req, res) => {
  try {
    const threads = await SupportThread.find({ userId: req.session.userId })
      .sort({ updatedAt: -1 })
      .lean();

    const threadIds = threads.map(t => t._id);

    const [lastMessages, unreadCounts] = await Promise.all([
      SupportMessage.aggregate([
        { $match: { threadId: { $in: threadIds } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$threadId', lastMessage: { $first: '$$ROOT' } } },
      ]),
      SupportMessage.aggregate([
        { $match: { threadId: { $in: threadIds }, from: 'support', readByUser: false } },
        { $group: { _id: '$threadId', count: { $sum: 1 } } },
      ]),
    ]);

    const lastMsgMap = {};
    lastMessages.forEach(m => { lastMsgMap[String(m._id)] = m.lastMessage; });
    const unreadMap = {};
    unreadCounts.forEach(u => { unreadMap[String(u._id)] = u.count; });

    const enriched = threads.map(t => ({
      ...t,
      label:       TOPIC_LABELS[t.topic] || t.topic,
      lastMessage: lastMsgMap[String(t._id)] || null,
      unreadCount: unreadMap[String(t._id)] || 0,
    }));

    res.render('contact', { title: 'Support', threads: enriched, TOPIC_LABELS });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading threads');
  }
});

// GET /contact/new?topic=X&txId=Y — find or create open thread, redirect into it
router.get('/new', async (req, res) => {
  try {
    const validTopics = SupportThread.schema.path('topic').enumValues;
    const topic = validTopics.includes(req.query.topic) ? req.query.topic : 'general';
    const txId  = req.query.txId || null;

    let thread = await SupportThread.findOne({
      userId: req.session.userId,
      topic,
      status: 'open',
    });

    const isNew = !thread;
    if (!thread) {
      thread = await SupportThread.create({ userId: req.session.userId, topic });
    }

    // Auto-post a reference message when opening a billing dispute from a transaction page
    if (isNew && topic === 'billing' && txId) {
      const tx = await WalletTransaction.findOne({ _id: txId, userId: req.session.userId }).lean();
      if (tx) {
        const txLabels = {
          top_up:                  'Top Up',
          contribution:            'Contribution',
          contribution_adjustment: 'Contribution Adjusted',
          contribution_withdrawal: 'Contribution Withdrawn',
          contest_payout_settled:  'Contest Payout',
          auto_payout:             'Auto-Payout',
          makeup_payout:           'Makeup Payout',
          admin_grant:             'Admin Grant',
          platform_fee:            'Platform Fee',
          manual_correction:       'Manual Correction',
        };
        const label  = txLabels[tx.type] || tx.type;
        const sign   = tx.direction === 'credit' ? '+' : '−';
        const date   = new Date(tx.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        const body   = `I'd like to dispute a transaction.\n\nType: ${label}\nAmount: ${sign}${tx.amountCHL.toLocaleString()} 🌶️ ($${tx.amountUSD.toFixed(2)})\nDate: ${date}\nTransaction ID: ${tx._id}`;
        await SupportMessage.create({
          threadId:      thread._id,
          userId:        req.session.userId,
          from:          'user',
          body,
          readBySupport: false,
          readByUser:    true,
        });
        await SupportThread.findByIdAndUpdate(thread._id, { updatedAt: new Date() });
      }
    }

    res.redirect('/contact/thread/' + thread._id);
  } catch (err) {
    console.error(err);
    res.redirect('/contact');
  }
});

// GET /contact/thread/:threadId — render chat view
router.get('/thread/:threadId', async (req, res) => {
  try {
    const [thread, allThreads] = await Promise.all([
      SupportThread.findOne({ _id: req.params.threadId, userId: req.session.userId }).lean(),
      SupportThread.find({ userId: req.session.userId }).sort({ updatedAt: -1 }).lean(),
    ]);

    if (!thread) return res.redirect('/contact');

    const threadIds = allThreads.map(t => t._id);
    const [lastMessages, unreadCounts] = await Promise.all([
      SupportMessage.aggregate([
        { $match: { threadId: { $in: threadIds } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$threadId', lastMessage: { $first: '$$ROOT' } } },
      ]),
      SupportMessage.aggregate([
        { $match: { threadId: { $in: threadIds }, from: 'support', readByUser: false } },
        { $group: { _id: '$threadId', count: { $sum: 1 } } },
      ]),
    ]);

    const lastMsgMap = {};
    lastMessages.forEach(m => { lastMsgMap[String(m._id)] = m.lastMessage; });
    const unreadMap = {};
    unreadCounts.forEach(u => { unreadMap[String(u._id)] = u.count; });

    const threads = allThreads.map(t => ({
      ...t,
      label:       TOPIC_LABELS[t.topic] || t.topic,
      lastMessage: lastMsgMap[String(t._id)] || null,
      unreadCount: unreadMap[String(t._id)] || 0,
    }));

    res.render('contact-thread', {
      title:   TOPIC_LABELS[thread.topic] || 'Support',
      thread:  { ...thread, label: TOPIC_LABELS[thread.topic] || thread.topic },
      threads,
    });
  } catch (err) {
    console.error(err);
    res.redirect('/contact');
  }
});

// GET /contact/thread/:threadId/messages — load messages (JSON)
router.get('/thread/:threadId/messages', async (req, res) => {
  try {
    const thread = await SupportThread.findOne({
      _id:    req.params.threadId,
      userId: req.session.userId,
    });
    if (!thread) return res.status(403).json({ error: 'Not found' });

    const messages = await SupportMessage.find({ threadId: thread._id })
      .sort({ createdAt: 1 })
      .lean();

    await SupportMessage.updateMany(
      { threadId: thread._id, from: 'support', readByUser: false },
      { $set: { readByUser: true } }
    );

    res.json({ messages, threadClosed: thread.status === 'closed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// POST /contact/thread/:threadId/messages — send message
router.post('/thread/:threadId/messages', upload.support.array('support', 5), async (req, res) => {
  try {
    const thread = await SupportThread.findOne({
      _id:    req.params.threadId,
      userId: req.session.userId,
      status: 'open',
    });
    if (!thread) return res.status(403).json({ error: 'Thread not found or closed' });

    const body        = (req.body.body || '').trim().slice(0, 500);
    const attachments = (req.files || []).map(f => '/uploads/support/' + f.filename);

    if (!body && attachments.length === 0) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const msg = await SupportMessage.create({
      threadId:      thread._id,
      userId:        req.session.userId,
      from:          'user',
      body,
      attachments,
      readBySupport: false,
      readByUser:    true,
    });

    await SupportThread.findByIdAndUpdate(thread._id, { updatedAt: new Date() });

    res.json({ message: msg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// GET /contact/unread — total unread count across all user threads (used for toast/badge)
router.get('/unread', async (req, res) => {
  try {
    const threads = await SupportThread.find({ userId: req.session.userId }).select('_id').lean();
    const threadIds = threads.map(t => t._id);

    const count = await SupportMessage.countDocuments({
      threadId:   { $in: threadIds },
      from:       'support',
      readByUser: false,
    });

    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check unread' });
  }
});

module.exports = router;
