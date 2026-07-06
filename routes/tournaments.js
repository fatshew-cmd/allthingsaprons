const express    = require('express');
const router     = express.Router();
const mongoose   = require('mongoose');
const User                        = require('../models/User');
const Tournament                  = require('../models/Tournament');
const TournamentEntry             = require('../models/TournamentEntry');
const TournamentGroup             = require('../models/TournamentGroup');
const TournamentMatch             = require('../models/TournamentMatch');
const TournamentJury              = require('../models/TournamentJury');
const TournamentJuryVote          = require('../models/TournamentJuryVote');
const TournamentComment           = require('../models/TournamentComment');
const TournamentCommentReport     = require('../models/TournamentCommentReport');
const TournamentReport            = require('../models/TournamentReport');
const TournamentLoop               = require('../models/TournamentLoop');
const TournamentEntryLoop          = require('../models/TournamentEntryLoop');
const WalletTransaction           = require('../models/WalletTransaction');
const Notification                = require('../models/Notification');
const Follow                      = require('../models/Follow');
const Nomination                  = require('../models/Nomination');
const requireAuth                 = require('../middleware/requireAuth');
const requireApproved             = require('../middleware/requireApproved');
const requireOrganizerEligibility = require('../middleware/requireOrganizerEligibility');
const upload                      = require('../middleware/upload');
const { CRITERIA_FIELDS, CRITERIA_OPERATORS, SEX_VALUES } = require('../utils/tournamentCriteria');
const { creditWallet } = require('../utils/wallet');
const estimateParticipantPool = require('../utils/estimateParticipantPool');
const { cancelTournament } = require('../jobs/tournamentJobs');

const EXCHANGE_RATE = 0.20;

const GROUP_CONFIG = {
  4:  { groupSize: 4, groupCount: 1 },
  8:  { groupSize: 4, groupCount: 2 },
  12: { groupSize: 3, groupCount: 4 },
  16: { groupSize: 4, groupCount: 4 },
  24: { groupSize: 3, groupCount: 8 },
};

router.use(requireAuth);
router.use(requireApproved);

// ── GET /tournaments — list ────────────────────────────────────────────────
router.get('/tournaments', async (req, res) => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const visibilityFilter = { $or: [{ visibility: 'public' }, { visibility: { $exists: false } }, { createdBy: req.currentUser._id }] };

  const [liveTournaments, closedTournaments] = await Promise.all([
    Tournament.find({ status: { $in: ['open', 'cooldown', 'active'] }, ...visibilityFilter })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('createdBy', 'username displayName avatar')
      .lean(),
    Tournament.find({ status: 'closed', updatedAt: { $gte: thirtyDaysAgo }, ...visibilityFilter })
      .sort({ updatedAt: -1 })
      .limit(5)
      .populate('createdBy', 'username displayName avatar')
      .lean(),
  ]);

  const currentUserId = req.currentUser._id;
  const organizerIds = [...liveTournaments, ...closedTournaments]
    .map(t => t.createdBy?._id)
    .filter(Boolean);
  const followDocs = organizerIds.length
    ? await Follow.find({ followerId: currentUserId, followingId: { $in: organizerIds } }).select('followingId').lean()
    : [];
  const followingSet = new Set(followDocs.map(f => f.followingId.toString()));
  [...liveTournaments, ...closedTournaments].forEach(t => {
    const uid = t.createdBy?._id?.toString();
    t.isFollowing = uid ? followingSet.has(uid) : false;
    t.isSelf      = uid === currentUserId.toString();
  });

  const openTournaments   = liveTournaments.filter(t => t.status === 'open' || t.status === 'cooldown');
  const activeTournaments = liveTournaments.filter(t => t.status === 'active');

  res.render('tournaments/index', {
    title:      'Tournaments',
    activePage: 'tournaments',
    currentUser: req.currentUser,
    openTournaments,
    activeTournaments,
    closedTournaments,
    draft: req.session.tournamentDraft || null,
    flash: req.query.flash || null,
    flashType: req.query.flashType === 'error' ? 'error' : 'success',
  });
});

// ── GET /tournaments/create — resume at last-visited step, or start fresh ──
// `?new=1` (the "+" FAB) explicitly discards any in-progress draft first — resuming is only
// for the "Draft" tab's "tap to resume" card, which links here without that flag.
router.get('/tournaments/create', requireOrganizerEligibility, (req, res) => {
  if (req.query.new === '1') delete req.session.tournamentDraft;

  const draftStep = req.session.tournamentDraft?.step;
  if (draftStep && draftStep > 1) {
    return res.redirect(`/tournaments/create/step${draftStep}`);
  }
  res.render('tournaments/create', {
    title:      'Create Tournament',
    activePage: 'tournaments',
    currentUser: req.currentUser,
    step:     1,
    maxStep:  req.session.tournamentDraft?.maxStep || 1,
    errors:   [],
    formData: req.session.tournamentDraft || {},
  });
});

// ── GET /tournaments/create/step1 — explicit revisit (back navigation) ─────
router.get('/tournaments/create/step1', requireOrganizerEligibility, (req, res) => {
  res.render('tournaments/create', {
    title:      'Create Tournament',
    activePage: 'tournaments',
    currentUser: req.currentUser,
    step:     1,
    maxStep:  req.session.tournamentDraft?.maxStep || 1,
    errors:   [],
    formData: req.session.tournamentDraft || {},
  });
});

// ── POST /tournaments/create/step1 — Basics ────────────────────────────────
// Trim/lowercase/dedupe stains the same way entry tags are normalized, capped at 6.
function normalizeStains(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return [...new Set(list.map(s => s.trim().toLowerCase()).filter(Boolean))].slice(0, 6);
}

// Trim/lowercase/dedupe wildcard stains the same way general stains are, capped at 2.
function normalizeWildcardStains(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return [...new Set(list.map(s => s.trim().toLowerCase()).filter(Boolean))].slice(0, 2);
}

router.post('/tournaments/create/step1', requireOrganizerEligibility, upload.tournament.single('thumbnail'), async (req, res) => {
  const name        = (req.body.name || '').trim();
  const description = (req.body.description || '').trim();
  const size        = parseInt(req.body.size, 10);
  const openDays    = parseInt(req.body.openDays, 10);
  const visibility  = req.body.visibility === 'private' ? 'private' : 'public';
  const stains      = normalizeStains(req.body.stains);
  const wildcardStains = normalizeWildcardStains(req.body.wildcardStains);

  const thumbnailUrl = req.file
    ? '/uploads/tournaments/' + req.file.filename
    : req.body.removeThumbnail === '1'
      ? null
      : (req.session.tournamentDraft?.thumbnailUrl || null);

  if (req.body.intent === 'draft') {
    req.session.tournamentDraft = {
      ...(req.session.tournamentDraft || {}),
      name, description, thumbnailUrl, visibility, stains, wildcardStains,
      size:     Number.isInteger(size) ? size : undefined,
      openDays: Number.isInteger(openDays) ? openDays : undefined,
      step: 1,
    };
    return res.redirect('/tournaments?flash=' + encodeURIComponent('Draft saved.'));
  }

  const errors = [];
  if (!thumbnailUrl) {
    errors.push('A tournament thumbnail is required.');
  }
  if (name.length < 3 || name.length > 60) {
    errors.push('Tournament name must be between 3 and 60 characters.');
  }
  if (name && !/^[A-Za-z0-9 ]+$/.test(name)) {
    errors.push('Tournament name may only contain letters, numbers, and spaces.');
  }
  if (![4, 8, 12, 16, 24].includes(size)) {
    errors.push('Participant count must be 4, 8, 12, 16, or 24.');
  }
  if (![1, 2, 3].includes(openDays)) {
    errors.push('Open phase must last 1 to 3 days.');
  }
  if (description.length > 220) {
    errors.push('Description must be 220 characters or fewer.');
  }
  if (name.length >= 3 && name.length <= 60) {
    const existing = await Tournament.findOne({
      name: { $regex: '^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' },
    }).select('_id').lean();
    if (existing) errors.push('A tournament with this name already exists.');
  }

  if (errors.length) {
    return res.render('tournaments/create', {
      title: 'Create Tournament', activePage: 'tournaments', currentUser: req.currentUser,
      step: 1, maxStep: req.session.tournamentDraft?.maxStep || 1, errors,
      formData: { name, description, size: req.body.size, openDays: req.body.openDays, thumbnailUrl, visibility, stains, wildcardStains },
    });
  }

  const maxStep = Math.max(2, req.session.tournamentDraft?.maxStep || 1);
  req.session.tournamentDraft = {
    ...(req.session.tournamentDraft || {}),
    name, description, size, openDays, thumbnailUrl, visibility, stains, wildcardStains,
    step: 2, maxStep,
  };
  res.redirect('/tournaments/create/step2');
});

// ── GET /tournaments/create/step2 — Prizes + Inline Funding ────────────────
router.get('/tournaments/create/step2', requireOrganizerEligibility, async (req, res) => {
  if (!req.session.tournamentDraft) return res.redirect('/tournaments/create');

  const user   = await User.findById(req.currentUser._id).select('wallet').lean();
  const prizes = req.session.tournamentDraft.prizes || {};
  res.render('tournaments/create', {
    title: 'Create Tournament', activePage: 'tournaments', currentUser: req.currentUser,
    step: 2, maxStep: req.session.tournamentDraft.maxStep || 2, sbBalance: user?.wallet?.purchasedCHL || 0, errors: [],
    formData: { prizeFirst: prizes.first, prizeSecond: prizes.second, prizeThird: prizes.third },
  });
});

