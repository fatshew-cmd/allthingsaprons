const Tournament      = require('../models/Tournament');
const TournamentEntry = require('../models/TournamentEntry');
const TournamentGroup = require('../models/TournamentGroup');
const TournamentJury  = require('../models/TournamentJury');
const TournamentMatch = require('../models/TournamentMatch');
const Contest         = require('../models/Contest');
const ContestVote     = require('../models/ContestVote');
const Notification    = require('../models/Notification');
const { creditWallet } = require('../utils/wallet');
const notifyEntryLoopedIn = require('../utils/tournamentEntryLoop');

const MIN_JURY = 5;

async function autoAcceptPendingJury(tournamentId) {
  await TournamentJury.updateMany(
    { tournamentId, status: 'pending' },
    { $set: { status: 'accepted', respondedAt: new Date() } },
  );
}

async function cancelTournament(tournamentId, reason) {
  const tournament = await Tournament.findOneAndUpdate(
    { _id: tournamentId, status: { $in: ['open', 'cooldown'] } },
    { $set: { status: 'canceled', cancelReason: reason } },
  ).lean();

  if (!tournament) return; // already handled

  // Tournament never reached the point of jurors actually voting, so releasing them
  // outright (rather than marking declined/missed) is correct — no penalty is owed.
  await TournamentJury.deleteMany({ tournamentId });

  // Refund prize pool to organizer's purchasedCHL
  const total = tournament.prizes.first + tournament.prizes.second + (tournament.prizes.third || 0);

  await creditWallet(tournament.createdBy, total, {
    type:          'tournament_prize_refund',
    source:        'tournament_cancel',
    referenceId:   tournamentId,
    referenceType: 'Tournament',
  });

  // Notify organizer
  await Notification.create({
    userId:  tournament.createdBy,
    type:    'tournament_canceled',
    payload: { tournamentId, reason, url: '/tournament/' + tournamentId },
  });

  // Notify all approved + pending contestants
  const entries = await TournamentEntry.find({
    tournamentId,
    approvalStatus: { $in: ['approved', 'pending'] },
  }).select('userId').lean();

  const contestantNotifications = entries
    .filter(e => e.userId.toString() !== tournament.createdBy.toString())
    .map(e => ({
      userId:  e.userId,
      type:    'tournament_canceled',
      payload: { tournamentId, reason, url: '/tournaments' },
    }));

  if (contestantNotifications.length > 0) {
    await Notification.insertMany(contestantNotifications, { ordered: false });
  }
}

// Status-filtered so a concurrent job run / cap-reached route call can't double-activate.
async function activateTournament(tournamentId) {
  const tournament = await Tournament.findOneAndUpdate(
    { _id: tournamentId, status: 'cooldown' },
    { $set: { status: 'active', activeAt: new Date(), stage: 'group' } },
    { new: true },
  );
  if (!tournament) return; // already activated/canceled by a concurrent call

  const { generateGroups, generateGroupMatches } = require('../utils/tournamentScheduler');
  const groups = await generateGroups(tournament._id);
  for (const group of groups) {
    await generateGroupMatches(group._id);
  }

  const entries = await TournamentEntry.find({ tournamentId: tournament._id, approvalStatus: 'approved' })
    .select('userId').lean();
  const notifications = entries.map(e => ({
    userId:  e.userId,
    type:    'tournament_live',
    payload: { tournamentId: tournament._id, url: '/tournament/' + tournament._id },
  }));
  if (notifications.length > 0) {
    await Notification.insertMany(notifications, { ordered: false }).catch(() => {});
  }
}

async function transitionToCooldown(tournamentId) {
  const cooldownDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000); // now + 24h

  // Status-filtered so a concurrent/retried job run can't double-transition this tournament.
  const tournament = await Tournament.findOneAndUpdate(
    { _id: tournamentId, status: 'open' },
    { $set: { status: 'cooldown', cooldownDeadline } },
    { new: true, select: 'createdBy name' },
  ).lean();
  if (!tournament) return; // already transitioned/canceled by another run

  const agenda = require('./agenda');
  await agenda.schedule(cooldownDeadline, 'tournament_cooldown_expiry', {
    tournamentId: tournamentId.toString(),
  });

  await Notification.create({
    userId:  tournament.createdBy,
    type:    'tournament_cooldown_started',
    payload: { tournamentId, cooldownDeadline, url: '/tournament/' + tournamentId },
  });
}

