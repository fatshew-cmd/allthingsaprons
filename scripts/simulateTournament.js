// Drives an 8-player tournament through its full lifecycle (creation -> open -> cooldown ->
// active group stage -> knockout -> closed), to surface gaps between the spec and the actual
// code. Route-backed logic (creation wizard, submission, approve/reject, voting, tie votes)
// runs over real HTTP against a running `npm run dev` server so it exercises the real handlers.
// Deadline-triggered transitions are fired by calling the exported job functions directly
// instead of waiting on real wall-clock deadlines (open=3d, cooldown=24h, votingDeadline=24h).
//
// Usage:
//   node scripts/simulateTournament.js                            happy path (no ties, no cancellations)
//   node scripts/simulateTournament.js --scenario=group-tie        force a 3-way group-ranking boundary tie
//   node scripts/simulateTournament.js --scenario=voting-restriction   organizer/jury barred from regular H2H voting
//   node scripts/simulateTournament.js --cleanup                   delete all __sim_ tagged data from prior runs
//
// All seeded users are tagged with a "__sim_" email prefix so cleanup can find them (usernames
// must satisfy the platform's real signup rule, so they can't carry the tag — see makeUsername()).

require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');

const User             = require('../models/User');
const Entry            = require('../models/Entry');
const Tournament       = require('../models/Tournament');
const TournamentEntry  = require('../models/TournamentEntry');
const TournamentGroup  = require('../models/TournamentGroup');
const TournamentMatch  = require('../models/TournamentMatch');
const TournamentJury   = require('../models/TournamentJury');
const TournamentJuryVote = require('../models/TournamentJuryVote');
const TournamentGroupTieVote = require('../models/TournamentGroupTieVote');
const Contest          = require('../models/Contest');
const ContestVote      = require('../models/ContestVote');
const Follow           = require('../models/Follow');
const ContestContribution = require('../models/ContestContribution');
const Notification     = require('../models/Notification');
const WalletTransaction = require('../models/WalletTransaction');

const {
  tournamentOpenExpiry, tournamentCooldownExpiry, closeTournament,
} = require('../jobs/tournamentJobs');
const { closeContest } = require('../jobs/contestJobs');
const notifyEntryLoopedIn = require('../utils/tournamentEntryLoop');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/allthingsaprons';
const BASE_URL  = `http://localhost:${process.env.PORT || 3001}`;
const PASSWORD  = 'SimPass123!';
const TAG       = '__sim_';
const DAY_MS    = 24 * 60 * 60 * 1000;

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const FINDINGS = []; // non-fatal anomalies collected along the way
function flag(msg) {
  FINDINGS.push(msg);
  console.log('  !! FINDING:', msg);
}
function log(msg) { console.log(msg); }

// ---------------------------------------------------------------- tiny HTTP + cookie helper ---
function newActor() { return { cookie: null }; }

async function httpReq(actor, method, urlPath, { body, isForm } = {}) {
  const opts = { method, headers: {}, redirect: 'manual' };
  if (actor?.cookie) opts.headers['Cookie'] = actor.cookie;
  if (body) {
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(body).toString();
    }
  }
  const res = await fetch(BASE_URL + urlPath, opts);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && actor) actor.cookie = setCookie.split(';')[0];
  return res;
}

async function login(actor, email) {
  const res = await httpReq(actor, 'POST', '/login', { body: { email, password: PASSWORD } });
  if (res.status !== 302 || !actor.cookie) {
    throw new Error(`Login failed for ${email} (status ${res.status})`);
  }
}

function tinyImageBlob() {
  return new Blob([TINY_PNG], { type: 'image/png' });
}