// ── POST /tournaments/create/step2 ─────────────────────────────────────────
router.post('/tournaments/create/step2', requireOrganizerEligibility, async (req, res) => {
  if (!req.session.tournamentDraft) return res.redirect('/tournaments/create');

  const prizeFirst  = parseInt(req.body.prizeFirst, 10);
  const prizeSecond = parseInt(req.body.prizeSecond, 10);
  const prizeThird  = parseInt(req.body.prizeThird, 10);

  if (req.body.intent === 'draft') {
    req.session.tournamentDraft.prizes = {
      first:  Number.isInteger(prizeFirst)  ? prizeFirst  : undefined,
      second: Number.isInteger(prizeSecond) ? prizeSecond : undefined,
      third:  Number.isInteger(prizeThird)  ? prizeThird  : undefined,
    };
    req.session.tournamentDraft.step = 2;
    return res.redirect('/tournaments?flash=' + encodeURIComponent('Draft saved.'));
  }

  const errors = [];
  if (!(prizeFirst >= 350))   errors.push('1st place prize must be at least 350 CHL.');
  if (!(prizeSecond >= 100))  errors.push('2nd place prize must be at least 100 CHL.');
  if (!(prizeThird >= 50))    errors.push('3rd place prize must be at least 50 CHL.');
  if (!errors.length) {
    if (!(prizeFirst > prizeSecond)) errors.push('1st place prize must be greater than 2nd place.');
    if (!(prizeSecond > prizeThird)) errors.push('2nd place prize must be greater than 3rd place.');
  }

  const user = await User.findById(req.currentUser._id).select('wallet').lean();
  const sbBalance = user?.wallet?.purchasedCHL || 0;
  const maxStep = req.session.tournamentDraft.maxStep || 2;

  if (errors.length) {
    return res.render('tournaments/create', {
      title: 'Create Tournament', activePage: 'tournaments', currentUser: req.currentUser,
      step: 2, maxStep, sbBalance, errors, formData: { prizeFirst: req.body.prizeFirst, prizeSecond: req.body.prizeSecond, prizeThird: req.body.prizeThird },
    });
  }

  const total = prizeFirst + prizeSecond + prizeThird;

  if (sbBalance >= total) {
    req.session.tournamentDraft.prizes = { first: prizeFirst, second: prizeSecond, third: prizeThird };
    req.session.tournamentDraft.step = 3;
    req.session.tournamentDraft.maxStep = Math.max(3, maxStep);
    return res.redirect('/tournaments/create/step3');
  }

  const shortfall = total - sbBalance;
  res.render('tournaments/create', {
    title: 'Create Tournament', activePage: 'tournaments', currentUser: req.currentUser,
    step: 2, maxStep, sbBalance, errors: [], formData: { prizeFirst, prizeSecond, prizeThird },
    insufficientFunds: true, shortfall, total,
  });
});

// ── POST /tournaments/fund — inline tournament-gated top-up (CCBill stub) ──
// Shared by both the create wizard (requires fresh organizer eligibility) and the edit wizard
// (the tournament already exists, so re-checking eligibility here would wrongly count it against
// its own organizer's concurrent-tournament cap) — whichever draft is in session decides the redirect.
router.post('/tournaments/fund', async (req, res, next) => {
  const editDraft = req.session.tournamentEditDraft;
  if (editDraft) return next();
  return requireOrganizerEligibility(req, res, next);
}, async (req, res) => {
  const wantsJson  = req.get('Accept') === 'application/json';
  const editDraft  = req.session.tournamentEditDraft;
  const returnPath = editDraft ? `/tournament/${editDraft.tournamentId}/edit/step2` : '/tournaments/create/step2';

  if (!req.session.tournamentDraft && !editDraft) {
    if (wantsJson) return res.status(400).json({ error: 'No tournament draft in progress.' });
    return res.redirect('/tournaments/create');
  }

  const amountCHL = parseInt(req.body.amountCHL, 10);
  if (!amountCHL || amountCHL <= 0 || amountCHL > 500) {
    if (wantsJson) return res.status(400).json({ error: 'Amount must be between 1 and 500 CHL.' });
    return res.redirect(returnPath);
  }

  const userId = req.currentUser._id;
  const updatedUser = await creditWallet(userId, amountCHL, {
    type:          'top_up',
    source:        'tournament_fund',
    referenceType: 'Tournament',
  });

  if (wantsJson) return res.json({ sbBalance: updatedUser.wallet.purchasedCHL || 0 });
  res.redirect(returnPath);
});

// ── GET /tournaments/create/step3 — Eligibility Criteria ───────────────────
router.get('/tournaments/create/step3', requireOrganizerEligibility, (req, res) => {
  if (!req.session.tournamentDraft?.prizes) return res.redirect('/tournaments/create/step2');
  res.render('tournaments/create', {
    title: 'Create Tournament', activePage: 'tournaments', currentUser: req.currentUser,
    step: 3, maxStep: req.session.tournamentDraft.maxStep || 3, errors: [],
    existingCriteria: req.session.tournamentDraft.eligibilityCriteria || [],
  });
});

// ── POST /tournaments/create/step3 ─────────────────────────────────────────
router.post('/tournaments/create/step3', requireOrganizerEligibility, (req, res) => {
  if (!req.session.tournamentDraft?.prizes) return res.redirect('/tournaments/create/step2');
  const maxStep = req.session.tournamentDraft.maxStep || 3;

  if (req.body.intent === 'draft') {
    try {
      const criteria = JSON.parse(req.body.criteria || '[]');
      req.session.tournamentDraft.eligibilityCriteria = Array.isArray(criteria) ? criteria : [];
    } catch {
      req.session.tournamentDraft.eligibilityCriteria = [];
    }
    req.session.tournamentDraft.step = 3;
    return res.redirect('/tournaments?flash=' + encodeURIComponent('Draft saved.'));
  }

  let criteria = [];
  try {
    criteria = JSON.parse(req.body.criteria || '[]');
    if (!Array.isArray(criteria)) throw new Error('not an array');
  } catch {
    return res.render('tournaments/create', {
      title: 'Create Tournament', activePage: 'tournaments', currentUser: req.currentUser,
      step: 3, maxStep, errors: ['Invalid eligibility criteria.'],
      existingCriteria: req.session.tournamentDraft.eligibilityCriteria || [],
    });
  }

  const errors = [];
  for (const c of criteria) {
    if (!CRITERIA_FIELDS.includes(c.field)) {
      errors.push(`Invalid criteria field: ${c.field}`);
      continue;
    }
    if (!CRITERIA_OPERATORS.includes(c.operator)) {
      errors.push(`Invalid criteria operator: ${c.operator}`);
      continue;
    }
    if (c.field === 'sex') {
      if (c.operator !== 'eq' || !SEX_VALUES.includes(c.value)) {
        errors.push('Sex criteria must use "eq" with value M, F, or NB.');
      }
    } else if (c.field === 'isFollower') {
      if (c.operator !== 'eq' || c.value !== true) {
        errors.push('Follower criteria must use "eq" with value true.');
      }
    } else if (typeof c.value !== 'number') {
      errors.push(`Value for ${c.field} must be a number.`);
    }
  }

  if (errors.length) {
    return res.render('tournaments/create', {
      title: 'Create Tournament', activePage: 'tournaments', currentUser: req.currentUser,
      step: 3, maxStep, errors, existingCriteria: criteria,
    });
  }

  req.session.tournamentDraft.eligibilityCriteria = criteria;
  req.session.tournamentDraft.maxStep = Math.max(4, maxStep);
  req.session.tournamentDraft.step = 4;
  res.redirect('/tournaments/create/step4');
});

// Resolves stored jury user ids into the {_id, username, displayName} shape the step4 UI expects.
async function loadExistingJury(userIds) {
  if (!userIds || !userIds.length) return [];
  const users = await User.find({ _id: { $in: userIds } }).select('username displayName avatar').lean();
  return users.map(u => ({
    _id:         u._id,
    username:    u.username?.value || '',
    displayName: u.displayName?.value || u.username?.value || '',
    avatar:      u.avatar?.value || null,
  }));
}

// ── GET /tournaments/create/step4 — Jury Selection ─────────────────────────
router.get('/tournaments/create/step4', requireOrganizerEligibility, async (req, res) => {
  if (!req.session.tournamentDraft?.eligibilityCriteria) return res.redirect('/tournaments/create/step3');
  const existingJury = await loadExistingJury(req.session.tournamentDraft.juryUserIds);
  res.render('tournaments/create', {
    title: 'Create Tournament', activePage: 'tournaments', currentUser: req.currentUser,
    step: 4, maxStep: req.session.tournamentDraft.maxStep || 4, errors: [], existingJury,
  });
});

// ── POST /tournaments/create/step4 — Jury Selection ────────────────────────
router.post('/tournaments/create/step4', requireOrganizerEligibility, async (req, res) => {
  if (!req.session.tournamentDraft?.eligibilityCriteria) return res.redirect('/tournaments/create/step3');
  const maxStep = req.session.tournamentDraft.maxStep || 4;

  const rawIds = Array.isArray(req.body.juryUserIds) ? req.body.juryUserIds : [req.body.juryUserIds].filter(Boolean);
  const juryUserIds = [...new Set(rawIds)];

  if (req.body.intent === 'draft') {
    req.session.tournamentDraft.juryUserIds = juryUserIds;
    req.session.tournamentDraft.step = 4;
    return res.redirect('/tournaments?flash=' + encodeURIComponent('Draft saved.'));
  }

  const errors = [];
  if (juryUserIds.length < 5 || juryUserIds.length > 7) {
    errors.push('You must select between 5 and 7 jury members.');
  }
  if (juryUserIds.includes(req.currentUser._id.toString())) {
    errors.push('You cannot add yourself as a jury member.');
  }

  let juryUsers = [];
  if (!errors.length) {
    juryUsers = await User.find({
      _id: { $in: juryUserIds },
      accountStatus: { $ne: 'banned' },
      juryBanned: { $ne: true },
    }).select('_id').lean();
    if (juryUsers.length !== juryUserIds.length) {
      errors.push('One or more selected jury members are not eligible.');
    }
  }

  if (errors.length) {
    return res.render('tournaments/create', {
      title: 'Create Tournament', activePage: 'tournaments', currentUser: req.currentUser,
      step: 4, maxStep, errors, existingJury: await loadExistingJury(juryUserIds),
    });
  }

  req.session.tournamentDraft.juryUserIds = juryUserIds;
  req.session.tournamentDraft.step = 5;
  req.session.tournamentDraft.maxStep = Math.max(5, maxStep);
  res.redirect('/tournaments/create/step5');
});

