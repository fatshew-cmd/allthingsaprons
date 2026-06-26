const express        = require('express');
const router         = express.Router();
const crypto         = require('crypto');
const bcrypt         = require('bcrypt');
const User           = require('../models/User');
const SupportMessage = require('../models/SupportMessage');
const AdminAuditLog  = require('../models/AdminAuditLog');
const isAdmin        = require('../middleware/isAdmin');
const requireDomain  = require('../middleware/requireDomain');
const logAuditEvent  = require('../utils/auditLog');
const BannedEmail    = require('../models/BannedEmail');
const BannedDocHash  = require('../models/BannedDocHash');
const Announcement   = require('../models/Announcement');
const AnnouncementDismissal = require('../models/AnnouncementDismissal');
const PlatformSettings        = require('../models/PlatformSettings');
const Comment                 = require('../models/Comment');
const CommentReport           = require('../models/CommentReport');
const ContestComment          = require('../models/ContestComment');
const ContestCommentReport    = require('../models/ContestCommentReport');
const Entry                   = require('../models/Entry');
const EntryReport             = require('../models/EntryReport');
const Contest                 = require('../models/Contest');
const Notification            = require('../models/Notification');
const upload         = require('../middleware/upload');

router.get('/login', (req, res) => {
  res.render('admin/login', { title: 'Admin Login', error: null, setup: req.query.setup === '1' });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const ADMIN_TIERS = ['moderator', 'supervisor', 'superadmin', 'founder'];
    const user = await User.findOne({ 'email.value': email.toLowerCase(), role: { $in: ADMIN_TIERS } });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.render('admin/login', { title: 'Admin Login', error: 'Invalid credentials' });
    }
    if (user.accountStatus === 'invited') {
      return res.render('admin/login', { title: 'Admin Login', error: 'Please set up your account using the invite link sent to your email.' });
    }
    if (user.isTemporary && user.temporaryUntil && user.temporaryUntil < new Date()) {
      return res.render('admin/login', { title: 'Admin Login', error: 'Your account has expired. Please contact your administrator.' });
    }
    req.session.isAdmin            = true;
    req.session.adminId            = user._id;
    req.session.adminRole          = user.role;
    req.session.adminPermissions   = user.permissions || [];
    req.session.adminDisplayName   = user.displayName?.value || null;
    req.session.adminEmail         = user.email?.value || null;
    req.session.adminAvatar        = user.avatar?.value || null;
    res.redirect('/admin');
  } catch {
    res.render('admin/login', { title: 'Admin Login', error: 'Something went wrong' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ── Invite acceptance (public — before isAdmin) ───────────────────

router.get('/accept-invite', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/admin/login');
  const user = await User.findOne({ adminInviteToken: token }).lean();
  if (!user) {
    return res.render('admin/accept-invite', { title: 'Set Up Account', token: null, error: 'This invite link is invalid.' });
  }
  if (new Date() > user.adminInviteExpiry) {
    return res.render('admin/accept-invite', { title: 'Set Up Account', token: null, error: 'This invite link has expired. Please contact your administrator.' });
  }
  res.render('admin/accept-invite', { title: 'Set Up Account', token, error: null });
});

router.post('/accept-invite', async (req, res) => {
  const { token, password, confirmPassword } = req.body;
  const renderErr = (msg) => res.render('admin/accept-invite', { title: 'Set Up Account', token, error: msg });

  if (!token) return res.redirect('/admin/login');
  if (!password || password.length < 8) return renderErr('Password must be at least 8 characters.');
  if (password !== confirmPassword) return renderErr('Passwords do not match.');

  const user = await User.findOne({ adminInviteToken: token });
  if (!user) return renderErr('This invite link is invalid.');
  if (new Date() > user.adminInviteExpiry) return renderErr('This invite link has expired. Please contact your administrator.');

  try {
    const hashed = await bcrypt.hash(password, 12);
    await User.findByIdAndUpdate(user._id, {
      password:          hashed,
      accountStatus:     'active',
      $unset:            { adminInviteToken: 1, adminInviteExpiry: 1 },
    });
    res.redirect('/admin/login?setup=1');
  } catch (err) {
    console.error(err);
    renderErr('Something went wrong. Please try again.');
  }
});

router.use(isAdmin);

// Inject sidebar data into res.locals for all protected routes
router.use(async (req, res, next) => {
  const role        = req.session.roleOverride        || req.session.adminRole        || '';
  const permissions = req.session.permissionsOverride || req.session.adminPermissions || [];
  const isFullAccess = role === 'superadmin' || role === 'founder';
  const hasContent   = isFullAccess || permissions.includes('content');
  const hasSupport   = isFullAccess || permissions.includes('support');
  try {
    const [pendingVerifications, unreadMessages] = await Promise.all([
      hasContent ? User.countDocuments({ idVerificationStatus: 'pending' })              : Promise.resolve(0),
      hasSupport ? SupportMessage.countDocuments({ from: 'user', readBySupport: false }) : Promise.resolve(0),
    ]);
    res.locals.sidebarCounts = { pendingVerifications, unreadMessages };
  } catch {
    res.locals.sidebarCounts = { pendingVerifications: 0, unreadMessages: 0 };
  }
  res.locals.adminRole          = role;
  res.locals.adminPermissions   = permissions;
  res.locals.adminDisplayName   = req.session.adminDisplayName || null;
  res.locals.adminEmail         = req.session.adminEmail       || null;
  res.locals.adminAvatar        = req.session.adminAvatar      || null;
  res.locals.isImpersonating    = !!req.session.roleOverride;
  res.locals.realAdminRole      = req.session.adminRole        || '';
  next();
});

router.use('/verification', requireDomain('content'));
router.use('/profile',      require('./adminProfile'));
router.use('/support',      requireDomain('support'), require('./adminSupport'));
router.use('/admins',       requireDomain(null));
router.use('/applications', requireDomain(null), require('./adminApplications'));

// ── Role impersonation (founder only) ────────────────────────────

const IMPERSONATE_PRESETS = {
  'superadmin':          { role: 'superadmin',  permissions: [] },
  'supervisor:content':  { role: 'supervisor',  permissions: ['content'] },
  'supervisor:comments': { role: 'supervisor',  permissions: ['comments'] },
  'supervisor:support':  { role: 'supervisor',  permissions: ['support'] },
  'moderator:content':   { role: 'moderator',   permissions: ['content'] },
  'moderator:comments':  { role: 'moderator',   permissions: ['comments'] },
  'moderator:support':   { role: 'moderator',   permissions: ['support'] },
};

router.post('/impersonate', (req, res) => {
  if (req.session.adminRole !== 'founder') return res.redirect('/admin');
  const preset = IMPERSONATE_PRESETS[req.body.preset];
  if (!preset) return res.redirect('/admin');
  req.session.roleOverride        = preset.role;
  req.session.permissionsOverride = preset.permissions;
  res.redirect('/admin');
});

router.post('/impersonate/exit', (req, res) => {
  delete req.session.roleOverride;
  delete req.session.permissionsOverride;
  res.redirect('/admin');
});

// ── Dashboard ─────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const [totalUsers, activeUsers] = await Promise.all([
    User.countDocuments({ role: 'user' }),
    User.countDocuments({ role: 'user', accountStatus: 'active' }),
  ]);
  res.render('admin/dashboard', {
    title: 'Dashboard',
    currentPage: 'dashboard',
    totalUsers,
    activeUsers,
  });
});