async function poll(fn, { timeoutMs = 5000, intervalMs = 100, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

// ---------------------------------------------------------------------------- seeding helpers ---
// Matches the signup route's username rule (routes/auth.js) exactly: starts with a letter,
// letters/digits only, 3-15 chars total. That leaves no room for the "__sim_" cleanup tag, so
// the tag lives on the email instead (see cleanup(), which matches on email, not username).
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9]{2,14}$/;
function makeUsername(tag) {
  const prefix = 'sim';
  // 6 base36 digits (36^6 ~= 2.2 billion combos) reserved for uniqueness — truncate the
  // human-readable tag, never the random suffix, so runs never collide on it.
  const rand = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0');
  const cleanTag = tag.replace(/[^a-zA-Z0-9]/g, '').slice(0, 15 - prefix.length - rand.length);
  const username = `${prefix}${cleanTag}${rand}`.slice(0, 15);
  if (!USERNAME_RE.test(username)) throw new Error(`Generated username "${username}" does not satisfy the platform's username rule`);
  return username;
}

async function makeUser({ tag, idVerified = false, purchasedCHL = 0 }) {
  const hashed = await bcrypt.hash(PASSWORD, 10);
  const emailStamp = `${TAG}${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const username = makeUsername(tag);
  const user = await User.create({
    password: hashed,
    accountStatus: 'active',
    idVerified,
    wallet: { purchasedCHL, earnedCHL: 0 },
    email:    { value: `${emailStamp}@example.test`, confirmed: true },
    username: { value: username },
    displayName: { value: username },
  });
  return user;
}

async function seedOrganizerEligibility(userId) {
  // followerCount > 250 — fake followers, the eligibility check only counts documents
  const followerDocs = Array.from({ length: 260 }, () => ({
    followerId: new mongoose.Types.ObjectId(),
    followingId: userId,
  }));
  await Follow.insertMany(followerDocs);

  // contributed to >= 5 distinct contests — fake contribution rows, only distinct contestId is checked
  const contribDocs = Array.from({ length: 5 }, () => ({
    contestId:     new mongoose.Types.ObjectId(),
    entryId:       new mongoose.Types.ObjectId(),
    beneficiaryId: new mongoose.Types.ObjectId(),
    contributorId: userId,
    amountCHL:     1,
  }));
  await ContestContribution.insertMany(contribDocs);
}

// Replicates the `open_tournament_match` agenda job body (jobs/tournamentJobs.js) — that job
// has no exported standalone function, unlike every other tournament job handler, so a
// deadline-driven round can't be forced without duplicating its logic here. See the simulation
// report (plans/July/tournament-simulation-report.md, section 5) for the writeup of this gap.
async function forceOpenMatch(matchId) {
  const match = await TournamentMatch.findOneAndUpdate(
    { _id: matchId, status: 'scheduled' },
    { $set: { status: 'active', openedAt: new Date() } },
  );
  if (!match) return null;
  const votingDeadline = new Date(Date.now() + DAY_MS);
  await Contest.findByIdAndUpdate(match.contestId, { $set: { status: 'active', votingDeadline } });

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
  return match;
}

// Deterministic winner picker: lexicographically-smaller entryId always wins. Applied
// consistently, this produces a strict, tie-free ranking within a round-robin group without
// needing to know the schedule/seed order ahead of time. Used for every match except the
// deliberately-tied group in the group-tie scenario (see pickWinnerCyclic below).
function pickWinner(match) {
  return match.entryIdA.toString() < match.entryIdB.toString() ? match.entryIdA : match.entryIdB;
}

// Forces a 3-way tie among group positions {1,2,3} while position 0 wins every match it plays
// (clean 3 wins). Position 0 ends up with groupPoints=3; positions 1/2/3 form a rock-paper-
// scissors cycle (1 beats 2, 2 beats 3, 3 beats 1) so each collects exactly 1 win/1 loss against
// the other two plus 1 loss to position 0 -> groupPoints=1 each, tied on ratingAvg/ratingCount
// (both 0 for freshly-created entries) and on totalVotesInGroup (1 each, since the harness casts
// exactly one vote per match, for the winner only). That 3-way tie straddles the group's
// rank-2/rank-3 cutoff, which is exactly the boundary resolveGroup() disputes.
function pickWinnerCyclic(match, positionOf) {
  // positionOf is keyed by TournamentEntry id (TournamentGroup.memberIds' type) — must look up
  // via match.tournamentEntryIdA/B, NOT match.entryIdA/B (those are plain Entry ids, a different
  // ID space entirely; keying by the wrong one makes every lookup silently return undefined).
  const posA = positionOf.get(match.tournamentEntryIdA.toString());
  const posB = positionOf.get(match.tournamentEntryIdB.toString());
  if (posA === 0) return match.entryIdA;
  if (posB === 0) return match.entryIdB;
  const aBeatsB = (posA === 1 && posB === 2) || (posA === 2 && posB === 3) || (posA === 3 && posB === 1);
  return aBeatsB ? match.entryIdA : match.entryIdB;
}

async function castVoteAndClose(voter, match, winnerEntryId) {
  const voteRes = await httpReq(voter, 'POST', `/api/contests/${match.contestId}/vote`, {
    body: { entryId: winnerEntryId.toString() },
  });
  if (voteRes.status !== 200) {
    const text = await voteRes.text().catch(() => '');
    flag(`Vote on contest ${match.contestId} returned ${voteRes.status}: ${text.slice(0, 200)}`);
  }

  await closeContest(match.contestId);
  const closed = await Contest.findById(match.contestId).select('status winnerEntryId').lean();
  if (closed.status !== 'closed') {
    flag(`Contest ${match.contestId} did not close after closeContest() — status is "${closed.status}"`);
    return;
  }
  if (!closed.winnerEntryId) {
    flag(`Contest ${match.contestId} closed with no winner despite a single clean vote — unexpected tie`);
  }
  // closeContest's hook into handleTournamentMatchClose is fire-and-forget (not awaited by
  // closeContest itself), so the wins/losses/groupPoints increments and the group/knockout
  // cascade land asynchronously. Calling handleTournamentMatchClose again ourselves to force
  // synchronous completion is NOT safe here despite its top-of-function "already closed" guard:
  // that guard reads TournamentMatch.status, and if our call races the still-in-flight
  // fire-and-forget one, both can pass the guard before either write lands, double-incrementing
  // wins/losses/groupPoints (see the simulation report, section 4.3). Poll for the match to
  // actually reach "closed" instead.
  await poll(async () => {
    const m = await TournamentMatch.findById(match._id).select('status').lean();
    return m.status === 'closed' ? m : null;
  }, { label: `TournamentMatch ${match._id} status === closed` });
}

// Groups group-stage matches into rounds by (scheduledAt - activeAt)/DAY_MS, rounded. Round 0's
// scheduledAt is a fresh `now` captured independently inside each group's own
// generateGroupMatches() call (a few ms apart between groups), so bucketing by raw scheduledAt
// equality incorrectly splits round 0 into two buckets — rounding relative to activeAt collapses
// them back together. Rounds 1+ share the tournament's persisted activeAt exactly.
function bucketByRound(matches, activeAt) {
  const byRound = {};
  for (const m of matches) {
    const r = Math.round((m.scheduledAt.getTime() - activeAt) / DAY_MS);
    (byRound[r] ||= []).push(m);
  }
  return Object.keys(byRound).map(Number).sort((a, b) => a - b).map(k => byRound[k]);
}

// -------------------------------------------------------------------------------- setup phase ---
// Phases 1-6: identical across every scenario. Seeds users, drives the real creation wizard,
// submits + approves all 8 candidates, and forces the open/cooldown deadlines so the tournament
// reaches status=active/stage=group with its 2 groups + 12 group-stage matches created.
async function setupThroughActiveGroupStage() {
  const agenda = require('../jobs/agenda');
  await new Promise((resolve, reject) => {
    agenda.once('ready', resolve);
    agenda.once('error', reject);
  });

  log('\n=== Phase 1: Seeding users ===');
  const organizer = await makeUser({ tag: 'organizer', idVerified: true, purchasedCHL: 1000 });
  await seedOrganizerEligibility(organizer._id);
  const contestants = [];
  for (let i = 1; i <= 8; i++) contestants.push(await makeUser({ tag: `contestant${i}`, idVerified: true }));
  const jurors = [];
  for (let i = 1; i <= 6; i++) jurors.push(await makeUser({ tag: `juror${i}` }));
  const voter = await makeUser({ tag: 'voter' });
  log(`Seeded organizer ${organizer.username.value}, 8 contestants, 6 jurors, 1 voter.`);

  const organizerActor = newActor();
  await login(organizerActor, organizer.email.value);
  const contestantActors = [];
  for (const c of contestants) {
    const actor = newActor();
    await login(actor, c.email.value);
    contestantActors.push(actor);
  }
  const jurorActors = [];
  for (const j of jurors) {
    const actor = newActor();
    await login(actor, j.email.value);
    jurorActors.push(actor);
  }
  const voterActor = newActor();
  await login(voterActor, voter.email.value);
  log('Logged in organizer, contestants, jurors, voter.');

  log('\n=== Phase 2: Tournament creation wizard (HTTP) ===');
  const tournamentName = `Sim Tournament ${Date.now()}`;

  const step1Form = new FormData();
  step1Form.append('name', tournamentName);
  step1Form.append('description', 'Simulated run');
  step1Form.append('size', '8');
  step1Form.append('openDays', '1');
  step1Form.append('visibility', 'public');
  step1Form.append('thumbnail', tinyImageBlob(), 'thumb.png');
  let res = await httpReq(organizerActor, 'POST', '/tournaments/create/step1', { body: step1Form, isForm: true });
  if (res.status !== 302) throw new Error(`step1 failed: ${res.status} ${await res.text()}`);

  res = await httpReq(organizerActor, 'POST', '/tournaments/create/step2', {
    body: { prizeFirst: '350', prizeSecond: '100', prizeThird: '50' },
  });
  if (res.status !== 302) throw new Error(`step2 failed: ${res.status} ${await res.text()}`);

  res = await httpReq(organizerActor, 'POST', '/tournaments/create/step3', { body: { criteria: '[]' } });
  if (res.status !== 302) throw new Error(`step3 failed: ${res.status} ${await res.text()}`);

  // Repeated-key form field (juryUserIds x6) — httpReq's plain-object body can't express that,
  // so build the urlencoded body directly instead.
  const step4Body = new URLSearchParams();
  for (const j of jurors) step4Body.append('juryUserIds', j._id.toString());
  res = await fetch(BASE_URL + '/tournaments/create/step4', {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: organizerActor.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: step4Body.toString(),
  });
  if (res.status !== 302) throw new Error(`step4 failed: ${res.status} ${await res.text()}`);

  res = await httpReq(organizerActor, 'POST', '/tournaments/create/step5', { body: {} });
  if (res.status !== 302) throw new Error(`step5 (finalize) failed: ${res.status} ${await res.text()}`);

  const tournament = await Tournament.findOne({ name: tournamentName });
  if (!tournament) throw new Error('Tournament not found after creation — finalize silently failed');
  log(`Created tournament ${tournament._id} ("${tournamentName}"), status=${tournament.status}`);

  const juryDocs = await TournamentJury.find({ tournamentId: tournament._id }).lean();
  if (juryDocs.length !== 6) flag(`Expected 6 TournamentJury docs, found ${juryDocs.length}`);
  if (juryDocs.some(j => j.status !== 'pending')) flag('Not all jury invites are "pending" right after creation');

  log('\n=== Phase 3: Candidate submission (HTTP, real entry upload) ===');
  for (let i = 0; i < contestants.length; i++) {
    const form = new FormData();
    form.append('title', `Sim Entry ${i + 1}`);
    form.append('tournamentId', tournament._id.toString());
    form.append('entryMedia', tinyImageBlob(), 'entry.png');
    const r = await httpReq(contestantActors[i], 'POST', '/api/entries', { body: form, isForm: true });
    if (r.status !== 200) {
      throw new Error(`Entry submission failed for contestant ${i + 1}: ${r.status} ${await r.text()}`);
    }
    const json = await r.json();
    if (!json.tournamentSubmission?.success) {
      flag(`Contestant ${i + 1}'s submission to the tournament did not succeed: ${JSON.stringify(json.tournamentSubmission)}`);
    }
  }
  const submittedCount = await TournamentEntry.countDocuments({ tournamentId: tournament._id });
  log(`${submittedCount}/8 candidates submitted.`);
  if (submittedCount !== 8) flag(`Expected exactly 8 TournamentEntry docs after submission, found ${submittedCount}`);

  log('\n=== Phase 4: Force open-phase deadline -> cooldown ===');
  await tournamentOpenExpiry(tournament._id);
  let fresh = await Tournament.findById(tournament._id).lean();
  if (fresh.status !== 'cooldown') throw new Error(`Expected status "cooldown" after tournamentOpenExpiry, got "${fresh.status}"`);
  const acceptedJury = await TournamentJury.countDocuments({ tournamentId: tournament._id, status: 'accepted' });
  if (acceptedJury !== 6) flag(`Expected all 6 jury invites auto-accepted at open-expiry, found ${acceptedJury} accepted`);
  log(`Tournament is now "${fresh.status}". Jury accepted: ${acceptedJury}/6.`);

  log('\n=== Phase 5: Organizer approves all 8 candidates (HTTP) ===');
  const pendingEntries = await TournamentEntry.find({ tournamentId: tournament._id }).lean();
  for (const te of pendingEntries) {
    const r = await httpReq(organizerActor, 'POST', `/api/tournaments/${tournament._id}/entries/${te._id}/approve`, { body: {} });
    if (r.status !== 200) flag(`Approve failed for TournamentEntry ${te._id}: ${r.status} ${await r.text()}`);
  }
  const approvedCount = await TournamentEntry.countDocuments({ tournamentId: tournament._id, approvalStatus: 'approved' });
  log(`${approvedCount}/8 approved.`);
  if (approvedCount !== 8) throw new Error(`Expected 8 approved candidates, got ${approvedCount} — cannot proceed`);

  const approveNotifs = await Notification.countDocuments({ type: 'tournament_entry_approved', 'payload.tournamentId': tournament._id });
  if (approveNotifs !== 8) flag(`Expected 8 "tournament_entry_approved" notifications, found ${approveNotifs}`);

  log('\n=== Phase 6: Force cooldown deadline -> active (group stage generated) ===');
  await tournamentCooldownExpiry(tournament._id);
  fresh = await Tournament.findById(tournament._id).lean();
  if (fresh.status !== 'active' || fresh.stage !== 'group') {
    throw new Error(`Expected status active/stage group after tournamentCooldownExpiry, got status=${fresh.status} stage=${fresh.stage}`);
  }
  const groups = await TournamentGroup.find({ tournamentId: tournament._id }).lean();
  if (groups.length !== 2) flag(`Expected 2 TournamentGroup docs for an 8-player tournament, found ${groups.length}`);
  const groupMatches = await TournamentMatch.find({ tournamentId: tournament._id, stage: 'group' }).lean();
  if (groupMatches.length !== 12) flag(`Expected 12 group-stage matches (2 groups x 3-round robin x 2 matches), found ${groupMatches.length}`);
  log(`Tournament is now active/group. ${groups.length} groups, ${groupMatches.length} group matches created.`);

  return { tournament, organizer, contestants, jurors, voter, organizerActor, contestantActors, jurorActors, voterActor, groups, groupMatches, activeAt: fresh.activeAt };
}