// Builds the render payload shared by the GET and error-path renders of the review step.
async function buildReviewViewData(req, errors) {
  const draft = req.session.tournamentDraft;
  return {
    title: 'Create Tournament', activePage: 'tournaments', currentUser: req.currentUser,
    step: 5, maxStep: draft.maxStep || 5, errors: errors || [],
    formData: draft,
    existingJury: await loadExistingJury(draft.juryUserIds),
  };
}

// ── GET /tournaments/create/step5 — Review ──────────────────────────────────
router.get('/tournaments/create/step5', requireOrganizerEligibility, async (req, res) => {
  const draft = req.session.tournamentDraft;
  if (!draft?.juryUserIds || draft.juryUserIds.length < 5) return res.redirect('/tournaments/create/step4');
  res.render('tournaments/create', await buildReviewViewData(req));
});

// ── POST /tournaments/create/step5 — finalize ───────────────────────────────
router.post('/tournaments/create/step5', requireOrganizerEligibility, async (req, res) => {
  const draft = req.session.tournamentDraft;
  if (!draft?.juryUserIds || draft.juryUserIds.length < 5) return res.redirect('/tournaments/create/step4');

  if (req.body.intent === 'draft') {
    return res.redirect('/tournaments?flash=' + encodeURIComponent('Draft saved.'));
  }

  try {
    const tournament = await finalizeTournamentCreation(req);
    delete req.session.tournamentDraft;
    res.redirect(`/tournament/${tournament._id}?flash=${encodeURIComponent('Your tournament is live and accepting candidates.')}`);
  } catch (err) {
    res.render('tournaments/create', await buildReviewViewData(req, [err.message || 'Something went wrong creating your tournament.']));
  }
});

async function finalizeTournamentCreation(req) {
  // Required lazily — jobs/agenda.js must load after mongoose.connect() resolves in server.js.
  const agenda = require('../jobs/agenda');
  const draft  = req.session.tournamentDraft;
  const userId = req.currentUser._id;

  const { groupSize, groupCount } = GROUP_CONFIG[draft.size];
  const openDeadline = new Date(Date.now() + draft.openDays * 24 * 60 * 60 * 1000);
  const totalPrize = draft.prizes.first + draft.prizes.second + draft.prizes.third;

  const updatedUser = await User.findOneAndUpdate(
    { _id: userId, 'wallet.purchasedCHL': { $gte: totalPrize } },
    { $inc: { 'wallet.purchasedCHL': -totalPrize }, $set: { 'wallet.updatedAt': new Date() } },
    { new: true, select: 'wallet' },
  );
  if (!updatedUser) throw new Error('Insufficient balance. Your wallet balance changed.');

  const tournament = await Tournament.create({
    createdBy:   userId,
    name:        draft.name,
    description: draft.description,
    thumbnailUrl: draft.thumbnailUrl || null,
    visibility:  draft.visibility === 'private' ? 'private' : 'public',
    size:        draft.size,
    groupSize,
    groupCount,
    stains: draft.stains || [],
    eligibilityCriteria: draft.eligibilityCriteria,
    wildcardStains: draft.wildcardStains || [],
    prizes: { first: draft.prizes.first, second: draft.prizes.second, third: draft.prizes.third, funded: true },
    status: 'open',
    openDeadline,
  });

  const balanceAfter  = (updatedUser.wallet.purchasedCHL || 0) + (updatedUser.wallet.earnedCHL || 0);
  const balanceBefore = balanceAfter + totalPrize;

  try {
    await Promise.all([
      WalletTransaction.create({
        userId,
        type:          'tournament_prize_hold',
        direction:     'debit',
        amountCHL:     totalPrize,
        amountUSD:     +(totalPrize * EXCHANGE_RATE).toFixed(2),
        exchangeRate:  EXCHANGE_RATE,
        balanceBefore,
        balanceAfter,
        status:        'completed',
        source:        'tournament_creation',
        referenceType: 'Tournament',
        referenceId:   tournament._id,
      }),
      TournamentJury.insertMany(draft.juryUserIds.map(uid => ({ tournamentId: tournament._id, userId: uid, missedVotes: 0, status: 'pending' }))),
      agenda.schedule(openDeadline, 'tournament_open_expiry', { tournamentId: tournament._id.toString() }),
      Notification.insertMany(draft.juryUserIds.map(uid => ({
        userId:  uid,
        type:    'tournament_jury_invite',
        payload: { tournamentId: tournament._id, tournamentName: tournament.name, openDeadline, url: '/tournament/' + tournament._id + '/jury-invite' },
      })), { ordered: false }),
    ]);
  } catch (err) {
    // Undo the wallet debit and remove the half-created tournament so a retry doesn't double-charge
    // or leave an orphaned 'open' tournament behind. Best-effort — don't mask the original error.
    await Promise.all([
      User.findByIdAndUpdate(userId, { $inc: { 'wallet.purchasedCHL': totalPrize } }),
      Tournament.findByIdAndDelete(tournament._id),
      TournamentJury.deleteMany({ tournamentId: tournament._id }),
      Notification.deleteMany({ type: 'tournament_jury_invite', 'payload.tournamentId': tournament._id }),
      agenda.cancel({ name: 'tournament_open_expiry', 'data.tournamentId': tournament._id.toString() }),
    ]).catch(() => {});
    throw err;
  }

  return tournament;
}

// ── Edit flow — reuses the create wizard views, but targets an existing tournament and is
// only reachable by its organizer while status is 'open' or 'cooldown' (not yet live). ──────

// Loads the tournament for an edit request, enforcing organizer + editable-status. Handles its
// own error response and returns null when the request should stop.
async function loadEditableTournament(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) { res.redirect('/tournaments'); return null; }

  const tournament = await Tournament.findById(req.params.id).lean();
  if (!tournament) { res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser }); return null; }

  if (!tournament.createdBy || tournament.createdBy.toString() !== req.currentUser._id.toString()) {
    res.status(403).render('404', { title: 'Not Found', currentUser: req.currentUser });
    return null;
  }
  if (!['open', 'cooldown'].includes(tournament.status)) {
    res.redirect(`/tournament/${tournament._id}?flash=${encodeURIComponent('This tournament can no longer be edited.')}&flashType=error`);
    return null;
  }

  return tournament;
}

function editDraftFor(req, tournamentId) {
  const draft = req.session.tournamentEditDraft;
  return draft && draft.tournamentId === tournamentId ? draft : null;
}

// Lets the organizer save from any step via the header "Save Changes" button instead of
// walking through the rest of the wizard — safe because the draft is seeded from the live
// tournament, so every step already holds a valid value even if the organizer never visits it.
// Returns true if it handled the response (either saved or re-rendered errors); false means
// the caller should continue with its normal "advance to next step" redirect.
async function trySaveNow(req, res, tournament, renderCurrentStepWithErrors) {
  if (req.body.intent !== 'save') return false;

  try {
    await finalizeTournamentEdit(req, tournament);
    delete req.session.tournamentEditDraft;
    res.redirect(`/tournament/${tournament._id}?flash=${encodeURIComponent('Your changes have been saved.')}`);
  } catch (err) {
    await renderCurrentStepWithErrors([err.message || 'Something went wrong saving your changes.']);
  }
  return true;
}

// ── GET /tournament/:id/edit — seeds the edit draft from the live tournament, then enters
// the wizard at step 1 ──────────────────────────────────────────────────────────────────────
router.get('/tournament/:id/edit', async (req, res) => {
  const tournament = await loadEditableTournament(req, res);
  if (!tournament) return;

  const jury = await TournamentJury.find({ tournamentId: tournament._id }).select('userId').lean();
  const openDays = Math.max(1, Math.min(3, Math.round((tournament.openDeadline - tournament.createdAt) / (24 * 60 * 60 * 1000))));

  req.session.tournamentEditDraft = {
    tournamentId: tournament._id.toString(),
    name: tournament.name,
    description: tournament.description || '',
    thumbnailUrl: tournament.thumbnailUrl,
    visibility: tournament.visibility,
    stains: tournament.stains || [],
    size: tournament.size,
    openDays,
    prizes: { first: tournament.prizes.first, second: tournament.prizes.second, third: tournament.prizes.third || 0 },
    eligibilityCriteria: tournament.eligibilityCriteria || [],
    wildcardStains: tournament.wildcardStains || [],
    juryUserIds: jury.map(j => j.userId.toString()),
    step: 1,
    maxStep: 5,
  };

  res.redirect(`/tournament/${tournament._id}/edit/step1`);
});

// ── GET /tournament/:id/edit/step1 — Basics ─────────────────────────────────
router.get('/tournament/:id/edit/step1', async (req, res) => {
  const tournament = await loadEditableTournament(req, res);
  if (!tournament) return;
  const draft = editDraftFor(req, req.params.id);
  if (!draft) return res.redirect(`/tournament/${req.params.id}/edit`);

  res.render('tournaments/create', {
    title: 'Edit Tournament', activePage: 'tournaments', currentUser: req.currentUser,
    step: 1, maxStep: draft.maxStep || 1, errors: [], formData: draft,
    editing: true, tournamentId: tournament._id.toString(), tournamentStatus: tournament.status,
  });
});

