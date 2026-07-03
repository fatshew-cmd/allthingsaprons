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
const WalletTransaction           = require('../models/WalletTransaction');
const requireAuth                 = require('../middleware/requireAuth');
const requireApproved             = require('../middleware/requireApproved');
const requireOrganizerEligibility = require('../middleware/requireOrganizerEligibility');
const upload                      = require('../middleware/upload');

const EXCHANGE_RATE = 0.20;

const GROUP_CONFIG = {
  4:  { groupSize: 4, groupCount: 1 },
  8:  { groupSize: 4, groupCount: 2 },
  12: { groupSize: 3, groupCount: 4 },
  16: { groupSize: 4, groupCount: 4 },
  24: { groupSize: 3, groupCount: 8 },
};

const CRITERIA_FIELDS   = ['ratingAvg', 'ratingCount', 'followerCount', 'age', 'sex', 'entryCount', 'accountAgeDays'];
const CRITERIA_OPERATORS = ['gte', 'lte', 'eq'];

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
router.get('/tournaments/create', requireOrganizerEligibility, (req, res) => {
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
router.post('/tournaments/create/step1', requireOrganizerEligibility, upload.tournament.single('thumbnail'), async (req, res) => {
  const name        = (req.body.name || '').trim();
  const description = (req.body.description || '').trim();
  const size        = parseInt(req.body.size, 10);
  const openDays    = parseInt(req.body.openDays, 10);
  const visibility  = req.body.visibility === 'private' ? 'private' : 'public';

  const thumbnailUrl = req.file
    ? '/uploads/tournaments/' + req.file.filename
    : req.body.removeThumbnail === '1'
      ? null
      : (req.session.tournamentDraft?.thumbnailUrl || null);

  if (req.body.intent === 'draft') {
    req.session.tournamentDraft = {
      ...(req.session.tournamentDraft || {}),
      name, description, thumbnailUrl, visibility,
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
      formData: { name, description, size: req.body.size, openDays: req.body.openDays, thumbnailUrl, visibility },
    });
  }

  const maxStep = Math.max(2, req.session.tournamentDraft?.maxStep || 1);
  req.session.tournamentDraft = {
    ...(req.session.tournamentDraft || {}),
    name, description, size, openDays, thumbnailUrl, visibility,
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
router.post('/tournaments/fund', requireOrganizerEligibility, async (req, res) => {
  if (!req.session.tournamentDraft) return res.redirect('/tournaments/create');

  const amountCHL = parseInt(req.body.amountCHL, 10);
  if (!amountCHL || amountCHL <= 0 || amountCHL > 500) {
    return res.redirect('/tournaments/create/step2');
  }

  const userId = req.currentUser._id;
  const updatedUser = await User.findByIdAndUpdate(
    userId,
    { $inc: { 'wallet.purchasedCHL': amountCHL }, $set: { 'wallet.updatedAt': new Date() } },
    { new: true, select: 'wallet' },
  );

  const balanceAfter  = (updatedUser.wallet.purchasedCHL || 0) + (updatedUser.wallet.earnedCHL || 0);
  const balanceBefore = balanceAfter - amountCHL;

  await WalletTransaction.create({
    userId,
    type:          'top_up',
    direction:     'credit',
    amountCHL,
    amountUSD:     +(amountCHL * EXCHANGE_RATE).toFixed(2),
    exchangeRate:  EXCHANGE_RATE,
    balanceBefore,
    balanceAfter,
    status:        'completed',
    source:        'tournament_fund',
    referenceType: 'Tournament',
  });

  res.redirect('/tournaments/create/step2');
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
      if (c.operator !== 'eq' || !['M', 'F', 'NB'].includes(c.value)) {
        errors.push('Sex criteria must use "eq" with value M, F, or NB.');
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
  const users = await User.find({ _id: { $in: userIds } }).select('username displayName').lean();
  return users.map(u => ({
    _id:         u._id,
    username:    u.username?.value || '',
    displayName: u.displayName?.value || u.username?.value || '',
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

// ── POST /tournaments/create/step4 — finalize ──────────────────────────────
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

  try {
    const tournament = await finalizeTournamentCreation(req);
    delete req.session.tournamentDraft;
    res.redirect(`/tournament/${tournament._id}?flash=${encodeURIComponent('Your tournament is live and accepting candidates.')}`);
  } catch (err) {
    res.render('tournaments/create', {
      title: 'Create Tournament', activePage: 'tournaments', currentUser: req.currentUser,
      step: 4, maxStep, errors: [err.message || 'Something went wrong creating your tournament.'], existingJury: await loadExistingJury(juryUserIds),
    });
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
    eligibilityCriteria: draft.eligibilityCriteria,
    prizes: { first: draft.prizes.first, second: draft.prizes.second, third: draft.prizes.third, funded: true },
    status: 'open',
    openDeadline,
  });

  const balanceAfter  = (updatedUser.wallet.purchasedCHL || 0) + (updatedUser.wallet.earnedCHL || 0);
  const balanceBefore = balanceAfter + totalPrize;

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
    TournamentJury.insertMany(draft.juryUserIds.map(uid => ({ tournamentId: tournament._id, userId: uid, missedVotes: 0 }))),
    agenda.schedule(openDeadline, 'tournament_open_expiry', { tournamentId: tournament._id.toString() }),
  ]);

  return tournament;
}

// ── GET /tournament/:id — detail ───────────────────────────────────────────
router.get('/tournament/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.redirect('/tournaments');

  const tournament = await Tournament.findById(req.params.id).populate('createdBy', 'username displayName avatar').lean();
  if (!tournament) return res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser });

  const [groups, entries, matches, userEntry, pendingCount] = await Promise.all([
    TournamentGroup.find({ tournamentId: tournament._id }).lean(),
    TournamentEntry.find({ tournamentId: tournament._id, approvalStatus: 'approved' })
      .populate('entryId')
      .populate('userId', 'username displayName avatar')
      .lean(),
    TournamentMatch.find({ tournamentId: tournament._id }).populate('contestId').lean(),
    TournamentEntry.findOne({ tournamentId: tournament._id, userId: req.currentUser._id }).lean(),
    tournament.status === 'open'
      ? TournamentEntry.countDocuments({ tournamentId: tournament._id, approvalStatus: 'pending' })
      : 0,
  ]);

  const isOrganizer = !!tournament.createdBy && tournament.createdBy._id.toString() === req.currentUser._id.toString();

  res.render('tournaments/detail', {
    title:      tournament.name,
    activePage: 'tournaments',
    currentUser: req.currentUser,
    tournament, groups, entries, matches, userEntry, isOrganizer, pendingCount,
    flash: req.query.flash || null,
  });
});

// ── GET /tournament/:id/review — organizer candidate review ────────────────
router.get('/tournament/:id/review', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.redirect('/tournaments');

  const tournament = await Tournament.findById(req.params.id).lean();
  if (!tournament) return res.status(404).render('404', { title: 'Not Found', currentUser: req.currentUser });
  if (!tournament.createdBy || tournament.createdBy.toString() !== req.currentUser._id.toString()) {
    return res.status(403).render('404', { title: 'Not Found', currentUser: req.currentUser });
  }

  const pendingEntries = await TournamentEntry.find({ tournamentId: tournament._id, approvalStatus: 'pending' })
    .populate({ path: 'entryId', select: 'title mediaType mediaUrl ratingAvg ratingCount' })
    .populate('userId', 'username displayName avatar')
    .lean();

  res.render('tournaments/review', {
    title:      'Review Candidates',
    activePage: 'tournaments',
    currentUser: req.currentUser,
    tournament, pendingEntries,
  });
});

// ── GET /tournament/:id/jury-vote/:matchId — juror tie-break vote page ─────
router.get('/tournament/:id/jury-vote/:matchId', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.matchId)) {
    return res.redirect('/tournaments');
  }

  const [tournament, jurorRecord] = await Promise.all([
    Tournament.findById(req.params.id).lean(),
    TournamentJury.findOne({ tournamentId: req.params.id, userId: req.currentUser._id }).lean(),
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

module.exports = router;