// Opens (if needed) and plays every match in a round, using winnerFn(match) to pick who wins.
async function playRound(matches, round, winnerFn, voterActor) {
  log(`  Round ${round + 1}: ${matches.length} matches`);
  let toPlay = matches;
  if (round > 0) {
    const opened = [];
    for (const m of matches) {
      const stillScheduled = await TournamentMatch.findById(m._id).select('status').lean();
      if (stillScheduled.status !== 'scheduled') {
        flag(`Round ${round + 1} match ${m._id} was not "scheduled" before forcing it open (was "${stillScheduled.status}")`);
      }
      const opened1 = await forceOpenMatch(m._id);
      if (opened1) opened.push(opened1);
    }
    toPlay = opened;
  }
  for (const m of toPlay) {
    const contest = await Contest.findById(m.contestId).select('status').lean();
    if (contest.status !== 'active') flag(`Match ${m._id}'s contest is "${contest.status}", expected "active" before voting`);
    await castVoteAndClose(voterActor, m, winnerFn(m));
  }
}

// Phases 8-9: identical across every scenario once the group stage has resolved (however it
// resolved). Plays the knockout bracket cleanly (no further ties) and verifies close + payout.
async function playKnockoutAndVerifyClose(ctx, { expectGroupTieVotes = 0 } = {}) {
  const { tournament, voterActor, jurors } = ctx;

  log('\n=== Phase 8: Knockout stage ===');
  let fresh = await Tournament.findById(tournament._id).lean();
  if (fresh.stage !== 'knockout' && fresh.stage !== 'finale') {
    flag(`Expected tournament.stage to have advanced to "knockout" after both groups completed, still "${fresh.stage}"`);
  }
  // generateKnockoutBracket runs off the last group's resolveGroup call (itself possibly inside
  // a fire-and-forget chain, or inside an awaited HTTP route for a jury/organizer tie vote) — the
  // SF matches may not exist the instant both groups go "complete", so this is polled.
  let sfMatches = await poll(async () => {
    const ms = await TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: 'SF' }).lean();
    return ms.length === 2 ? ms : null;
  }, { timeoutMs: 8000, label: '2 SF matches created' }).catch(() => TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: 'SF' }).lean());
  if (sfMatches.length !== 2) flag(`Expected 2 SF matches, found ${sfMatches.length}`);
  for (const m of sfMatches) {
    const contest = await Contest.findById(m.contestId).select('status').lean();
    if (contest.status !== 'active') flag(`SF match ${m._id}'s contest is "${contest.status}", expected "active" immediately after bracket generation`);
    await castVoteAndClose(voterActor, m, pickWinner(m));
  }

  const finalMatch = await poll(async () => {
    return TournamentMatch.findOne({ tournamentId: tournament._id, knockoutRound: 'Final' }).lean();
  }, { timeoutMs: 8000, label: 'Final match created' }).catch(() => null);
  const thirdMatch = await TournamentMatch.findOne({ tournamentId: tournament._id, knockoutRound: '3rd' }).lean();
  if (!finalMatch) throw new Error('Final match was not created after both SF matches closed');
  if (!thirdMatch) flag('3rd-place match was not created after both SF matches closed (expected for an 8-player tournament)');

  await castVoteAndClose(voterActor, finalMatch, pickWinner(finalMatch));
  if (thirdMatch) await castVoteAndClose(voterActor, thirdMatch, pickWinner(thirdMatch));

  log('\n=== Phase 9: Verifying close + payout ===');
  let closedTournament = await poll(async () => {
    const t = await Tournament.findById(tournament._id).lean();
    return t.status === 'closed' ? t : null;
  }, { label: 'tournament.status === closed' }).catch(async () => {
    flag('Tournament did not auto-close after Final+3rd matches closed — had to call closeTournament() manually');
    await closeTournament(tournament._id);
    return Tournament.findById(tournament._id).lean();
  });
  if (closedTournament.status !== 'closed') throw new Error('Tournament never reached "closed" status');
  if (!closedTournament.prizes?.winnersSet) flag('Tournament closed but prizes.winnersSet is not true');
  log('Tournament closed successfully.');

  const closedFinal = await TournamentMatch.findById(finalMatch._id).lean();
  const closedThird = thirdMatch ? await TournamentMatch.findById(thirdMatch._id).lean() : null;
  const firstTE  = closedFinal.entryIdA.toString() === closedFinal.winnerId.toString() ? closedFinal.tournamentEntryIdA : closedFinal.tournamentEntryIdB;
  const secondTE = closedFinal.entryIdA.toString() === closedFinal.winnerId.toString() ? closedFinal.tournamentEntryIdB : closedFinal.tournamentEntryIdA;
  const thirdTE  = closedThird ? (closedThird.entryIdA.toString() === closedThird.winnerId.toString() ? closedThird.tournamentEntryIdA : closedThird.tournamentEntryIdB) : null;

  const placementChecks = [
    { label: '1st', teId: firstTE, expected: 350 },
    { label: '2nd', teId: secondTE, expected: 100 },
    ...(thirdTE ? [{ label: '3rd', teId: thirdTE, expected: 50 }] : []),
  ];
  for (const { label, teId, expected } of placementChecks) {
    const te = await TournamentEntry.findById(teId).select('userId').lean();
    const user = await User.findById(te.userId).select('wallet').lean();
    if ((user.wallet.earnedCHL || 0) !== expected) {
      flag(`${label}-place winner's earnedCHL is ${user.wallet.earnedCHL}, expected ${expected}`);
    } else {
      log(`  ${label} place: earnedCHL credited correctly (${expected} CHL)`);
    }
  }

  const prizeNotifs = await Notification.countDocuments({ type: 'tournament_prize_awarded', 'payload.tournamentId': tournament._id });
  if (prizeNotifs !== placementChecks.length) flag(`Expected ${placementChecks.length} tournament_prize_awarded notifications, found ${prizeNotifs}`);

  const closedNotifs = await Notification.countDocuments({ type: 'tournament_closed', 'payload.tournamentId': tournament._id });
  if (closedNotifs !== 8) flag(`Expected 8 tournament_closed notifications (one per approved participant), found ${closedNotifs}`);

  const knockoutStartedNotifs = await Notification.countDocuments({ type: 'tournament_knockout_started', 'payload.tournamentId': tournament._id });
  if (knockoutStartedNotifs !== 4) flag(`Expected 4 tournament_knockout_started notifications (2 per SF match), found ${knockoutStartedNotifs}`);

  const bannedJurors = await User.countDocuments({ _id: { $in: jurors.map(j => j._id) }, juryBanned: true });
  if (bannedJurors !== 0) flag(`${bannedJurors} jurors were banned despite no juror ever missing a vote in this run`);

  const matchJuryVotesCast = await TournamentJuryVote.countDocuments({ tournamentId: tournament._id });
  if (matchJuryVotesCast !== 0) flag(`Expected 0 match-tie jury votes (this scenario never ties a single match), found ${matchJuryVotesCast}`);

  const groupTieVotesCast = await TournamentGroupTieVote.countDocuments({ tournamentId: tournament._id });
  if (groupTieVotesCast !== expectGroupTieVotes) flag(`Expected ${expectGroupTieVotes} group-tie votes, found ${groupTieVotesCast}`);
}

