const express         = require('express');
const router          = express.Router();
const mongoose        = require('mongoose');
const User            = require('../models/User');
const Conversation    = require('../models/Conversation');
const DirectMessage   = require('../models/DirectMessage');
const requireAuth     = require('../middleware/requireAuth');
const requireApproved = require('../middleware/requireApproved');

router.use(requireAuth);
router.use(requireApproved);

// ── Helpers ────────────────────────────────────────────────────────────────

function sortedIds(a, b) {
  const sa = a.toString(), sb = b.toString();
  return sa < sb ? [sa, sb] : [sb, sa];
}

async function findOrCreateConversation(idA, idB) {
  const [p0, p1] = sortedIds(idA, idB);
  let conv = await Conversation.findOne({
    'participants.0': p0,
    'participants.1': p1,
  });
  if (!conv) {
    conv = await Conversation.create({ participants: [p0, p1] });
  }
  return conv;
}

async function getConversationsForUser(userId) {
  const convs = await Conversation.find({ participants: userId })
    .sort({ lastMessageAt: -1 })
    .lean();
  if (!convs.length) return [];

  const otherIds = convs.map(c =>
    c.participants.find(p => p.toString() !== userId.toString())
  );
  const convIds = convs.map(c => c._id);

  const [users, unreadAgg] = await Promise.all([
    User.find({ _id: { $in: otherIds } })
      .select('username displayName avatar')
      .lean(),
    DirectMessage.aggregate([
      {
        $match: {
          conversationId:  { $in: convIds },
          senderId:        { $nin: [new mongoose.Types.ObjectId(userId)] },
          readByRecipient: false,
        },
      },
      { $group: { _id: '$conversationId', count: { $sum: 1 } } },
    ]),
  ]);

  const userMap = {};
  users.forEach(u => { userMap[u._id.toString()] = u; });
  const unreadMap = {};
  unreadAgg.forEach(u => { unreadMap[u._id.toString()] = u.count; });

  return convs.map(c => {
    const otherId = c.participants.find(p => p.toString() !== userId.toString());
    return {
      ...c,
      otherUser:   userMap[otherId.toString()] || null,
      unreadCount: unreadMap[c._id.toString()] || 0,
    };
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────

// GET /messages
router.get('/', async (req, res) => {
  try {
    const conversations = await getConversationsForUser(req.session.userId);
    res.render('messages', {
      title:           'Messages',
      activePage:      'messages',
      currentUser:     req.currentUser,
      conversations,
      activeConv:      null,
      otherUser:       null,
      initialMessages: [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading messages');
  }
});

// GET /messages/:username — open or create conversation
router.get('/:username', async (req, res) => {
  try {
    const other = await User.findOne({ 'username.value': req.params.username.toLowerCase() })
      .select('username displayName avatar _id')
      .lean();
    if (!other) return res.redirect('/messages');
    if (other._id.toString() === req.session.userId) return res.redirect('/messages');

    const conv = await findOrCreateConversation(req.session.userId, other._id);

    const [messages, conversations] = await Promise.all([
      DirectMessage.find({ conversationId: conv._id }).sort({ createdAt: 1 }).lean(),
      getConversationsForUser(req.session.userId),
      DirectMessage.updateMany(
        { conversationId: conv._id, senderId: other._id, readByRecipient: false },
        { $set: { readByRecipient: true } }
      ),
    ]);

    const displayName = other.displayName?.value || ('@' + other.username?.value);

    res.render('messages', {
      title:           `Messages · ${displayName}`,
      activePage:      'messages',
      currentUser:     req.currentUser,
      conversations,
      activeConv:      conv,
      otherUser:       other,
      initialMessages: messages,
    });
  } catch (err) {
    console.error(err);
    res.redirect('/messages');
  }
});

// GET /messages/:username/history — JSON poll
router.get('/:username/history', async (req, res) => {
  try {
    const other = await User.findOne({ 'username.value': req.params.username.toLowerCase() })
      .select('_id')
      .lean();
    if (!other) return res.status(404).json({ error: 'User not found' });

    const [p0, p1] = sortedIds(req.session.userId, other._id);
    const conv = await Conversation.findOne({ 'participants.0': p0, 'participants.1': p1 }).lean();
    if (!conv) return res.json({ messages: [] });

    const messages = await DirectMessage.find({ conversationId: conv._id })
      .sort({ createdAt: 1 })
      .lean();

    await DirectMessage.updateMany(
      { conversationId: conv._id, senderId: other._id, readByRecipient: false },
      { $set: { readByRecipient: true } }
    );

    res.json({ messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// POST /messages/:username/send
router.post('/:username/send', async (req, res) => {
  try {
    const other = await User.findOne({ 'username.value': req.params.username.toLowerCase() })
      .select('_id')
      .lean();
    if (!other) return res.status(404).json({ error: 'User not found' });
    if (other._id.toString() === req.session.userId) {
      return res.status(400).json({ error: 'Cannot message yourself' });
    }

    const body = (req.body.body || '').trim().slice(0, 500);
    if (!body) return res.status(400).json({ error: 'Message cannot be empty' });

    const conv = await findOrCreateConversation(req.session.userId, other._id);

    const msg = await DirectMessage.create({
      conversationId:  conv._id,
      senderId:        req.session.userId,
      body,
      readByRecipient: false,
    });

    await Conversation.findByIdAndUpdate(conv._id, {
      lastMessageAt:   new Date(),
      lastMessageBody: body.slice(0, 80),
      lastSenderId:    req.session.userId,
    });

    res.json({ message: msg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