async function getVoteCounts(contestId) {
  const agg = await ContestVote.aggregate([
    { $match: { contestId } },
    { $group: { _id: '$entryId', count: { $sum: 1 } } },
  ]);
  const counts = {};
  for (const row of agg) counts[row._id.toString()] = row.count;
  return counts;
}

// Fired (fire-and-forget) from jobs/contestJobs.js's closeContest whenever a closing
// Contest has a tournamentId. Records the result onto TournamentMatch/TournamentEntry.
// Knockout progression (Phase 6) and jury/organizer tie resolution (Phase 7) are not built
// yet — a tie is flagged and left for a future session; a knockout match close is a no-op
// beyond the win/loss bookkeeping below, since stage: 'knockout' never occurs until Phase 6.
// `voteCounts` is an optional { entryId: count } map — closeContest already computes this
// while determining the winner, so it's threaded through to avoid a second identical
// aggregate; callers without it handy (e.g. crash-recovery reconciliation) can omit it.
async function handleTournamentMatchClose(contestId, winnerEntryId, voteCounts) {
  const match = await TournamentMatch.findOne({ contestId });
  if (!match || match.status === 'closed') return;

  if (!winnerEntryId) {
    match.status    = 'tie';
    match.tieStatus = 'jury_pending';
    await match.save();
    return;
  }

  const winnerIsA     = match.entryIdA.toString() === winnerEntryId.toString();
  const winnerTEId    = winnerIsA ? match.tournamentEntryIdA : match.tournamentEntryIdB;
  const loserTEId     = winnerIsA ? match.tournamentEntryIdB : match.tournamentEntryIdA;
  const loserEntryId  = winnerIsA ? match.entryIdB : match.entryIdA;
  const isTiebreaker  = match.isTiebreakerMatch;

  match.status                 = 'closed';
  match.winnerId                = winnerEntryId;
  match.loserTournamentEntryId = loserTEId;
  await match.save();

  // A tiebreaker match only exists to break a group-ranking tie — it isn't a "real" round-
  // robin result, so it must not inflate wins/losses/groupPoints/totalVotes beyond what
  // regular-season play already produced (that inflation would also make the record shown
  // in the UI inconsistent with entries that didn't need a tiebreaker).
  if (!isTiebreaker) {
    const counts      = voteCounts || await getVoteCounts(contestId);
    const winnerVotes = counts[winnerEntryId.toString()] || 0;
    const loserVotes  = counts[loserEntryId.toString()] || 0;

    const winnerInc = { wins: 1, totalVotes: winnerVotes };
    if (match.stage === 'group') winnerInc.groupPoints = 1;

    await Promise.all([
      TournamentEntry.findByIdAndUpdate(winnerTEId, { $inc: winnerInc }),
      TournamentEntry.findByIdAndUpdate(loserTEId, { $inc: { losses: 1, totalVotes: loserVotes } }),
    ]);
  }

  if (match.stage === 'group') {
    await checkGroupComplete(match.groupId);
  } else if (match.stage === 'knockout') {
    await handleKnockoutMatchClose(match);
  }
}

// No group-existence guard here — resolveGroup's own atomic guard is the single source of
// truth for "already complete", so this just avoids the openCount query when possible.
async function checkGroupComplete(groupId) {
  const openCount = await TournamentMatch.countDocuments({
    groupId, stage: 'group', status: { $ne: 'closed' }, isTiebreakerMatch: false,
  });
  if (openCount > 0) return; // still waiting on regular-season matches (including any tie)

  await resolveGroup(groupId);
}