function printSummary(tournamentId) {
  log('\n=== Summary ===');
  log(`Tournament ${tournamentId} completed its full lifecycle.`);
  if (FINDINGS.length === 0) {
    log('No anomalies found.');
  } else {
    log(`${FINDINGS.length} anomaly(ies) found:`);
    FINDINGS.forEach((f, i) => log(`  ${i + 1}. ${f}`));
  }
  log(`\nRun 'node scripts/simulateTournament.js --cleanup' to remove this run's seeded data.`);
}

// -------------------------------------------------------------------------- scenario: happy path ---
async function runHappyPath() {
  await mongoose.connect(MONGO_URI);
  log(`Connected to ${MONGO_URI}. Server assumed running at ${BASE_URL}.`);

  const ctx = await setupThroughActiveGroupStage();
  const { tournament, voterActor, groupMatches, activeAt } = ctx;

  log('\n=== Phase 7: Playing out the group stage (no ties) ===');
  const rounds = bucketByRound(groupMatches, activeAt.getTime());
  if (rounds.length !== 3) flag(`Expected 3 rounds of group play, found ${rounds.length}`);
  for (let r = 0; r < rounds.length; r++) {
    await playRound(rounds[r], r, pickWinner, voterActor);
  }

  await poll(async () => {
    const n = await TournamentGroup.countDocuments({ tournamentId: tournament._id, status: 'complete' });
    return n === 2 ? true : null;
  }, { timeoutMs: 8000, label: 'both TournamentGroups status === complete' }).catch(e => flag(e.message));

  const completedGroups = await TournamentGroup.countDocuments({ tournamentId: tournament._id, status: 'complete' });
  if (completedGroups !== 2) flag(`Expected both groups "complete" after group stage, found ${completedGroups}/2`);

  // resolveGroup only sets groupRank on the 2 advancing members per group — eliminated members
  // get `eliminated: true` with groupRank left unset by design (not a bug — see the report).
  const rankedEntries = await TournamentEntry.find({ tournamentId: tournament._id }).select('groupRank eliminated').lean();
  const advancing  = rankedEntries.filter(e => !e.eliminated);
  const eliminated = rankedEntries.filter(e => e.eliminated);
  if (advancing.length !== 4) flag(`Expected 4 advancing entries (2 per group), found ${advancing.length}`);
  if (advancing.some(e => ![1, 2].includes(e.groupRank))) flag('An advancing entry has a groupRank other than 1 or 2');
  if (eliminated.length !== 4) flag(`Expected 4 eliminated entries (2 per group), found ${eliminated.length}`);
  if (eliminated.some(e => e.groupRank)) flag('An eliminated entry unexpectedly has a groupRank set');
  log(`Group stage complete. ${advancing.length} advancing, ${eliminated.length} eliminated.`);

  await playKnockoutAndVerifyClose(ctx, { expectGroupTieVotes: 0 });
  printSummary(tournament._id);
}

