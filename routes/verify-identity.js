const express   = require('express');
const router    = express.Router();
const fs        = require('fs');
const crypto    = require('crypto');
const User      = require('../models/User');
const BannedDocHash         = require('../models/BannedDocHash');
const requireAuth           = require('../middleware/requireAuth');
const upload                = require('../middleware/upload');
const logAuditEvent         = require('../utils/auditLog');
const { generateCaseRef }   = require('../utils/auditLog');

router.use(requireAuth);

function genVerificationCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// GET /verify-identity
router.get('/', async (req, res) => {
  const user = await User.findById(req.session.userId)
    .select('idVerified idVerificationStatus idVerifyBlockedUntil idVerificationRejectionReasons idVerificationClaimNumber');
  if (!user) { req.session.destroy(() => {}); return res.redirect('/signup'); }

  if (user.idVerified) return res.redirect('/feed');

  const now     = new Date();
  const blocked = !!(user.idVerifyBlockedUntil && user.idVerifyBlockedUntil > now);
  const pending = !blocked && user.idVerificationStatus === 'pending';
  const showRejection = !pending && !blocked && user.idVerificationRejectionReasons?.length;

  res.render('verify-identity', {
    title:            'Verify Identity',
    blocked,
    blockedUntil:     blocked ? user.idVerifyBlockedUntil : null,
    pending,
    activeCode:       req.session.verificationCode   || null,
    codeGeneratedAt:  req.session.verificationCodeAt || null,
    error:            req.query.error || null,
    reason:           req.query.reason || null,
    rejectionReasons: showRejection ? user.idVerificationRejectionReasons : [],
    claimNumber:      showRejection ? (user.idVerificationClaimNumber || null) : null,
  });
});

// GET /verify-identity/code — generate selfie code
router.get('/code', async (req, res) => {
  const user = await User.findById(req.session.userId)
    .select('idVerified idVerifyBlockedUntil');
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  if (user.idVerified) return res.status(403).json({ error: 'Already verified.' });

  if (user.idVerifyBlockedUntil && user.idVerifyBlockedUntil > new Date()) {
    return res.status(429).json({ error: 'Account temporarily blocked.', blockedUntil: user.idVerifyBlockedUntil });
  }

  const code = genVerificationCode();
  req.session.verificationCode   = code;
  req.session.verificationCodeAt = Date.now();
  res.json({ code });
});

// POST /verify-identity — submit docs for review
router.post('/', upload.fields([{ name: 'idSelfie', maxCount: 1 }, { name: 'idDoc', maxCount: 1 }]), async (req, res) => {
  const selfie = req.files?.idSelfie?.[0];
  const idDoc  = req.files?.idDoc?.[0];
  const code   = req.session.verificationCode;

  const fail = (msg) => res.redirect(`/verify-identity?error=${encodeURIComponent(msg)}`);

  if (!selfie) return fail('Please upload your verification selfie.');
  if (!idDoc)  return fail('Please upload a photo of your ID.');
  if (!code)   return fail('No active verification code found. Please generate a code and try again.');

  const submitter = await User.findById(req.session.userId)
    .select('idVerifyBlockedUntil idVerificationStatus idVerifyFailedAttempts idVerificationCaseRef');

  if (!submitter) return fail('Session expired. Please log in again.');

  if (submitter.idVerificationStatus === 'closed') {
    return fail('Your identity verification case has been permanently closed. Please contact support.');
  }

  if (submitter.idVerifyFailedAttempts >= 5) {
    return fail('Your identity verification case has been permanently closed. Please contact support.');
  }

  if (submitter.idVerifyBlockedUntil && submitter.idVerifyBlockedUntil > new Date()) {
    return fail('Your account is temporarily blocked from re-submitting. Please wait for the cooldown to expire.');
  }

  const docBytes = fs.readFileSync(idDoc.path);
  const docHash  = crypto.createHash('sha256').update(docBytes).digest('hex');

  const isBannedDoc = await BannedDocHash.exists({ hash: docHash });
  if (isBannedDoc) {
    fs.unlink(selfie.path, () => {});
    fs.unlink(idDoc.path,  () => {});
    return fail('This document has been flagged and cannot be used for verification. Please contact support.');
  }

  const conflictingUser = await User.findOne({
    idDocHash: docHash,
    _id: { $ne: req.session.userId },
  }).select('_id').lean();

  const caseRef     = submitter.idVerificationCaseRef || generateCaseRef();
  const submittedAt = new Date();
  const attemptNum  = (submitter.idVerifyFailedAttempts || 0) + 1;

  await User.findByIdAndUpdate(req.session.userId, {
    idVerificationStatus:      'pending',
    idSelfieUrl:               `/uploads/id-docs/${selfie.filename}`,
    idDocUrl:                  `/uploads/id-docs/${idDoc.filename}`,
    idVerificationCode:        code,
    idVerificationSubmittedAt: submittedAt,
    idVerificationCaseRef:     caseRef,
    idDocHash:                 docHash,
    $unset: { idVerificationRejectionReasons: '' },
  });

  logAuditEvent({
    actorId:    req.session.userId,
    actorRole:  'user',
    action:     'id_verification_submitted',
    entityType: 'user',
    entityId:   req.session.userId,
    caseRef,
    metadata:   {
      submittedAt,
      attempt:           attemptNum,
      docHashConflict:   !!conflictingUser,
      conflictingUserId: conflictingUser?._id || null,
    },
  });

  delete req.session.verificationCode;

  res.redirect('/verify-identity');
});

module.exports = router;