// ── Users ─────────────────────────────────────────────────────────

router.get('/users', async (req, res) => {
  const users = await User.find({ role: 'user' }).sort({ createdAt: -1 });
  res.render('admin/users/index', { title: 'Users', currentPage: 'users', users });
});

router.get('/users/:id', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).send('User not found');
  res.render('admin/users/detail', { title: user.email?.value, currentPage: 'users', user });
});

// ── Admin Accounts ────────────────────────────────────────────────

router.get('/admins', async (req, res) => {
  const ADMIN_TIERS = ['moderator', 'supervisor', 'superadmin', 'founder'];
  const admins = await User.find({ role: { $in: ADMIN_TIERS } })
    .select('username displayName email role permissions createdAt')
    .sort({ createdAt: 1 })
    .lean();
  res.render('admin/admins/index', {
    title:       'Admin Accounts',
    currentPage: 'admins',
    admins,
    granterRole: req.session.adminRole,
  });
});

// ── Role Assignment ───────────────────────────────────────────────

const TIER = { user: 0, moderator: 1, supervisor: 2, superadmin: 3, founder: 4 };
const VALID_PERMISSIONS = ['content', 'chat', 'comments', 'financial', 'support'];

router.post('/users/:id/role', async (req, res) => {
  const granterRole = req.session.adminRole;
  if (granterRole !== 'superadmin' && granterRole !== 'founder') {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const target = await User.findById(req.params.id).select('role');
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'founder') return res.status(403).json({ error: 'Founders cannot be reassigned' });

    const { role, permissions = [] } = req.body;
    if (!(role in TIER)) return res.status(400).json({ error: 'Invalid role' });
    if (TIER[granterRole] - TIER[role] < 2) {
      return res.status(403).json({ error: 'Insufficient authority to assign this role' });
    }

    const perms = permissions.filter(p => VALID_PERMISSIONS.includes(p));
    if (role === 'moderator' && perms.length !== 1) {
      return res.status(400).json({ error: 'Moderators must have exactly 1 permission' });
    }
    if (role === 'supervisor' && perms.length < 1) {
      return res.status(400).json({ error: 'Supervisors must have at least 1 permission' });
    }

    const finalPerms = (role === 'user' || role === 'superadmin' || role === 'founder') ? [] : perms;
    await User.findByIdAndUpdate(req.params.id, { role, permissions: finalPerms });
    logAuditEvent({
      actorId:      req.session.adminId,
      actorRole:    req.session.adminRole,
      action:       'user_role_changed',
      entityType:   'user',
      entityId:     target._id,
      targetUserId: target._id,
      remarks:      req.body.remarks,
      metadata:     { previousRole: target.role, newRole: role, permissions: finalPerms },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// ── ID Verification ───────────────────────────────────────────────

const SEX_LABELS_V = { male: 'Male', female: 'Female', other: 'Other', 'prefer-not-to-say': 'Prefer not to say' };

function genClaimNumber() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return 'VRF-' + code;
}

function calcAgeVerify(birthdate) {
  if (!birthdate) return null;
  const today = new Date();
  const birth  = new Date(birthdate);
  let age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth() ||
      (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age--;
  return age;
}

router.get('/verification', async (req, res) => {
  const pending = await User.find({ idVerificationStatus: 'pending' })
    .select('username email avatar sex birthdate createdAt')
    .sort({ createdAt: 1 });
  res.render('admin/verification', {
    title: 'ID Verification',
    currentPage: 'verification',
    pending,
  });
});

router.get('/verification/:id', async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, idVerificationStatus: 'pending' })
    .select('username email avatar sex birthdate idSelfieUrl idDocUrl idVerificationCode idVerificationSubmittedAt idDocHash idVerifyFailedAttempts idVerificationEscalated');
  if (!user) return res.redirect('/admin/verification');
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setFullYear(today.getFullYear() - 19);
  cutoff.setDate(cutoff.getDate() - 1);

  const submittedAt = user.idVerificationSubmittedAt;
  const submittedAtFormatted = submittedAt
    ? submittedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' at ' +
      submittedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    : null;

  // Check if this document hash appears on any other account
  let docHashConflict = null;
  if (user.idDocHash) {
    docHashConflict = await User.findOne({
      idDocHash: user.idDocHash,
      _id: { $ne: user._id },
    }).select('username email idVerified accountStatus').lean();
  }

  res.render('admin/verification-review', {
    title: 'Review Submission',
    currentPage: 'verification',
    user,
    age:      calcAgeVerify(user.birthdate?.value),
    sexLabel: SEX_LABELS_V[user.sex?.value] || user.sex?.value || '—',
    birthdateFormatted: user.birthdate?.value
      ? new Date(user.birthdate.value).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
      : '—',
    ageCutoffFormatted: cutoff.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' }),
    ageCutoffISO: cutoff.toISOString().split('T')[0],
    submittedAtFormatted,
    docHashConflict,
    attemptNumber:        (user.idVerifyFailedAttempts || 0) + 1,
    isEscalated:          !!user.idVerificationEscalated,
  });
});

router.post('/verification/:id/approve', async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, idVerificationStatus: 'pending' })
      .select('_id idVerificationSubmittedAt idVerificationCaseRef idVerifyFailedAttempts email idDocHash');
    if (!user) return res.redirect('/admin/verification');
    // idDocHash is kept on the User after approval — permanent record that this document was used for this account
    await User.findByIdAndUpdate(user._id, {
      $set:   { idVerified: true, idVerificationStatus: 'none', idVerificationReviewedAt: new Date() },
      $unset: { idSelfieUrl: 1, idDocUrl: 1, idVerificationCode: 1, idVerificationSubmittedAt: 1, idVerificationRejectionReasons: 1, idVerificationCaseRef: 1, idVerificationEscalated: 1 },
    });
    logAuditEvent({
      actorId:      req.session.adminId,
      actorRole:    req.session.adminRole,
      action:       'id_verification_approved',
      entityType:   'user',
      entityId:     user._id,
      targetUserId: user._id,
      caseRef:      user.idVerificationCaseRef || null,
      remarks:      req.body.remarks,
      metadata:     {
        submittedAt:   user.idVerificationSubmittedAt,
        attemptNumber: user.idVerifyFailedAttempts + 1,
        dobDeclared:   req.body.dobDeclared || null,
        dobOnCard:     req.body.dobOnCard   || null,
      },
    });
    res.redirect('/admin/verification');
  } catch (err) {
    console.error('Verification approve error:', err);
    res.redirect('/admin/verification');
  }
});