// ── POST /tournament/:id/edit/step1 ─────────────────────────────────────────
router.post('/tournament/:id/edit/step1', upload.tournament.single('thumbnail'), async (req, res) => {
  const tournament = await loadEditableTournament(req, res);
  if (!tournament) return;
  const draft = editDraftFor(req, req.params.id);
  if (!draft) return res.redirect(`/tournament/${req.params.id}/edit`);

  const name        = (req.body.name || '').trim();
  const description = (req.body.description || '').trim();
  const size        = parseInt(req.body.size, 10);
  // Open phase length can't be changed once the open phase itself is over (status !== 'open') —
  // the deadline has either passed or is already locked in via the scheduled sweeper job.
  const openDays    = tournament.status === 'open' ? parseInt(req.body.openDays, 10) : draft.openDays;
  const visibility  = req.body.visibility === 'private' ? 'private' : 'public';
  const stains      = normalizeStains(req.body.stains);
  const wildcardStains = normalizeWildcardStains(req.body.wildcardStains);

  const thumbnailUrl = req.file
    ? '/uploads/tournaments/' + req.file.filename
    : req.body.removeThumbnail === '1'
      ? null
      : (draft.thumbnailUrl || null);

  const errors = [];
  if (!thumbnailUrl) errors.push('A tournament thumbnail is required.');
  if (name.length < 3 || name.length > 60) errors.push('Tournament name must be between 3 and 60 characters.');
  if (name && !/^[A-Za-z0-9 ]+$/.test(name)) errors.push('Tournament name may only contain letters, numbers, and spaces.');
  if (![4, 8, 12, 16, 24].includes(size)) errors.push('Participant count must be 4, 8, 12, 16, or 24.');
  if (tournament.status === 'open' && ![1, 2, 3].includes(openDays)) errors.push('Open phase must last 1 to 3 days.');
  if (description.length > 220) errors.push('Description must be 220 characters or fewer.');
  if (name.length >= 3 && name.length <= 60) {
    const existing = await Tournament.findOne({
      _id: { $ne: tournament._id },
      name: { $regex: '^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' },
    }).select('_id').lean();
    if (existing) errors.push('A tournament with this name already exists.');
  }

  if (errors.length) {
    return res.render('tournaments/create', {
      title: 'Edit Tournament', activePage: 'tournaments', currentUser: req.currentUser,
      step: 1, maxStep: draft.maxStep || 1, errors,
      formData: { ...draft, name, description, size: req.body.size, openDays, thumbnailUrl, visibility, stains, wildcardStains },
      editing: true, tournamentId: tournament._id.toString(), tournamentStatus: tournament.status,
    });
  }

  req.session.tournamentEditDraft = {
    ...draft, name, description, size, openDays, thumbnailUrl, visibility, stains, wildcardStains,
    step: 2, maxStep: Math.max(2, draft.maxStep || 1),
  };

  const handled = await trySaveNow(req, res, tournament, (errors) => res.render('tournaments/create', {
    title: 'Edit Tournament', activePage: 'tournaments', currentUser: req.currentUser,
    step: 1, maxStep: req.session.tournamentEditDraft.maxStep || 1, errors,
    formData: req.session.tournamentEditDraft,
    editing: true, tournamentId: tournament._id.toString(), tournamentStatus: tournament.status,
  }));
  if (handled) return;

  res.redirect(`/tournament/${tournament._id}/edit/step2`);
});

// ── GET /tournament/:id/edit/step2 — Prizes ─────────────────────────────────
router.get('/tournament/:id/edit/step2', async (req, res) => {
  const tournament = await loadEditableTournament(req, res);
  if (!tournament) return;
  const draft = editDraftFor(req, req.params.id);
  if (!draft) return res.redirect(`/tournament/${req.params.id}/edit`);

  const user     = await User.findById(req.currentUser._id).select('wallet').lean();
  const oldTotal = tournament.prizes.first + tournament.prizes.second + (tournament.prizes.third || 0);

  res.render('tournaments/create', {
    title: 'Edit Tournament', activePage: 'tournaments', currentUser: req.currentUser,
    step: 2, maxStep: draft.maxStep || 2, sbBalance: user?.wallet?.purchasedCHL || 0, errors: [],
    formData: { prizeFirst: draft.prizes.first, prizeSecond: draft.prizes.second, prizeThird: draft.prizes.third },
    editing: true, tournamentId: tournament._id.toString(), tournamentStatus: tournament.status, oldTotal,
  });
});

// ── POST /tournament/:id/edit/step2 ─────────────────────────────────────────
router.post('/tournament/:id/edit/step2', async (req, res) => {
  const tournament = await loadEditableTournament(req, res);
  if (!tournament) return;
  const draft = editDraftFor(req, req.params.id);
  if (!draft) return res.redirect(`/tournament/${req.params.id}/edit`);

  const prizeFirst  = parseInt(req.body.prizeFirst, 10);
  const prizeSecond = parseInt(req.body.prizeSecond, 10);
  const prizeThird  = parseInt(req.body.prizeThird, 10);

  const errors = [];
  if (!(prizeFirst >= 350))   errors.push('1st place prize must be at least 350 CHL.');
  if (!(prizeSecond >= 100))  errors.push('2nd place prize must be at least 100 CHL.');
  if (!(prizeThird >= 50))    errors.push('3rd place prize must be at least 50 CHL.');
  if (!errors.length) {
    if (!(prizeFirst > prizeSecond)) errors.push('1st place prize must be greater than 2nd place.');
    if (!(prizeSecond > prizeThird)) errors.push('2nd place prize must be greater than 3rd place.');
  }

  const user     = await User.findById(req.currentUser._id).select('wallet').lean();
  const sbBalance = user?.wallet?.purchasedCHL || 0;
  const maxStep   = draft.maxStep || 2;
  const oldTotal  = tournament.prizes.first + tournament.prizes.second + (tournament.prizes.third || 0);

  if (errors.length) {
    return res.render('tournaments/create', {
      title: 'Edit Tournament', activePage: 'tournaments', currentUser: req.currentUser,
      step: 2, maxStep, sbBalance, errors, formData: { prizeFirst: req.body.prizeFirst, prizeSecond: req.body.prizeSecond, prizeThird: req.body.prizeThird },
      editing: true, tournamentId: tournament._id.toString(), tournamentStatus: tournament.status, oldTotal,
    });
  }

  const total = prizeFirst + prizeSecond + prizeThird;
  // Only the *increase* over what's already funded needs to be covered by the wallet —
  // the existing prize hold stays put and true-up happens at finalize time.
  const additionalNeeded = Math.max(0, total - oldTotal);

  if (sbBalance >= additionalNeeded) {
    req.session.tournamentEditDraft = {
      ...draft, prizes: { first: prizeFirst, second: prizeSecond, third: prizeThird },
      step: 3, maxStep: Math.max(3, maxStep),
    };

    const handled = await trySaveNow(req, res, tournament, (errs) => res.render('tournaments/create', {
      title: 'Edit Tournament', activePage: 'tournaments', currentUser: req.currentUser,
      step: 2, maxStep: req.session.tournamentEditDraft.maxStep || 2, sbBalance, errors: errs,
      formData: { prizeFirst, prizeSecond, prizeThird },
      editing: true, tournamentId: tournament._id.toString(), tournamentStatus: tournament.status, oldTotal,
    }));
    if (handled) return;

    return res.redirect(`/tournament/${tournament._id}/edit/step3`);
  }

  const shortfall = additionalNeeded - sbBalance;
  res.render('tournaments/create', {
    title: 'Edit Tournament', activePage: 'tournaments', currentUser: req.currentUser,
    step: 2, maxStep, sbBalance, errors: [], formData: { prizeFirst, prizeSecond, prizeThird },
    editing: true, tournamentId: tournament._id.toString(), tournamentStatus: tournament.status, oldTotal,
    insufficientFunds: true, shortfall, total: additionalNeeded,
  });
});

// ── GET /tournament/:id/edit/step3 — Eligibility Criteria ───────────────────
router.get('/tournament/:id/edit/step3', async (req, res) => {
  const tournament = await loadEditableTournament(req, res);
  if (!tournament) return;
  const draft = editDraftFor(req, req.params.id);
  if (!draft) return res.redirect(`/tournament/${req.params.id}/edit`);

  res.render('tournaments/create', {
    title: 'Edit Tournament', activePage: 'tournaments', currentUser: req.currentUser,
    step: 3, maxStep: draft.maxStep || 3, errors: [], existingCriteria: draft.eligibilityCriteria || [],
    editing: true, tournamentId: tournament._id.toString(), tournamentStatus: tournament.status,
  });
});

// ── POST /tournament/:id/edit/step3 ─────────────────────────────────────────
router.post('/tournament/:id/edit/step3', async (req, res) => {
  const tournament = await loadEditableTournament(req, res);
  if (!tournament) return;
  const draft = editDraftFor(req, req.params.id);
  if (!draft) return res.redirect(`/tournament/${req.params.id}/edit`);

  const maxStep = draft.maxStep || 3;

  let criteria = [];
  try {
    criteria = JSON.parse(req.body.criteria || '[]');
    if (!Array.isArray(criteria)) throw new Error('not an array');
  } catch {
    return res.render('tournaments/create', {
      title: 'Edit Tournament', activePage: 'tournaments', currentUser: req.currentUser,
      step: 3, maxStep, errors: ['Invalid eligibility criteria.'], existingCriteria: draft.eligibilityCriteria || [],
      editing: true, tournamentId: tournament._id.toString(), tournamentStatus: tournament.status,
    });
  }

  const errors = [];
  for (const c of criteria) {
    if (!CRITERIA_FIELDS.includes(c.field)) { errors.push(`Invalid criteria field: ${c.field}`); continue; }
    if (!CRITERIA_OPERATORS.includes(c.operator)) { errors.push(`Invalid criteria operator: ${c.operator}`); continue; }
    if (c.field === 'sex') {
      if (c.operator !== 'eq' || !SEX_VALUES.includes(c.value)) errors.push('Sex criteria must use "eq" with value M, F, or NB.');
    } else if (c.field === 'isFollower') {
      if (c.operator !== 'eq' || c.value !== true) errors.push('Follower criteria must use "eq" with value true.');
    } else if (typeof c.value !== 'number') {
      errors.push(`Value for ${c.field} must be a number.`);
    }
  }

  if (errors.length) {
    return res.render('tournaments/create', {
      title: 'Edit Tournament', activePage: 'tournaments', currentUser: req.currentUser,
      step: 3, maxStep, errors, existingCriteria: criteria,
      editing: true, tournamentId: tournament._id.toString(), tournamentStatus: tournament.status,
    });
  }

  req.session.tournamentEditDraft = { ...draft, eligibilityCriteria: criteria, step: 4, maxStep: Math.max(4, maxStep) };

  const handled = await trySaveNow(req, res, tournament, (errs) => res.render('tournaments/create', {
    title: 'Edit Tournament', activePage: 'tournaments', currentUser: req.currentUser,
    step: 3, maxStep: req.session.tournamentEditDraft.maxStep || 3, errors: errs, existingCriteria: criteria,
    editing: true, tournamentId: tournament._id.toString(), tournamentStatus: tournament.status,
  }));
  if (handled) return;

  res.redirect(`/tournament/${tournament._id}/edit/step4`);
});

