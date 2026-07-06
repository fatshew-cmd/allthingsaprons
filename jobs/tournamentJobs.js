const Tournament      = require('../models/Tournament');
const TournamentEntry = require('../models/TournamentEntry');
const TournamentGroup = require('../models/TournamentGroup');
const TournamentJury  = require('../models/TournamentJury');
const TournamentJuryVote = require('../models/TournamentJuryVote');
const TournamentMatch = require('../models/TournamentMatch');
const Contest         = require('../models/Contest');
const ContestVote     = require('../models/ContestVote');
const Notification    = require('../models/Notification');
const User            = require('../models/User');
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

// Kicks off the jury tie-break chain: notify accepted jurors (never revealing which entries
// are tied) and give them a 6h window to reach quorum before falling through to the organizer.
// `juryDeadline` is the same Date the caller already stamped onto TournamentMatch.tieDeadline —
// threaded through so the scheduled agenda job fires at exactly that instant, not a
// microseconds-later re-computation of "now + 6h".
async function initiateTieResolution(matchId, juryDeadline) {
  const match = await TournamentMatch.findById(matchId).select('tournamentId').lean();
  if (!match) return;

  const jurors = await TournamentJury.find({ tournamentId: match.tournamentId, status: 'accepted' })
    .select('userId').lean();

  const notifications = jurors.map(j => ({
    userId:  j.userId,
    type:    'tournament_tie_jury',
    payload: { tournamentId: match.tournamentId, matchId, url: '/tournament/' + match.tournamentId + '/jury-vote/' + matchId },
  }));
  if (notifications.length > 0) {
    await Notification.insertMany(notifications, { ordered: false }).catch(() => {});
  }

  // Stamped so tournamentJuryExpiry can tell "jurors were actually notified" apart from "the
  // process crashed before this point ran" — see its retry branch below.
  await TournamentMatch.updateOne({ _id: matchId }, { $set: { juryNotifiedAt: new Date() } });

  const agenda = require('./agenda');
  await agenda.schedule(juryDeadline, 'tournament_jury_expiry', {
    matchId: matchId.toString(),
  });
}

// Called from the jury-vote route once a match's votes reach quorum (3). Re-entrant-safe:
// the tieStatus: 'jury_pending' filter on the claiming update means only one concurrent
// caller (two jurors hitting quorum in the same instant) actually resolves the match.
// `votes` is an optional array of already-fetched TournamentJuryVote docs ({votedForEntryId})
// — the jury-vote route already fetches these to compute the per-contestant vote counts it
// notifies with, so it's threaded through to avoid a second identical query here.
async function resolveJuryVote(matchId, votes) {
  const match = await TournamentMatch.findById(matchId).select('tieStatus entryIdA entryIdB contestId').lean();
  if (!match || match.tieStatus !== 'jury_pending') return; // already resolved

  const juryVotes = votes || await TournamentJuryVote.find({ matchId }).select('votedForEntryId').lean();
  const counts = {};
  for (const vote of juryVotes) {
    const key = vote.votedForEntryId.toString();
    counts[key] = (counts[key] || 0) + 1;
  }
  const countA = counts[match.entryIdA.toString()] || 0;
  const countB = counts[match.entryIdB.toString()] || 0;

  let winnerEntryId = null;
  if (countA > countB) winnerEntryId = match.entryIdA;
  else if (countB > countA) winnerEntryId = match.entryIdB;
  else return; // still tied among jury (shouldn't happen at quorum 3) — let the 6h expiry hand off to the organizer

  const claimed = await TournamentMatch.findOneAndUpdate(
    { _id: matchId, tieStatus: 'jury_pending' },
    { $set: { tieStatus: 'resolved' } },
  );
  if (!claimed) return; // a concurrent vote already resolved this

  const agenda = require('./agenda');
  await agenda.cancel({ name: 'tournament_jury_expiry', 'data.matchId': matchId.toString() });

  await handleTournamentMatchClose(match.contestId, winnerEntryId);
}