router.post('/verification/:id/reject', async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, idVerificationStatus: 'pending' })
      .select('_id email idVerifyFailedAttempts idVerificationSubmittedAt idVerificationCaseRef idDocHash');
    if (!user) return res.redirect('/admin/verification');

    const raw      = req.body.reasons;
    const reasons  = raw ? (Array.isArray(raw) ? raw : [raw]).filter(Boolean) : [];
    const caseRef  = user.idVerificationCaseRef || null;
    const newCount = (user.idVerifyFailedAttempts || 0) + 1;
    const isBan    = newCount >= 5;
    const isEscalate = newCount === 4;

    const claimNumber = genClaimNumber();
    const sharedMeta  = {
      reasons,
      claimNumber,
      attemptNumber: newCount,
      submittedAt:   user.idVerificationSubmittedAt,
    };

    if (isBan) {
      // Permanently close the case and ban the account
      await User.findByIdAndUpdate(user._id, {
        $set: {
          idVerificationStatus:      'closed',
          accountStatus:             'banned',
          idVerifyFailedAttempts:    newCount,
          idVerificationReviewedAt:  new Date(),
          idVerificationClaimNumber: claimNumber,
        },
        $unset: { idSelfieUrl: 1, idDocUrl: 1, idVerificationCode: 1, idVerificationSubmittedAt: 1, idVerificationCaseRef: 1, idDocHash: 1 },
      });

      if (user.idDocHash) {
        await BannedDocHash.create({
          hash:     user.idDocHash,
          bannedBy: req.session.adminId,
          caseRef,
          reason:   'max_verification_attempts',
        }).catch(() => {});
      }

      await BannedEmail.create({
        email:    user.email?.value,
        bannedBy: req.session.adminId,
        caseRef,
        reason:   'max_verification_attempts',
      }).catch(() => {}); // silently handle duplicate key if already banned

      logAuditEvent({
        actorId: req.session.adminId, actorRole: req.session.adminRole,
        action: 'id_verification_rejected', entityType: 'user',
        entityId: user._id, targetUserId: user._id,
        caseRef, remarks: req.body.remarks, metadata: { ...sharedMeta, blocked: false },
      });
      logAuditEvent({
        actorId: req.session.adminId, actorRole: req.session.adminRole,
        action: 'id_verification_case_closed', entityType: 'user',
        entityId: user._id, targetUserId: user._id,
        caseRef, metadata: { reason: 'max_attempts', attemptNumber: newCount },
      });
      logAuditEvent({
        actorId: req.session.adminId, actorRole: req.session.adminRole,
        action: 'user_banned', entityType: 'user',
        entityId: user._id, targetUserId: user._id,
        caseRef, remarks: req.body.remarks,
        metadata: { email: user.email?.value, reason: 'max_verification_attempts' },
      });
    } else {
      const update = {
        $set: {
          idVerificationStatus:           'none',
          idVerificationRejectionReasons: reasons,
          idVerifyFailedAttempts:         newCount,
          idVerificationReviewedAt:       new Date(),
          idVerificationClaimNumber:      claimNumber,
        },
        $unset: { idSelfieUrl: 1, idDocUrl: 1, idVerificationCode: 1, idVerificationSubmittedAt: 1, idDocHash: 1 },
      };

      // 6-hour block after every 3rd failure
      if (newCount % 3 === 0) {
        update.$set.idVerifyBlockedUntil = new Date(Date.now() + 6 * 60 * 60 * 1000);
      }

      if (isEscalate) {
        update.$set.idVerificationEscalated = true;
      }

      await User.findByIdAndUpdate(user._id, update);

      logAuditEvent({
        actorId: req.session.adminId, actorRole: req.session.adminRole,
        action: 'id_verification_rejected', entityType: 'user',
        entityId: user._id, targetUserId: user._id,
        caseRef, remarks: req.body.remarks,
        metadata: { ...sharedMeta, blocked: newCount % 3 === 0 },
      });

      if (isEscalate) {
        logAuditEvent({
          actorId: req.session.adminId, actorRole: req.session.adminRole,
          action: 'id_verification_escalated', entityType: 'user',
          entityId: user._id, targetUserId: user._id,
          caseRef, metadata: { attemptNumber: newCount, reason: 'repeated_failures' },
        });
      }
    }

    res.redirect('/admin/verification');
  } catch (err) {
    console.error('Verification reject error:', err);
    res.redirect('/admin/verification');
  }
});

