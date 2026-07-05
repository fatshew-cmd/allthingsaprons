const Tournament      = require('../models/Tournament');
const TournamentJury  = require('../models/TournamentJury');
const TournamentEntry = require('../models/TournamentEntry');
const Notification    = require('../models/Notification');
const User            = require('../models/User');
const estimateParticipantPool = require('./estimateParticipantPool');

// Pre-upload eligibility check — run before a candidate is sent to the upload page for a given
// tournament, so they never waste an upload only to be told at submit-time that they don't
// qualify. No entry exists yet, so only profile-level gates/criteria are checked (every
// eligibility criteria field is profile-level — see estimateParticipantPool.js).
async function checkTournamentPreflight(tournament, userId) {
  if (tournament.status !== 'open') {
    return { eligible: false, reason: 'This tournament is no longer accepting candidates.' };
  }
  if (tournament.createdBy.toString() === userId.toString()) {
    return { eligible: false, reason: 'Organizers cannot enter their own tournament.' };
  }

  const isJuror = await TournamentJury.exists({ tournamentId: tournament._id, userId });
  if (isJuror) {
    return { eligible: false, reason: 'Jury members cannot enter the tournament they are serving on.' };
  }

  const user = await User.findById(userId).select('idVerified').lean();
  if (!user?.idVerified) {
    return { eligible: false, reason: 'Identity verification is required to enter a tournament.' };
  }

  const alreadySubmitted = await TournamentEntry.exists({ tournamentId: tournament._id, userId });
  if (alreadySubmitted) {
    return { eligible: false, reason: 'You have already submitted an entry to this tournament.' };
  }

  const { eligible, failedCriteria } = await estimateParticipantPool.evaluateTournamentCriteria(
    userId, null, tournament.createdBy, tournament.eligibilityCriteria,
  );
  if (!eligible) {
    return { eligible: false, reason: 'You do not meet this tournament\'s eligibility criteria.', failedCriteria };
  }

  return { eligible: true };
}

// Every tournament candidate is submitted at the moment its entry is uploaded — there is no
// "pick one of your existing entries" flow. This one function is the single place that decision
// is enforced, called either when the uploader explicitly targets a tournament at upload time,
// or when a freshly uploaded entry's stain matches one of a tournament's wildcardStains (auto-draft).
//
// Returns { success, reason } instead of throwing — the explicit-choice caller surfaces `reason`
// to the user, the auto-draft caller just skips silently on failure.
async function submitEntryToTournament({ tournament, entry, actor, autoSubmitted }) {
  if (tournament.status !== 'open') {
    return { success: false, reason: 'This tournament is no longer accepting candidates.' };
  }
  if (tournament.createdBy.toString() === actor._id.toString()) {
    return { success: false, reason: 'Organizers cannot enter their own tournament.' };
  }

  const isJuror = await TournamentJury.exists({ tournamentId: tournament._id, userId: actor._id });
  if (isJuror) {
    return { success: false, reason: 'Jury members cannot enter the tournament they are serving on.' };
  }

  if (!actor.idVerified) {
    return { success: false, reason: 'Identity verification is required to enter a tournament.' };
  }

  const alreadySubmitted = await TournamentEntry.exists({ tournamentId: tournament._id, userId: actor._id });
  if (alreadySubmitted) {
    return { success: false, reason: 'You have already submitted an entry to this tournament.' };
  }

  const { eligible, failedCriteria } = await estimateParticipantPool.evaluateTournamentCriteria(
    actor._id, entry._id, tournament.createdBy, tournament.eligibilityCriteria,
  );
  if (!eligible) {
    return { success: false, reason: 'Your entry does not meet the eligibility criteria.', failedCriteria };
  }

  const approvedCount = await TournamentEntry.countDocuments({ tournamentId: tournament._id, approvalStatus: 'approved' });
  if (approvedCount >= tournament.size) {
    return { success: false, reason: 'This tournament is already full.' };
  }

  await TournamentEntry.create({
    tournamentId:   tournament._id,
    entryId:        entry._id,
    userId:         actor._id,
    approvalStatus: 'pending',
    submittedAt:    new Date(),
    autoSubmitted:  !!autoSubmitted,
  });

  await Notification.create({
    userId:  tournament.createdBy,
    type:    'tournament_entry_submitted',
    payload: {
      actorUsername:    actor.username?.value    || 'Someone',
      actorDisplayName: actor.displayName?.value || actor.username?.value || 'Someone',
      actorAvatar:      actor.avatar?.value      || null,
      tournamentId:     tournament._id,
      tournamentName:   tournament.name,
      entryId:          entry._id,
      entryUrl:         entry.mediaUrl,
      entryType:        entry.mediaType,
      url:              '/tournament/' + tournament._id + '/review',
    },
  });

  return { success: true };
}

// Called right after a brand-new entry is created. Any open tournament whose wildcardStains
// overlaps one of the entry's tags gets an automatic submission — the same gates as an explicit
// submission apply (organizer/juror exclusion, idVerified, criteria, cap), just triggered by the
// tag instead of a user action. Failures are swallowed per-tournament; this must never affect
// the entry-creation response.
async function attemptTournamentAutoDraft(entry, actor) {
  if (!entry.tags?.length) return;

  const tournaments = await Tournament.find({
    status: 'open',
    wildcardStains: { $in: entry.tags },
    createdBy: { $ne: actor._id },
  }).lean();

  for (const tournament of tournaments) {
    try {
      await submitEntryToTournament({ tournament, entry, actor, autoSubmitted: true });
    } catch {
      // best-effort — an auto-draft failure must never surface to the uploader
    }
  }
}

module.exports = { submitEntryToTournament, checkTournamentPreflight, attemptTournamentAutoDraft };
