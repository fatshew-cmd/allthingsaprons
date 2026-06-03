const express  = require('express');
const router   = express.Router();
const User     = require('../models/User');
const Entry    = require('../models/Entry');
const Tournament      = require('../models/Tournament');
const TournamentEntry = require('../models/TournamentEntry');
const requireAuth     = require('../middleware/requireAuth');
const upload          = require('../middleware/upload');

router.use(requireAuth);

const SEX_LABELS = { male: 'Male', female: 'Female', other: 'Other', 'prefer-not-to-say': 'Prefer not to say' };

function genVerificationCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function calcAge(birthdate) {
  if (!birthdate) return null;
  const today = new Date();
  const birth  = new Date(birthdate);
  let age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth() ||
      (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age--;
  return age;
}

function fmtOrientation(o) {
  if (!o) return null;
  if (o === 'prefer-not-to-say') return 'Prefer not to say';
  return o.charAt(0).toUpperCase() + o.slice(1);
}

function deadlineLabel(deadline) {
  if (!deadline) return null;
  const ms = new Date(deadline) - Date.now();
  if (ms <= 0) return 'Closing soon';
  const hours = Math.floor(ms / 3600000);
  if (hours < 24) return hours + 'h left';
  return Math.floor(hours / 24) + 'd left';
}

// GET /onboarding — show open tournaments or redirect to waiting
router.get('/', async (req, res) => {
  const user = await User.findById(req.session.userId)
    .select('onboardingStatus username email avatar birthdate sex orientation');
  if (!user) { req.session.destroy(() => {}); return res.redirect('/signup'); }

  if (user.onboardingStatus === 'approved') return res.redirect('/feed');
  if (user.onboardingStatus === 'pending_id_verification') return res.redirect('/onboarding/verify-identity');
  if (user.onboardingStatus === 'pending_approval') return res.redirect('/onboarding/waiting');

  const tournaments = await Tournament.find({ status: 'open' })
    .populate('createdBy', 'username')
    .sort({ createdAt: -1 });

  const tIds         = tournaments.map(t => t._id);
  const organizerIds = tournaments.map(t => t.createdBy?._id).filter(Boolean);

  const [entryCounts, orgCounts] = await Promise.all([
    tIds.length ? TournamentEntry.aggregate([
      { $match: { tournamentId: { $in: tIds } } },
      { $group: { _id: '$tournamentId', count: { $sum: 1 } } },
    ]) : [],
    organizerIds.length ? Tournament.aggregate([
      { $match: { createdBy: { $in: organizerIds } } },
      { $group: { _id: '$createdBy', count: { $sum: 1 } } },
    ]) : [],
  ]);

  const entryCountMap = Object.fromEntries(entryCounts.map(e => [e._id.toString(), e.count]));
  const orgCountMap   = Object.fromEntries(orgCounts.map(e => [e._id.toString(), e.count]));

  const tournamentData = tournaments.map(t => {
    const obj          = t.toObject();
    obj.entryCount     = entryCountMap[t._id.toString()] || 0;
    obj.organizerCount = orgCountMap[t.createdBy?._id?.toString()] || 0;
    obj.timeLeft       = deadlineLabel(t.entryDeadline);
    return obj;
  });

  const wasRejected = user.onboardingStatus === 'rejected';

  res.render('onboarding/index', {
    title:       'Submit Your Entry',
    tournaments: tournamentData,
    wasRejected,
    error:       req.query.error || null,
    profileUser: {
      username:    user.username,
      email:       user.email,
      avatar:      user.avatar || null,
      age:         calcAge(user.birthdate),
      sex:         SEX_LABELS[user.sex] || null,
      orientation: fmtOrientation(user.orientation),
    },
  });
});

// POST /onboarding/submit — create Entry + TournamentEntry, set status to pending_approval
router.post('/submit', upload.fields([{ name: 'entryPhoto', maxCount: 1 }]), async (req, res) => {
  const { tournamentId, caption } = req.body;

  if (!tournamentId) return res.redirect('/onboarding?error=Please+select+a+tournament.');
  if (!req.files?.entryPhoto) return res.redirect('/onboarding?error=Please+upload+a+photo+for+your+entry.');

  try {
    const tournament = await Tournament.findOne({ _id: tournamentId, status: 'open' });
    if (!tournament) return res.redirect('/onboarding?error=That+tournament+is+no+longer+open.');

    const mediaUrl = `/uploads/entries/${req.files.entryPhoto[0].filename}`;

    const entry = await Entry.create({
      userId:    req.session.userId,
      mediaUrl,
      mediaType: 'photo',
      caption:   caption || undefined,
    });

    await TournamentEntry.create({
      tournamentId: tournament._id,
      entryId:      entry._id,
      userId:       req.session.userId,
      approvalStatus: 'pending',
      submittedAt:  new Date(),
    });

    await User.findByIdAndUpdate(req.session.userId, { onboardingStatus: 'pending_approval' });

    res.redirect('/onboarding/waiting');
  } catch (err) {
    console.error('Onboarding submit error:', err);
    res.redirect('/onboarding?error=Something+went+wrong.+Please+try+again.');
  }
});

// POST /onboarding/cancel — delete onboarding account and log out
router.post('/cancel', async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select('accountStatus');
    if (user && user.accountStatus === 'onboarding') {
      const tournamentEntries = await TournamentEntry.find({ userId: user._id }).select('entryId');
      const entryIds = tournamentEntries.map(te => te.entryId).filter(Boolean);
      await TournamentEntry.deleteMany({ userId: user._id });
      if (entryIds.length) await Entry.deleteMany({ _id: { $in: entryIds } });
      await User.findByIdAndDelete(user._id);
    }
  } catch (err) {
    console.error('Cancel signup error:', err);
  }
  req.session.destroy(() => res.redirect('/signup'));
});