router.get('/tournaments', (req, res) => {
  res.render('admin/tournaments/index', { title: 'Tournaments', currentPage: 'tournaments' });
});

router.get('/tournaments/review', (req, res) => {
  res.render('admin/tournaments/review', { title: 'Tournament Review', currentPage: 'tournament-review' });
});

// ── Audit Log (supervisor+) ───────────────────────────────────────

const AUDIT_MIN_ROLES = ['supervisor', 'superadmin', 'founder'];

const ACTION_LABELS = {
  id_verification_submitted: 'ID Docs Submitted',
  id_verification_approved:  'ID Verification Approved',
  id_verification_rejected:  'ID Verification Rejected',
  user_role_changed:         'Role Changed',
};

router.get('/audit-log', async (req, res) => {
  const role = req.session.roleOverride || req.session.adminRole;
  if (!AUDIT_MIN_ROLES.includes(role)) return res.redirect('/admin');

  try {
    const { action, ticketRef, targetUser, page } = req.query;
    const currentPage = Math.max(1, parseInt(page) || 1);
    const perPage     = 50;
    const filter      = {};

    if (action)     filter.action    = action;
    if (ticketRef)  filter.ticketRef = { $regex: ticketRef.trim(), $options: 'i' };

    // targetUser: search by username or partial match
    if (targetUser) {
      const matched = await User.find({ 'username.value': { $regex: targetUser.trim(), $options: 'i' } })
        .select('_id').limit(50).lean();
      filter.targetUserId = { $in: matched.map(u => u._id) };
    }

    const [total, logs] = await Promise.all([
      AdminAuditLog.countDocuments(filter),
      AdminAuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((currentPage - 1) * perPage)
        .limit(perPage)
        .populate('actorId',      'username displayName email')
        .populate('targetUserId', 'username displayName email')
        .lean(),
    ]);

    res.render('admin/audit-log', {
      title:        'Audit Log',
      currentPage:  'audit-log',
      logs,
      total,
      page:         currentPage,
      perPage,
      totalPages:   Math.ceil(total / perPage),
      filters:      { action: action || '', ticketRef: ticketRef || '', targetUser: targetUser || '' },
      actionLabels: ACTION_LABELS,
      actionKeys:   Object.keys(ACTION_LABELS),
    });
  } catch (err) {
    console.error('Audit log error:', err);
    res.redirect('/admin');
  }
});