// ---------------------------------------------------------------------- scenario: group-tie ---
async function runGroupTieScenario() {
  await mongoose.connect(MONGO_URI);
  log(`Connected to ${MONGO_URI}. Server assumed running at ${BASE_URL}.`);

  const ctx = await setupThroughActiveGroupStage();
  const { tournament, voterActor, jurorActors, groupMatches, activeAt, groups } = ctx;

  const groupA = groups.find(g => g.label === 'A'); // deliberately tied
  const groupB = groups.find(g => g.label === 'B'); // resolved cleanly, for isolation
  if (!groupA || !groupB) throw new Error('Expected TournamentGroup docs labeled "A" and "B"');

  // Position 0 (memberIds[0]) beats everyone -> groupPoints 3. Positions 1/2/3 form a 3-way
  // cycle -> groupPoints 1 each, tied on every resolveGroup tiebreak field (see pickWinnerCyclic's
  // comment). That 3-way tie straddles the rank-2/rank-3 cutoff (ADVANCE_COUNT=2 for group size 4).
  const positionOf = new Map(groupA.memberIds.map((id, i) => [id.toString(), i]));
  const groupATieTargetTEId = groupA.memberIds[1]; // the harness's designated jury pick, position 1

  log(`\n=== Phase 7: Playing out the group stage (forcing a 3-way tie in Group ${groupA.label}) ===`);
  const rounds = bucketByRound(groupMatches, activeAt.getTime());
  if (rounds.length !== 3) flag(`Expected 3 rounds of group play, found ${rounds.length}`);
  for (let r = 0; r < rounds.length; r++) {
    const matches = rounds[r];
    const winnerFn = m => m.groupId.toString() === groupA._id.toString()
      ? pickWinnerCyclic(m, positionOf)
      : pickWinner(m);
    await playRound(matches, r, winnerFn, voterActor);
  }

  log('\n=== Phase 7b: Verifying the tie was detected and paused correctly ===');
  await poll(async () => {
    const g = await TournamentGroup.findById(groupB._id).select('status').lean();
    return g.status === 'complete' ? g : null;
  }, { timeoutMs: 8000, label: `Group ${groupB.label} (clean) status === complete` }).catch(e => flag(e.message));

  const pausedGroupA = await poll(async () => {
    const g = await TournamentGroup.findById(groupA._id).lean();
    return g.tieStatus === 'jury_pending' ? g : null;
  }, { timeoutMs: 8000, label: `Group ${groupA.label} tieStatus === jury_pending` }).catch(async () => TournamentGroup.findById(groupA._id).lean());

  if (pausedGroupA.status === 'complete') flag(`Group ${groupA.label} resolved to "complete" without ever pausing for a tie vote — the 3-way tie was not detected`);
  if (pausedGroupA.tieStatus !== 'jury_pending') flag(`Expected Group ${groupA.label} tieStatus "jury_pending", got "${pausedGroupA.tieStatus}"`);
  if ((pausedGroupA.tiedEntryIds || []).length !== 3) flag(`Expected 3 tiedEntryIds, found ${(pausedGroupA.tiedEntryIds || []).length}`);
  if (pausedGroupA.tieSlotsForCluster !== 1) flag(`Expected tieSlotsForCluster 1 (only the rank-2 spot is disputed), got ${pausedGroupA.tieSlotsForCluster}`);
  if (!pausedGroupA.tieDeadline) flag('Expected tieDeadline to be set once the tie was raised');
  log(`Group ${groupA.label} correctly paused: tieStatus=jury_pending, ${pausedGroupA.tiedEntryIds?.length} tied entries, ${pausedGroupA.tieSlotsForCluster} slot(s) disputed.`);

  const tieJuryNotifs = await Notification.countDocuments({ type: 'tournament_group_tie_jury', 'payload.tournamentId': tournament._id });
  if (tieJuryNotifs !== 6) flag(`Expected 6 tournament_group_tie_jury notifications (one per accepted juror), found ${tieJuryNotifs}`);

  log('\n=== Phase 7c: 3 jurors cast their top-pick vote (real HTTP) ===');
  for (let i = 0; i < 3; i++) {
    const r = await httpReq(jurorActors[i], 'POST', `/api/tournaments/${tournament._id}/groups/${groupA._id}/jury-vote`, {
      body: { votedForTournamentEntryId: groupATieTargetTEId.toString() },
    });
    if (r.status !== 200) flag(`Juror ${i + 1}'s tie vote returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }

  // The 3rd vote's route handler awaits resolveGroupJuryVote() -> resolveGroup() synchronously
  // (unlike the fire-and-forget contest-close chain elsewhere), so resolution should already be
  // done by the time the 3rd POST's response comes back. Polled anyway as cheap insurance.
  const resolvedGroupA = await poll(async () => {
    const g = await TournamentGroup.findById(groupA._id).lean();
    return g.status === 'complete' ? g : null;
  }, { timeoutMs: 5000, label: `Group ${groupA.label} status === complete after quorum jury vote` }).catch(async () => TournamentGroup.findById(groupA._id).lean());

  if (resolvedGroupA.status !== 'complete') flag(`Group ${groupA.label} did not resolve to "complete" after 3 jurors voted for the same entry`);
  if (resolvedGroupA.tieStatus !== 'resolved') flag(`Expected Group ${groupA.label} tieStatus "resolved", got "${resolvedGroupA.tieStatus}"`);

  const groupTieVoteCount = await TournamentGroupTieVote.countDocuments({ groupId: groupA._id });
  if (groupTieVoteCount !== 3) flag(`Expected exactly 3 TournamentGroupTieVote docs, found ${groupTieVoteCount}`);

  const pos0TE  = await TournamentEntry.findById(groupA.memberIds[0]).select('groupRank eliminated').lean();
  const pickTE  = await TournamentEntry.findById(groupATieTargetTEId).select('groupRank eliminated').lean();
  const others  = await TournamentEntry.find({ _id: { $in: [groupA.memberIds[2], groupA.memberIds[3]] } }).select('groupRank eliminated').lean();

  if (pos0TE.eliminated) flag('Position 0 (clean 3-0 winner) was unexpectedly eliminated');
  if (![1, 2].includes(pos0TE.groupRank)) flag(`Position 0 should have groupRank 1 or 2, got ${pos0TE.groupRank}`);
  if (pickTE.eliminated) flag("The jury's chosen tie winner was unexpectedly eliminated");
  if (![1, 2].includes(pickTE.groupRank)) flag(`The jury's chosen tie winner should have groupRank 1 or 2, got ${pickTE.groupRank}`);
  if (others.some(e => !e.eliminated)) flag('One of the two non-selected tied entries was not marked eliminated');
  if (others.some(e => e.groupRank)) flag('One of the two non-selected tied entries unexpectedly has a groupRank set');
  log(`Tie resolved via jury quorum: position 0 and the jury's pick both advance (ranks ${pos0TE.groupRank}/${pickTE.groupRank}); the other two tied entries are eliminated.`);

  // Nobody should be penalized — resolution happened well within the 6h window, so
  // tournamentGroupJuryExpiry (the only place that increments missedVotes) never fired.
  const groupATournamentJurors = await TournamentJury.find({ tournamentId: tournament._id }).select('missedVotes').lean();
  if (groupATournamentJurors.some(j => j.missedVotes > 0)) flag('A juror was penalized with missedVotes despite the tie resolving well within the 6h window');

  await playKnockoutAndVerifyClose(ctx, { expectGroupTieVotes: 3 });
  printSummary(tournament._id);
}

// ------------------------------------------------------------ scenario: voting-restriction ---
// Universal business rule (CLAUDE.md): while a tournament is open/cooldown/active, its organizer
// and jury are barred from voting in an unrelated STANDALONE H2H contest (Contest.tournamentId
// null) — but voting on the tournament's OWN group/knockout matches (Contest.tournamentId set)
// is unaffected, since that's how those matches are normally decided in the first place. The
// check lives inline in POST /api/contests/:id/vote (routes/api.js).
async function runVotingRestrictionScenario() {
  await mongoose.connect(MONGO_URI);
  log(`Connected to ${MONGO_URI}. Server assumed running at ${BASE_URL}.`);

  // Stops right after Phase 6 (tournament active/group, round-1 matches already live) — no need
  // to play out the group stage at all for this scenario, which only probes the vote route's
  // organizer/jury guard, not the tournament state machine itself.
  const ctx = await setupThroughActiveGroupStage();
  const { tournament, organizerActor, jurors, jurorActors, groupMatches } = ctx;

  log('\n=== Phase 7: Seeding an unrelated standalone contest (fixture, not under test) ===');
  const bystander1 = await makeUser({ tag: 'bystander1', idVerified: true });
  const bystander2 = await makeUser({ tag: 'bystander2', idVerified: true });
  const entry1 = await Entry.create({ userId: bystander1._id, mediaUrl: '/uploads/entries/sim.png', mediaType: 'photo', title: 'Sim Standalone Entry 1' });
  const entry2 = await Entry.create({ userId: bystander2._id, mediaUrl: '/uploads/entries/sim.png', mediaType: 'photo', title: 'Sim Standalone Entry 2' });
  const standaloneContest = await Contest.create({
    createdBy: bystander1._id,
    visibility: 'public',
    tournamentId: null,
    status: 'active',
    windowHours: 72,
    votingDeadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
    entries: [
      { entryId: entry1._id, userId: bystander1._id, submittedAt: new Date() },
      { entryId: entry2._id, userId: bystander2._id, submittedAt: new Date() },
    ],
    lastActivityAt: new Date(),
  });
  log(`Seeded standalone contest ${standaloneContest._id} (tournamentId: null), unrelated to the sim tournament.`);

  log("\n=== Phase 8: Organizer attempts to vote in the unrelated standalone contest ===");
  let r = await httpReq(organizerActor, 'POST', `/api/contests/${standaloneContest._id}/vote`, { body: { entryId: entry1._id.toString() } });
  if (r.status !== 403) {
    flag(`Expected the organizer's vote on an unrelated standalone contest to be blocked (403) while their tournament is active, got ${r.status}: ${(await r.text()).slice(0, 200)}`);
  } else {
    log('  Organizer correctly blocked (403).');
  }

  log("\n=== Phase 9: An accepted juror attempts to vote in the same unrelated contest ===");
  r = await httpReq(jurorActors[0], 'POST', `/api/contests/${standaloneContest._id}/vote`, { body: { entryId: entry1._id.toString() } });
  if (r.status !== 403) {
    flag(`Expected an accepted juror's vote on an unrelated standalone contest to be blocked (403), got ${r.status}: ${(await r.text()).slice(0, 200)}`);
  } else {
    log('  Accepted juror correctly blocked (403).');
  }

  log("\n=== Phase 10: A juror who DECLINED their invite attempts the same vote ===");
  // The route's restriction query (TournamentJury.distinct('tournamentId', { userId })) doesn't
  // filter by status at all — worth checking directly whether a juror who never actually served
  // is nonetheless still blocked, merely for having a TournamentJury record naming them.
  const declinedJuror = jurors[2];
  const declinedJurorActor = jurorActors[2];
  await TournamentJury.updateOne({ tournamentId: tournament._id, userId: declinedJuror._id }, { $set: { status: 'declined', respondedAt: new Date() } });
  r = await httpReq(declinedJurorActor, 'POST', `/api/contests/${standaloneContest._id}/vote`, { body: { entryId: entry2._id.toString() } });
  if (r.status === 403) {
    flag('A juror who explicitly DECLINED their invite is still blocked from unrelated standalone voting — the restriction query does not filter TournamentJury by status, so a merely-invited-and-declined juror is treated the same as an actively-serving one');
  } else if (r.status === 200) {
    log('  Declined juror was allowed to vote — the restriction is correctly scoped to active jury service only.');
  } else {
    flag(`Unexpected status ${r.status} for the declined juror's vote attempt: ${(await r.text()).slice(0, 200)}`);
  }

  log("\n=== Phase 11: Control case — organizer + an accepted juror CAN vote on the tournament's OWN match ===");
  const ownMatch = groupMatches.find(m => m.status === 'active') || groupMatches[0];
  const ownContest = await Contest.findById(ownMatch.contestId).select('entries').lean();
  const ownEntryId = ownContest.entries[0].entryId;

  r = await httpReq(organizerActor, 'POST', `/api/contests/${ownMatch.contestId}/vote`, { body: { entryId: ownEntryId.toString() } });
  if (r.status !== 200) {
    flag(`Expected the organizer's vote on their OWN tournament's match to succeed, got ${r.status}: ${(await r.text()).slice(0, 200)}`);
  } else {
    log("  Organizer correctly ALLOWED to vote on their own tournament's match.");
  }

  r = await httpReq(jurorActors[1], 'POST', `/api/contests/${ownMatch.contestId}/vote`, { body: { entryId: ownEntryId.toString() } });
  if (r.status !== 200) {
    flag(`Expected an accepted juror's vote on their own tournament's match to succeed, got ${r.status}: ${(await r.text()).slice(0, 200)}`);
  } else {
    log("  Accepted juror correctly ALLOWED to vote on their own tournament's match.");
  }

  printSummary(tournament._id);
}

// ---------------------------------------------------------------------------------- cleanup ---
async function cleanup() {
  await mongoose.connect(MONGO_URI);
  const users = await User.find({ 'email.value': { $regex: `^${TAG}` } }).select('_id').lean();
  const userIds = users.map(u => u._id);
  log(`Found ${userIds.length} __sim_ users to clean up.`);
  if (!userIds.length) { log('Nothing to clean up.'); return; }

  const tournaments = await Tournament.find({ createdBy: { $in: userIds } }).select('_id').lean();
  const tournamentIds = tournaments.map(t => t._id);

  const entries = await Entry.find({ userId: { $in: userIds } }).select('_id').lean();
  const entryIds = entries.map(e => e._id);

  const contests = await Contest.find({ $or: [
    { tournamentId: { $in: tournamentIds } },
    { 'entries.userId': { $in: userIds } },
  ] }).select('_id').lean();
  const contestIds = contests.map(c => c._id);

  const matches = await TournamentMatch.find({ tournamentId: { $in: tournamentIds } }).select('_id').lean();
  const matchIds = matches.map(m => m._id);

  await Promise.all([
    TournamentGroupTieVote.deleteMany({ tournamentId: { $in: tournamentIds } }),
    TournamentJuryVote.deleteMany({ tournamentId: { $in: tournamentIds } }),
    TournamentJury.deleteMany({ tournamentId: { $in: tournamentIds } }),
    TournamentMatch.deleteMany({ tournamentId: { $in: tournamentIds } }),
    TournamentGroup.deleteMany({ tournamentId: { $in: tournamentIds } }),
    TournamentEntry.deleteMany({ tournamentId: { $in: tournamentIds } }),
    ContestVote.deleteMany({ contestId: { $in: contestIds } }),
    Contest.deleteMany({ _id: { $in: contestIds } }),
    Notification.deleteMany({ $or: [
      { userId: { $in: userIds } },
      { 'payload.tournamentId': { $in: tournamentIds } },
    ] }),
    WalletTransaction.deleteMany({ userId: { $in: userIds } }),
    ContestContribution.deleteMany({ contributorId: { $in: userIds } }),
    Follow.deleteMany({ followingId: { $in: userIds } }),
    Entry.deleteMany({ _id: { $in: entryIds } }),
    Tournament.deleteMany({ _id: { $in: tournamentIds } }),
  ]);
  await User.deleteMany({ _id: { $in: userIds } });

  log(`Cleaned up ${tournamentIds.length} tournament(s), ${matchIds.length} match(es), ${contestIds.length} contest(s), ${entryIds.length} entr(y/ies), ${userIds.length} user(s).`);
}

// ------------------------------------------------------------------------------------- main ---
const scenarioArg = process.argv.find(a => a.startsWith('--scenario='));
const scenario = scenarioArg ? scenarioArg.split('=')[1] : 'happy-path';

const SCENARIOS = {
  'happy-path': runHappyPath,
  'group-tie': runGroupTieScenario,
  'voting-restriction': runVotingRestrictionScenario,
};

let mode;
if (process.argv.includes('--cleanup')) {
  mode = cleanup;
} else if (SCENARIOS[scenario]) {
  mode = SCENARIOS[scenario];
} else {
  console.error(`Unknown scenario "${scenario}". Valid scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}

mode()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\nSimulation failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