// A group-ranking tie between exactly two members that straddles the advance/eliminate
// boundary is settled with an ordinary extra H2H match (plan section 5E) — this doesn't
// need the jury system since it's just another vote, not a match-result dispute.
// Throws a MongoServerError (code 11000) if another concurrent resolveGroup call already
// created this group's tiebreaker match first — models/TournamentMatch.js has a partial
// unique index on { groupId } scoped to isTiebreakerMatch: true guaranteeing at most one.
// Callers should catch that error and treat it as "already handled", not a real failure.
async function createTiebreakerMatch(group, teIdA, teIdB) {
  const [teA, teB, tournament] = await Promise.all([
    TournamentEntry.findById(teIdA).select('entryId userId').populate('userId', 'username displayName').lean(),
    TournamentEntry.findById(teIdB).select('entryId userId').populate('userId', 'username displayName').lean(),
    Tournament.findById(group.tournamentId).select('createdBy').lean(),
  ]);

  const now            = new Date();
  const votingDeadline  = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const contest = await Contest.create({
    createdBy:      tournament.createdBy,
    visibility:     'public',
    tournamentId:   group.tournamentId,
    status:         'active',
    windowHours:    24,
    votingDeadline,
    entries: [
      { entryId: teA.entryId, userId: teA.userId._id, submittedAt: now },
      { entryId: teB.entryId, userId: teB.userId._id, submittedAt: now },
    ],
    lastActivityAt: now,
  });

  const match = await TournamentMatch.create({
    tournamentId:       group.tournamentId,
    contestId:          contest._id,
    stage:              'group',
    groupId:            group._id,
    isTiebreakerMatch:  true,
    entryIdA:           teA.entryId,
    entryIdB:           teB.entryId,
    tournamentEntryIdA: teA._id,
    tournamentEntryIdB: teB._id,
    status:             'active',
    scheduledAt:        now,
    openedAt:           now,
  });
  // No explicit close_contest scheduling — the existing 15-min sweeper picks up any active
  // contest nearing its votingDeadline, same as every other tournament match.

  await notifyEntryLoopedIn([
    { tournamentEntryId: teA._id, type: 'tournament_entry_match_live', payload: {
        tournamentId: group.tournamentId, tournamentEntryId: teA._id, matchId: match._id, contestId: contest._id,
        opponentUsername: teB.userId.username?.value, opponentDisplayName: teB.userId.displayName?.value || teB.userId.username?.value,
        url: '/contest/' + contest._id,
    } },
    { tournamentEntryId: teB._id, type: 'tournament_entry_match_live', payload: {
        tournamentId: group.tournamentId, tournamentEntryId: teB._id, matchId: match._id, contestId: contest._id,
        opponentUsername: teA.userId.username?.value, opponentDisplayName: teA.userId.displayName?.value || teA.userId.username?.value,
        url: '/contest/' + contest._id,
    } },
  ], [teA.userId._id, teB.userId._id]);
}