router.get('/moderation', async (req, res) => {
  try {
    const rawCommentReports = await CommentReport.find({ status: 'pending' })
      .populate({ path: 'commentId', populate: [
        { path: 'userId', select: 'username displayName avatar' },
        { path: 'entryId', select: 'title _id' },
      ]})
      .populate('reportedBy', 'username displayName')
      .sort({ createdAt: 1 })
      .lean();

    const rawContestReports = await ContestCommentReport.find({ status: 'pending' })
      .populate({ path: 'contestCommentId', populate: [
        { path: 'userId', select: 'username displayName avatar' },
        { path: 'contestId', select: '_id' },
      ]})
      .populate('reportedBy', 'username displayName')
      .sort({ createdAt: 1 })
      .lean();

    const commentMap = {};
    for (const r of rawCommentReports) {
      if (!r.commentId) continue;
      const cid = r.commentId._id.toString();
      if (!commentMap[cid]) {
        commentMap[cid] = {
          commentId: r.commentId._id,
          body: r.commentId.body,
          author: r.commentId.userId,
          context: { type: 'entry', ref: r.commentId.entryId },
          reporters: [],
          firstReportedAt: r.createdAt,
        };
      }
      commentMap[cid].reporters.push(r.reportedBy);
      if (r.createdAt < commentMap[cid].firstReportedAt) commentMap[cid].firstReportedAt = r.createdAt;
    }

    const contestCommentMap = {};
    for (const r of rawContestReports) {
      if (!r.contestCommentId) continue;
      const cid = r.contestCommentId._id.toString();
      if (!contestCommentMap[cid]) {
        contestCommentMap[cid] = {
          commentId: r.contestCommentId._id,
          body: r.contestCommentId.body,
          author: r.contestCommentId.userId,
          context: { type: 'contest', ref: r.contestCommentId.contestId },
          reporters: [],
          firstReportedAt: r.createdAt,
        };
      }
      contestCommentMap[cid].reporters.push(r.reportedBy);
      if (r.createdAt < contestCommentMap[cid].firstReportedAt) contestCommentMap[cid].firstReportedAt = r.createdAt;
    }

    const queue = [
      ...Object.values(commentMap),
      ...Object.values(contestCommentMap),
    ].sort((a, b) => b.reporters.length - a.reporters.length || a.firstReportedAt - b.firstReportedAt);

    // Entry queue
    const rawEntryReports = await EntryReport.find({ status: 'pending' })
      .select('entryId reportedBy createdAt')
      .lean();

    const entryReportMap = {};
    for (const r of rawEntryReports) {
      const eid = r.entryId.toString();
      if (!entryReportMap[eid]) entryReportMap[eid] = { reportCount: 0, firstReportedAt: r.createdAt };
      entryReportMap[eid].reportCount++;
      if (r.createdAt < entryReportMap[eid].firstReportedAt) entryReportMap[eid].firstReportedAt = r.createdAt;
    }

    const entryIds = Object.keys(entryReportMap);
    const hiddenEntries = entryIds.length
      ? await Entry.find({ _id: { $in: entryIds }, hidden: true })
          .select('_id mediaUrl mediaType title userId')
          .populate('userId', 'username displayName avatar')
          .lean()
      : [];

    // Find which of those entries are stalling an active contest
    const stalledContests = hiddenEntries.length
      ? await Contest.find({
          status: 'active',
          stalled: true,
          'entries.entryId': { $in: hiddenEntries.map(e => e._id) },
        }).select('entries').lean()
      : [];

    const stallingEntryIds = new Set();
    for (const c of stalledContests) {
      for (const ce of c.entries) stallingEntryIds.add(ce.entryId.toString());
    }

    const entryQueue = hiddenEntries.map(e => ({
      entry: e,
      owner: e.userId,
      reportCount: entryReportMap[e._id.toString()]?.reportCount || 0,
      firstReportedAt: entryReportMap[e._id.toString()]?.firstReportedAt,
      stallingContest: stallingEntryIds.has(e._id.toString()),
    })).sort((a, b) => b.reportCount - a.reportCount || a.firstReportedAt - b.firstReportedAt);

    const activeTab = req.query.tab === 'entries' ? 'entries' : 'comments';

    res.render('admin/moderation', { title: 'Moderation', currentPage: 'moderation', queue, entryQueue, activeTab });
  } catch (err) {
    console.error('Moderation queue error:', err);
    res.redirect('/admin');
  }
});

