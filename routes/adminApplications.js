const express          = require('express');
const router           = express.Router();
const crypto           = require('crypto');
const bcrypt           = require('bcrypt');
const { Resend }       = require('resend');
const AdminApplication = require('../models/AdminApplication');
const User             = require('../models/User');

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@allthingsaprons.com';
const BASE_URL   = process.env.APP_URL    || `http://localhost:${process.env.PORT || 3000}`;

const TIER          = { user: 0, moderator: 1, supervisor: 2, superadmin: 3, founder: 4 };
const VALID_PERMS   = ['content', 'chat', 'comments', 'financial', 'support'];
const TIER_LABELS   = { moderator: 'Moderator', supervisor: 'Supervisor', superadmin: 'Super Admin' };

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

// GET / — list all applications
router.get('/', async (req, res) => {
  const filter = req.query.status ? { status: req.query.status } : {};
  const applications = await AdminApplication.find(filter).sort({ createdAt: -1 }).lean();
  res.render('admin/applications/index', {
    title:        'Applications',
    currentPage:  'applications',
    applications,
    statusFilter: req.query.status || '',
    hired:        req.query.hired === '1',
  });
});

// GET /:id — application detail
router.get('/:id', async (req, res) => {
  const application = await AdminApplication.findById(req.params.id).lean();
  if (!application) return res.redirect('/admin/applications');
  res.render('admin/applications/detail', {
    title:       application.name,
    currentPage: 'applications',
    application,
    granterRole: req.session.adminRole,
    error:       req.query.error || null,
  });
});

// POST /:id/status — mark reviewed or rejected
router.post('/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['reviewed', 'rejected'].includes(status)) return res.redirect('/admin/applications');
  await AdminApplication.findByIdAndUpdate(req.params.id, { status });
  res.redirect('/admin/applications/' + req.params.id);
});

// POST /:id/hire — create account + send invite
router.post('/:id/hire', async (req, res) => {
  const application = await AdminApplication.findById(req.params.id);
  if (!application) return res.redirect('/admin/applications');
  if (application.status === 'hired') return res.redirect('/admin/applications/' + req.params.id);

  const granterRole = req.session.adminRole;
  const granterTier = TIER[granterRole] || 0;

  const { role } = req.body;
  const rawPerms  = req.body.permissions || [];
  const perms     = Array.isArray(rawPerms) ? rawPerms : [rawPerms];
  const isTemporary   = req.body.isTemporary === 'on';
  const temporaryUntil = isTemporary && req.body.temporaryUntil ? new Date(req.body.temporaryUntil) : undefined;

  const targetTier = TIER[role] || 0;
  if (!(role in TIER) || role === 'user' || role === 'founder') {
    return res.redirect('/admin/applications/' + req.params.id + '?error=Invalid+role');
  }
  if (granterTier - targetTier < 2) {
    return res.redirect('/admin/applications/' + req.params.id + '?error=Insufficient+authority+to+assign+this+role');
  }

  const filteredPerms = perms.filter(p => VALID_PERMS.includes(p));
  if (role === 'moderator' && filteredPerms.length !== 1) {
    return res.redirect('/admin/applications/' + req.params.id + '?error=Moderators+must+have+exactly+1+permission');
  }
  if (role === 'supervisor' && filteredPerms.length < 1) {
    return res.redirect('/admin/applications/' + req.params.id + '?error=Supervisors+must+have+at+least+1+permission');
  }
  const finalPerms = role === 'superadmin' ? [] : filteredPerms;

  const existing = await User.findOne({ 'email.value': application.email });
  if (existing) {
    return res.redirect('/admin/applications/' + req.params.id + '?error=An+account+with+this+email+already+exists');
  }

  try {
    const token          = crypto.randomBytes(32).toString('hex');
    const inviteExpiry   = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const placeholderPwd = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    const now            = new Date();

    await User.create({
      password:         placeholderPwd,
      role,
      permissions:      finalPerms,
      accountStatus:    'invited',
      onboardingStatus: 'approved',
      isTemporary,
      temporaryUntil,
      adminInviteToken:  token,
      adminInviteExpiry: inviteExpiry,
      email: {
        value:     application.email,
        confirmed: true,
        history:   [{ value: application.email, setAt: now, source: 'admin-hire' }],
      },
    });

    await AdminApplication.findByIdAndUpdate(req.params.id, { status: 'hired' });

    const resend = getResend();
    if (resend) {
      try {
        const inviteUrl  = `${BASE_URL}/admin/accept-invite?token=${token}`;
        const roleLabel  = TIER_LABELS[role] || role;
        await resend.emails.send({
          from:    FROM_EMAIL,
          to:      application.email,
          subject: "You've been invited to join the ATA Admin team",
          html: `<p style="font-family:sans-serif">Hi ${application.name},</p><p style="font-family:sans-serif">You've been selected to join the AllThingsAprons admin team as a <strong>${roleLabel}</strong>.</p><p style="font-family:sans-serif">Click the link below to set up your account. This link expires in 72 hours.</p><p><a href="${inviteUrl}" style="font-family:sans-serif;color:#f59e0b">Set up your account →</a></p><p style="font-family:sans-serif;color:#6b7280;font-size:13px">If you weren't expecting this, you can ignore this email.</p>`,
        });
      } catch (emailErr) {
        console.error('Invite email failed:', emailErr.message);
      }
    }

    res.redirect('/admin/applications?hired=1');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/applications/' + req.params.id + '?error=Failed+to+create+account');
  }
});

module.exports = router;