// Re-entrant: safe to call again once a tiebreaker match it created closes.
async function resolveGroup(groupId) {
  const group = await TournamentGroup.findById(groupId);
  if (!group || group.status === 'complete') return;

  // A still-open (or tied) tiebreaker match means this group is paused, waiting on it.
  const pendingTiebreaker = await TournamentMatch.findOne({
    groupId, isTiebreakerMatch: true, status: { $ne: 'closed' },
  }).lean();
  if (pendingTiebreaker) return;

  const members = await TournamentEntry.find({ _id: { $in: group.memberIds } })
    .populate('entryId', 'ratingAvg ratingCount')
    .lean();

  const closedGroupMatches = await TournamentMatch.find({
    groupId, stage: 'group', status: 'closed', isTiebreakerMatch: false,
  }).select('contestId').lean();

  const contestIds = closedGroupMatches.map(m => m.contestId);
  const voteAgg = contestIds.length
    ? await ContestVote.aggregate([
        { $match: { contestId: { $in: contestIds } } },
        { $group: { _id: '$entryId', count: { $sum: 1 } } },
      ])
    : [];
  const votesByEntry = {};
  for (const row of voteAgg) votesByEntry[row._id.toString()] = row.count;

  const ranked = members.map(m => ({
    id:                m._id.toString(),
    userId:            m.userId,
    groupPoints:       m.groupPoints || 0,
    ratingAvg:         m.entryId?.ratingAvg || 0,
    ratingCount:       m.entryId?.ratingCount || 0,
    totalVotesInGroup: votesByEntry[m.entryId?._id?.toString()] || 0,
  }));

  ranked.sort((a, b) =>
    b.groupPoints - a.groupPoints ||
    b.ratingAvg - a.ratingAvg ||
    b.ratingCount - a.ratingCount ||
    b.totalVotesInGroup - a.totalVotesInGroup,
  );

  function sameOnAllCriteria(a, b) {
    return a.groupPoints === b.groupPoints &&
           a.ratingAvg === b.ratingAvg &&
           a.ratingCount === b.ratingCount &&
           a.totalVotesInGroup === b.totalVotesInGroup;
  }

  const ADVANCE_COUNT = 2;
  const boundaryA = ranked[ADVANCE_COUNT - 1];
  const boundaryB = ranked[ADVANCE_COUNT];

  if (boundaryB && sameOnAllCriteria(boundaryA, boundaryB)) {
    const cluster = ranked.filter(r => sameOnAllCriteria(r, boundaryA));

    if (cluster.length === 2) {
      const key      = cluster.map(c => c.id).sort().join('_');
      const tbMatch  = await TournamentMatch.findOne({
        groupId, isTiebreakerMatch: true, status: 'closed',
      }).lean();
      const tbWinner = tbMatch && [tbMatch.tournamentEntryIdA.toString(), tbMatch.tournamentEntryIdB.toString()].sort().join('_') === key
        ? (tbMatch.entryIdA.toString() === tbMatch.winnerId?.toString() ? tbMatch.tournamentEntryIdA : tbMatch.tournamentEntryIdB).toString()
        : null;

      if (!tbWinner) {
        try {
          await createTiebreakerMatch(group, cluster[0].id, cluster[1].id);
        } catch (err) {
          // Another concurrent resolveGroup call for this same group already created it
          // (partial unique index on TournamentMatch enforces at most one per group) —
          // that call is handling the pause, so just back off here too.
          if (err.code !== 11000) throw err;
        }
        return; // paused until the tiebreaker match closes
      }

      const winnerEntry = cluster.find(c => c.id === tbWinner);
      const loserEntry   = cluster.find(c => c.id !== tbWinner);
      ranked[ADVANCE_COUNT - 1] = winnerEntry;
      ranked[ADVANCE_COUNT]     = loserEntry;
    } else {
      console.warn(`[resolveGroup] group ${groupId} has an unresolvable ${cluster.length}-way boundary tie — leaving unresolved (Phase 7 not built yet).`);
      return;
    }
  }

  // Atomically claim finalization: round-robin matches within one round share an identical
  // votingDeadline, so multiple matches in this group can close (and re-enter resolveGroup)
  // within the same sweep. Only the call that wins this race writes results/notifications;
  // a concurrent loser sees status already flipped and backs off.
  const claimed = await TournamentGroup.findOneAndUpdate(
    { _id: groupId, status: { $ne: 'complete' } },
    { $set: { status: 'complete' } },
  );
  if (!claimed) return;

  const advancing  = ranked.slice(0, ADVANCE_COUNT);
  const eliminated = ranked.slice(ADVANCE_COUNT);

  await Promise.all([
    ...advancing.map((r, i) => TournamentEntry.findByIdAndUpdate(r.id, { $set: { groupRank: i + 1 } })),
    ...eliminated.map(r => TournamentEntry.findByIdAndUpdate(r.id, { $set: { eliminated: true } })),
  ]);

  const notifications = [
    ...advancing.map(r => ({
      userId:  r.userId,
      type:    'tournament_group_advance',
      payload: { tournamentId: group.tournamentId, url: '/tournament/' + group.tournamentId },
    })),
    ...eliminated.map(r => ({
      userId:  r.userId,
      type:    'tournament_eliminated',
      payload: { tournamentId: group.tournamentId, url: '/tournament/' + group.tournamentId },
    })),
  ];
  await Notification.insertMany(notifications, { ordered: false }).catch(() => {});

  const incompleteGroups = await TournamentGroup.countDocuments({
    tournamentId: group.tournamentId, status: { $ne: 'complete' },
  });
  if (incompleteGroups === 0) {
    const { generateKnockoutBracket } = require('../utils/tournamentScheduler');
    await generateKnockoutBracket(group.tournamentId);
  }
}