// ── Comment moderation actions ────────────────────────────────────────────────

router.post('/moderation/comment-reports/:id/approve', async (req, res) => {
  const { id } = req.params;
  const isContest = req.body.commentType === 'contest';

  try {
    if (isContest) {
      const comment = await ContestComment.findById(id).select('userId contestId').lean();
      if (!comment) return res.redirect('/admin/moderation');

      await ContestComment.deleteOne({ _id: id });

      const reports = await ContestCommentReport.find({ contestCommentId: id, status: 'pending' }).select('reportedBy').lean();
      await ContestCommentReport.updateMany({ contestCommentId: id, status: 'pending' }, { $set: { status: 'approved' } });

      const notifs = [
        { userId: comment.userId, type: 'comment_removed', payload: { contestId: comment.contestId?.toString() }, read: false },
        ...reports.map(r => ({ userId: r.reportedBy, type: 'report_reviewed', payload: { outcome: 'approved' }, read: false })),
      ];
      await Notification.insertMany(notifs, { ordered: false });
    } else {
      const comment = await Comment.findById(id).select('userId entryId').lean();
      if (!comment) return res.redirect('/admin/moderation');

      await Comment.deleteOne({ _id: id });
      if (comment.entryId) {
        await Entry.updateOne({ _id: comment.entryId }, { $inc: { commentCount: -1 } });
      }

      const reports = await CommentReport.find({ commentId: id, status: 'pending' }).select('reportedBy').lean();
      await CommentReport.updateMany({ commentId: id, status: 'pending' }, { $set: { status: 'approved' } });

      const notifs = [
        { userId: comment.userId, type: 'comment_removed', payload: { entryId: comment.entryId?.toString() }, read: false },
        ...reports.map(r => ({ userId: r.reportedBy, type: 'report_reviewed', payload: { outcome: 'approved' }, read: false })),
      ];
      await Notification.insertMany(notifs, { ordered: false });
    }
  } catch (err) {
    console.error('Comment approve error:', err);
  }

  res.redirect('/admin/moderation');
});

router.post('/moderation/comment-reports/:id/reject', async (req, res) => {
  const { id } = req.params;
  const isContest = req.body.commentType === 'contest';

  try {
    if (isContest) {
      await ContestComment.updateOne({ _id: id }, { $set: { hidden: false } });
      const reports = await ContestCommentReport.find({ contestCommentId: id, status: 'pending' }).select('reportedBy').lean();
      await ContestCommentReport.updateMany({ contestCommentId: id, status: 'pending' }, { $set: { status: 'rejected' } });

      const notifs = reports.map(r => ({ userId: r.reportedBy, type: 'report_reviewed', payload: { outcome: 'rejected' }, read: false }));
      if (notifs.length) await Notification.insertMany(notifs, { ordered: false });
    } else {
      await Comment.updateOne({ _id: id }, { $set: { hidden: false } });
      const reports = await CommentReport.find({ commentId: id, status: 'pending' }).select('reportedBy').lean();
      await CommentReport.updateMany({ commentId: id, status: 'pending' }, { $set: { status: 'rejected' } });

      const notifs = reports.map(r => ({ userId: r.reportedBy, type: 'report_reviewed', payload: { outcome: 'rejected' }, read: false }));
      if (notifs.length) await Notification.insertMany(notifs, { ordered: false });
    }
  } catch (err) {
    console.error('Comment reject error:', err);
  }

  res.redirect('/admin/moderation');
});

// ── Entry moderation actions ──────────────────────────────────────────────────

router.post('/moderation/entry-reports/:eid/reject', async (req, res) => {
  const { eid } = req.params;
  try {
    const entry = await Entry.findById(eid).select('_id').lean();
    if (!entry) return res.redirect('/admin/moderation?tab=entries');

    await Entry.updateOne({ _id: eid }, { $set: { hidden: false } });
    await EntryReport.updateMany({ entryId: eid, status: 'pending' }, { $set: { status: 'rejected' } });

    // Unstall any active contest that was stalled by this entry
    const stalledContests = await Contest.find({
      status: 'active',
      stalled: true,
      'entries.entryId': entry._id,
    }).select('_id entries stalledAt votingDeadline').lean();

    const now = new Date();
    for (const contest of stalledContests) {
      const stallDuration = contest.stalledAt ? Math.min(now - contest.stalledAt, 24 * 60 * 60 * 1000) : 0;
      const newDeadline   = new Date((contest.votingDeadline?.getTime() || now.getTime()) + stallDuration);

      await Contest.updateOne({ _id: contest._id }, {
        $set: { stalled: false, stalledAt: null, votingDeadline: newDeadline },
      });

      const contestantUserIds = contest.entries.map(e => e.userId);
      const payload = { contestId: contest._id.toString(), entryId: eid };

      await Notification.insertMany(
        contestantUserIds.map(uid => ({ userId: uid, type: 'contest_resumed', payload, read: false })),
        { ordered: false }
      );
      const notifyWatchers = require('../utils/notifyWatchers');
      await notifyWatchers(contest._id, 'contest_resumed', payload, contestantUserIds);
    }
  } catch (err) {
    console.error('Entry report reject error:', err);
  }

  res.redirect('/admin/moderation?tab=entries');
});

