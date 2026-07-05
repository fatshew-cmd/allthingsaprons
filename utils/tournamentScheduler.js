const Tournament      = require('../models/Tournament');
const TournamentEntry  = require('../models/TournamentEntry');
const TournamentGroup  = require('../models/TournamentGroup');
const TournamentMatch  = require('../models/TournamentMatch');
const Contest          = require('../models/Contest');
const notifyEntryLoopedIn = require('./tournamentEntryLoop');

const DAY_MS = 24 * 60 * 60 * 1000;

async function generateGroups(tournamentId) {
  const tournament = await Tournament.findById(tournamentId).select('groupSize').lean();
  const entries = await TournamentEntry.find({ tournamentId, approvalStatus: 'approved' }).select('_id').lean();

  const shuffled = entries.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const chunks = [];
  for (let i = 0; i < shuffled.length; i += tournament.groupSize) {
    chunks.push(shuffled.slice(i, i + tournament.groupSize));
  }

  const groups = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const group = await TournamentGroup.create({
      tournamentId,
      label:     String.fromCharCode(65 + i),
      memberIds: chunk.map(e => e._id),
      status:    'active',
    });
    await TournamentEntry.updateMany(
      { _id: { $in: chunk.map(e => e._id) } },
      { $set: { groupId: group._id } },
    );
    groups.push(group);
  }

  return groups;
}

// Standard round-robin "circle method": fixes one player and rotates the rest, guaranteeing
// the minimum possible number of rounds (n-1 for even n) with nobody double-booked in a round.
// Odd-length input gets a padded "bye" seat; pairs involving it are dropped.
function circleMethodRounds(players) {
  const list = players.slice();
  if (list.length % 2 === 1) list.push(null);
  const n = list.length;
  const fixed = list[0];
  let rotating = list.slice(1);
  const rounds = [];

  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    const first = [fixed, rotating[0]];
    if (first[0] !== null && first[1] !== null) pairs.push(first);
    for (let i = 1; i < n / 2; i++) {
      const a = rotating[i], b = rotating[n - 1 - i];
      if (a !== null && b !== null) pairs.push([a, b]);
    }
    rounds.push(pairs);
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, -1)];
  }

  return rounds;
}

async function generateGroupMatches(groupId) {
  const group = await TournamentGroup.findById(groupId).populate({
    path: 'memberIds',
    populate: [{ path: 'entryId' }, { path: 'userId' }],
  });
  const tournament = await Tournament.findById(group.tournamentId).select('createdBy activeAt').lean();

  const rounds = circleMethodRounds(group.memberIds);
  const now = new Date();
  const activationTime = tournament.activeAt || now;
  const matches = [];

  for (let r = 0; r < rounds.length; r++) {
    const isFirstRound = r === 0;
    const scheduledAt = isFirstRound ? now : new Date(activationTime.getTime() + r * DAY_MS);

    for (const [A, B] of rounds[r]) {
      const contest = await Contest.create({
        createdBy:      tournament.createdBy,
        visibility:     'public',
        tournamentId:   group.tournamentId,
        status:         isFirstRound ? 'active' : 'scheduled',
        windowHours:    24,
        votingDeadline: isFirstRound ? new Date(now.getTime() + DAY_MS) : undefined,
        entries: [
          { entryId: A.entryId._id, userId: A.userId._id, submittedAt: now },
          { entryId: B.entryId._id, userId: B.userId._id, submittedAt: now },
        ],
        lastActivityAt: now,
      });

      const match = await TournamentMatch.create({
        tournamentId:       group.tournamentId,
        contestId:          contest._id,
        stage:              'group',
        groupId:            group._id,
        entryIdA:           A.entryId._id,
        entryIdB:           B.entryId._id,
        tournamentEntryIdA: A._id,
        tournamentEntryIdB: B._id,
        status:             isFirstRound ? 'active' : 'scheduled',
        scheduledAt,
        openedAt:           isFirstRound ? now : null,
      });

      if (!isFirstRound) {
        const agenda = require('../jobs/agenda');
        await agenda.schedule(scheduledAt, 'open_tournament_match', { matchId: match._id.toString() });
      } else {
        await notifyEntryLoopedIn([
          { tournamentEntryId: A._id, type: 'tournament_entry_match_live', payload: {
              tournamentId: group.tournamentId, tournamentEntryId: A._id, matchId: match._id, contestId: contest._id,
              opponentUsername: B.userId.username?.value, opponentDisplayName: B.userId.displayName?.value || B.userId.username?.value,
              url: '/contest/' + contest._id,
          } },
          { tournamentEntryId: B._id, type: 'tournament_entry_match_live', payload: {
              tournamentId: group.tournamentId, tournamentEntryId: B._id, matchId: match._id, contestId: contest._id,
              opponentUsername: A.userId.username?.value, opponentDisplayName: A.userId.displayName?.value || A.userId.username?.value,
              url: '/contest/' + contest._id,
          } },
        ], [A.userId._id, B.userId._id]);
      }

      matches.push(match);
    }
  }

  return matches;
}

module.exports = { generateGroups, generateGroupMatches, circleMethodRounds };