const KNOCKOUT_NEXT_ROUND = { R16: 'QF', QF: 'SF' };

// Creates the next knockout-stage Contest + TournamentMatch for two advancing TournamentEntry
// ids — same shape as createTiebreakerMatch above, opened immediately (no deferred scheduling,
// since every knockout round opens as soon as the previous one fully resolves).
async function createBracketMatch(tournamentId, teIdA, teIdB, round) {
  const [teA, teB, tournament] = await Promise.all([
    TournamentEntry.findById(teIdA).select('entryId userId').populate('userId', 'username displayName').lean(),
    TournamentEntry.findById(teIdB).select('entryId userId').populate('userId', 'username displayName').lean(),
    Tournament.findById(tournamentId).select('createdBy').lean(),
  ]);

  const now            = new Date();
  const votingDeadline  = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const contest = await Contest.create({
    createdBy:      tournament.createdBy,
    visibility:     'public',
    tournamentId,
    status:         'active',
    windowHours:    24,
    votingDeadline,
    entries: [
      { entryId: teA.entryId, userId: teA.userId._id, submittedAt: now },
      { entryId: teB.entryId, userId: teB.userId._id, submittedAt: now },
    ],
    lastActivityAt: now,
  });

  const match = await TournamentMatch.create({
    tournamentId,
    contestId:          contest._id,
    stage:              'knockout',
    knockoutRound:       round,
    entryIdA:           teA.entryId,
    entryIdB:           teB.entryId,
    tournamentEntryIdA: teA._id,
    tournamentEntryIdB: teB._id,
    status:             'active',
    scheduledAt:        now,
    openedAt:           now,
  });

  const agenda = require('./agenda');
  await Promise.all([
    agenda.schedule(votingDeadline, 'close_contest', { contestId: contest._id.toString() }),
    TournamentEntry.updateMany(
      { _id: { $in: [teA._id, teB._id] } },
      { $set: { knockoutRound: round } },
    ),
  ]);

  await notifyEntryLoopedIn([
    { tournamentEntryId: teA._id, type: 'tournament_entry_match_live', payload: {
        tournamentId, tournamentEntryId: teA._id, matchId: match._id, contestId: contest._id,
        opponentUsername: teB.userId.username?.value, opponentDisplayName: teB.userId.displayName?.value || teB.userId.username?.value,
        url: '/contest/' + contest._id,
    } },
    { tournamentEntryId: teB._id, type: 'tournament_entry_match_live', payload: {
        tournamentId, tournamentEntryId: teB._id, matchId: match._id, contestId: contest._id,
        opponentUsername: teA.userId.username?.value, opponentDisplayName: teA.userId.displayName?.value || teA.userId.username?.value,
        url: '/contest/' + contest._id,
    } },
  ], [teA.userId._id, teB.userId._id]);

  return match;
}

function winnerTournamentEntryId(m) {
  return m.entryIdA.toString() === m.winnerId.toString() ? m.tournamentEntryIdA : m.tournamentEntryIdB;
}
function loserTournamentEntryId(m) {
  return m.entryIdA.toString() === m.winnerId.toString() ? m.tournamentEntryIdB : m.tournamentEntryIdA;
}