router.post('/moderation/entry-reports/:eid/approve', async (req, res) => {
  const { eid } = req.params;
  try {
    const entry = await Entry.findById(eid).select('_id userId title').lean();
    if (!entry) return res.redirect('/admin/moderation?tab=entries');

    // Void any active contest containing this entry before deleting
    const activeContests = await Contest.find({
      status: 'active',
      'entries.entryId': entry._id,
    }).select('_id entries').lean();

    const notifyWatchers = require('../utils/notifyWatchers');

    for (const contest of activeContests) {
      await Contest.updateOne({ _id: contest._id }, {
        $set: { status: 'void', voidReason: 'entry_removed', stalled: false, stalledAt: null },
      });

      const contestantUserIds = contest.entries.map(e => e.userId);
      const payload = { contestId: contest._id.toString(), voidReason: 'entry_removed' };

      await Notification.insertMany(
        contestantUserIds.map(uid => ({ userId: uid, type: 'contest_voided', payload, read: false })),
        { ordered: false }
      );
      await notifyWatchers(contest._id, 'contest_voided', payload, contestantUserIds);
    }

    await Entry.deleteOne({ _id: eid });
    await EntryReport.updateMany({ entryId: eid, status: 'pending' }, { $set: { status: 'approved' } });

    await Notification.create({
      userId: entry.userId,
      type: 'entry_removed',
      payload: { entryTitle: entry.title },
      read: false,
    });
  } catch (err) {
    console.error('Entry report approve error:', err);
  }

  res.redirect('/admin/moderation?tab=entries');
});

router.get('/content', (req, res) => {
  res.render('admin/content/index', { title: 'Entries', currentPage: 'content' });
});

// ── Announcements (superadmin + founder) ─────────────────────────────────────

const ANNOUNCEMENT_ROLES = ['superadmin', 'founder'];

router.get('/announcements', async (req, res) => {
  const role = req.session.roleOverride || req.session.adminRole;
  if (!ANNOUNCEMENT_ROLES.includes(role)) return res.redirect('/admin');

  try {
    const now = new Date();
    const announcements = await Announcement.find().sort({ createdAt: -1 }).lean();
    for (const a of announcements) {
      if (a.status === 'active' && a.expiresAt && a.expiresAt < now) a.status = 'expired';
    }
    res.render('admin/announcements/index', {
      title: 'Announcements',
      currentPage: 'announcements',
      announcements,
      flash: req.query.flash || null,
    });
  } catch (err) {
    console.error('Announcements list error:', err);
    res.redirect('/admin');
  }
});

router.post('/announcements', upload.thumbnail.single('thumbnail'), async (req, res) => {
  const role = req.session.roleOverride || req.session.adminRole;
  if (!ANNOUNCEMENT_ROLES.includes(role)) return res.status(403).json({ error: 'Forbidden' });

  const { title, description, redirectUrl, publishedAt, expiresAt, publish, filters } = req.body;
  if (!title?.trim()) return res.redirect('/admin/announcements?flash=title-required');

  try {
    const thumbnailUrl = req.file ? '/uploads/announcements/' + req.file.filename : undefined;
    const status = publish === '1' ? 'active' : 'draft';
    await Announcement.create({
      createdBy:   req.session.adminId,
      title:       title.trim(),
      description: description?.trim() || undefined,
      thumbnailUrl,
      redirectUrl:  redirectUrl?.trim() || undefined,
      publishedAt:  publishedAt ? new Date(publishedAt) : (status === 'active' ? new Date() : undefined),
      expiresAt:    expiresAt ? new Date(expiresAt) : undefined,
      status,
      filters: {
        sex:         filters?.sex?.trim()         || undefined,
        ageMin:      filters?.ageMin              ? Number(filters.ageMin)    : undefined,
        orientation: filters?.orientation?.trim() || undefined,
      },
    });
    res.redirect('/admin/announcements?flash=created');
  } catch (err) {
    console.error('Create announcement error:', err);
    res.redirect('/admin/announcements?flash=error');
  }
});

router.get('/announcements/:id', async (req, res) => {
  const role = req.session.roleOverride || req.session.adminRole;
  if (!ANNOUNCEMENT_ROLES.includes(role)) return res.redirect('/admin');

  try {
    const ann = await Announcement.findById(req.params.id).lean();
    if (!ann) return res.redirect('/admin/announcements');

    if (ann.status === 'active' && ann.expiresAt && ann.expiresAt < new Date()) ann.status = 'expired';

    const dismissalCount = await AnnouncementDismissal.countDocuments({ announcementId: req.params.id });

    res.render('admin/announcements/detail', {
      title: ann.title,
      currentPage: 'announcements',
      ann,
      dismissalCount,
    });
  } catch {
    res.redirect('/admin/announcements');
  }
});