// ── GET /tournament/:id/edit/step4 — Jury Selection ─────────────────────────
router.get('/tournament/:id/edit/step4', async (req, res) => {
  const tournament = await loadEditableTournament(req, res);
  if (!tournament) return;
  const draft = editDraftFor(req, req.params.id);
  if (!draft) return res.redirect(`/tournament/${req.params.id}/edit`);

  const existingJury = await loadExistingJury(draft.juryUserIds);
  res.render('tournaments/create', {
    title: 'Edit Tournament', activePage: 'tournaments', currentUser: req.currentUser,
    step: 4, maxStep: draft.maxStep || 4, errors: [], existingJury,
    editing: true, tournamentId: tournament._id.toString(), tournamentStatus: tournament.status,
  });
});

// ── POST /tournament/:id/edit/step4 ─────────────────────────────────────────
router.post('/tournament/:id/edit/step4', async (req, res) => {
  const tournament = await loadEditableTournament(req, res);
  if (!tournament) return;
  const draft = editDraftFor(req, req.params.id);
  if (!draft) return res.redirect(`/tournament/${req.params.id}/edit`);

  const maxStep = draft.maxStep || 4;
  const rawIds = Array.isArray(req.body.juryUserIds) ? req.body.juryUserIds : [req.body.juryUserIds].filter(Boolean);
  const juryUserIds = [...new Set(rawIds)];

  const errors = [];
  if (juryUserIds.length < 5 || juryUserIds.length > 7) errors.push('You must select between 5 and 7 jury members.');
  if (juryUserIds.includes(req.currentUser._id.toString())) errors.push('You cannot add yourself as a jury member.');

  let juryUsers = [];
  if (!errors.length) {
    juryUsers = await User.find({
      _id: { $in: juryUserIds }, accountStatus: { $ne: 'banned' }, juryBanned: { $ne: true },
    }).select('_id').lean();
    if (juryUsers.length !== juryUserIds.length) errors.push('One or more selected jury members are not eligible.');
  }

  if (errors.length) {
    return res.render('tournaments/create', {
      title: 'Edit Tournament', activePage: 'tournaments', currentUser: req.currentUser,
      step: 4, maxStep, errors, existingJury: await loadExistingJury(juryUserIds),
      editing: true, tournamentId: tournament._id.toString(), tournamentStatus: tournament.status,
    });
  }

  req.session.tournamentEditDraft = { ...draft, juryUserIds, step: 5, maxStep: Math.max(5, maxStep) };

  const handled = await trySaveNow(req, res, tournament, async (errs) => res.render('tournaments/create', {
    title: 'Edit Tournament', activePage: 'tournaments', currentUser: req.currentUser,
    step: 4, maxStep: req.session.tournamentEditDraft.maxStep || 4, errors: errs, existingJury: await loadExistingJury(juryUserIds),
    editing: true, tournamentId: tournament._id.toString(), tournamentStatus: tournament.status,
  }));
  if (handled) return;

  res.redirect(`/tournament/${tournament._id}/edit/step5`);
});

// Builds the render payload shared by the GET and error-path renders of the edit review step.
async function buildEditReviewViewData(req, tournament, errors) {
  const draft = req.session.tournamentEditDraft;
  return {
    title: 'Edit Tournament', activePage: 'tournaments', currentUser: req.currentUser,
    step: 5, maxStep: draft.maxStep || 5, errors: errors || [], formData: draft,
    existingJury: await loadExistingJury(draft.juryUserIds),
    editing: true, tournamentId: tournament._id.toString(), tournamentStatus: tournament.status,
  };
}

// ── GET /tournament/:id/edit/step5 — Review ─────────────────────────────────
router.get('/tournament/:id/edit/step5', async (req, res) => {
  const tournament = await loadEditableTournament(req, res);
  if (!tournament) return;
  const draft = editDraftFor(req, req.params.id);
  if (!draft || !draft.juryUserIds || draft.juryUserIds.length < 5) return res.redirect(`/tournament/${req.params.id}/edit/step4`);

  res.render('tournaments/create', await buildEditReviewViewData(req, tournament));
});

// ── POST /tournament/:id/edit/step5 — save changes ──────────────────────────
router.post('/tournament/:id/edit/step5', async (req, res) => {
  const tournament = await loadEditableTournament(req, res);
  if (!tournament) return;
  const draft = editDraftFor(req, req.params.id);
  if (!draft || !draft.juryUserIds || draft.juryUserIds.length < 5) return res.redirect(`/tournament/${req.params.id}/edit/step4`);

  try {
    await finalizeTournamentEdit(req, tournament);
    delete req.session.tournamentEditDraft;
    res.redirect(`/tournament/${tournament._id}?flash=${encodeURIComponent('Your changes have been saved.')}`);
  } catch (err) {
    res.render('tournaments/create', await buildEditReviewViewData(req, tournament, [err.message || 'Something went wrong saving your changes.']));
  }
});

async function finalizeTournamentEdit(req, tournament) {
  const agenda = require('../jobs/agenda');
  const draft  = req.session.tournamentEditDraft;
  const organizerId = req.currentUser._id;

  // Re-fetch fresh in case status changed mid-edit (e.g. a sweeper job transitioned it while
  // the organizer was still filling out the form).
  const fresh = await Tournament.findOne({ _id: tournament._id, status: { $in: ['open', 'cooldown'] } });
  if (!fresh) throw new Error('This tournament can no longer be edited.');

  // ── Validate everything that can fail *before* making any writes, so a late failure never
  // leaves the tournament partially updated (no multi-document transactions in this codebase). ──

  let groupSize = fresh.groupSize, groupCount = fresh.groupCount;
  if (fresh.size !== draft.size) {
    const approvedCount = await TournamentEntry.countDocuments({ tournamentId: fresh._id, approvalStatus: 'approved' });
    if (approvedCount > draft.size) {
      throw new Error(`Cannot reduce participant count below the ${approvedCount} already-approved candidates.`);
    }
    ({ groupSize, groupCount } = GROUP_CONFIG[draft.size]);
  }

  let openDeadline = fresh.openDeadline;
  let needsReschedule = false;
  if (fresh.status === 'open') {
    const recomputed = new Date(fresh.createdAt.getTime() + draft.openDays * 24 * 60 * 60 * 1000);
    if (recomputed.getTime() !== fresh.openDeadline.getTime()) {
      if (recomputed <= new Date()) throw new Error('That open-phase length would end in the past.');
      openDeadline = recomputed;
      needsReschedule = true;
    }
  }

  const existingJury = await TournamentJury.find({ tournamentId: fresh._id }).lean();
  const existingIds  = new Set(existingJury.map(j => j.userId.toString()));
  const newIds       = new Set(draft.juryUserIds);
  const toAdd        = draft.juryUserIds.filter(id => !existingIds.has(id));
  const toRemove     = existingJury.filter(j => !newIds.has(j.userId.toString()));

  if (toAdd.length) {
    const eligible = await User.find({
      _id: { $in: toAdd }, accountStatus: { $ne: 'banned' }, juryBanned: { $ne: true },
    }).select('_id').lean();
    if (eligible.length !== toAdd.length) throw new Error('One or more selected jury members are not eligible.');
  }

  // ── All validation passed — apply changes ────────────────────────────────

  if (needsReschedule) {
    await agenda.cancel({ name: 'tournament_open_expiry', 'data.tournamentId': fresh._id.toString() });
    await agenda.schedule(openDeadline, 'tournament_open_expiry', { tournamentId: fresh._id.toString() });
  }

  // Prizes / wallet true-up — only the delta over what's already funded moves.
  const oldTotal = fresh.prizes.first + fresh.prizes.second + (fresh.prizes.third || 0);
  const newTotal = draft.prizes.first + draft.prizes.second + draft.prizes.third;
  const delta    = newTotal - oldTotal;

  if (delta > 0) {
    const updatedUser = await User.findOneAndUpdate(
      { _id: organizerId, 'wallet.purchasedCHL': { $gte: delta } },
      { $inc: { 'wallet.purchasedCHL': -delta }, $set: { 'wallet.updatedAt': new Date() } },
      { new: true, select: 'wallet' },
    );
    if (!updatedUser) throw new Error('Insufficient balance. Your wallet balance changed.');

    const balanceAfter  = (updatedUser.wallet.purchasedCHL || 0) + (updatedUser.wallet.earnedCHL || 0);
    const balanceBefore = balanceAfter + delta;
    await WalletTransaction.create({
      userId: organizerId, type: 'tournament_prize_hold', direction: 'debit',
      amountCHL: delta, amountUSD: +(delta * EXCHANGE_RATE).toFixed(2), exchangeRate: EXCHANGE_RATE,
      balanceBefore, balanceAfter, status: 'completed', source: 'tournament_edit',
      referenceType: 'Tournament', referenceId: fresh._id,
    });
  } else if (delta < 0) {
    await creditWallet(organizerId, -delta, {
      type: 'tournament_prize_refund', source: 'tournament_edit', referenceId: fresh._id, referenceType: 'Tournament',
    });
  }

  // Eligibility criteria — re-check already-submitted candidates, drop anyone who no longer qualifies.
  const criteriaChanged = JSON.stringify(fresh.eligibilityCriteria || []) !== JSON.stringify(draft.eligibilityCriteria || []);
  if (criteriaChanged) {
    const affectedEntries = await TournamentEntry.find({
      tournamentId: fresh._id, approvalStatus: { $in: ['pending', 'approved'] },
    }).lean();

    for (const entry of affectedEntries) {
      const stillMeets = await estimateParticipantPool.meetsTournamentCriteria(
        entry.userId, entry.entryId, organizerId, draft.eligibilityCriteria,
      );
      if (!stillMeets) {
        await TournamentEntry.updateOne({ _id: entry._id }, { $set: { approvalStatus: 'rejected', reviewedAt: new Date() } });
        await Notification.create({
          userId:  entry.userId,
          type:    'tournament_entry_removed',
          payload: { tournamentId: fresh._id, tournamentName: draft.name, url: '/tournament/' + fresh._id },
        });
      }
    }
  }

  // Jury — apply the diff computed above.
  if (toAdd.length) {
    await TournamentJury.insertMany(toAdd.map(uid => ({ tournamentId: fresh._id, userId: uid, missedVotes: 0, status: 'pending' })));
    await Notification.insertMany(toAdd.map(uid => ({
      userId:  uid,
      type:    'tournament_jury_invite',
      payload: { tournamentId: fresh._id, tournamentName: draft.name, openDeadline, url: '/tournament/' + fresh._id + '/jury-invite' },
    })), { ordered: false });
  }
  if (toRemove.length) {
    await TournamentJury.deleteMany({ _id: { $in: toRemove.map(j => j._id) } });
  }

  // Persist basics last, once every other subsystem has already succeeded.
  await Tournament.updateOne({ _id: fresh._id }, { $set: {
    name: draft.name, description: draft.description, thumbnailUrl: draft.thumbnailUrl,
    visibility: draft.visibility, size: draft.size, groupSize, groupCount, stains: draft.stains || [],
    eligibilityCriteria: draft.eligibilityCriteria, wildcardStains: draft.wildcardStains || [], openDeadline,
    'prizes.first': draft.prizes.first, 'prizes.second': draft.prizes.second, 'prizes.third': draft.prizes.third,
  } });
}