// Fired (fire-and-forget) from jobs/contestJobs.js's closeContest whenever a closing
// Contest has a tournamentId. Records the result onto TournamentMatch/TournamentEntry.
// A tie hands off to the jury/organizer/coin-flip chain (initiateTieResolution below);
// this same function is called again with the eventual winner once that chain resolves.
// `voteCounts` is an optional { entryId: count } map — closeContest already computes this
// while determining the winner, so it's threaded through to avoid a second identical
// aggregate; callers without it handy (e.g. crash-recovery reconciliation) can omit it.
async function handleTournamentMatchClose(contestId, winnerEntryId, voteCounts) {
  const match = await TournamentMatch.findOne({ contestId });
  if (!match || match.status === 'closed') return;

  if (!winnerEntryId) {
    // Atomic claim: this same function can be invoked concurrently for one match — e.g. the
    // fire-and-forget call from contestJobs.js's closeContest racing sweeper.js's crash-recovery
    // reconciliation (which runs on every server restart) — so only the caller that actually
    // flips status → 'tie' initiates jury resolution. A concurrent loser just backs off here.
    const tieDeadline = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const claimed = await TournamentMatch.findOneAndUpdate(
      { _id: match._id, status: { $nin: ['tie', 'closed'] } },
      { $set: { status: 'tie', tieStatus: 'jury_pending', tieDeadline } },
    );
    if (!claimed) return;
    await initiateTieResolution(match._id, tieDeadline);
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
      console.warn(`[resolveGroup] group ${groupId} has an unresolvable ${cluster.length}-way boundary tie — the jury system only breaks match ties, not group-ranking ties beyond a 2-way boundary, so this is left unresolved.`);
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
// bracket round by round; 'Final'/'3rd' closing ends the tournament, handed off to
// closeTournament (which itself checks whether the tournament's full podium is actually
// decided yet, since Final and 3rd close independently and in either order).
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
    await closeTournament(match.tournamentId);
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

async function tournamentOpenExpiry(tournamentId) {
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
}

async function tournamentCooldownExpiry(tournamentId) {
  const tournament = await Tournament.findOne({ _id: tournamentId, status: 'cooldown' });
  if (!tournament) return; // already transitioned/canceled

  // Organizer must land on exactly `size` approved candidates during cooldown (no byes).
  const approvedCount = await TournamentEntry.countDocuments({ tournamentId: tournament._id, approvalStatus: 'approved' });
  if (approvedCount !== tournament.size) {
    await cancelTournament(tournament._id, 'cooldown_incomplete');
    return;
  }

  await activateTournament(tournament._id);
}

// 6h jury window expired without quorum (3 votes). Penalize non-voting accepted jurors
// with a missedVotes increment (closeTournament turns that into a permanent juryBanned flag
// once the tournament finishes) and hand off to the organizer for 3h.
async function tournamentJuryExpiry(matchId) {
  // If jurors were never actually notified — the process can crash between
  // handleTournamentMatchClose's atomic tieStatus claim and initiateTieResolution's notify
  // step — retry the jury phase from scratch instead of penalizing jurors for a vote they
  // were never asked to cast.
  const pendingMatch = await TournamentMatch.findOne({ _id: matchId, tieStatus: 'jury_pending' })
    .select('juryNotifiedAt').lean();
  if (pendingMatch && !pendingMatch.juryNotifiedAt) {
    const retryDeadline = new Date(Date.now() + 6 * 60 * 60 * 1000);
    await TournamentMatch.updateOne({ _id: matchId }, { $set: { tieDeadline: retryDeadline } });
    await initiateTieResolution(matchId, retryDeadline);
    return;
  }

  const organizerDeadline = new Date(Date.now() + 3 * 60 * 60 * 1000);

  // Atomic claim: a juror's vote can reach quorum (resolveJuryVote) at nearly the same
  // instant this 6h window elapses. Claiming jury_pending → organizer_pending here — before
  // any side effects — means only one of the two ever proceeds; the loser just returns,
  // instead of a losing `.save()` silently overwriting the winner's 'resolved' tieStatus.
  const match = await TournamentMatch.findOneAndUpdate(
    { _id: matchId, tieStatus: 'jury_pending' },
    { $set: { tieStatus: 'organizer_pending', tieDeadline: organizerDeadline } },
  );
  if (!match) return; // already resolved by quorum

  const allJurors = await TournamentJury.find({ tournamentId: match.tournamentId, status: 'accepted' })
    .select('_id userId').lean();
  const votedIds = await TournamentJuryVote.distinct('jurorId', { matchId: match._id });
  const votedSet = new Set(votedIds.map(id => id.toString()));

  const missedJuryIds = allJurors.filter(j => !votedSet.has(j.userId.toString())).map(j => j._id);
  if (missedJuryIds.length > 0) {
    await TournamentJury.updateMany({ _id: { $in: missedJuryIds } }, { $inc: { missedVotes: 1 } });
  }

  const tournament = await Tournament.findById(match.tournamentId).select('createdBy').lean();
  await Notification.create({
    userId:  tournament.createdBy,
    type:    'tournament_tie_organizer',
    payload: {
      tournamentId: match.tournamentId,
      matchId:      match._id,
      url:          '/tournament/' + match.tournamentId + '/organizer-vote/' + match._id,
    },
  });

  const agenda = require('./agenda');
  await agenda.schedule(organizerDeadline, 'tournament_organizer_vote_expiry', {
    matchId: matchId.toString(),
  });
}

// 3h organizer window expired without a decision — platform coin flip resolves so no tie
// can block progression more than 9h total (6h jury + 3h organizer).
async function tournamentOrganizerVoteExpiry(matchId) {
  const match = await TournamentMatch.findOne({ _id: matchId, tieStatus: 'organizer_pending' });
  if (!match) return; // organizer voted in time

  const claimed = await TournamentMatch.findOneAndUpdate(
    { _id: matchId, tieStatus: 'organizer_pending' },
    { $set: { tieStatus: 'resolved' } },
  );
  if (!claimed) return;

  const winnerId = Math.random() < 0.5 ? match.entryIdA : match.entryIdB;
  await handleTournamentMatchClose(match.contestId, winnerId);
}

// Credits 1st/2nd/3rd prizes, closes out the tournament, and bans jurors who missed a vote.
// Called speculatively whenever a Final or 3rd-place match closes (they close independently,
// in either order) and from the crash-recovery reconcile sweeper — the atomic status claim
// below means only the caller that actually sees the full podium decided proceeds.
async function closeTournament(tournamentId) {
  const tournament = await Tournament.findById(tournamentId).select('size prizes status').lean();
  if (!tournament || tournament.status === 'closed') return;

  const needsThird = tournament.size !== 4;
  const [finalMatch, thirdMatch] = await Promise.all([
    TournamentMatch.findOne({ tournamentId, knockoutRound: 'Final', status: 'closed' }).lean(),
    needsThird
      ? TournamentMatch.findOne({ tournamentId, knockoutRound: '3rd', status: 'closed' }).lean()
      : Promise.resolve(null),
  ]);
  if (!finalMatch) return; // podium not decided yet
  if (needsThird && !thirdMatch) return;

  // Atomic claim: Final and 3rd-place can each independently trigger this call (whichever
  // closes last), and the reconcile sweeper can too — only the caller that flips
  // status → 'closed' actually pays out and notifies; everyone else backs off.
  const claimed = await Tournament.findOneAndUpdate(
    { _id: tournamentId, status: { $ne: 'closed' } },
    { $set: { status: 'closed' } },
  );
  if (!claimed) return;

  const placements = [
    { tournamentEntryId: winnerTournamentEntryId(finalMatch), place: 1, prize: tournament.prizes.first },
    { tournamentEntryId: loserTournamentEntryId(finalMatch),  place: 2, prize: tournament.prizes.second },
  ];
  if (thirdMatch) {
    placements.push({ tournamentEntryId: winnerTournamentEntryId(thirdMatch), place: 3, prize: tournament.prizes.third });
  }

  // Single query for every approved participant — the 2-3 placement winners are always a
  // subset of this, so it also backs the userIdByTEId lookup below (no separate query needed).
  const allParticipants = await TournamentEntry.find({ tournamentId, approvalStatus: 'approved' })
    .select('userId').lean();
  const userIdByTEId = {};
  for (const e of allParticipants) userIdByTEId[e._id.toString()] = e.userId;

  // Each placement's payout is independent — isolate failures the same way closeContest's
  // per-beneficiary settlement does, so one bad credit (e.g. a transient WalletTransaction
  // write error) can't skip the remaining placements, the winnersSet flag, the participant
  // notifications, or the jury ban below. The tournament is already committed to 'closed' by
  // the atomic claim above, so silently aborting here would strand it with no retry path.
  for (const { tournamentEntryId, place, prize } of placements) {
    const userId = userIdByTEId[tournamentEntryId.toString()];
    if (!userId) continue;

    try {
      await creditWallet(userId, prize, {
        pool:          'earnedCHL',
        type:          'tournament_prize_payout',
        source:        'tournament_close',
        referenceId:   tournamentId,
        referenceType: 'Tournament',
      });

      await Notification.create({
        userId,
        type:    'tournament_prize_awarded',
        payload: { tournamentId, place, amountCHL: prize, url: '/tournament/' + tournamentId },
      });
    } catch (err) {
      console.error('[closeTournament] payout failed for place', place, 'tournament', tournamentId, ':', err.message);
    }
  }

  await Tournament.updateOne({ _id: tournamentId }, { $set: { 'prizes.winnersSet': true } });

  const closedNotifications = allParticipants.map(e => ({
    userId:  e.userId,
    type:    'tournament_closed',
    payload: { tournamentId, url: '/tournament/' + tournamentId },
  }));
  if (closedNotifications.length > 0) {
    await Notification.insertMany(closedNotifications, { ordered: false }).catch(() => {});
  }

  // Post-tournament jury ban: anyone who missed a vote during this tournament is permanently
  // barred from serving as jury again.
  const bannedJurors = await TournamentJury.find({ tournamentId, missedVotes: { $gt: 0 } })
    .select('userId').lean();
  if (bannedJurors.length > 0) {
    await User.updateMany(
      { _id: { $in: bannedJurors.map(j => j.userId) } },
      { $set: { juryBanned: true } },
    );
  }
}

function registerTournamentJobs(agenda) {
  agenda.define('tournament_open_expiry', async job => {
    await tournamentOpenExpiry(job.attrs.data.tournamentId);
  });

  agenda.define('tournament_cooldown_expiry', async job => {
    await tournamentCooldownExpiry(job.attrs.data.tournamentId);
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

  agenda.define('tournament_jury_expiry', async job => {
    await tournamentJuryExpiry(job.attrs.data.matchId);
  });

  agenda.define('tournament_organizer_vote_expiry', async job => {
    await tournamentOrganizerVoteExpiry(job.attrs.data.matchId);
  });
}

module.exports = {
  registerTournamentJobs, cancelTournament, transitionToCooldown, activateTournament, autoAcceptPendingJury, MIN_JURY,
  handleTournamentMatchClose, checkGroupComplete, resolveGroup, handleKnockoutMatchClose,
  initiateTieResolution, resolveJuryVote, closeTournament,
  tournamentOpenExpiry, tournamentCooldownExpiry, tournamentJuryExpiry, tournamentOrganizerVoteExpiry,
};