// GET /onboarding/verify-identity
router.get('/verify-identity', async (req, res) => {
  const user = await User.findById(req.session.userId)
    .select('onboardingStatus idVerified idVerificationStatus idVerifyBlockedUntil');
  if (!user) { req.session.destroy(() => {}); return res.redirect('/signup'); }

  if (user.onboardingStatus === 'approved') return res.redirect('/feed');
  if (user.onboardingStatus !== 'pending_id_verification') return res.redirect('/onboarding');

  const now     = new Date();
  const blocked = !!(user.idVerifyBlockedUntil && user.idVerifyBlockedUntil > now);

  res.render('onboarding/verify-identity', {
    title:           'Verify Identity',
    blocked,
    blockedUntil:    blocked ? user.idVerifyBlockedUntil : null,
    pending:         !blocked && user.idVerificationStatus === 'pending',
    activeCode:      req.session.verificationCode   || null,
    codeGeneratedAt: req.session.verificationCodeAt || null,
    error:           req.query.error || null,
  });
});

// GET /onboarding/verify-identity/code — generate selfie code
router.get('/verify-identity/code', async (req, res) => {
  const user = await User.findById(req.session.userId)
    .select('onboardingStatus idVerified idVerifyBlockedUntil idVerifyFailedAttempts');
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  if (user.onboardingStatus !== 'pending_id_verification') return res.status(403).json({ error: 'Not in verification step.' });
  if (user.idVerified) return res.status(403).json({ error: 'Already verified.' });

  const now = new Date();

  if (user.idVerifyBlockedUntil && user.idVerifyBlockedUntil > now) {
    return res.status(429).json({ error: 'Account temporarily blocked.', blockedUntil: user.idVerifyBlockedUntil });
  }

  const updated = await User.findByIdAndUpdate(
    req.session.userId,
    { $inc: { idVerifyFailedAttempts: 1 } },
    { returnDocument: 'after' }
  ).select('idVerifyFailedAttempts');

  if (updated.idVerifyFailedAttempts > 3) {
    const blockedUntil = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    await User.updateOne({ _id: req.session.userId }, { idVerifyBlockedUntil: blockedUntil, idVerifyFailedAttempts: 0 });
    delete req.session.verificationCode;
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 2 hours.', blockedUntil });
  }

  const code = genVerificationCode();
  req.session.verificationCode   = code;
  req.session.verificationCodeAt = Date.now();
  res.json({ code });
});

// POST /onboarding/verify-identity — submit docs for review
router.post('/verify-identity', upload.fields([{ name: 'idSelfie', maxCount: 1 }, { name: 'idDoc', maxCount: 1 }]), async (req, res) => {
  const selfie = req.files?.idSelfie?.[0];
  const idDoc  = req.files?.idDoc?.[0];
  const code   = req.session.verificationCode;

  const fail = (msg) => res.redirect(`/onboarding/verify-identity?error=${encodeURIComponent(msg)}`);

  if (!selfie) return fail('Please upload your verification selfie.');
  if (!idDoc)  return fail('Please upload a photo of your ID.');

  await User.findByIdAndUpdate(req.session.userId, {
    idVerificationStatus:   'pending',
    idSelfieUrl:            `/uploads/id-docs/${selfie.filename}`,
    idDocUrl:               `/uploads/id-docs/${idDoc.filename}`,
    idVerificationCode:     code || '',
    idVerifyFailedAttempts: 0,
    $unset: { idVerifyBlockedUntil: '' },
  });

  delete req.session.verificationCode;

  res.render('onboarding/verify-identity', {
    title:           'Verify Identity',
    pending:         true,
    blocked:         false,
    blockedUntil:    null,
    activeCode:      null,
    codeGeneratedAt: null,
    error:           null,
  });
});

// GET /onboarding/waiting — poll for approval status
router.get('/waiting', async (req, res) => {
  const user = await User.findById(req.session.userId).select('onboardingStatus username');
  if (!user) { req.session.destroy(() => {}); return res.redirect('/signup'); }

  if (user.onboardingStatus === 'approved') return res.redirect('/feed');
  if (user.onboardingStatus === 'rejected') return res.redirect('/onboarding');
  if (user.onboardingStatus === 'pending_submission') return res.redirect('/onboarding');

  res.render('onboarding/waiting', {
    title:    'Waiting for Approval',
    username: user.username,
  });
});

module.exports = router;