// Shared sort options + aggregation pipeline for browsing a tournament's TournamentEntry docs
// (used by both the detail page's Entries row and the organizer's dedicated review queue) —
// joins in the Entry, User, and follower-count data needed to sort/search by rating, rating
// count, recency, or follower count.
const TOURNAMENT_ENTRY_SORTS = {
  recent:      { submittedAt: -1 },
  oldest:      { submittedAt: 1 },
  rating:      { 'entry.ratingAvg': -1 },
  ratingCount: { 'entry.ratingCount': -1 },
  followers:   { followerCount: -1 },
};

function buildTournamentEntryPipeline(tournamentId, approvalStatus, sort, search) {
  const pipeline = [
    { $match: { tournamentId, approvalStatus } },
    { $lookup: { from: 'entries', localField: 'entryId', foreignField: '_id', as: 'entry' } },
    { $unwind: '$entry' },
    { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
  ];

  if (search) {
    pipeline.push({ $match: {
      'user.username.value': { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' },
    } });
  }

  pipeline.push(
    { $lookup: {
        from: 'follows', localField: 'userId', foreignField: 'followingId', as: 'followerDocs',
        pipeline: [{ $project: { _id: 1 } }],
    } },
    { $addFields: { followerCount: { $size: '$followerDocs' } } },
    { $sort: TOURNAMENT_ENTRY_SORTS[sort] },
    { $project: {
        approvalStatus: 1, submittedAt: 1, followerCount: 1, autoSubmitted: 1,
        entryId: { _id: '$entry._id', title: '$entry.title', caption: '$entry.caption', mediaType: '$entry.mediaType', mediaUrl: '$entry.mediaUrl', ratingAvg: '$entry.ratingAvg', ratingCount: '$entry.ratingCount', takeOnCount: '$entry.takeOnCount', tags: '$entry.tags' },
        userId:  { _id: '$user._id', username: '$user.username', displayName: '$user.displayName', avatar: '$user.avatar' },
    } },
  );

  return pipeline;
}

// ── GET /tournament/:id — detail ───────────────────────────────────────────
router.get('/tournament/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.redirect('/tournaments');

  const tournament = await Tournament.findById(req.params.id).populate('createdBy', 'username displayName avatar').lean();
  if (!tournament || tournament.status === 'canceled') {
    return res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser });
  }

  const isOrganizer = !!tournament.createdBy && tournament.createdBy._id.toString() === req.currentUser._id.toString();

  const [groups, entries, matches, userEntry, pendingCount, declinedJuryCount, isFollowing, isLoopedIn, isJuror] = await Promise.all([
    TournamentGroup.find({ tournamentId: tournament._id })
      .populate({ path: 'memberIds', populate: [
        { path: 'userId', select: 'username displayName avatar' },
        { path: 'entryId' },
      ] })
      .lean(),
    TournamentEntry.find({
      tournamentId: tournament._id,
      approvalStatus: { $in: ['approved', 'pending'] },
    })
      .populate('entryId')
      .populate('userId', 'username displayName avatar')
      .lean(),
    TournamentMatch.find({ tournamentId: tournament._id })
      .populate({ path: 'tournamentEntryIdA', populate: [
        { path: 'userId', select: 'username displayName avatar' },
        { path: 'entryId' },
      ] })
      .populate({ path: 'tournamentEntryIdB', populate: [
        { path: 'userId', select: 'username displayName avatar' },
        { path: 'entryId' },
      ] })
      .populate('contestId')
      .lean(),
    TournamentEntry.findOne({ tournamentId: tournament._id, userId: req.currentUser._id }).populate('entryId').lean(),
    isOrganizer && (tournament.status === 'open' || tournament.status === 'cooldown')
      ? TournamentEntry.countDocuments({ tournamentId: tournament._id, approvalStatus: 'pending' })
      : 0,
    isOrganizer
      ? TournamentJury.countDocuments({ tournamentId: tournament._id, status: 'declined' })
      : 0,
    !isOrganizer && tournament.createdBy
      ? Follow.exists({ followerId: req.currentUser._id, followingId: tournament.createdBy._id })
      : false,
    !isOrganizer
      ? TournamentLoop.exists({ tournamentId: tournament._id, userId: req.currentUser._id })
      : false,
    !isOrganizer
      ? TournamentJury.exists({ tournamentId: tournament._id, userId: req.currentUser._id })
      : false,
  ]);

  const entryOwnerIds = [...new Set(
    entries.map(e => e.userId?._id?.toString()).filter(id => id && id !== req.currentUser._id.toString()),
  )];

  const [comments, placements, entryFollowDocs, entryLoopDocs] = await Promise.all([
    loadTournamentComments(tournament._id),
    tournament.status === 'closed' ? loadTournamentPlacements(tournament._id) : {},
    entryOwnerIds.length
      ? Follow.find({ followerId: req.currentUser._id, followingId: { $in: entryOwnerIds } }).select('followingId').lean()
      : [],
    entries.length
      ? TournamentEntryLoop.find({ tournamentEntryId: { $in: entries.map(e => e._id) }, userId: req.currentUser._id }).select('tournamentEntryId').lean()
      : [],
  ]);
  const entryFollowingSet = new Set(entryFollowDocs.map(f => f.followingId.toString()));
  const entryLoopedInSet  = new Set(entryLoopDocs.map(w => w.tournamentEntryId.toString()));

  res.render('tournaments/detail', {
    title:      tournament.name,
    activePage: 'tournaments',
    currentUser: req.currentUser,
    tournament, groups, entries, matches, userEntry, isOrganizer, pendingCount, declinedJuryCount,
    entryLoopedInSet,
    entryFollowingSet,
    isFollowing: !!isFollowing,
    isLoopedIn: !!isLoopedIn,
    isJuror: !!isJuror,
    comments,
    placements,
    flash: req.query.flash || null,
    flashType: req.query.flashType === 'error' ? 'error' : 'success',
  });
});

// Derives 1st/2nd/3rd place TournamentEntry docs (with populated userId) from the Final and
// 3rd-place knockout matches — no separate "placement" field is persisted anywhere; the winner
// of each match already tells us who placed where.
async function loadTournamentPlacements(tournamentId) {
  const [finalMatch, thirdMatch] = await Promise.all([
    TournamentMatch.findOne({ tournamentId, knockoutRound: 'Final' }).lean(),
    TournamentMatch.findOne({ tournamentId, knockoutRound: '3rd' }).lean(),
  ]);

  function winnerTournamentEntryId(match) {
    if (!match || !match.winnerId) return null;
    return match.entryIdA.toString() === match.winnerId.toString() ? match.tournamentEntryIdA : match.tournamentEntryIdB;
  }
  function loserTournamentEntryId(match) {
    if (!match || !match.winnerId) return null;
    return match.entryIdA.toString() === match.winnerId.toString() ? match.tournamentEntryIdB : match.tournamentEntryIdA;
  }

  const placementIds = {
    first:  winnerTournamentEntryId(finalMatch),
    second: loserTournamentEntryId(finalMatch),
    third:  winnerTournamentEntryId(thirdMatch),
  };

  const ids = Object.values(placementIds).filter(Boolean);
  if (!ids.length) return {};

  const entries = await TournamentEntry.find({ _id: { $in: ids } })
    .populate('userId', 'username displayName avatar')
    .lean();
  const byId = {};
  entries.forEach(e => { byId[e._id.toString()] = e; });

  return {
    first:  placementIds.first  ? byId[placementIds.first.toString()]  || null : null,
    second: placementIds.second ? byId[placementIds.second.toString()] || null : null,
    third:  placementIds.third  ? byId[placementIds.third.toString()]  || null : null,
  };
}