// Fired from handleTournamentMatchClose once a knockout-stage match closes. Progresses the
// bracket round by round; 'Final'/'3rd' closing ends the tournament, but prize payout /
// closing (Phase 8, closeTournament) isn't built yet, so that's a no-op beyond bookkeeping.
async function handleKnockoutMatchClose(match) {
  const winnerTEId = winnerTournamentEntryId(match);
  const loserTEId  = loserTournamentEntryId(match);

  // An SF loser still has a 3rd-place match to play — not actually eliminated yet. Every
  // other round's loser (R16/QF/Final/3rd) has no more matches, so mark + notify them now.
  // (routes/pages.js's prize-placement logic depends on the 3rd-place winner's `eliminated`
  // staying false the whole way through, which only holds if SF losers aren't flagged here.)
  if (match.knockoutRound === 'SF') {
    await TournamentEntry.findByIdAndUpdate(loserTEId, { $set: { knockoutRound: match.knockoutRound } });
  } else {
    const loserEntry = await TournamentEntry.findByIdAndUpdate(
      loserTEId,
      { $set: { eliminated: true, knockoutRound: match.knockoutRound } },
      { new: true },
    ).select('userId').lean();
    await Notification.create({
      userId:  loserEntry.userId,
      type:    'tournament_eliminated',
      payload: { tournamentId: match.tournamentId, url: '/tournament/' + match.tournamentId },
    }).catch(() => {});
  }

  await TournamentEntry.findByIdAndUpdate(winnerTEId, { $set: { knockoutRound: match.knockoutRound } });

  if (match.knockoutRound === 'Final' || match.knockoutRound === '3rd') {
    // Tournament ends here (Phase 8's closeTournament isn't built yet — no prize payout,
    // no status transition to 'closed'; the tournament just stops progressing).
    return;
  }

  if (match.knockoutRound === 'SF') {
    const stillOpen = await TournamentMatch.countDocuments({
      tournamentId: match.tournamentId, knockoutRound: 'SF', status: { $ne: 'closed' },
    });
    if (stillOpen > 0) return; // waiting on the other semifinal

    // Atomic claim: both SF matches can close in the same sweep, so only the call that wins
    // this race fans out to Final/3rd; the other backs off.
    const claimed = await Tournament.findOneAndUpdate(
      { _id: match.tournamentId, lastKnockoutRoundAdvanced: { $ne: 'SF' } },
      { $set: { lastKnockoutRoundAdvanced: 'SF', stage: 'finale' } },
    );
    if (!claimed) return;

    const sfMatches = await TournamentMatch.find({
      tournamentId: match.tournamentId, knockoutRound: 'SF', status: 'closed',
    }).sort({ createdAt: 1 }).lean();
    if (sfMatches.length < 2) return; // shouldn't happen, but don't fan out on a partial read

    const winners = sfMatches.map(winnerTournamentEntryId);
    const losers  = sfMatches.map(loserTournamentEntryId);

    await createBracketMatch(match.tournamentId, winners[0], winners[1], 'Final');
    await createBracketMatch(match.tournamentId, losers[0], losers[1], '3rd');
    return;
  }

  const nextRound = KNOCKOUT_NEXT_ROUND[match.knockoutRound];
  if (!nextRound) return; // unrecognized round — nothing to advance to

  const stillOpen = await TournamentMatch.countDocuments({
    tournamentId: match.tournamentId, knockoutRound: match.knockoutRound, status: { $ne: 'closed' },
  });
  if (stillOpen > 0) return; // other matches in this round still in progress

  // Atomic claim: same race as above, one round earlier (R16 → QF or QF → SF).
  const claimed = await Tournament.findOneAndUpdate(
    { _id: match.tournamentId, lastKnockoutRoundAdvanced: { $ne: match.knockoutRound } },
    { $set: { lastKnockoutRoundAdvanced: match.knockoutRound } },
  );
  if (!claimed) return;

  const closedMatches = await TournamentMatch.find({
    tournamentId: match.tournamentId, knockoutRound: match.knockoutRound, status: 'closed',
  }).sort({ createdAt: 1 }).lean();

  const winners = closedMatches.map(winnerTournamentEntryId);
  for (let i = 0; i < winners.length; i += 2) {
    await createBracketMatch(match.tournamentId, winners[i], winners[i + 1], nextRound);
  }
}