router.get('/announcements/:id/edit', async (req, res) => {
  const role = req.session.roleOverride || req.session.adminRole;
  if (!ANNOUNCEMENT_ROLES.includes(role)) return res.redirect('/admin');

  try {
    const ann = await Announcement.findById(req.params.id).lean();
    if (!ann) return res.redirect('/admin/announcements');
    res.render('admin/announcements/edit', {
      title: 'Edit Announcement',
      currentPage: 'announcements',
      ann,
      flash: req.query.flash || null,
    });
  } catch {
    res.redirect('/admin/announcements');
  }
});

router.post('/announcements/:id/edit', upload.thumbnail.single('thumbnail'), async (req, res) => {
  const role = req.session.roleOverride || req.session.adminRole;
  if (!ANNOUNCEMENT_ROLES.includes(role)) return res.status(403).end();

  const { title, description, redirectUrl, publishedAt, expiresAt, removeThumbnail, filters } = req.body;
  if (!title?.trim()) return res.redirect(`/admin/announcements/${req.params.id}/edit?flash=title-required`);

  try {
    const existing = await Announcement.findById(req.params.id);
    if (!existing) return res.redirect('/admin/announcements');

    let thumbnailUrl = existing.thumbnailUrl;
    if (req.file) {
      thumbnailUrl = '/uploads/announcements/' + req.file.filename;
    } else if (removeThumbnail === '1') {
      thumbnailUrl = undefined;
    }

    await Announcement.findByIdAndUpdate(req.params.id, {
      title:        title.trim(),
      description:  description?.trim() || undefined,
      thumbnailUrl,
      redirectUrl:  redirectUrl?.trim() || undefined,
      publishedAt:  publishedAt ? new Date(publishedAt) : null,
      expiresAt:    expiresAt ? new Date(expiresAt) : null,
      filters: {
        sex:         filters?.sex?.trim()  || undefined,
        ageMin:      filters?.ageMin       ? Number(filters.ageMin) : undefined,
        orientation: filters?.orientation?.trim() || undefined,
      },
    });
    res.redirect('/admin/announcements?flash=updated');
  } catch (err) {
    console.error('Edit announcement error:', err);
    res.redirect(`/admin/announcements/${req.params.id}/edit?flash=error`);
  }
});

router.post('/announcements/:id/activate', async (req, res) => {
  const role = req.session.roleOverride || req.session.adminRole;
  if (!ANNOUNCEMENT_ROLES.includes(role)) return res.status(403).end();

  await Announcement.findByIdAndUpdate(req.params.id, { status: 'active', publishedAt: new Date() });
  res.redirect('/admin/announcements');
});

router.post('/announcements/:id/expire', async (req, res) => {
  const role = req.session.roleOverride || req.session.adminRole;
  if (!ANNOUNCEMENT_ROLES.includes(role)) return res.status(403).end();

  await Announcement.findByIdAndUpdate(req.params.id, { status: 'expired' });
  res.redirect('/admin/announcements');
});

router.post('/announcements/:id/delete', async (req, res) => {
  const role = req.session.roleOverride || req.session.adminRole;
  if (!ANNOUNCEMENT_ROLES.includes(role)) return res.status(403).end();

  await Announcement.findByIdAndDelete(req.params.id);
  await AnnouncementDismissal.deleteMany({ announcementId: req.params.id });
  res.redirect('/admin/announcements');
});

// ── Platform Settings (superadmin + founder) ──────────────────────────────────

const SETTINGS_ROLES = ['superadmin', 'founder'];

router.get('/settings', async (req, res) => {
  const role = req.session.roleOverride || req.session.adminRole;
  if (!SETTINGS_ROLES.includes(role)) return res.redirect('/admin');
  const settings = await PlatformSettings.findOne({ key: 'global' }).lean();
  res.render('admin/settings', {
    title:       'Platform Settings',
    currentPage: 'settings',
    settings,
    flash:       req.query.flash || null,
  });
});

router.post('/settings/contest-eligibility', async (req, res) => {
  const role = req.session.roleOverride || req.session.adminRole;
  if (!SETTINGS_ROLES.includes(role)) return res.status(403).end();
  const minEntries     = Math.max(1, parseInt(req.body.minEntries, 10) || 5);
  const minRatingCount = Math.max(1, parseInt(req.body.minRatingCount, 10) || 250);
  const minWeightedAvg = Math.min(10, Math.max(1, parseFloat(req.body.minWeightedAvg) || 7.4));
  await PlatformSettings.findOneAndUpdate(
    { key: 'global' },
    { $set: { 'contestEligibility.minEntries': minEntries, 'contestEligibility.minRatingCount': minRatingCount, 'contestEligibility.minWeightedAvg': minWeightedAvg } },
    { upsert: true }
  );
  res.redirect('/admin/settings?flash=saved');
});

module.exports = router;