// Loads top-level tournament comments + their replies, sorted by a recency-weighted net-reaction score.
async function loadTournamentComments(tournamentId) {
  const topLevelComments = await TournamentComment.find({ tournamentId, parentId: null, hidden: false })
    .populate('userId', 'username displayName avatar')
    .sort({ createdAt: -1 })
    .lean()
    .catch(() => []);

  const topLevelIds = topLevelComments.map(c => c._id);
  const allReplies = topLevelIds.length
    ? await TournamentComment.find({ parentId: { $in: topLevelIds }, hidden: false })
        .populate('userId', 'username displayName avatar')
        .sort({ createdAt: 1 })
        .lean()
        .catch(() => [])
    : [];

  const replyMap = {};
  for (const r of allReplies) {
    const pid = r.parentId.toString();
    if (!replyMap[pid]) replyMap[pid] = [];
    replyMap[pid].push(r);
  }
  const comments = topLevelComments.map(c => ({ ...c, replies: replyMap[c._id.toString()] || [] }));

  const now = Date.now();
  const score = c => {
    const ownNet   = (c.likes?.length || 0) - (c.dislikes?.length || 0);
    const hoursOld = (now - new Date(c.createdAt).getTime()) / 3600000;
    const recency  = 1 / Math.pow(hoursOld + 2, 1.5);
    const replyBoost = (c.replies || []).reduce((sum, r) => {
      const rNet   = (r.likes?.length || 0) - (r.dislikes?.length || 0);
      const rHours = (now - new Date(r.createdAt).getTime()) / 3600000;
      return sum + rNet * (1 / Math.pow(rHours + 2, 1.5));
    }, 0);
    return ownNet + replyBoost * 0.25 + recency;
  };
  comments.sort((a, b) => score(b) - score(a));

  return comments;
}

// ── POST /tournament/:id/cancel — organizer self-cancel ─────────────────────
router.post('/tournament/:id/cancel', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found.' });

  const tournament = await Tournament.findOne({ _id: req.params.id, status: { $in: ['open', 'cooldown'] } }).lean();
  if (!tournament) return res.status(404).json({ error: 'This tournament can no longer be canceled.' });
  if (tournament.createdBy.toString() !== req.currentUser._id.toString()) {
    return res.status(403).json({ error: 'Only the organizer can cancel this tournament.' });
  }

  const agenda = require('../jobs/agenda');
  await Promise.all([
    agenda.cancel({ name: 'tournament_open_expiry', 'data.tournamentId': tournament._id.toString() }),
    agenda.cancel({ name: 'tournament_cooldown_expiry', 'data.tournamentId': tournament._id.toString() }),
  ]);
  await cancelTournament(tournament._id, 'organizer_canceled');

  res.json({ success: true });
});

// ── POST /tournament/:id/entry/withdraw — candidate withdraws their own submission ──
// Only allowed while the organizer hasn't reviewed it yet — once approved/rejected the
// entry is locked into (or out of) the bracket and can no longer be pulled by the candidate.
router.post('/tournament/:id/entry/withdraw', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const entry = await TournamentEntry.findOne({ tournamentId: req.params.id, userId: req.currentUser._id });
  if (!entry) return res.status(404).json({ error: 'Submission not found.' });
  if (entry.approvalStatus !== 'pending') {
    return res.status(400).json({ error: 'Your entry has already been reviewed and can no longer be withdrawn.' });
  }

  await entry.deleteOne();
  res.json({ success: true });
});

// ── POST /tournament/:id/loop-in — toggle loop-in/subscribe ─────────────────
router.post('/tournament/:id/loop-in', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const existing = await TournamentLoop.findOne({ tournamentId: req.params.id, userId: req.currentUser._id });
  if (existing) {
    await existing.deleteOne();
    return res.json({ loopedIn: false });
  }

  const tournament = await Tournament.findById(req.params.id).select('createdBy').lean();
  if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
  if (tournament.createdBy.toString() === req.currentUser._id.toString()) {
    return res.status(400).json({ error: "You can't loop in on your own tournament." });
  }

  await TournamentLoop.create({ tournamentId: req.params.id, userId: req.currentUser._id });
  res.json({ loopedIn: true });
});

// ── POST /tournament/:id/entry/:teId/loop-in — toggle loop-in on a specific candidate ───
router.post('/tournament/:id/entry/:teId/loop-in', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.teId)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }

  const existing = await TournamentEntryLoop.findOne({ tournamentEntryId: req.params.teId, userId: req.currentUser._id });
  if (existing) {
    await existing.deleteOne();
    return res.json({ loopedIn: false });
  }

  const entry = await TournamentEntry.findById(req.params.teId).select('tournamentId userId').lean();
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  if (entry.tournamentId.toString() !== req.params.id) {
    return res.status(400).json({ error: 'Entry does not belong to this tournament.' });
  }
  if (entry.userId.toString() === req.currentUser._id.toString()) {
    return res.status(400).json({ error: "You can't loop in on your own entry." });
  }

  await TournamentEntryLoop.create({ tournamentEntryId: req.params.teId, tournamentId: req.params.id, userId: req.currentUser._id });
  res.json({ loopedIn: true });
});

// ── POST /tournament/:id/report — report the tournament itself ──────────────
router.post('/tournament/:id/report', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const tournament = await Tournament.findById(req.params.id).select('createdBy').lean();
  if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
  if (tournament.createdBy.toString() === req.currentUser._id.toString()) {
    return res.status(400).json({ error: "You can't report your own tournament." });
  }

  try {
    await TournamentReport.create({ tournamentId: req.params.id, reportedBy: req.currentUser._id });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "You've already reported this tournament." });
    console.error('Tournament report error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ── Tournament comments ──────────────────────────────────────────────────────

router.post('/tournament/:id/comments', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const body = req.body.body?.trim();
  if (!body || body.length === 0) return res.status(400).json({ error: 'Comment body is required.' });
  if (body.replace(/\s/g, '').length > 280) return res.status(400).json({ error: 'Comment cannot exceed 280 characters (spaces not counted).' });

  const parentId = req.body.parentId || null;
  if (parentId && !mongoose.isValidObjectId(parentId)) return res.status(400).json({ error: 'Invalid parentId.' });

  const tournament = await Tournament.findById(req.params.id).select('_id').lean();
  if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });

  let effectiveParentId = null;
  if (parentId) {
    const parent = await TournamentComment.findById(parentId).select('tournamentId parentId').lean().catch(() => null);
    if (!parent || parent.tournamentId.toString() !== req.params.id) {
      return res.status(400).json({ error: 'Invalid parent comment.' });
    }
    effectiveParentId = parent.parentId || parent._id;
  }

  try {
    const comment = await TournamentComment.create({
      tournamentId: tournament._id,
      userId:       req.currentUser._id,
      parentId:     effectiveParentId,
      body,
    });

    res.json({
      _id:          comment._id,
      tournamentId: comment.tournamentId,
      userId:       comment.userId,
      parentId:     comment.parentId,
      body:         comment.body,
      editedAt:     comment.editedAt,
      createdAt:    comment.createdAt,
      user: {
        username:    req.currentUser.username,
        displayName: req.currentUser.displayName || null,
        avatar:      req.currentUser.avatar || null,
      },
    });
  } catch (err) {
    console.error('Tournament comment create error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.patch('/tournament/:id/comments/:cid', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }

  const body = req.body.body?.trim();
  if (!body || body.length === 0) return res.status(400).json({ error: 'Comment body is required.' });
  if (body.replace(/\s/g, '').length > 280) return res.status(400).json({ error: 'Comment cannot exceed 280 characters (spaces not counted).' });

  const comment = await TournamentComment.findById(req.params.cid).catch(() => null);
  if (!comment || comment.tournamentId.toString() !== req.params.id) {
    return res.status(404).json({ error: 'Comment not found.' });
  }
  if (comment.userId.toString() !== req.currentUser._id.toString()) {
    return res.status(403).json({ error: 'Not your comment.' });
  }

  comment.body     = body;
  comment.editedAt = new Date();
  await comment.save();

  res.json({ ok: true, body: comment.body, editedAt: comment.editedAt });
});

router.delete('/tournament/:id/comments/:cid', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }

  const comment = await TournamentComment.findById(req.params.cid).catch(() => null);
  if (!comment || comment.tournamentId.toString() !== req.params.id) {
    return res.status(404).json({ error: 'Comment not found.' });
  }

  const MOD_ROLES = new Set(['moderator', 'supervisor', 'superadmin', 'founder']);
  const isOwn = comment.userId.toString() === req.currentUser._id.toString();
  const isMod = MOD_ROLES.has(req.currentUser.role);
  if (!isOwn && !isMod) return res.status(403).json({ error: 'Not authorized.' });

  await Promise.all([
    TournamentComment.deleteOne({ _id: comment._id }),
    TournamentComment.deleteMany({ parentId: comment._id }),
    TournamentCommentReport.deleteMany({ tournamentCommentId: comment._id }),
  ]);

  res.json({ ok: true });
});

router.post('/tournament/:id/comments/:cid/report', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }

  const comment = await TournamentComment.findById(req.params.cid).select('userId tournamentId').lean().catch(() => null);
  if (!comment || comment.tournamentId.toString() !== req.params.id) {
    return res.status(404).json({ error: 'Comment not found.' });
  }
  if (comment.userId.toString() === req.currentUser._id.toString()) {
    return res.status(400).json({ error: "You can't report your own comment." });
  }

  const existing = await TournamentCommentReport.findOne({ tournamentCommentId: comment._id, reportedBy: req.currentUser._id }).lean();
  if (existing) {
    if (existing.status !== 'rejected') return res.status(409).json({ error: "You've already reported this comment." });
    await TournamentCommentReport.updateOne({ _id: existing._id }, { $set: { status: 'pending' } });
    await TournamentComment.updateOne({ _id: comment._id }, { $set: { hidden: true } });
    return res.json({ ok: true });
  }

  try {
    await TournamentCommentReport.create({ tournamentCommentId: comment._id, reportedBy: req.currentUser._id });
    await TournamentComment.updateOne({ _id: comment._id }, { $set: { hidden: true } });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "You've already reported this comment." });
    console.error('Tournament comment report error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.post('/tournament/:id/comments/:cid/react', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.cid)) {
    return res.status(400).json({ error: 'Invalid ID.' });
  }
  const { type } = req.body;
  if (!['like', 'dislike'].includes(type)) return res.status(400).json({ error: 'Invalid type.' });

  const comment = await TournamentComment.findById(req.params.cid).select('tournamentId likes dislikes').catch(() => null);
  if (!comment || comment.tournamentId.toString() !== req.params.id) return res.status(404).json({ error: 'Comment not found.' });

  const uid = req.currentUser._id.toString();
  const hasLiked    = comment.likes.some(id => id.toString() === uid);
  const hasDisliked = comment.dislikes.some(id => id.toString() === uid);
  let update;
  if (type === 'like') {
    if (hasLiked)         update = { $pull: { likes: req.currentUser._id } };
    else if (hasDisliked) update = { $pull: { dislikes: req.currentUser._id }, $addToSet: { likes: req.currentUser._id } };
    else                  update = { $addToSet: { likes: req.currentUser._id } };
  } else {
    if (hasDisliked)   update = { $pull: { dislikes: req.currentUser._id } };
    else if (hasLiked) update = { $pull: { likes: req.currentUser._id }, $addToSet: { dislikes: req.currentUser._id } };
    else               update = { $addToSet: { dislikes: req.currentUser._id } };
  }
  const updated = await TournamentComment.findByIdAndUpdate(comment._id, update, { new: true }).select('likes dislikes');
  const userLiked    = updated.likes.some(id => id.toString() === uid);
  const userDisliked = updated.dislikes.some(id => id.toString() === uid);
  res.json({ likes: updated.likes.length, dislikes: updated.dislikes.length, userLiked, userDisliked });
});