function registerTournamentJobs(agenda) {
  agenda.define('tournament_open_expiry', async job => {
    const { tournamentId } = job.attrs.data;
    const tournament = await Tournament.findOne({ _id: tournamentId, status: 'open' });
    if (!tournament) return; // already transitioned

    // Anyone who never responded to their jury invite is auto-accepted.
    await autoAcceptPendingJury(tournamentId);

    const acceptedJuryCount = await TournamentJury.countDocuments({ tournamentId, status: 'accepted' });
    if (acceptedJuryCount < MIN_JURY) {
      await cancelTournament(tournamentId, 'insufficient_jury');
      return;
    }

    // Organizer review (approve/reject) happens during cooldown, not open — nothing
    // is 'approved' yet at this point, so gate on how many candidates submitted at all.
    const submittedCount = await TournamentEntry.countDocuments({ tournamentId: tournament._id });

    if (submittedCount < tournament.size) {
      await cancelTournament(tournament._id, 'insufficient_candidates');
      return;
    }

    await transitionToCooldown(tournament._id);
  });

  agenda.define('tournament_cooldown_expiry', async job => {
    const { tournamentId } = job.attrs.data;
    const tournament = await Tournament.findOne({ _id: tournamentId, status: 'cooldown' });
    if (!tournament) return; // already transitioned/canceled

    // Organizer must land on exactly `size` approved candidates during cooldown (no byes).
    const approvedCount = await TournamentEntry.countDocuments({ tournamentId: tournament._id, approvalStatus: 'approved' });
    if (approvedCount !== tournament.size) {
      await cancelTournament(tournament._id, 'cooldown_incomplete');
      return;
    }

    await activateTournament(tournament._id);
  });

  agenda.define('open_tournament_match', async job => {
    const { matchId } = job.attrs.data;
    const match = await TournamentMatch.findOneAndUpdate(
      { _id: matchId, status: 'scheduled' },
      { $set: { status: 'active', openedAt: new Date() } },
    );
    if (!match) return; // already opened/handled

    const votingDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await Contest.findByIdAndUpdate(match.contestId, { $set: { status: 'active', votingDeadline } });
    // No explicit close_contest scheduling — the existing 15-min sweeper (jobs/sweeper.js)
    // picks up any active contest nearing its votingDeadline, same as every other contest.

    const [entryA, entryB] = await Promise.all([
      TournamentEntry.findById(match.tournamentEntryIdA).populate('userId', 'username displayName').lean(),
      TournamentEntry.findById(match.tournamentEntryIdB).populate('userId', 'username displayName').lean(),
    ]);
    await notifyEntryLoopedIn([
      { tournamentEntryId: match.tournamentEntryIdA, type: 'tournament_entry_match_live', payload: {
          tournamentId: match.tournamentId, tournamentEntryId: match.tournamentEntryIdA, matchId: match._id, contestId: match.contestId,
          opponentUsername: entryB.userId.username?.value, opponentDisplayName: entryB.userId.displayName?.value || entryB.userId.username?.value,
          url: '/contest/' + match.contestId,
      } },
      { tournamentEntryId: match.tournamentEntryIdB, type: 'tournament_entry_match_live', payload: {
          tournamentId: match.tournamentId, tournamentEntryId: match.tournamentEntryIdB, matchId: match._id, contestId: match.contestId,
          opponentUsername: entryA.userId.username?.value, opponentDisplayName: entryA.userId.displayName?.value || entryA.userId.username?.value,
          url: '/contest/' + match.contestId,
      } },
    ], [entryA.userId._id, entryB.userId._id]);
  });
}

module.exports = {
  registerTournamentJobs, cancelTournament, transitionToCooldown, activateTournament, autoAcceptPendingJury, MIN_JURY,
  handleTournamentMatchClose, checkGroupComplete, resolveGroup, handleKnockoutMatchClose,
};