// ── GET /tournament/:id/review — organizer candidate review ────────────────
router.get('/tournament/:id/review', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.redirect('/tournaments');

  const tournament = await Tournament.findById(req.params.id).lean();
  if (!tournament) return res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser });
  if (!tournament.createdBy || tournament.createdBy.toString() !== req.currentUser._id.toString()) {
    return res.status(403).render('404', { title: 'Not Found', currentUser: req.currentUser });
  }

  const sort   = TOURNAMENT_ENTRY_SORTS[req.query.sort] ? req.query.sort : 'recent';
  const search = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';

  const pendingEntries = await TournamentEntry.aggregate(
    buildTournamentEntryPipeline(tournament._id, 'pending', sort, search),
  );

  const candidateUserIds = [...new Set(pendingEntries.map(pe => pe.userId?._id?.toString()).filter(Boolean))];
  const [followingDocs, nominationCounts] = await Promise.all([
    candidateUserIds.length
      ? Follow.find({ followerId: req.currentUser._id, followingId: { $in: candidateUserIds } }).select('followingId').lean()
      : [],
    candidateUserIds.length
      ? Nomination.aggregate([
          { $match: { nomineeId: { $in: candidateUserIds.map(id => new mongoose.Types.ObjectId(id)) }, status: 'accepted' } },
          { $group: { _id: '$nomineeId', count: { $sum: 1 } } },
        ])
      : [],
  ]);
  const followingSet = new Set(followingDocs.map(f => f.followingId.toString()));
  const nominationCountMap = {};
  nominationCounts.forEach(nc => { nominationCountMap[nc._id.toString()] = nc.count; });

  res.render('tournaments/review', {
    title:      'Review Candidates',
    activePage: 'tournaments',
    currentUser: req.currentUser,
    tournament, pendingEntries, sort, search: req.query.q || '',
    followingSet, nominationCountMap,
  });
});

// ── GET /tournament/:id/jury-vote/:matchId — juror tie-break vote page ─────
router.get('/tournament/:id/jury-vote/:matchId', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.matchId)) {
    return res.redirect('/tournaments');
  }

  const [tournament, jurorRecord] = await Promise.all([
    Tournament.findById(req.params.id).lean(),
    TournamentJury.findOne({ tournamentId: req.params.id, userId: req.currentUser._id, status: 'accepted' }).lean(),
  ]);
  if (!tournament) return res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser });
  if (!jurorRecord) return res.status(403).render('404', { title: 'Not Found', currentUser: req.currentUser });

  const match = await TournamentMatch.findOne({ _id: req.params.matchId, tournamentId: tournament._id }).lean();
  if (!match || match.status !== 'tie' || match.tieStatus !== 'jury_pending') {
    return res.redirect(`/tournament/${tournament._id}`);
  }

  const existingVote = await TournamentJuryVote.findOne({ matchId: match._id, jurorId: req.currentUser._id }).lean();
  if (existingVote) {
    return res.redirect(`/tournament/${tournament._id}?flash=${encodeURIComponent('You already voted on this tie.')}`);
  }

  const Entry = require('../models/Entry');
  const [entryA, entryB] = await Promise.all([
    Entry.findById(match.entryIdA).lean(),
    Entry.findById(match.entryIdB).lean(),
  ]);

  res.render('tournaments/jury-vote', {
    title:      'Jury Tie-Break',
    activePage: 'tournaments',
    currentUser: req.currentUser,
    tournament, match, entryA, entryB,
  });
});

// ── GET /tournament/:id/jury-invite — juror accept/decline page ────────────
router.get('/tournament/:id/jury-invite', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.redirect('/tournaments');

  const [tournament, jurorRecord] = await Promise.all([
    Tournament.findById(req.params.id).lean(),
    TournamentJury.findOne({ tournamentId: req.params.id, userId: req.currentUser._id }).lean(),
  ]);
  if (!tournament) return res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser });
  if (!jurorRecord) return res.status(403).render('404', { title: 'Not Found', currentUser: req.currentUser });

  if (tournament.status !== 'open') {
    return res.redirect(`/tournament/${tournament._id}?flash=${encodeURIComponent('This jury invite is no longer active.')}`);
  }
  if (jurorRecord.status !== 'pending') {
    const msg = jurorRecord.status === 'accepted' ? 'You already accepted this jury invite.' : 'You already declined this jury invite.';
    return res.redirect(`/tournament/${tournament._id}?flash=${encodeURIComponent(msg)}`);
  }

  res.render('tournaments/jury-invite', {
    title:      'Jury Invitation',
    activePage: 'tournaments',
    currentUser: req.currentUser,
    tournament,
  });
});

// ── POST /tournament/:id/jury-invite/respond — accept or decline ───────────
router.post('/tournament/:id/jury-invite/respond', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid tournament.' });

  const action = req.body.action;
  if (action !== 'accept' && action !== 'decline') return res.status(400).json({ error: 'Invalid action.' });

  const tournament = await Tournament.findOne({ _id: req.params.id, status: 'open' }).lean();
  if (!tournament) return res.status(400).json({ error: 'This jury invite is no longer active.' });

  const jurorRecord = await TournamentJury.findOneAndUpdate(
    { tournamentId: tournament._id, userId: req.currentUser._id, status: 'pending' },
    { $set: { status: action === 'accept' ? 'accepted' : 'declined', respondedAt: new Date() } },
  );
  if (!jurorRecord) return res.status(400).json({ error: 'You already responded to this invite.' });

  if (action === 'decline') {
    await Notification.create({
      userId:  tournament.createdBy,
      type:    'tournament_jury_declined',
      payload: { tournamentId: tournament._id, tournamentName: tournament.name, url: '/tournament/' + tournament._id + '/jury/manage' },
    });
  }

  res.json({ success: true, redirect: `/tournament/${tournament._id}` });
});

// ── GET /tournament/:id/jury/manage — organizer: view jury + replace declines ──
router.get('/tournament/:id/jury/manage', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.redirect('/tournaments');

  const tournament = await Tournament.findById(req.params.id).lean();
  if (!tournament) return res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser });
  if (!tournament.createdBy || tournament.createdBy.toString() !== req.currentUser._id.toString()) {
    return res.status(403).render('404', { title: 'Not Found', currentUser: req.currentUser });
  }

  const jury = await TournamentJury.find({ tournamentId: tournament._id })
    .populate('userId', 'username displayName avatar')
    .lean();

  res.render('tournaments/jury-manage', {
    title:      'Manage Jury',
    activePage: 'tournaments',
    currentUser: req.currentUser,
    tournament, jury,
  });
});

// ── POST /tournament/:id/jury/replace — organizer: swap a declined juror ───
router.post('/tournament/:id/jury/replace', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid tournament.' });

  const { oldUserId, newUserId } = req.body;
  if (!mongoose.isValidObjectId(oldUserId) || !mongoose.isValidObjectId(newUserId)) {
    return res.status(400).json({ error: 'Invalid user.' });
  }

  const tournament = await Tournament.findOne({ _id: req.params.id, status: 'open' }).lean();
  if (!tournament) return res.status(400).json({ error: 'This tournament is no longer accepting jury changes.' });
  if (tournament.createdBy.toString() !== req.currentUser._id.toString()) {
    return res.status(403).json({ error: 'Not authorized.' });
  }

  if (newUserId === tournament.createdBy.toString()) {
    return res.status(400).json({ error: 'The organizer cannot serve as jury.' });
  }

  const [alreadyJury, newUser] = await Promise.all([
    TournamentJury.findOne({ tournamentId: tournament._id, userId: newUserId }),
    User.findOne({ _id: newUserId, role: 'user', accountStatus: { $ne: 'banned' }, juryBanned: { $ne: true } }).select('_id').lean(),
  ]);

  if (alreadyJury) return res.status(400).json({ error: 'That user is already on this tournament\'s jury.' });
  if (!newUser) return res.status(400).json({ error: 'That user is not eligible to serve as jury.' });

  // Atomic find-and-delete: only one concurrent replace request can consume this declined
  // slot, so two racing requests can't both succeed and grow the jury past its intended size.
  const oldRecord = await TournamentJury.findOneAndDelete({ tournamentId: tournament._id, userId: oldUserId, status: 'declined' });
  if (!oldRecord) return res.status(400).json({ error: 'That juror has not declined — nothing to replace.' });

  await TournamentJury.create({ tournamentId: tournament._id, userId: newUserId, missedVotes: 0, status: 'pending' });

  await Notification.create({
    userId:  newUserId,
    type:    'tournament_jury_invite',
    payload: { tournamentId: tournament._id, tournamentName: tournament.name, openDeadline: tournament.openDeadline, url: '/tournament/' + tournament._id + '/jury-invite' },
  });

  res.json({ success: true });
});

module.exports = router;
