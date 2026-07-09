// Drives an 8-player tournament through its full lifecycle (creation -> open -> cooldown ->
// active group stage -> knockout -> closed), to surface gaps between the spec and the actual
// code. Route-backed logic (creation wizard, submission, approve/reject, voting, tie votes)
// runs over real HTTP against a running `npm run dev` server so it exercises the real handlers.
// Deadline-triggered transitions are fired by calling the exported job functions directly
// instead of waiting on real wall-clock deadlines (open=3d, cooldown=24h, votingDeadline=24h).
//
// Usage:
//   node scripts/simulateTournament.js                                  happy path (no ties, no cancellations)
//   node scripts/simulateTournament.js --scenario=group-tie              force a 3-way group-ranking boundary tie
//   node scripts/simulateTournament.js --scenario=voting-restriction     organizer/jury barred from regular H2H voting
//   node scripts/simulateTournament.js --scenario=group-tie-organizer    ambiguous jury vote -> organizer resolves within 3h
//   node scripts/simulateTournament.js --scenario=group-tie-coinflip     nobody votes at all -> 6h + 3h expire -> coin flip
//   node scripts/simulateTournament.js --scenario=group-tie-2way         plain 2-way tie -> ordinary extra H2H tiebreaker match
//   node scripts/simulateTournament.js --scenario=open-underfill-cancel  fewer candidates than the cap -> auto-cancel + refund
//   node scripts/simulateTournament.js --cleanup                        delete all __sim_ tagged data from prior runs
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
const TournamentComment  = require('../models/TournamentComment');
const TournamentCommentReport = require('../models/TournamentCommentReport');
const TournamentReport  = require('../models/TournamentReport');
const TournamentLoop    = require('../models/TournamentLoop');
const Contest          = require('../models/Contest');
const ContestVote      = require('../models/ContestVote');
const Follow           = require('../models/Follow');
const ContestContribution = require('../models/ContestContribution');
const Notification     = require('../models/Notification');
const WalletTransaction = require('../models/WalletTransaction');

const {
  tournamentOpenExpiry, tournamentCooldownExpiry, closeTournament,
  tournamentGroupJuryExpiry, tournamentGroupOrganizerVoteExpiry,
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

// Job functions we call directly (transitionToCooldown, generateGroupMatches,
// generateKnockoutBracket, createBracketMatch, cancelTournament, ...) schedule agenda jobs
// internally via a lazy `require('../jobs/agenda')`. Agenda connects to Mongo asynchronously in
// its constructor — scheduling before that connection is up throws "Cannot read properties of
// undefined (reading 'insertOne')". Cached as a module-level singleton promise rather than a
// fresh `agenda.once('ready', ...)` registration every call: agenda's 'ready' event fires exactly
// once ever, so a scenario that reaches this point a second time (e.g. cooldown-edges seeding two
// separate tournaments in one process) would register a listener for an event that's already
// happened and never fires again — hanging forever. Every caller awaits this same promise instead.
let agendaReadyPromise = null;
function ensureAgendaReady() {
  if (!agendaReadyPromise) {
    const agenda = require('../jobs/agenda');
    agendaReadyPromise = new Promise((resolve, reject) => {
      agenda.once('ready', resolve);
      agenda.once('error', reject);
    });
  }
  return agendaReadyPromise;
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

// followerCount/contributionCount are parameterized so the creation-boundaries scenario can seed
// organizers sitting exactly at/either side of requireOrganizerEligibility's thresholds
// (followerCount > 250, contributedContestIds.length >= 5) instead of always comfortably clear.
async function seedOrganizerEligibility(userId, { followerCount = 260, contributionCount = 5 } = {}) {
  // fake followers — the eligibility check only counts documents, doesn't validate they're real users
  const followerDocs = Array.from({ length: followerCount }, () => ({
    followerId: new mongoose.Types.ObjectId(),
    followingId: userId,
  }));
  if (followerDocs.length) await Follow.insertMany(followerDocs);

  // fake contribution rows — only distinct contestId is checked, not the contest's existence
  const contribDocs = Array.from({ length: contributionCount }, () => ({
    contestId:     new mongoose.Types.ObjectId(),
    entryId:       new mongoose.Types.ObjectId(),
    beneficiaryId: new mongoose.Types.ObjectId(),
    contributorId: userId,
    amountCHL:     1,
  }));
  if (contribDocs.length) await ContestContribution.insertMany(contribDocs);
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

// Mirrors routes/tournaments.js's own GROUP_CONFIG — the fixed size->group shape table. Needed
// here so the boundary-sizes scenario (size 4 and size 12) can compute expected group/knockout
// counts instead of the hardcoded "2 groups / 12 matches" assumptions built for size 8.
const GROUP_CONFIG = {
  4:  { groupSize: 4, groupCount: 1 },
  8:  { groupSize: 4, groupCount: 2 },
  12: { groupSize: 3, groupCount: 4 },
  16: { groupSize: 4, groupCount: 4 },
  24: { groupSize: 3, groupCount: 8 },
};

// -------------------------------------------------------------------------------- setup phase ---
// Phases 1-3: seeds `size` users, drives the real creation wizard, and submits `submitCount` of
// them. Shared by every scenario, including the ones that need fewer submissions than the cap
// (e.g. the open-phase under-fill auto-cancel scenario) or a non-default tournament size.
async function setupThroughSubmission({ submitCount, size = 8 } = {}) {
  if (submitCount === undefined) submitCount = size;
  await ensureAgendaReady();

  log('\n=== Phase 1: Seeding users ===');
  const organizer = await makeUser({ tag: 'organizer', idVerified: true, purchasedCHL: 1000 });
  await seedOrganizerEligibility(organizer._id);
  const contestants = [];
  for (let i = 1; i <= size; i++) contestants.push(await makeUser({ tag: `contestant${i}`, idVerified: true }));
  const jurors = [];
  for (let i = 1; i <= 6; i++) jurors.push(await makeUser({ tag: `juror${i}` }));
  const voter = await makeUser({ tag: 'voter' });
  log(`Seeded organizer ${organizer.username.value}, ${size} contestants, 6 jurors, 1 voter.`);

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
  step1Form.append('size', String(size));
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

  log(`\n=== Phase 3: Candidate submission (HTTP, real entry upload) — ${submitCount}/${size} contestants ===`);
  for (let i = 0; i < submitCount; i++) {
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
  log(`${submittedCount}/${submitCount} intended candidates submitted.`);
  if (submittedCount !== submitCount) flag(`Expected exactly ${submitCount} TournamentEntry docs after submission, found ${submittedCount}`);

  return { tournament, organizer, contestants, jurors, voter, organizerActor, contestantActors, jurorActors, voterActor };
}

// Phases 1-6: identical across every scenario that needs a full roster of `size` candidates
// (default 8, matching every scenario built before the boundary-sizes one). Builds on
// setupThroughSubmission() (all `size` submit) and forces the open/cooldown deadlines so the
// tournament reaches status=active/stage=group with its groups + group-stage matches created.
async function setupThroughActiveGroupStage({ size = 8 } = {}) {
  const setup = await setupThroughSubmission({ submitCount: size, size });
  const { tournament, jurors, organizerActor } = setup;
  const { groupSize, groupCount } = GROUP_CONFIG[size];
  const expectedGroupMatches = groupCount * (groupSize * (groupSize - 1) / 2);

  log('\n=== Phase 4: Force open-phase deadline -> cooldown ===');
  await tournamentOpenExpiry(tournament._id);
  let fresh = await Tournament.findById(tournament._id).lean();
  if (fresh.status !== 'cooldown') throw new Error(`Expected status "cooldown" after tournamentOpenExpiry, got "${fresh.status}"`);
  const acceptedJury = await TournamentJury.countDocuments({ tournamentId: tournament._id, status: 'accepted' });
  if (acceptedJury !== 6) flag(`Expected all 6 jury invites auto-accepted at open-expiry, found ${acceptedJury} accepted`);
  log(`Tournament is now "${fresh.status}". Jury accepted: ${acceptedJury}/6.`);

  log(`\n=== Phase 5: Organizer approves all ${size} candidates (HTTP) ===`);
  const pendingEntries = await TournamentEntry.find({ tournamentId: tournament._id }).lean();
  for (const te of pendingEntries) {
    const r = await httpReq(organizerActor, 'POST', `/api/tournaments/${tournament._id}/entries/${te._id}/approve`, { body: {} });
    if (r.status !== 200) flag(`Approve failed for TournamentEntry ${te._id}: ${r.status} ${await r.text()}`);
  }
  const approvedCount = await TournamentEntry.countDocuments({ tournamentId: tournament._id, approvalStatus: 'approved' });
  log(`${approvedCount}/${size} approved.`);
  if (approvedCount !== size) throw new Error(`Expected ${size} approved candidates, got ${approvedCount} — cannot proceed`);

  const approveNotifs = await Notification.countDocuments({ type: 'tournament_entry_approved', 'payload.tournamentId': tournament._id });
  if (approveNotifs !== size) flag(`Expected ${size} "tournament_entry_approved" notifications, found ${approveNotifs}`);

  log('\n=== Phase 6: Force cooldown deadline -> active (group stage generated) ===');
  await tournamentCooldownExpiry(tournament._id);
  fresh = await Tournament.findById(tournament._id).lean();
  if (fresh.status !== 'active' || fresh.stage !== 'group') {
    throw new Error(`Expected status active/stage group after tournamentCooldownExpiry, got status=${fresh.status} stage=${fresh.stage}`);
  }
  const groups = await TournamentGroup.find({ tournamentId: tournament._id }).lean();
  if (groups.length !== groupCount) flag(`Expected ${groupCount} TournamentGroup docs for a ${size}-player tournament, found ${groups.length}`);
  const groupMatches = await TournamentMatch.find({ tournamentId: tournament._id, stage: 'group' }).lean();
  if (groupMatches.length !== expectedGroupMatches) {
    flag(`Expected ${expectedGroupMatches} group-stage matches (${groupCount} group(s) x round-robin of ${groupSize}), found ${groupMatches.length}`);
  }
  log(`Tournament is now active/group. ${groups.length} groups, ${groupMatches.length} group matches created.`);

  return { ...setup, groups, groupMatches, activeAt: fresh.activeAt };
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
async function playKnockoutAndVerifyClose(ctx, { expectGroupTieVotes = 0, expectBannedJurorIds = [] } = {}) {
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

  // Generalized rather than a flat "expect 0 banned" — the group-tie-organizer/coin-flip
  // scenarios deliberately let jurors miss a vote and expect them banned once the tournament
  // closes (missedVotes -> juryBanned is only applied at close, see closeTournament()).
  const bannedJurorDocs = await User.find({ _id: { $in: jurors.map(j => j._id) }, juryBanned: true }).select('_id').lean();
  const bannedIds = new Set(bannedJurorDocs.map(u => u._id.toString()));
  const expectedBannedIds = new Set(expectBannedJurorIds.map(String));
  const missingBans = [...expectedBannedIds].filter(id => !bannedIds.has(id));
  const unexpectedBans = [...bannedIds].filter(id => !expectedBannedIds.has(id));
  if (missingBans.length) flag(`${missingBans.length} juror(s) expected to be banned (missed a vote) were not banned`);
  if (unexpectedBans.length) flag(`${unexpectedBans.length} juror(s) were unexpectedly banned despite not being expected to miss a vote`);

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
  const { tournament, jurorActors } = ctx;
  const { groupA, tiedTEIds } = await forceGroupTie(ctx);
  const groupATieTargetTEId = tiedTEIds[0]; // the harness's designated jury pick, position 1

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

// ---------------------------------------------------------- shared: force the same 3-way tie ---
// Both group-tie-organizer and group-tie-coinflip start from the identical forced tie the
// group-tie scenario uses (position 0 wins everything, positions 1/2/3 cycle) — only what
// happens *after* the tie is raised differs (who votes, and how the deadline chain resolves it).
async function forceGroupTie(ctx) {
  const { voterActor, groups, groupMatches, activeAt } = ctx;
  const groupA = groups.find(g => g.label === 'A'); // deliberately tied
  const groupB = groups.find(g => g.label === 'B'); // resolved cleanly, for isolation
  if (!groupA || !groupB) throw new Error('Expected TournamentGroup docs labeled "A" and "B"');

  const positionOf = new Map(groupA.memberIds.map((id, i) => [id.toString(), i]));
  const tiedTEIds = [groupA.memberIds[1], groupA.memberIds[2], groupA.memberIds[3]]; // positions 1,2,3

  log(`\n=== Phase 7: Playing out the group stage (forcing a 3-way tie in Group ${groupA.label}) ===`);
  const rounds = bucketByRound(groupMatches, activeAt.getTime());
  if (rounds.length !== 3) flag(`Expected 3 rounds of group play, found ${rounds.length}`);
  for (let r = 0; r < rounds.length; r++) {
    const winnerFn = m => m.groupId.toString() === groupA._id.toString()
      ? pickWinnerCyclic(m, positionOf)
      : pickWinner(m);
    await playRound(rounds[r], r, winnerFn, voterActor);
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

  if (pausedGroupA.tieStatus !== 'jury_pending') flag(`Expected Group ${groupA.label} tieStatus "jury_pending", got "${pausedGroupA.tieStatus}"`);
  if ((pausedGroupA.tiedEntryIds || []).length !== 3) flag(`Expected 3 tiedEntryIds, found ${(pausedGroupA.tiedEntryIds || []).length}`);
  if (pausedGroupA.tieSlotsForCluster !== 1) flag(`Expected tieSlotsForCluster 1, got ${pausedGroupA.tieSlotsForCluster}`);
  log(`Group ${groupA.label} correctly paused: tieStatus=jury_pending, ${pausedGroupA.tiedEntryIds?.length} tied entries, ${pausedGroupA.tieSlotsForCluster} slot(s) disputed.`);

  return { groupA, groupB, tiedTEIds };
}

// ------------------------------------------------------- scenario: group-tie-organizer ---
// Jurors split their votes across all 3 tied entries -> quorum (3) is reached but the plurality
// is ambiguous at the cutoff (resolveGroupJuryVote's ambiguity check) -> the tie stays paused ->
// the 6h jury window is forced to expire (penalizing the 3 non-voting jurors with missedVotes,
// which becomes a permanent juryBanned once the tournament closes) -> the organizer resolves it
// via the real HTTP route within the 3h window.
async function runGroupTieOrganizerScenario() {
  await mongoose.connect(MONGO_URI);
  log(`Connected to ${MONGO_URI}. Server assumed running at ${BASE_URL}.`);

  const ctx = await setupThroughActiveGroupStage();
  const { tournament, organizerActor, jurors, jurorActors } = ctx;
  const { groupA, tiedTEIds } = await forceGroupTie(ctx);

  log('\n=== Phase 7c: 3 jurors split their vote across the 3 tied entries (ambiguous plurality) ===');
  for (let i = 0; i < 3; i++) {
    const r = await httpReq(jurorActors[i], 'POST', `/api/tournaments/${tournament._id}/groups/${groupA._id}/jury-vote`, {
      body: { votedForTournamentEntryId: tiedTEIds[i].toString() },
    });
    if (r.status !== 200) flag(`Juror ${i + 1}'s tie vote returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const stillPending = await TournamentGroup.findById(groupA._id).lean();
  if (stillPending.tieStatus !== 'jury_pending') {
    flag(`Expected Group A to remain "jury_pending" after a 3-way vote split (ambiguous at the cutoff), got "${stillPending.tieStatus}"`);
  } else {
    log('  Group correctly remained jury_pending — quorum (3) was reached, but a 1-1-1 split leaves the cutoff ambiguous.');
  }

  log('\n=== Phase 7d: Forcing the 6h jury window to expire ===');
  await tournamentGroupJuryExpiry(groupA._id);
  const afterJuryExpiry = await TournamentGroup.findById(groupA._id).lean();
  if (afterJuryExpiry.tieStatus !== 'organizer_pending') {
    flag(`Expected tieStatus "organizer_pending" after the 6h jury window expired, got "${afterJuryExpiry.tieStatus}"`);
  }

  const votedUserIds = new Set(jurors.slice(0, 3).map(j => j._id.toString()));
  const juryDocsAfter = await TournamentJury.find({ tournamentId: tournament._id }).select('userId missedVotes').lean();
  const wronglyPenalized = juryDocsAfter.filter(j => votedUserIds.has(j.userId.toString()) && j.missedVotes > 0);
  const correctlyPenalized = juryDocsAfter.filter(j => !votedUserIds.has(j.userId.toString()) && j.missedVotes > 0);
  if (wronglyPenalized.length) flag(`${wronglyPenalized.length} juror(s) who DID vote were incorrectly penalized with missedVotes`);
  if (correctlyPenalized.length !== 3) flag(`Expected exactly 3 non-voting jurors penalized with missedVotes, found ${correctlyPenalized.length}`);
  else log('  The 3 non-voting jurors were correctly penalized with missedVotes; the 3 who voted were not.');

  const organizerTieNotifs = await Notification.countDocuments({ type: 'tournament_group_tie_organizer', 'payload.tournamentId': tournament._id });
  if (organizerTieNotifs !== 1) flag(`Expected 1 tournament_group_tie_organizer notification (to the organizer), found ${organizerTieNotifs}`);

  log("\n=== Phase 7e: Organizer resolves the tie via real HTTP within the 3h window ===");
  // Repeated-key form field (orderedTournamentEntryIds x3), same reason step4's juryUserIds
  // needed a raw urlencoded body instead of httpReq's plain-object shorthand.
  const orderedBody = new URLSearchParams();
  orderedBody.append('orderedTournamentEntryIds', tiedTEIds[0].toString()); // organizer's pick for the disputed slot
  orderedBody.append('orderedTournamentEntryIds', tiedTEIds[1].toString());
  orderedBody.append('orderedTournamentEntryIds', tiedTEIds[2].toString());
  const orgRes = await fetch(BASE_URL + `/api/tournaments/${tournament._id}/groups/${groupA._id}/organizer-vote`, {
    method: 'POST',
    headers: { Cookie: organizerActor.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: orderedBody.toString(),
  });
  if (orgRes.status !== 200) flag(`Organizer's tie-break vote returned ${orgRes.status}: ${(await orgRes.text()).slice(0, 200)}`);

  const resolvedGroupA = await poll(async () => {
    const g = await TournamentGroup.findById(groupA._id).lean();
    return g.status === 'complete' ? g : null;
  }, { timeoutMs: 5000, label: 'Group A status === complete after organizer vote' }).catch(async () => TournamentGroup.findById(groupA._id).lean());
  if (resolvedGroupA.status !== 'complete') flag('Group A did not resolve to "complete" after the organizer voted');
  if (resolvedGroupA.tieStatus !== 'resolved') flag(`Expected Group A tieStatus "resolved", got "${resolvedGroupA.tieStatus}"`);

  const pos0TE = await TournamentEntry.findById(groupA.memberIds[0]).select('groupRank eliminated').lean();
  const pickTE = await TournamentEntry.findById(tiedTEIds[0]).select('groupRank eliminated').lean();
  const others = await TournamentEntry.find({ _id: { $in: [tiedTEIds[1], tiedTEIds[2]] } }).select('groupRank eliminated').lean();
  if (pos0TE.eliminated || ![1, 2].includes(pos0TE.groupRank)) flag(`Position 0 should advance with groupRank 1 or 2, got rank=${pos0TE.groupRank} eliminated=${pos0TE.eliminated}`);
  if (pickTE.eliminated || ![1, 2].includes(pickTE.groupRank)) flag(`The organizer's chosen tie winner should advance, got rank=${pickTE.groupRank} eliminated=${pickTE.eliminated}`);
  if (others.some(e => !e.eliminated || e.groupRank)) flag('The two non-selected tied entries were not both cleanly eliminated (no groupRank)');
  else log(`  Tie resolved via organizer decision: position 0 and the organizer's pick both advance; the other two are eliminated.`);

  // The 3 non-voting jurors' missedVotes>0 should become a permanent ban once the tournament
  // closes — closeTournament() applies the ban, not the jury-expiry step itself.
  const expectBannedJurorIds = jurors.slice(3, 6).map(j => j._id);
  await playKnockoutAndVerifyClose(ctx, { expectGroupTieVotes: 3, expectBannedJurorIds });
  printSummary(tournament._id);
}

// -------------------------------------------------------- scenario: group-tie-coinflip ---
// Nobody votes at all: the 6h jury window expires with zero votes cast (penalizing all 6 accepted
// jurors), the tie hands off to the organizer, and the 3h organizer window is also forced to
// expire untouched -> the platform coin flip resolves it. Confirms a group-ranking tie can never
// block progression past 9h total even in the total-non-engagement case.
async function runGroupTieCoinflipScenario() {
  await mongoose.connect(MONGO_URI);
  log(`Connected to ${MONGO_URI}. Server assumed running at ${BASE_URL}.`);

  const ctx = await setupThroughActiveGroupStage();
  const { tournament, jurors } = ctx;
  const { groupA, tiedTEIds } = await forceGroupTie(ctx);

  log('\n=== Phase 7c: Nobody votes — forcing the 6h jury window to expire untouched ===');
  await tournamentGroupJuryExpiry(groupA._id);
  const afterJuryExpiry = await TournamentGroup.findById(groupA._id).lean();
  if (afterJuryExpiry.tieStatus !== 'organizer_pending') {
    flag(`Expected tieStatus "organizer_pending" after the 6h jury window expired with no votes, got "${afterJuryExpiry.tieStatus}"`);
  }
  const juryDocsAfter = await TournamentJury.find({ tournamentId: tournament._id }).select('missedVotes').lean();
  const notPenalized = juryDocsAfter.filter(j => !(j.missedVotes > 0));
  if (notPenalized.length) flag(`Expected all 6 accepted jurors penalized with missedVotes (nobody voted), ${notPenalized.length} were not`);
  else log('  All 6 jurors correctly penalized with missedVotes — nobody cast a single vote.');

  log('\n=== Phase 7d: Organizer also never acts — forcing the 3h organizer window to expire ===');
  await tournamentGroupOrganizerVoteExpiry(groupA._id);
  const resolvedGroupA = await poll(async () => {
    const g = await TournamentGroup.findById(groupA._id).lean();
    return g.status === 'complete' ? g : null;
  }, { timeoutMs: 5000, label: 'Group A status === complete after the organizer window expired' }).catch(async () => TournamentGroup.findById(groupA._id).lean());
  if (resolvedGroupA.status !== 'complete') flag('Group A did not resolve to "complete" after the organizer window expired (coin flip)');
  if (resolvedGroupA.tieStatus !== 'resolved') flag(`Expected Group A tieStatus "resolved", got "${resolvedGroupA.tieStatus}"`);

  const pos0TE = await TournamentEntry.findById(groupA.memberIds[0]).select('groupRank eliminated').lean();
  const tiedEntries = await TournamentEntry.find({ _id: { $in: tiedTEIds } }).select('groupRank eliminated').lean();
  const advancingTied = tiedEntries.filter(e => !e.eliminated);
  const eliminatedTied = tiedEntries.filter(e => e.eliminated);
  if (pos0TE.eliminated || ![1, 2].includes(pos0TE.groupRank)) flag(`Position 0 should always advance regardless of the coin flip, got rank=${pos0TE.groupRank} eliminated=${pos0TE.eliminated}`);
  if (advancingTied.length !== 1) flag(`Expected exactly 1 of the 3 tied entries to win the coin flip and advance, found ${advancingTied.length}`);
  if (eliminatedTied.length !== 2) flag(`Expected exactly 2 of the 3 tied entries eliminated after the coin flip, found ${eliminatedTied.length}`);
  if (advancingTied.length === 1 && eliminatedTied.length === 2) {
    log(`  Coin flip resolved the tie: position 0 and one randomly-chosen tied entry advance; the other two are eliminated.`);
  }

  // Total non-engagement -> all 6 accepted jurors miss a vote -> all 6 get permanently banned
  // once the tournament closes.
  await playKnockoutAndVerifyClose(ctx, { expectGroupTieVotes: 0, expectBannedJurorIds: jurors.map(j => j._id) });
  printSummary(tournament._id);
}

// -------------------------------------------------------- scenario: group-tie-2way ---
// A genuine 2-way group-ranking boundary tie -> resolveGroup()'s `cluster.length === 2` branch,
// which is a structurally different resolution path from the 3+-way jury/organizer/coin-flip
// chain (§7/§9/§10 in the report): it just creates one ordinary extra H2H tiebreaker match
// (isTiebreakerMatch: true) between the two disputed entries — no jury, no organizer, no
// tieStatus/tieDeadline at all.
//
// Mathematical note: in a 4-player round robin (6 total wins across all players), it's
// impossible to get a clean 2-way tie at the rank-2/rank-3 cutoff from groupPoints alone with
// unique 1st and 4th place — any groupPoints split that ties exactly two middle players forces
// a fractional win count for the other two. So this scenario reuses the same 3-way cyclic win
// pattern as the 3+-way scenarios (position 0 sweeps at 3 groupPoints; positions 1/2/3 cycle at
// 1 groupPoints each), then directly bumps two of the three 1-point entries' ratingAvg/ratingCount
// (resolveGroup's next tiebreak fields after groupPoints) to pull them together and above the
// third — narrowing the disputed cluster from 3 members down to exactly 2, with the third pushed
// to an uncontested rank 4. This fixture manipulation isn't under test; only resolveGroup's
// 2-way branch and createTiebreakerMatch are.
async function runTwoWayTiebreakerScenario() {
  await mongoose.connect(MONGO_URI);
  log(`Connected to ${MONGO_URI}. Server assumed running at ${BASE_URL}.`);

  const ctx = await setupThroughActiveGroupStage();
  const { tournament, voterActor, groupMatches, activeAt, groups } = ctx;

  const groupA = groups.find(g => g.label === 'A'); // deliberately tied (2-way)
  const groupB = groups.find(g => g.label === 'B'); // resolved cleanly, for isolation
  if (!groupA || !groupB) throw new Error('Expected TournamentGroup docs labeled "A" and "B"');

  const positionOf = new Map(groupA.memberIds.map((id, i) => [id.toString(), i]));
  const [te1, te2] = await Promise.all([
    TournamentEntry.findById(groupA.memberIds[1]).select('entryId').lean(),
    TournamentEntry.findById(groupA.memberIds[2]).select('entryId').lean(),
  ]);

  log('\n=== Phase 7: Differentiating position 3 so only positions 1/2 remain tied for the boundary ===');
  await Entry.updateMany({ _id: { $in: [te1.entryId, te2.entryId] } }, { $set: { ratingAvg: 5, ratingCount: 3 } });
  log('  Positions 1 & 2\'s entries bumped to ratingAvg=5 (position 3 stays at the default 0) — all three still tie on groupPoints, but only 1 & 2 now tie on every resolveGroup criterion.');

  log(`\n=== Phase 8: Playing out the group stage (forcing a 3-way groupPoints tie, narrowed to a 2-way tie in Group ${groupA.label}) ===`);
  const rounds = bucketByRound(groupMatches, activeAt.getTime());
  if (rounds.length !== 3) flag(`Expected 3 rounds of group play, found ${rounds.length}`);
  for (let r = 0; r < rounds.length; r++) {
    const winnerFn = m => m.groupId.toString() === groupA._id.toString()
      ? pickWinnerCyclic(m, positionOf)
      : pickWinner(m);
    await playRound(rounds[r], r, winnerFn, voterActor);
  }

  log('\n=== Phase 9: Verifying a plain tiebreaker match was created (not the jury chain) ===');
  await poll(async () => {
    const g = await TournamentGroup.findById(groupB._id).select('status').lean();
    return g.status === 'complete' ? g : null;
  }, { timeoutMs: 8000, label: `Group ${groupB.label} (clean) status === complete` }).catch(e => flag(e.message));

  const tbMatch = await poll(async () => {
    return TournamentMatch.findOne({ groupId: groupA._id, isTiebreakerMatch: true }).lean();
  }, { timeoutMs: 8000, label: 'tiebreaker TournamentMatch created' }).catch(() => null);
  if (!tbMatch) throw new Error('No tiebreaker match was created — the 2-way tie was not detected at all');

  const pausedGroupA = await TournamentGroup.findById(groupA._id).lean();
  if (pausedGroupA.status === 'complete') flag(`Group ${groupA.label} resolved to "complete" before the tiebreaker match closed — it should have paused`);
  if (pausedGroupA.tieStatus) flag(`Expected tieStatus to stay null for a 2-way tiebreaker (this is NOT the jury/organizer chain), got "${pausedGroupA.tieStatus}"`);
  if (tbMatch.stage !== 'group') flag(`Expected the tiebreaker match's stage to be "group", got "${tbMatch.stage}"`);

  const tbEntryIds = [tbMatch.tournamentEntryIdA.toString(), tbMatch.tournamentEntryIdB.toString()].sort();
  const expectedIds = [groupA.memberIds[1].toString(), groupA.memberIds[2].toString()].sort();
  if (JSON.stringify(tbEntryIds) !== JSON.stringify(expectedIds)) {
    flag(`Tiebreaker match paired the wrong two entries — got [${tbEntryIds}], expected [${expectedIds}]`);
  } else {
    log('  Tiebreaker match correctly pairs exactly the two tied entries (positions 1 and 2), stage="group", no tieStatus set.');
  }

  log('\n=== Phase 10: Voting on and closing the tiebreaker match (position 1 designated winner) ===');
  const winnerEntryId = tbMatch.entryIdA.toString() === te1.entryId.toString() ? tbMatch.entryIdA : tbMatch.entryIdB;
  await castVoteAndClose(voterActor, tbMatch, winnerEntryId);

  const resolvedGroupA = await poll(async () => {
    const g = await TournamentGroup.findById(groupA._id).lean();
    return g.status === 'complete' ? g : null;
  }, { timeoutMs: 5000, label: `Group ${groupA.label} status === complete after the tiebreaker match closed` }).catch(async () => TournamentGroup.findById(groupA._id).lean());
  if (resolvedGroupA.status !== 'complete') flag(`Group ${groupA.label} did not resolve to "complete" after the tiebreaker match closed`);

  const pos0TE = await TournamentEntry.findById(groupA.memberIds[0]).select('groupRank eliminated').lean();
  const winnerTE = await TournamentEntry.findById(groupA.memberIds[1]).select('groupRank eliminated').lean();
  const loserTE = await TournamentEntry.findById(groupA.memberIds[2]).select('groupRank eliminated').lean();
  const pos3TE = await TournamentEntry.findById(groupA.memberIds[3]).select('groupRank eliminated').lean();

  if (pos0TE.groupRank !== 1 || pos0TE.eliminated) flag(`Position 0 (clean 3-0 sweep) should have groupRank exactly 1, got rank=${pos0TE.groupRank} eliminated=${pos0TE.eliminated}`);
  if (winnerTE.groupRank !== 2 || winnerTE.eliminated) flag(`The tiebreaker match's winner should have groupRank exactly 2, got rank=${winnerTE.groupRank} eliminated=${winnerTE.eliminated}`);
  if (!loserTE.eliminated || loserTE.groupRank) flag(`The tiebreaker match's loser should be eliminated with no groupRank, got rank=${loserTE.groupRank} eliminated=${loserTE.eliminated}`);
  if (!pos3TE.eliminated || pos3TE.groupRank) flag(`Position 3 (differentiated via ratingAvg) should be cleanly eliminated with no groupRank, got rank=${pos3TE.groupRank} eliminated=${pos3TE.eliminated}`);
  if (pos0TE.groupRank === 1 && winnerTE.groupRank === 2 && loserTE.eliminated && pos3TE.eliminated) {
    log('  Ranks assigned exactly as expected: rank 1 = clean sweep, rank 2 = tiebreaker winner, ranks 3-4 (eliminated, no groupRank) = tiebreaker loser + the differentiated entry.');
  }

  // Plain tiebreaker matches never touch TournamentGroupTieVote/TournamentJuryVote or the jury
  // at all — no juror is ever notified or asked to vote for an ordinary 2-way tie.
  await playKnockoutAndVerifyClose(ctx, { expectGroupTieVotes: 0, expectBannedJurorIds: [] });
  printSummary(tournament._id);
}

// ------------------------------------------------------ scenario: open-underfill-cancel ---
// Fewer candidates submit than the tournament's size cap by the open-phase deadline ->
// tournamentOpenExpiry() should auto-cancel the tournament (reason: 'insufficient_candidates')
// instead of transitioning to cooldown, refund the organizer's full prize pool, release the jury
// with no penalty, and notify the organizer + every contestant who did submit.
async function runOpenUnderfillCancelScenario() {
  await mongoose.connect(MONGO_URI);
  log(`Connected to ${MONGO_URI}. Server assumed running at ${BASE_URL}.`);

  // Only 5 of the 8 seeded contestants submit — size cap is 8, so this deliberately under-fills.
  const SUBMIT_COUNT = 5;
  const setup = await setupThroughSubmission({ submitCount: SUBMIT_COUNT });
  const { tournament, organizer, jurors } = setup;

  const preCancelBalance = await User.findById(organizer._id).select('wallet').lean();
  log(`\nOrganizer's purchasedCHL after the 500 CHL prize-pool debit at creation: ${preCancelBalance.wallet.purchasedCHL} (started at 1000).`);
  if (preCancelBalance.wallet.purchasedCHL !== 500) {
    flag(`Expected organizer's purchasedCHL to be 500 (1000 - 500 prize pool) right after creation, found ${preCancelBalance.wallet.purchasedCHL}`);
  }

  log('\n=== Phase 4: Forcing the open-phase deadline with an under-filled roster ===');
  await tournamentOpenExpiry(tournament._id);

  const fresh = await Tournament.findById(tournament._id).lean();
  if (fresh.status !== 'canceled') {
    throw new Error(`Expected status "canceled" after tournamentOpenExpiry() with ${SUBMIT_COUNT}/8 submitted, got "${fresh.status}"`);
  }
  if (fresh.cancelReason !== 'insufficient_candidates') {
    flag(`Expected cancelReason "insufficient_candidates", got "${fresh.cancelReason}"`);
  }
  log(`Tournament correctly auto-canceled: status=${fresh.status}, cancelReason=${fresh.cancelReason}.`);

  log('\n=== Phase 5: Verifying the jury was released with no penalty ===');
  const remainingJury = await TournamentJury.countDocuments({ tournamentId: tournament._id });
  if (remainingJury !== 0) flag(`Expected all 6 TournamentJury docs deleted on cancellation (no penalty owed), found ${remainingJury} remaining`);
  else log('  All 6 jury invites released — no TournamentJury docs remain.');

  log("\n=== Phase 6: Verifying the organizer's prize pool was refunded ===");
  const postCancelUser = await User.findById(organizer._id).select('wallet').lean();
  if (postCancelUser.wallet.purchasedCHL !== 1000) {
    flag(`Expected organizer's purchasedCHL refunded back to 1000 (500 + 500 refund), found ${postCancelUser.wallet.purchasedCHL}`);
  } else {
    log('  Organizer\'s purchasedCHL correctly refunded back to 1000 (the full 350+100+50 prize pool).');
  }

  const refundTx = await WalletTransaction.findOne({ userId: organizer._id, type: 'tournament_prize_refund' }).lean();
  if (!refundTx) flag('Expected a WalletTransaction with type "tournament_prize_refund", found none');
  else if (refundTx.amountCHL !== 500) flag(`Expected the refund WalletTransaction to be 500 CHL, found ${refundTx.amountCHL}`);
  else log('  WalletTransaction audit record correctly created for the 500 CHL refund.');

  log('\n=== Phase 7: Verifying notifications ===');
  const cancelNotifs = await Notification.countDocuments({ type: 'tournament_canceled', 'payload.tournamentId': tournament._id });
  // 1 to the organizer + 1 to each of the SUBMIT_COUNT contestants who actually submitted
  // (cancelTournament excludes the organizer from the contestant-notification loop, but the
  // organizer already gets their own separate notification just above it in the same function).
  const expectedNotifs = 1 + SUBMIT_COUNT;
  if (cancelNotifs !== expectedNotifs) {
    flag(`Expected ${expectedNotifs} tournament_canceled notifications (1 organizer + ${SUBMIT_COUNT} contestants who submitted), found ${cancelNotifs}`);
  } else {
    log(`  ${cancelNotifs} tournament_canceled notifications fired correctly (organizer + all ${SUBMIT_COUNT} submitted contestants).`);
  }

  // The 3 contestants who never got around to submitting shouldn't be notified about a
  // tournament they never actually joined.
  const nonSubmitterIds = setup.contestants.slice(SUBMIT_COUNT).map(c => c._id);
  const wrongfulNotifs = await Notification.countDocuments({
    type: 'tournament_canceled', 'payload.tournamentId': tournament._id, userId: { $in: nonSubmitterIds },
  });
  if (wrongfulNotifs !== 0) flag(`${wrongfulNotifs} contestant(s) who never submitted were incorrectly notified of the cancellation`);

  const bannedJurors = await User.countDocuments({ _id: { $in: jurors.map(j => j._id) }, juryBanned: true });
  if (bannedJurors !== 0) flag(`${bannedJurors} juror(s) were incorrectly banned despite the tournament canceling before any jury service began`);

  printSummary(tournament._id);
}

// ------------------------------------------------------------ scenario: creation-boundaries ---
// A bundle of independent probes against the creation wizard's validation, none of which need
// the tournament to progress past creation — each uses its own minimal fixture organizer(s)
// rather than the shared 8-contestant/6-juror setup.
async function runCreationBoundariesScenario() {
  await mongoose.connect(MONGO_URI);
  log(`Connected to ${MONGO_URI}. Server assumed running at ${BASE_URL}.`);
  await ensureAgendaReady();

  async function eligibleOrganizer(tag, { followerCount, contributionCount, purchasedCHL = 1000 }) {
    const u = await makeUser({ tag, idVerified: true, purchasedCHL });
    await seedOrganizerEligibility(u._id, { followerCount, contributionCount });
    const actor = newActor();
    await login(actor, u.email.value);
    return { user: u, actor };
  }

  // ---- 1. Follower-count boundary (>250 required) ----
  log('\n=== Phase 1: Follower-count eligibility boundary (>250 required) ===');
  const { actor: at250 } = await eligibleOrganizer('org250followers', { followerCount: 250, contributionCount: 5 });
  let r = await httpReq(at250, 'GET', '/tournaments/create/step1');
  if (r.status !== 302) flag(`Expected exactly 250 followers to be BLOCKED (302 redirect) from step1, got ${r.status}`);
  else log('  250 followers (not > 250): correctly blocked.');

  const { actor: at251 } = await eligibleOrganizer('org251followers', { followerCount: 251, contributionCount: 5 });
  r = await httpReq(at251, 'GET', '/tournaments/create/step1');
  if (r.status !== 200) flag(`Expected 251 followers to be ALLOWED (200) on step1, got ${r.status}`);
  else log('  251 followers: correctly allowed.');

  // ---- 2. Contest-contribution boundary (>=5 required) ----
  log('\n=== Phase 2: Contest-contribution eligibility boundary (>=5 required) ===');
  const { actor: at4contribs } = await eligibleOrganizer('org4contribs', { followerCount: 300, contributionCount: 4 });
  r = await httpReq(at4contribs, 'GET', '/tournaments/create/step1');
  if (r.status !== 302) flag(`Expected 4 contest contributions to be BLOCKED (302), got ${r.status}`);
  else log('  4 contributions (< 5): correctly blocked.');

  const { actor: at5contribs } = await eligibleOrganizer('org5contribs', { followerCount: 300, contributionCount: 5 });
  r = await httpReq(at5contribs, 'GET', '/tournaments/create/step1');
  if (r.status !== 200) flag(`Expected 5 contest contributions to be ALLOWED (200), got ${r.status}`);
  else log('  5 contributions: correctly allowed.');

  // ---- 3. Concurrent-tournament boundary (< 3 required) ----
  log('\n=== Phase 3: Concurrent-tournament eligibility boundary (max 3 open/cooldown/active) ===');
  async function fixtureTournament(createdBy) {
    return Tournament.create({
      createdBy, name: `${TAG}fixture_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      thumbnailUrl: '/uploads/tournaments/fake.png', size: 8, groupSize: 4, groupCount: 2,
      prizes: { first: 350, second: 100, third: 50 }, status: 'open',
      openDeadline: new Date(Date.now() + DAY_MS),
    });
  }
  const { user: orgWith2, actor: actorWith2 } = await eligibleOrganizer('orgWith2concurrent', { followerCount: 300, contributionCount: 5 });
  await fixtureTournament(orgWith2._id);
  await fixtureTournament(orgWith2._id);
  r = await httpReq(actorWith2, 'GET', '/tournaments/create/step1');
  if (r.status !== 200) flag(`Expected 2 existing concurrent tournaments to still ALLOW a 3rd (200), got ${r.status}`);
  else log('  2 existing concurrent tournaments: correctly still allowed (below the cap of 3).');

  const { user: orgWith3, actor: actorWith3 } = await eligibleOrganizer('orgWith3concurrent', { followerCount: 300, contributionCount: 5 });
  await fixtureTournament(orgWith3._id);
  await fixtureTournament(orgWith3._id);
  await fixtureTournament(orgWith3._id);
  r = await httpReq(actorWith3, 'GET', '/tournaments/create/step1');
  if (r.status !== 302) flag(`Expected 3 existing concurrent tournaments to BLOCK a 4th (302), got ${r.status}`);
  else log('  3 existing concurrent tournaments: correctly blocked from starting a 4th.');

  // ---- 4. Jury size boundary (5-7 required) ----
  log('\n=== Phase 4: Jury size boundary (5-7 required) ===');
  const { actor: juryOrgActor } = await eligibleOrganizer('juryBoundaryOrg', { followerCount: 300, contributionCount: 5 });
  const candidateJurors = [];
  for (let i = 0; i < 8; i++) candidateJurors.push(await makeUser({ tag: `jurycand${i}` }));

  const step1Form = new FormData();
  step1Form.append('name', `Sim Jury Boundary ${Date.now()}`);
  step1Form.append('size', '8');
  step1Form.append('openDays', '1');
  step1Form.append('visibility', 'public');
  step1Form.append('thumbnail', tinyImageBlob(), 'thumb.png');
  r = await httpReq(juryOrgActor, 'POST', '/tournaments/create/step1', { body: step1Form, isForm: true });
  if (r.status !== 302) throw new Error(`Jury-boundary fixture step1 failed: ${r.status} ${await r.text()}`);
  r = await httpReq(juryOrgActor, 'POST', '/tournaments/create/step2', { body: { prizeFirst: '350', prizeSecond: '100', prizeThird: '50' } });
  if (r.status !== 302) throw new Error(`Jury-boundary fixture step2 failed: ${r.status} ${await r.text()}`);
  r = await httpReq(juryOrgActor, 'POST', '/tournaments/create/step3', { body: { criteria: '[]' } });
  if (r.status !== 302) throw new Error(`Jury-boundary fixture step3 failed: ${r.status} ${await r.text()}`);

  async function tryJuryCount(n, expectSuccess) {
    const body = new URLSearchParams();
    candidateJurors.slice(0, n).forEach(j => body.append('juryUserIds', j._id.toString()));
    const res = await fetch(BASE_URL + '/tournaments/create/step4', {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: juryOrgActor.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const ok = expectSuccess ? res.status === 302 : res.status === 200;
    if (!ok) flag(`Jury count ${n}: expected ${expectSuccess ? '302 (accepted)' : '200 (rejected)'}, got ${res.status}`);
    else log(`  Jury count ${n}: correctly ${expectSuccess ? 'accepted' : 'rejected'}.`);
  }
  await tryJuryCount(4, false);
  await tryJuryCount(5, true);
  await tryJuryCount(8, false);
  await tryJuryCount(7, true);

  // ---- 5. Private-visibility tournament ----
  log('\n=== Phase 5: Private-visibility tournament — excluded from browse, reachable by direct link ===');
  const { actor: privOrgActor } = await eligibleOrganizer('privOrg', { followerCount: 300, contributionCount: 5 });
  const privName = `Sim Private ${Date.now()}`;
  const privForm = new FormData();
  privForm.append('name', privName);
  privForm.append('size', '8');
  privForm.append('openDays', '1');
  privForm.append('visibility', 'private');
  privForm.append('thumbnail', tinyImageBlob(), 'thumb.png');
  r = await httpReq(privOrgActor, 'POST', '/tournaments/create/step1', { body: privForm, isForm: true });
  if (r.status !== 302) throw new Error(`Private-tournament fixture step1 failed: ${r.status} ${await r.text()}`);
  r = await httpReq(privOrgActor, 'POST', '/tournaments/create/step2', { body: { prizeFirst: '350', prizeSecond: '100', prizeThird: '50' } });
  r = await httpReq(privOrgActor, 'POST', '/tournaments/create/step3', { body: { criteria: '[]' } });
  const privJuryBody = new URLSearchParams();
  for (let i = 0; i < 5; i++) privJuryBody.append('juryUserIds', (await makeUser({ tag: `privjury${i}` }))._id.toString());
  r = await fetch(BASE_URL + '/tournaments/create/step4', {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: privOrgActor.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: privJuryBody.toString(),
  });
  if (r.status !== 302) throw new Error(`Private-tournament fixture step4 failed: ${r.status} ${await r.text()}`);
  r = await httpReq(privOrgActor, 'POST', '/tournaments/create/step5', { body: {} });
  if (r.status !== 302) throw new Error(`Private-tournament fixture step5 failed: ${r.status} ${await r.text()}`);

  const privTournament = await Tournament.findOne({ name: privName }).lean();
  if (!privTournament) throw new Error('Private tournament not found after creation');
  if (privTournament.visibility !== 'private') flag(`Expected visibility "private", got "${privTournament.visibility}"`);

  const { actor: bystanderActor } = await eligibleOrganizer('privBystander', { followerCount: 0, contributionCount: 0 });
  const browseRes = await httpReq(bystanderActor, 'GET', '/tournaments');
  const browseHtml = await browseRes.text();
  if (browseHtml.includes(privName)) flag('Private tournament name appeared in a non-organizer\'s /tournaments browse listing — should be excluded');
  else log('  Private tournament correctly excluded from a non-organizer\'s browse listing.');

  const directRes = await httpReq(bystanderActor, 'GET', `/tournament/${privTournament._id}`);
  if (directRes.status !== 200) flag(`Expected a private tournament to still be reachable by direct link (200), got ${directRes.status}`);
  else log('  Private tournament still reachable by a non-organizer via direct link.');

  // ---- 6. Insufficient-funds inline funding path ----
  log('\n=== Phase 6: Insufficient-funds inline funding path (including the >500-per-payment cap) ===');
  const { user: fundOrgUserSeed, actor: fundOrgActor } = await eligibleOrganizer('fundOrg', { followerCount: 300, contributionCount: 5, purchasedCHL: 0 });
  const fundForm = new FormData();
  fundForm.append('name', `Sim Fund ${Date.now()}`);
  fundForm.append('size', '8');
  fundForm.append('openDays', '1');
  fundForm.append('visibility', 'public');
  fundForm.append('thumbnail', tinyImageBlob(), 'thumb.png');
  r = await httpReq(fundOrgActor, 'POST', '/tournaments/create/step1', { body: fundForm, isForm: true });
  if (r.status !== 302) throw new Error(`Fund-scenario fixture step1 failed: ${r.status} ${await r.text()}`);

  // Prizes well above the legal minimums so total (1300) exceeds the 500-CHL single-payment cap.
  const step2Res = await httpReq(fundOrgActor, 'POST', '/tournaments/create/step2', {
    body: { prizeFirst: '1000', prizeSecond: '200', prizeThird: '100' },
  });
  const step2Html = await step2Res.text();
  // The template never uses the word "insufficient" — it renders "You need X more to fund this
  // prize pool", with the shortfall formatted via toLocaleString() (so 1300 -> "1,300").
  if (step2Res.status !== 200 || !step2Html.includes('1,300') || !step2Html.includes('more to fund this prize pool')) {
    flag(`Expected step2 to render the insufficient-funds branch (200, "1,300" shortfall shown) for a 1300 CHL total against a 0 CHL balance, got ${step2Res.status}`);
  } else {
    log('  Step2 correctly detected insufficient funds (1,300 CHL needed, 0 CHL available).');
  }

  const overCapRes = await httpReq(fundOrgActor, 'POST', '/tournaments/fund', { body: { amountCHL: '1300' } });
  if (overCapRes.status !== 302 && overCapRes.status !== 400) {
    flag(`Expected a single 1300 CHL top-up (over the 500 cap) to be rejected, got ${overCapRes.status}`);
  }
  const afterOverCap = await User.findById(fundOrgUserSeed._id).select('wallet').lean();
  if (afterOverCap.wallet.purchasedCHL !== 0) flag(`Expected the over-cap top-up attempt to be fully rejected (balance still 0), found ${afterOverCap.wallet.purchasedCHL}`);
  else log('  A single 1300 CHL top-up (over the 500-per-request cap) was correctly rejected outright — confirms multiple payments are genuinely required, not just a UI suggestion.');

  for (const amount of [500, 500, 300]) {
    const fundRes = await httpReq(fundOrgActor, 'POST', '/tournaments/fund', { body: { amountCHL: String(amount) } });
    if (fundRes.status !== 302) flag(`Top-up of ${amount} CHL failed: ${fundRes.status} ${await fundRes.text()}`);
  }
  const fundedUser = await User.findById(fundOrgUserSeed._id).select('wallet').lean();
  if (fundedUser.wallet.purchasedCHL !== 1300) flag(`Expected purchasedCHL 1300 after 3 top-ups (500+500+300), found ${fundedUser.wallet.purchasedCHL}`);
  else log('  3 separate top-ups (500+500+300=1300) correctly accumulated.');

  const finalStep2Res = await httpReq(fundOrgActor, 'POST', '/tournaments/create/step2', {
    body: { prizeFirst: '1000', prizeSecond: '200', prizeThird: '100' },
  });
  if (finalStep2Res.status !== 302) flag(`Expected step2 to now succeed (302) with sufficient funds, got ${finalStep2Res.status}`);
  else log('  Step2 now succeeds once the balance covers the full prize pool.');

  printSummary('creation-boundaries (no single tournament id — multiple fixture organizers)');
}

// ---------------------------------------------------------------- scenario: open-phase-edges ---
// Three independent open-phase probes: organizer self-submission must be blocked; a fresh entry
// whose tags match a tournament's wildcardStains must auto-draft into it even without explicitly
// targeting it; and a submitted-but-not-yet-reviewed candidate whose Entry gets deleted out from
// under it must not crash the organizer's review action.
async function runOpenPhaseEdgesScenario() {
  await mongoose.connect(MONGO_URI);
  log(`Connected to ${MONGO_URI}. Server assumed running at ${BASE_URL}.`);
  await ensureAgendaReady();

  async function makeEligibleOrganizer(tag) {
    const u = await makeUser({ tag, idVerified: true, purchasedCHL: 1000 });
    await seedOrganizerEligibility(u._id);
    const actor = newActor();
    await login(actor, u.email.value);
    return { user: u, actor };
  }

  async function createTournament(organizerActor, { name, wildcardStains = [] }) {
    const form = new FormData();
    form.append('name', name);
    form.append('size', '8');
    form.append('openDays', '1');
    form.append('visibility', 'public');
    for (const s of wildcardStains) form.append('wildcardStains', s);
    form.append('thumbnail', tinyImageBlob(), 'thumb.png');
    let r = await httpReq(organizerActor, 'POST', '/tournaments/create/step1', { body: form, isForm: true });
    if (r.status !== 302) throw new Error(`step1 failed: ${r.status} ${await r.text()}`);
    r = await httpReq(organizerActor, 'POST', '/tournaments/create/step2', { body: { prizeFirst: '350', prizeSecond: '100', prizeThird: '50' } });
    if (r.status !== 302) throw new Error(`step2 failed: ${r.status} ${await r.text()}`);
    r = await httpReq(organizerActor, 'POST', '/tournaments/create/step3', { body: { criteria: '[]' } });
    if (r.status !== 302) throw new Error(`step3 failed: ${r.status} ${await r.text()}`);
    const juryBody = new URLSearchParams();
    for (let i = 0; i < 5; i++) juryBody.append('juryUserIds', (await makeUser({ tag: `${name}jury${i}` }))._id.toString());
    r = await fetch(BASE_URL + '/tournaments/create/step4', {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: organizerActor.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: juryBody.toString(),
    });
    if (r.status !== 302) throw new Error(`step4 failed: ${r.status} ${await r.text()}`);
    r = await httpReq(organizerActor, 'POST', '/tournaments/create/step5', { body: {} });
    if (r.status !== 302) throw new Error(`step5 failed: ${r.status} ${await r.text()}`);
    const t = await Tournament.findOne({ name }).lean();
    if (!t) throw new Error(`Tournament "${name}" not found after creation`);
    return t;
  }

  async function uploadEntry(actor, { title, tags = [], tournamentId = null }) {
    const form = new FormData();
    form.append('title', title);
    if (tournamentId) form.append('tournamentId', tournamentId.toString());
    for (const t of tags) form.append('tags', t);
    form.append('entryMedia', tinyImageBlob(), 'entry.png');
    const r = await httpReq(actor, 'POST', '/api/entries', { body: form, isForm: true });
    if (r.status !== 200) throw new Error(`Entry upload failed: ${r.status} ${await r.text()}`);
    return r.json();
  }

  // ---- 1. Organizer self-submission blocked ----
  log('\n=== Phase 1: Organizer attempts to submit an entry to their own tournament ===');
  const { user: org1, actor: org1Actor } = await makeEligibleOrganizer('selfsubmitorg');
  const t1 = await createTournament(org1Actor, { name: `Sim SelfSubmit ${Date.now()}` });
  const selfSubmitJson = await uploadEntry(org1Actor, { title: 'Organizer self-entry', tournamentId: t1._id });
  if (selfSubmitJson.tournamentSubmission?.success !== false) {
    flag(`Expected organizer self-submission to fail, got tournamentSubmission=${JSON.stringify(selfSubmitJson.tournamentSubmission)}`);
  } else if (!/own tournament/i.test(selfSubmitJson.tournamentSubmission.reason || '')) {
    flag(`Expected a reason mentioning "own tournament", got "${selfSubmitJson.tournamentSubmission.reason}"`);
  } else {
    log(`  Organizer self-submission correctly blocked: "${selfSubmitJson.tournamentSubmission.reason}"`);
  }
  const orgEntryCount = await TournamentEntry.countDocuments({ tournamentId: t1._id, userId: org1._id });
  if (orgEntryCount !== 0) flag(`Expected 0 TournamentEntry docs for the organizer, found ${orgEntryCount}`);

  // ---- 2. Wildcard-stain auto-draft ----
  log('\n=== Phase 2: Wildcard-stain auto-draft (entry uploaded without explicitly targeting the tournament) ===');
  const { actor: org2Actor } = await makeEligibleOrganizer('wildcardorg');
  const t2 = await createTournament(org2Actor, { name: `Sim Wildcard ${Date.now()}`, wildcardStains: ['brunch'] });

  const matchingUser = await makeUser({ tag: 'wildcardmatch', idVerified: true });
  const matchingActor = newActor();
  await login(matchingActor, matchingUser.email.value);
  const matchJson = await uploadEntry(matchingActor, { title: 'Matches the wildcard stain', tags: ['brunch'] });
  // attemptTournamentAutoDraft() is explicitly fire-and-forget in the route
  // (`.catch(() => {})`, never awaited — "must never affect the entry-creation response" per its
  // own comment), so checking immediately after the HTTP response races it. Poll instead.
  const autoEntry = await poll(async () => {
    return TournamentEntry.findOne({ tournamentId: t2._id, userId: matchingUser._id }).lean();
  }, { timeoutMs: 3000, label: 'auto-drafted TournamentEntry to appear' }).catch(() => null);
  if (!autoEntry) flag('Expected an entry tagged "brunch" to auto-draft into the tournament (wildcardStains: ["brunch"]), but no TournamentEntry was created');
  else if (!autoEntry.autoSubmitted) flag('Auto-drafted TournamentEntry exists but autoSubmitted is not true');
  else log('  Entry with a matching tag correctly auto-drafted (autoSubmitted: true), despite never explicitly targeting the tournament.');

  const nonMatchingUser = await makeUser({ tag: 'wildcardnomatch', idVerified: true });
  const nonMatchingActor = newActor();
  await login(nonMatchingActor, nonMatchingUser.email.value);
  await uploadEntry(nonMatchingActor, { title: 'Does not match the wildcard stain', tags: ['unrelated'] });
  // Give the (also fire-and-forget) auto-draft attempt the same window to prove a negative fairly.
  await new Promise(r => setTimeout(r, 500));
  const noAutoEntry = await TournamentEntry.findOne({ tournamentId: t2._id, userId: nonMatchingUser._id }).lean();
  if (noAutoEntry) flag('An entry with a non-matching tag was unexpectedly auto-drafted into the tournament');
  else log('  Entry with a non-matching tag correctly did NOT auto-draft (control case).');

  // ---- 3. Mid-review Entry deletion ----
  log("\n=== Phase 3: A submitted candidate's Entry is deleted before the organizer reviews it ===");
  const { actor: org3Actor } = await makeEligibleOrganizer('midreviewdelorg');
  const t3 = await createTournament(org3Actor, { name: `Sim MidReviewDelete ${Date.now()}` });

  const doomedUser = await makeUser({ tag: 'doomedcandidate', idVerified: true });
  const doomedActor = newActor();
  await login(doomedActor, doomedUser.email.value);
  const doomedForm = new FormData();
  doomedForm.append('title', 'About to be deleted');
  doomedForm.append('tournamentId', t3._id.toString());
  doomedForm.append('entryMedia', tinyImageBlob(), 'entry.png');
  const doomedRes = await httpReq(doomedActor, 'POST', '/api/entries', { body: doomedForm, isForm: true });
  const doomedJson = await doomedRes.json();
  if (!doomedJson.tournamentSubmission?.success) throw new Error(`Doomed candidate's submission failed: ${JSON.stringify(doomedJson.tournamentSubmission)}`);

  const doomedTE = await TournamentEntry.findOne({ tournamentId: t3._id, userId: doomedUser._id }).lean();
  if (!doomedTE) throw new Error('Doomed candidate TournamentEntry not found');
  await Entry.deleteOne({ _id: doomedJson.entryId });
  log(`  Deleted Entry ${doomedJson.entryId} while its TournamentEntry (${doomedTE._id}) is still "pending" review.`);

  // Fixed in routes/api.js after the orphaned-entry-crash scenario (see the simulation report,
  // §14.4 + the follow-up scenario) confirmed approving this silently used to crash bracket
  // generation later, permanently wedging the tournament. The approve route now checks the
  // underlying Entry still exists first.
  const approveRes = await httpReq(org3Actor, 'POST', `/api/tournaments/${t3._id}/entries/${doomedTE._id}/approve`, { body: {} });
  if (approveRes.status !== 409) {
    flag(`Expected approving a TournamentEntry whose underlying Entry was deleted to be blocked (409), got ${approveRes.status}: ${(await approveRes.text()).slice(0, 200)}`);
  } else {
    log('  Approving an orphaned TournamentEntry correctly blocked (409).');
  }
  const doomedTEAfter = await TournamentEntry.findById(doomedTE._id).select('approvalStatus').lean();
  if (doomedTEAfter.approvalStatus !== 'pending') flag(`Expected the orphaned TournamentEntry to remain "pending" after the blocked approve, got "${doomedTEAfter.approvalStatus}"`);

  printSummary('open-phase-edges (no single tournament id — multiple fixture tournaments)');
}

// ------------------------------------------------------------------ scenario: cooldown-edges ---
// Two tournaments: one lets the 24h cooldown review window expire incomplete (auto-cancel), the
// other combines "approve during open" (review runs on a rolling basis, not cooldown-only) with
// an organizer self-cancel once over-rejection makes reaching the exact size cap impossible.
async function runCooldownEdgesScenario() {
  await mongoose.connect(MONGO_URI);
  log(`Connected to ${MONGO_URI}. Server assumed running at ${BASE_URL}.`);
  // No separate agenda-ready wait here — setupThroughSubmission() (called below) already does
  // it. agenda's 'ready' event only fires once ever; registering a second `.once('ready', ...)`
  // listener after it already fired hangs forever (that's exactly what happened here originally).

  async function assertCanceled(tournamentId, expectedReason, { expectedNotifiedCount, jurors }) {
    const t = await Tournament.findById(tournamentId).lean();
    if (t.status !== 'canceled') flag(`Expected status "canceled", got "${t.status}"`);
    if (t.cancelReason !== expectedReason) flag(`Expected cancelReason "${expectedReason}", got "${t.cancelReason}"`);

    const remainingJury = await TournamentJury.countDocuments({ tournamentId });
    if (remainingJury !== 0) flag(`Expected all jury docs released on cancellation, found ${remainingJury} remaining`);

    const organizer = await Tournament.findById(tournamentId).select('createdBy').lean();
    const orgUser = await User.findById(organizer.createdBy).select('wallet').lean();
    if (orgUser.wallet.purchasedCHL !== 1000) flag(`Expected organizer's purchasedCHL refunded back to 1000, found ${orgUser.wallet.purchasedCHL}`);

    const refundTx = await WalletTransaction.findOne({ userId: organizer.createdBy, type: 'tournament_prize_refund' }).lean();
    if (!refundTx || refundTx.amountCHL !== 500) flag(`Expected a 500 CHL "tournament_prize_refund" WalletTransaction, found ${refundTx ? refundTx.amountCHL : 'none'}`);

    const cancelNotifs = await Notification.countDocuments({ type: 'tournament_canceled', 'payload.tournamentId': tournamentId });
    if (cancelNotifs !== expectedNotifiedCount) flag(`Expected ${expectedNotifiedCount} tournament_canceled notifications, found ${cancelNotifs}`);

    if (jurors) {
      const bannedJurors = await User.countDocuments({ _id: { $in: jurors.map(j => j._id) }, juryBanned: true });
      if (bannedJurors !== 0) flag(`${bannedJurors} juror(s) incorrectly banned despite the tournament canceling before any jury service began`);
    }
    return t;
  }

  // ---- Tournament A: cooldown review-timeout auto-cancel ----
  log('\n=== Tournament A: organizer never finishes reviewing within the 24h cooldown window ===');
  const setupA = await setupThroughSubmission({ submitCount: 8 });
  await tournamentOpenExpiry(setupA.tournament._id);
  let freshA = await Tournament.findById(setupA.tournament._id).lean();
  if (freshA.status !== 'cooldown') throw new Error(`Expected "cooldown", got "${freshA.status}"`);

  const pendingA = await TournamentEntry.find({ tournamentId: setupA.tournament._id }).lean();
  for (const te of pendingA.slice(0, 5)) {
    const r = await httpReq(setupA.organizerActor, 'POST', `/api/tournaments/${setupA.tournament._id}/entries/${te._id}/approve`, { body: {} });
    if (r.status !== 200) flag(`Approve failed: ${r.status} ${await r.text()}`);
  }
  log('  Organizer approves 5/8, then the 24h cooldown window is forced to expire with 3 still pending.');
  await tournamentCooldownExpiry(setupA.tournament._id);
  await assertCanceled(setupA.tournament._id, 'cooldown_incomplete', { expectedNotifiedCount: 1 + 8, jurors: setupA.jurors });
  log('  Correctly auto-canceled: status=canceled, cancelReason=cooldown_incomplete, jury released, prize pool refunded, all 8 submitters + organizer notified.');

  // ---- Tournament B: approve-during-open, then self-cancel after over-rejection ----
  log('\n=== Tournament B: approve while still "open" (rolling review), then self-cancel after over-rejection ===');
  const setupB = await setupThroughSubmission({ submitCount: 8 });
  const entriesB = await TournamentEntry.find({ tournamentId: setupB.tournament._id }).lean();

  const preApproveTournament = await Tournament.findById(setupB.tournament._id).select('status').lean();
  if (preApproveTournament.status !== 'open') throw new Error(`Expected tournament B to still be "open" before any deadline forcing, got "${preApproveTournament.status}"`);
  const approveWhileOpenRes = await httpReq(setupB.organizerActor, 'POST', `/api/tournaments/${setupB.tournament._id}/entries/${entriesB[0]._id}/approve`, { body: {} });
  if (approveWhileOpenRes.status !== 200) flag(`Expected approval to succeed while tournament is still "open" (rolling review), got ${approveWhileOpenRes.status}`);
  else log('  Organizer successfully approved a candidate while the tournament was still "open" — review is not cooldown-only.');
  const stillOpen = await Tournament.findById(setupB.tournament._id).select('status').lean();
  if (stillOpen.status !== 'open') flag(`Expected tournament to remain "open" after a single approval (approving doesn't itself transition status), got "${stillOpen.status}"`);

  await tournamentOpenExpiry(setupB.tournament._id);
  const afterOpenExpiryB = await Tournament.findById(setupB.tournament._id).select('status').lean();
  if (afterOpenExpiryB.status !== 'cooldown') throw new Error(`Expected tournament B to reach "cooldown", got "${afterOpenExpiryB.status}"`);

  // 1 already approved + reject 4 of the remaining 7 -> only 3 pending left, can never reach the
  // exact 8-approved cap needed (no byes allowed) -> organizer's only path forward is self-cancel.
  for (const te of entriesB.slice(1, 5)) {
    const r = await httpReq(setupB.organizerActor, 'POST', `/api/tournaments/${setupB.tournament._id}/entries/${te._id}/reject`, { body: {} });
    if (r.status !== 200) flag(`Reject failed: ${r.status} ${await r.text()}`);
  }
  log('  1 approved + 4 rejected of 8 -> only 3 pending remain, the 8-approved cap can no longer be reached (no byes).');

  const selfCancelRes = await httpReq(setupB.organizerActor, 'POST', `/tournament/${setupB.tournament._id}/cancel`, { body: {} });
  if (selfCancelRes.status !== 200) flag(`Expected the organizer's self-cancel to succeed (200), got ${selfCancelRes.status}: ${await selfCancelRes.text()}`);

  // Notified: the organizer + the 1 approved + 3 still-pending candidates (4 total) — the 4
  // rejected candidates already received their own rejection notice, not a cancellation one.
  await assertCanceled(setupB.tournament._id, 'organizer_canceled', { expectedNotifiedCount: 1 + 4, jurors: setupB.jurors });
  log('  Correctly self-canceled: status=canceled, cancelReason=organizer_canceled, jury released, prize pool refunded, approved+pending submitters notified (not the rejected ones).');

  printSummary('cooldown-edges (no single tournament id — two fixture tournaments A/B)');
}

// ------------------------------------------------------------------- scenario: knockout-tie ---
// A clean group stage (both groups resolve without dispute), then one semifinal is forced to a
// 1-1 vote tie -> the match-level jury chain (TournamentJuryVote, distinct from the group-ranking
// TournamentGroupTieVote chain exercised elsewhere) resolves it by quorum. Specifically confirms
// the SF-loser-still-gets-a-3rd-place-match bookkeeping (handleKnockoutMatchClose's SF branch
// deliberately does NOT mark an SF loser `eliminated` — only R16/QF/Final/3rd losers are).
async function runKnockoutTieScenario() {
  await mongoose.connect(MONGO_URI);
  log(`Connected to ${MONGO_URI}. Server assumed running at ${BASE_URL}.`);

  const ctx = await setupThroughActiveGroupStage();
  const { tournament, voterActor, jurorActors, jurors, groupMatches, activeAt } = ctx;

  log('\n=== Phase 7: Playing out a clean group stage (no ties) ===');
  const rounds = bucketByRound(groupMatches, activeAt.getTime());
  for (let r = 0; r < rounds.length; r++) await playRound(rounds[r], r, pickWinner, voterActor);
  await poll(async () => {
    const n = await TournamentGroup.countDocuments({ tournamentId: tournament._id, status: 'complete' });
    return n === 2 ? true : null;
  }, { timeoutMs: 8000, label: 'both TournamentGroups status === complete' }).catch(e => flag(e.message));

  log('\n=== Phase 8: Forcing a 1-1 vote tie on the first semifinal ===');
  const sfMatches = await poll(async () => {
    const ms = await TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: 'SF' }).lean();
    return ms.length === 2 ? ms : null;
  }, { timeoutMs: 8000, label: '2 SF matches created' }).catch(() => TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: 'SF' }).lean());
  if (sfMatches.length !== 2) throw new Error(`Expected 2 SF matches, found ${sfMatches.length}`);
  const [tieMatch, cleanMatch] = sfMatches;

  const voter2 = await makeUser({ tag: 'knockouttievoter2' });
  const voter2Actor = newActor();
  await login(voter2Actor, voter2.email.value);

  let r = await httpReq(voterActor, 'POST', `/api/contests/${tieMatch.contestId}/vote`, { body: { entryId: tieMatch.entryIdA.toString() } });
  if (r.status !== 200) flag(`Vote A on tie match failed: ${r.status} ${await r.text()}`);
  r = await httpReq(voter2Actor, 'POST', `/api/contests/${tieMatch.contestId}/vote`, { body: { entryId: tieMatch.entryIdB.toString() } });
  if (r.status !== 200) flag(`Vote B on tie match failed: ${r.status} ${await r.text()}`);

  await closeContest(tieMatch.contestId);
  const closedTieContest = await Contest.findById(tieMatch.contestId).select('status winnerEntryId').lean();
  if (closedTieContest.status !== 'closed') flag(`Expected the tied contest itself to still reach "closed" (only winnerEntryId is null on a tie), got "${closedTieContest.status}"`);
  if (closedTieContest.winnerEntryId) flag(`Expected a null winnerEntryId for a 1-1 vote split, got one anyway`);

  // closeContest's hook into handleTournamentMatchClose is fire-and-forget — poll for the match
  // to actually flip to the tie state instead of checking immediately (see the report's §4.3).
  const tiedMatch = await poll(async () => {
    const m = await TournamentMatch.findById(tieMatch._id).lean();
    return m.status === 'tie' ? m : null;
  }, { timeoutMs: 5000, label: 'SF match status === tie' }).catch(async () => TournamentMatch.findById(tieMatch._id).lean());

  if (tiedMatch.status !== 'tie') flag(`Expected the SF match status to be "tie", got "${tiedMatch.status}"`);
  if (tiedMatch.tieStatus !== 'jury_pending') flag(`Expected tieStatus "jury_pending", got "${tiedMatch.tieStatus}"`);
  if (!tiedMatch.tieDeadline) flag('Expected tieDeadline to be set once the match tie was raised');
  else log('  Semifinal correctly tied: status=tie, tieStatus=jury_pending, tieDeadline set.');

  // initiateTieResolution() (which inserts these notifications) runs a step AFTER the status
  // write within the same fire-and-forget chain closeContest kicks off — polling for
  // status === 'tie' above doesn't guarantee this later step has landed yet. Poll the
  // notification count itself instead of checking immediately.
  const tieJuryNotifs = await poll(async () => {
    const n = await Notification.countDocuments({ type: 'tournament_tie_jury', 'payload.tournamentId': tournament._id });
    return n === 6 ? n : null;
  }, { timeoutMs: 5000, label: '6 tournament_tie_jury notifications' }).catch(async () => Notification.countDocuments({ type: 'tournament_tie_jury', 'payload.tournamentId': tournament._id }));
  if (tieJuryNotifs !== 6) flag(`Expected 6 tournament_tie_jury notifications (one per accepted juror), found ${tieJuryNotifs}`);
  else log('  6 tournament_tie_jury notifications correctly fired (one per accepted juror).');

  log('\n=== Phase 9: 3 jurors cast their vote (real HTTP), resolving the tie by quorum ===');
  const designatedWinner = tiedMatch.entryIdA;
  for (let i = 0; i < 3; i++) {
    const jr = await httpReq(jurorActors[i], 'POST', `/api/tournaments/${tournament._id}/matches/${tiedMatch._id}/jury-vote`, {
      body: { votedForEntryId: designatedWinner.toString() },
    });
    if (jr.status !== 200) flag(`Juror ${i + 1}'s match-tie vote returned ${jr.status}: ${(await jr.text()).slice(0, 200)}`);
  }
  // resolveJuryVote() is awaited directly by the 3rd vote's route handler (unlike the
  // fire-and-forget contest-close chain), so this should already be resolved; polled as insurance.
  const resolvedMatch = await poll(async () => {
    const m = await TournamentMatch.findById(tiedMatch._id).lean();
    return m.status === 'closed' ? m : null;
  }, { timeoutMs: 5000, label: 'SF match status === closed after quorum jury vote' }).catch(async () => TournamentMatch.findById(tiedMatch._id).lean());

  if (resolvedMatch.status !== 'closed') flag('SF match did not resolve to "closed" after 3 jurors voted for the same entry');
  if (resolvedMatch.tieStatus !== 'resolved') flag(`Expected tieStatus "resolved", got "${resolvedMatch.tieStatus}"`);
  if (!resolvedMatch.winnerId || resolvedMatch.winnerId.toString() !== designatedWinner.toString()) {
    flag(`Expected winnerId to be the jury's chosen entry, got ${resolvedMatch.winnerId}`);
  } else {
    log(`  Semifinal correctly resolved via jury quorum: winner = the jury's chosen entry.`);
  }

  const juryVoteCount = await TournamentJuryVote.countDocuments({ matchId: tiedMatch._id });
  if (juryVoteCount !== 3) flag(`Expected exactly 3 TournamentJuryVote docs, found ${juryVoteCount}`);

  log('\n=== Phase 10: Verifying the SF loser is NOT eliminated yet (3rd-place match still ahead) ===');
  const loserTEId = resolvedMatch.entryIdA.toString() === designatedWinner.toString() ? resolvedMatch.tournamentEntryIdB : resolvedMatch.tournamentEntryIdA;
  const loserTE = await TournamentEntry.findById(loserTEId).select('eliminated knockoutRound').lean();
  if (loserTE.eliminated) flag('The SF tie\'s loser was incorrectly marked eliminated — SF losers still have the 3rd-place match ahead of them');
  else log('  SF loser correctly NOT marked eliminated (unlike an R16/QF/Final/3rd loser would be).');

  log('\n=== Phase 11: Closing the other semifinal normally, then the Final and 3rd-place matches ===');
  await castVoteAndClose(voterActor, cleanMatch, pickWinner(cleanMatch));

  const finalMatch = await poll(async () => {
    return TournamentMatch.findOne({ tournamentId: tournament._id, knockoutRound: 'Final' }).lean();
  }, { timeoutMs: 8000, label: 'Final match created' }).catch(() => null);
  const thirdMatch = await TournamentMatch.findOne({ tournamentId: tournament._id, knockoutRound: '3rd' }).lean();
  if (!finalMatch) throw new Error('Final match was not created after both SF matches closed');
  if (!thirdMatch) throw new Error('3rd-place match was not created after both SF matches closed');

  const thirdEntryIds = [thirdMatch.tournamentEntryIdA.toString(), thirdMatch.tournamentEntryIdB.toString()];
  if (!thirdEntryIds.includes(loserTEId.toString())) {
    flag(`Expected the tied SF's loser to appear in the 3rd-place match, but it does not (3rd-place entries: ${thirdEntryIds})`);
  } else {
    log('  The tied semifinal\'s loser correctly appears in the 3rd-place match.');
  }

  await castVoteAndClose(voterActor, finalMatch, pickWinner(finalMatch));
  await castVoteAndClose(voterActor, thirdMatch, pickWinner(thirdMatch));

  log('\n=== Phase 12: Verifying close + payout ===');
  const closedTournament = await poll(async () => {
    const t = await Tournament.findById(tournament._id).lean();
    return t.status === 'closed' ? t : null;
  }, { label: 'tournament.status === closed' }).catch(async () => {
    flag('Tournament did not auto-close after Final+3rd matches closed — had to call closeTournament() manually');
    await closeTournament(tournament._id);
    return Tournament.findById(tournament._id).lean();
  });
  if (closedTournament.status !== 'closed') throw new Error('Tournament never reached "closed" status');
  if (!closedTournament.prizes?.winnersSet) flag('Tournament closed but prizes.winnersSet is not true');
  else log('  Tournament closed successfully despite one semifinal needing a full jury tie-break.');

  const bannedJurors = await User.countDocuments({ _id: { $in: jurors.map(j => j._id) }, juryBanned: true });
  if (bannedJurors !== 0) flag(`${bannedJurors} juror(s) incorrectly banned despite the tie resolving well within the 6h window`);

  const groupTieVotes = await TournamentGroupTieVote.countDocuments({ tournamentId: tournament._id });
  if (groupTieVotes !== 0) flag(`Expected 0 group-ranking tie votes (this scenario never ties a group), found ${groupTieVotes}`);

  log('\n=== Phase 13: Verifying tournament_knockout_started actually renders on /notifications ===');
  // Every earlier scenario only confirmed the Notification document was created and that
  // views/notifications.ejs has a `case 'tournament_knockout_started'` (via a code read) — never
  // that it renders correctly in a live response. Fetch the real page as an actual recipient.
  const knockoutNotif = await Notification.findOne({ type: 'tournament_knockout_started', 'payload.tournamentId': tournament._id }).lean();
  if (!knockoutNotif) {
    flag('No tournament_knockout_started notification exists to verify rendering against');
  } else {
    const recipientIndex = ctx.contestants.findIndex(c => c._id.toString() === knockoutNotif.userId.toString());
    if (recipientIndex === -1) {
      flag('Could not find the logged-in actor matching a tournament_knockout_started notification recipient');
    } else {
      const notifRes = await httpReq(ctx.contestantActors[recipientIndex], 'GET', '/notifications');
      const notifHtml = await notifRes.text();
      if (notifRes.status !== 200) {
        flag(`Expected /notifications to return 200, got ${notifRes.status}`);
      } else if (!notifHtml.includes('advanced to the knockout stage')) {
        flag('tournament_knockout_started notification did not render its expected text ("advanced to the knockout stage") on the real /notifications page');
      } else {
        log('  tournament_knockout_started correctly renders on the real /notifications page (not just a code read).');
      }
    }
  }

  printSummary(tournament._id);
}

// ------------------------------------------------------------------- scenario: boundary-sizes ---
// Every prior scenario used size 8 (fieldSize 4 -> SF is the first/only knockout round before the
// Final). This scenario exercises the two structurally different bracket shapes at the tournament
// size boundaries: size 4 (fieldSize 2 -> the single group's rank1-vs-rank2 pairing directly *is*
// the Final, no SF/3rd-place match at all) and size 12 (fieldSize 8 -> QF is the first knockout
// round, reached via 4 groups of 3 — the only size so far with an odd groupSize needing the
// round-robin bye padding, and the only one whose knockout bracket has more than one round before
// the Final).
async function runBoundarySizesScenario() {
  await mongoose.connect(MONGO_URI);
  log(`Connected to ${MONGO_URI}. Server assumed running at ${BASE_URL}.`);

  // ==================================================================== Tournament A: size 4 ===
  log('\n############################## Tournament A: size 4 (no SF, no 3rd-place match) ##############################');
  const ctx4 = await setupThroughActiveGroupStage({ size: 4 });
  {
    const { tournament, voterActor, groupMatches, activeAt, jurors } = ctx4;
    log('\n=== Phase 7: Playing out the single group (no ties) ===');
    const rounds = bucketByRound(groupMatches, activeAt.getTime());
    for (let r = 0; r < rounds.length; r++) await playRound(rounds[r], r, pickWinner, voterActor);

    const group = await poll(async () => {
      const g = await TournamentGroup.findOne({ tournamentId: tournament._id }).lean();
      return g.status === 'complete' ? g : null;
    }, { timeoutMs: 8000, label: 'the single group status === complete' }).catch(e => { flag(e.message); return null; });
    if (group) log('  Group complete.');

    log('\n=== Phase 8: Verifying the group\'s rank1-vs-rank2 pairing became the Final directly (no SF) ===');
    const sfCount = await TournamentMatch.countDocuments({ tournamentId: tournament._id, knockoutRound: 'SF' });
    if (sfCount !== 0) flag(`Expected 0 SF matches for a 4-player tournament, found ${sfCount}`);
    const finalMatch = await poll(async () => {
      return TournamentMatch.findOne({ tournamentId: tournament._id, knockoutRound: 'Final' }).lean();
    }, { timeoutMs: 8000, label: 'Final match created directly from the group' }).catch(() => null);
    if (!finalMatch) throw new Error('Final match was never created for the 4-player tournament');
    else log('  Final match created directly from the group\'s top 2 — no SF round exists for size 4.');

    await castVoteAndClose(voterActor, finalMatch, pickWinner(finalMatch));

    log('\n=== Phase 9: Verifying close — exactly 2 placements, no 3rd-place match/prize ===');
    const thirdCount = await TournamentMatch.countDocuments({ tournamentId: tournament._id, knockoutRound: '3rd' });
    if (thirdCount !== 0) flag(`Expected 0 "3rd"-place matches for a 4-player tournament, found ${thirdCount}`);

    const closedTournament = await poll(async () => {
      const t = await Tournament.findById(tournament._id).lean();
      return t.status === 'closed' ? t : null;
    }, { label: 'tournament.status === closed' }).catch(async () => {
      flag('Tournament did not auto-close after the Final closed — had to call closeTournament() manually');
      await closeTournament(tournament._id);
      return Tournament.findById(tournament._id).lean();
    });
    if (closedTournament.status !== 'closed') throw new Error('4-player tournament never reached "closed"');
    if (!closedTournament.prizes?.winnersSet) flag('Tournament closed but prizes.winnersSet is not true');

    const prizeNotifs = await Notification.countDocuments({ type: 'tournament_prize_awarded', 'payload.tournamentId': tournament._id });
    if (prizeNotifs !== 2) flag(`Expected exactly 2 tournament_prize_awarded notifications (1st+2nd only, no 3rd place exists), found ${prizeNotifs}`);
    else log('  Exactly 2 prizes awarded (1st + 2nd) — correctly no 3rd place for a 4-player tournament.');

    const closedFinal = await TournamentMatch.findById(finalMatch._id).lean();
    const firstTE  = closedFinal.entryIdA.toString() === closedFinal.winnerId.toString() ? closedFinal.tournamentEntryIdA : closedFinal.tournamentEntryIdB;
    const secondTE = closedFinal.entryIdA.toString() === closedFinal.winnerId.toString() ? closedFinal.tournamentEntryIdB : closedFinal.tournamentEntryIdA;
    for (const { label, teId, expected } of [{ label: '1st', teId: firstTE, expected: 350 }, { label: '2nd', teId: secondTE, expected: 100 }]) {
      const te = await TournamentEntry.findById(teId).select('userId').lean();
      const user = await User.findById(te.userId).select('wallet').lean();
      if ((user.wallet.earnedCHL || 0) !== expected) flag(`${label}-place winner's earnedCHL is ${user.wallet.earnedCHL}, expected ${expected}`);
      else log(`  ${label} place: earnedCHL credited correctly (${expected} CHL)`);
    }

    const bannedJurors = await User.countDocuments({ _id: { $in: jurors.map(j => j._id) }, juryBanned: true });
    if (bannedJurors !== 0) flag(`${bannedJurors} juror(s) incorrectly banned in a tie-free 4-player run`);
  }

  // =================================================================== Tournament B: size 12 ===
  log('\n############################## Tournament B: size 12 (4 groups of 3, first knockout round is QF) ##############################');
  const ctx12 = await setupThroughActiveGroupStage({ size: 12 });
  {
    const { tournament, voterActor, groupMatches, activeAt, jurors } = ctx12;
    log('\n=== Phase 7: Playing out 4 groups of 3 (odd groupSize -> round-robin bye padding, no ties) ===');
    const rounds = bucketByRound(groupMatches, activeAt.getTime());
    for (let r = 0; r < rounds.length; r++) await playRound(rounds[r], r, pickWinner, voterActor);

    const completedGroups = await poll(async () => {
      const n = await TournamentGroup.countDocuments({ tournamentId: tournament._id, status: 'complete' });
      return n === 4 ? n : null;
    }, { timeoutMs: 10000, label: 'all 4 TournamentGroups status === complete' }).catch(async () => TournamentGroup.countDocuments({ tournamentId: tournament._id, status: 'complete' }));
    if (completedGroups !== 4) flag(`Expected all 4 groups "complete", found ${completedGroups}/4`);
    else log('  All 4 groups complete — 8 entries advance to the knockout stage.');

    log('\n=== Phase 8: Verifying the first knockout round is QF (not SF) ===');
    const qfMatches = await poll(async () => {
      const ms = await TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: 'QF' }).lean();
      return ms.length === 4 ? ms : null;
    }, { timeoutMs: 8000, label: '4 QF matches created' }).catch(() => TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: 'QF' }).lean());
    if (qfMatches.length !== 4) flag(`Expected 4 QF matches (8 entrants), found ${qfMatches.length}`);
    else log('  4 QF matches correctly created — this size never reaches SF/Final without QF first.');
    const sfCountBeforeQF = await TournamentMatch.countDocuments({ tournamentId: tournament._id, knockoutRound: 'SF' });
    if (sfCountBeforeQF !== 0) flag(`Expected 0 SF matches before QF closes, found ${sfCountBeforeQF}`);

    for (const m of qfMatches) await castVoteAndClose(voterActor, m, pickWinner(m));

    log('\n=== Phase 9: Verifying QF -> SF advancement ===');
    const sfMatches = await poll(async () => {
      const ms = await TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: 'SF' }).lean();
      return ms.length === 2 ? ms : null;
    }, { timeoutMs: 8000, label: '2 SF matches created after QF closed' }).catch(() => TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: 'SF' }).lean());
    if (sfMatches.length !== 2) flag(`Expected 2 SF matches after QF closed, found ${sfMatches.length}`);
    else log('  QF winners correctly advanced into 2 SF matches.');

    const eliminatedQFLosers = await TournamentEntry.countDocuments({ tournamentId: tournament._id, knockoutRound: 'QF', eliminated: true });
    if (eliminatedQFLosers !== 4) flag(`Expected all 4 QF losers marked eliminated, found ${eliminatedQFLosers}`);

    for (const m of sfMatches) await castVoteAndClose(voterActor, m, pickWinner(m));

    log('\n=== Phase 10: Final + 3rd-place, then close + payout ===');
    const finalMatch = await poll(async () => TournamentMatch.findOne({ tournamentId: tournament._id, knockoutRound: 'Final' }).lean(),
      { timeoutMs: 8000, label: 'Final match created' }).catch(() => null);
    const thirdMatch = await TournamentMatch.findOne({ tournamentId: tournament._id, knockoutRound: '3rd' }).lean();
    if (!finalMatch) throw new Error('Final match was not created after both SF matches closed');
    if (!thirdMatch) flag('3rd-place match was not created after both SF matches closed (expected for a 12-player tournament)');

    await castVoteAndClose(voterActor, finalMatch, pickWinner(finalMatch));
    if (thirdMatch) await castVoteAndClose(voterActor, thirdMatch, pickWinner(thirdMatch));

    const closedTournament = await poll(async () => {
      const t = await Tournament.findById(tournament._id).lean();
      return t.status === 'closed' ? t : null;
    }, { label: 'tournament.status === closed' }).catch(async () => {
      flag('Tournament did not auto-close after Final+3rd closed — had to call closeTournament() manually');
      await closeTournament(tournament._id);
      return Tournament.findById(tournament._id).lean();
    });
    if (closedTournament.status !== 'closed') throw new Error('12-player tournament never reached "closed"');
    if (!closedTournament.prizes?.winnersSet) flag('Tournament closed but prizes.winnersSet is not true');
    else log('  Tournament closed successfully with a 4-group / QF-first bracket.');

    const prizeNotifs = await Notification.countDocuments({ type: 'tournament_prize_awarded', 'payload.tournamentId': tournament._id });
    if (prizeNotifs !== 3) flag(`Expected 3 tournament_prize_awarded notifications, found ${prizeNotifs}`);

    const bannedJurors = await User.countDocuments({ _id: { $in: jurors.map(j => j._id) }, juryBanned: true });
    if (bannedJurors !== 0) flag(`${bannedJurors} juror(s) incorrectly banned in a tie-free 12-player run`);
  }

  // ==================================================================== Tournament C: size 16 ===
  log('\n############################## Tournament C: size 16 (4 groups of 4, first knockout round is QF) ##############################');
  const ctx16 = await setupThroughActiveGroupStage({ size: 16 });
  await playGroupsAndKnockoutForBoundarySize(ctx16, { size: 16, expectedGroups: 4, firstRound: 'QF', firstRoundCount: 4 });

  // ==================================================================== Tournament D: size 24 ===
  log('\n############################## Tournament D: size 24 (8 groups of 3, first knockout round is R16 — the deepest bracket in this report) ##############################');
  const ctx24 = await setupThroughActiveGroupStage({ size: 24 });
  await playGroupsAndKnockoutForBoundarySize(ctx24, { size: 24, expectedGroups: 8, firstRound: 'R16', firstRoundCount: 8 });

  printSummary('boundary-sizes (no single tournament id — size 4/12/16/24 fixtures)');
}

// Shared by sizes 16 and 24 (and reusable for any future size): plays out an arbitrary number of
// groups cleanly, then walks the knockout bracket from whichever round it actually starts at
// (QF for 16, R16 for 24) all the way to Final+3rd and close, advancing one round at a time.
async function playGroupsAndKnockoutForBoundarySize(ctx, { size, expectedGroups, firstRound, firstRoundCount }) {
  const { tournament, voterActor, jurors, groupMatches, activeAt } = ctx;

  log(`\n=== Playing out ${expectedGroups} groups (no ties) ===`);
  const rounds = bucketByRound(groupMatches, activeAt.getTime());
  for (let r = 0; r < rounds.length; r++) await playRound(rounds[r], r, pickWinner, voterActor);

  const completedGroups = await poll(async () => {
    const n = await TournamentGroup.countDocuments({ tournamentId: tournament._id, status: 'complete' });
    return n === expectedGroups ? n : null;
  }, { timeoutMs: 15000, label: `all ${expectedGroups} TournamentGroups status === complete` }).catch(async () => TournamentGroup.countDocuments({ tournamentId: tournament._id, status: 'complete' }));
  if (completedGroups !== expectedGroups) flag(`Expected all ${expectedGroups} groups "complete", found ${completedGroups}/${expectedGroups}`);
  else log(`  All ${expectedGroups} groups complete — ${expectedGroups * 2} entries advance to the knockout stage.`);

  log(`\n=== Verifying the first knockout round is ${firstRound} (${firstRoundCount} matches) ===`);
  let currentRoundMatches = await poll(async () => {
    const ms = await TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: firstRound }).lean();
    return ms.length === firstRoundCount ? ms : null;
  }, { timeoutMs: 10000, label: `${firstRoundCount} ${firstRound} matches created` }).catch(() => TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: firstRound }).lean());
  if (currentRoundMatches.length !== firstRoundCount) flag(`Expected ${firstRoundCount} ${firstRound} matches, found ${currentRoundMatches.length}`);
  else log(`  ${firstRoundCount} ${firstRound} matches correctly created.`);

  const KNOCKOUT_ORDER = ['R16', 'QF', 'SF', 'Final'];
  let roundIdx = KNOCKOUT_ORDER.indexOf(firstRound);
  let currentRoundName = firstRound;

  // Walk the bracket one round at a time until SF (Final + 3rd are created together once both
  // SF matches close, handled separately below) — closing every match in the current round,
  // recording how many losers that should eliminate, then waiting for the next round's matches
  // (always half as many) to appear.
  while (currentRoundName !== 'SF') {
    const closedRoundName = currentRoundName;
    const closedRoundMatchCount = currentRoundMatches.length;
    for (const m of currentRoundMatches) await castVoteAndClose(voterActor, m, pickWinner(m));

    // The `eliminated` flag is written inside handleKnockoutMatchClose(), which runs AFTER
    // TournamentMatch.status flips to 'closed' within the same fire-and-forget chain closeContest
    // kicks off (see the report's §4.3/§14.3/§16.3 — the same class of race every time). Polling
    // for status === 'closed' (which castVoteAndClose already does) does not guarantee this
    // separate, later write has landed too. Poll the eliminated count itself instead.
    const eliminatedCount = await poll(async () => {
      const n = await TournamentEntry.countDocuments({ tournamentId: tournament._id, knockoutRound: closedRoundName, eliminated: true });
      return n === closedRoundMatchCount ? n : null;
    }, { timeoutMs: 5000, label: `${closedRoundMatchCount} ${closedRoundName} losers marked eliminated` })
      .catch(async () => TournamentEntry.countDocuments({ tournamentId: tournament._id, knockoutRound: closedRoundName, eliminated: true }));
    if (eliminatedCount !== closedRoundMatchCount) {
      flag(`Expected all ${closedRoundMatchCount} ${closedRoundName} losers marked eliminated, found ${eliminatedCount}`);
    }

    const nextRoundName = KNOCKOUT_ORDER[++roundIdx];
    const nextRoundCount = closedRoundMatchCount / 2;
    currentRoundMatches = await poll(async () => {
      const ms = await TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: nextRoundName }).lean();
      return ms.length === nextRoundCount ? ms : null;
    }, { timeoutMs: 10000, label: `${nextRoundCount} ${nextRoundName} matches created` }).catch(() => TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: nextRoundName }).lean());
    if (currentRoundMatches.length !== nextRoundCount) flag(`Expected ${nextRoundCount} ${nextRoundName} matches after ${closedRoundName} closed, found ${currentRoundMatches.length}`);
    else log(`  ${nextRoundCount} ${nextRoundName} matches correctly created after ${closedRoundName} closed.`);
    currentRoundName = nextRoundName;
  }
  // currentRoundMatches now holds the 2 SF matches — close them too (SF losers are deliberately
  // NOT marked eliminated, per the knockout-tie scenario, so no eliminated-count check here).
  for (const m of currentRoundMatches) await castVoteAndClose(voterActor, m, pickWinner(m));

  log('\n=== Final + 3rd-place, then close + payout ===');
  const finalMatch = await poll(async () => TournamentMatch.findOne({ tournamentId: tournament._id, knockoutRound: 'Final' }).lean(),
    { timeoutMs: 10000, label: 'Final match created' }).catch(() => null);
  const thirdMatch = await TournamentMatch.findOne({ tournamentId: tournament._id, knockoutRound: '3rd' }).lean();
  if (!finalMatch) throw new Error(`Final match was not created for the size-${size} tournament`);
  if (!thirdMatch) flag(`3rd-place match was not created for the size-${size} tournament`);

  await castVoteAndClose(voterActor, finalMatch, pickWinner(finalMatch));
  if (thirdMatch) await castVoteAndClose(voterActor, thirdMatch, pickWinner(thirdMatch));

  const closedTournament = await poll(async () => {
    const t = await Tournament.findById(tournament._id).lean();
    return t.status === 'closed' ? t : null;
  }, { label: 'tournament.status === closed' }).catch(async () => {
    flag(`Size-${size} tournament did not auto-close after Final+3rd closed — had to call closeTournament() manually`);
    await closeTournament(tournament._id);
    return Tournament.findById(tournament._id).lean();
  });
  if (closedTournament.status !== 'closed') throw new Error(`Size-${size} tournament never reached "closed"`);
  if (!closedTournament.prizes?.winnersSet) flag('Tournament closed but prizes.winnersSet is not true');
  else log(`  Size-${size} tournament closed successfully (bracket depth: ${firstRound} -> ... -> Final/3rd).`);

  const prizeNotifs = await Notification.countDocuments({ type: 'tournament_prize_awarded', 'payload.tournamentId': tournament._id });
  if (prizeNotifs !== 3) flag(`Expected 3 tournament_prize_awarded notifications, found ${prizeNotifs}`);

  const bannedJurors = await User.countDocuments({ _id: { $in: jurors.map(j => j._id) }, juryBanned: true });
  if (bannedJurors !== 0) flag(`${bannedJurors} juror(s) incorrectly banned in a tie-free size-${size} run`);
}

// ---------------------------------------------------------------------- scenario: social-layer ---
// Comments (post/reply-reparenting/edit/react/report/delete), tournament-level and per-candidate
// loop-in, tournament reports (including that they land in /admin/moderation's "Tournaments" tab
// over a real admin HTTP session), and the profile trophy-counter data condition — all run
// against one tournament taken all the way to a real close, so the trophy check has genuine
// 1st/2nd/3rd placements to verify against.
async function runSocialLayerScenario() {
  await mongoose.connect(MONGO_URI);
  log(`Connected to ${MONGO_URI}. Server assumed running at ${BASE_URL}.`);

  const ctx = await setupThroughActiveGroupStage();
  const { tournament, voterActor, groupMatches, activeAt } = ctx;

  log('\n=== Phase 7: Playing out the group stage + knockout to a real close (fixture, not under test) ===');
  const rounds = bucketByRound(groupMatches, activeAt.getTime());
  for (let r = 0; r < rounds.length; r++) await playRound(rounds[r], r, pickWinner, voterActor);
  await poll(async () => {
    const n = await TournamentGroup.countDocuments({ tournamentId: tournament._id, status: 'complete' });
    return n === 2 ? true : null;
  }, { timeoutMs: 8000, label: 'both TournamentGroups status === complete' }).catch(e => flag(e.message));
  await playKnockoutAndVerifyClose(ctx, { expectGroupTieVotes: 0 });

  const bystander1 = await makeUser({ tag: 'social1', idVerified: true });
  const bystander1Actor = newActor();
  await login(bystander1Actor, bystander1.email.value);
  const bystander2 = await makeUser({ tag: 'social2', idVerified: true });
  const bystander2Actor = newActor();
  await login(bystander2Actor, bystander2.email.value);
  const bystander3 = await makeUser({ tag: 'social3', idVerified: true });
  const bystander3Actor = newActor();
  await login(bystander3Actor, bystander3.email.value);

  log('\n=== Phase 8: Tournament comments — post, reply re-parenting, edit, react, report, delete ===');
  let r = await httpReq(bystander1Actor, 'POST', `/tournament/${tournament._id}/comments`, { body: { body: 'Great tournament!' } });
  if (r.status !== 200) throw new Error(`Top-level comment post failed: ${r.status} ${await r.text()}`);
  const c1 = await r.json();

  r = await httpReq(bystander2Actor, 'POST', `/tournament/${tournament._id}/comments`, { body: { body: 'Agreed!', parentId: c1._id.toString() } });
  if (r.status !== 200) throw new Error(`Reply post failed: ${r.status} ${await r.text()}`);
  const reply1 = await r.json();
  if (reply1.parentId?.toString() !== c1._id.toString()) flag(`Expected the first reply's parentId to be the top-level comment, got ${reply1.parentId}`);

  // Replying to a reply must re-parent to the ORIGINAL top-level comment, keeping nesting at
  // exactly one level (routes/tournaments.js's `effectiveParentId` logic).
  r = await httpReq(bystander3Actor, 'POST', `/tournament/${tournament._id}/comments`, { body: { body: 'Replying to a reply', parentId: reply1._id.toString() } });
  if (r.status !== 200) throw new Error(`Reply-to-reply post failed: ${r.status} ${await r.text()}`);
  const reply2 = await r.json();
  if (reply2.parentId?.toString() !== c1._id.toString()) {
    flag(`Expected a reply-to-a-reply to re-parent to the top-level comment (${c1._id}), got parentId ${reply2.parentId} — nesting is not staying at one level`);
  } else {
    log('  Reply-to-a-reply correctly re-parented to the top-level comment — nesting stays at one level.');
  }

  r = await httpReq(bystander1Actor, 'PATCH', `/tournament/${tournament._id}/comments/${c1._id}`, { body: { body: 'Great tournament!! (edited)' } });
  if (r.status !== 200) flag(`Comment edit failed: ${r.status} ${await r.text()}`);
  else {
    const edited = await r.json();
    if (!edited.editedAt) flag('Expected editedAt to be set after editing a comment');
    else log('  Comment edit succeeded, editedAt stamped.');
  }

  r = await httpReq(bystander2Actor, 'POST', `/tournament/${tournament._id}/comments/${c1._id}/react`, { body: { type: 'like' } });
  let reactJson = await r.json();
  if (reactJson.likes !== 1 || !reactJson.userLiked) flag(`Expected 1 like after reacting, got likes=${reactJson.likes} userLiked=${reactJson.userLiked}`);

  r = await httpReq(bystander2Actor, 'POST', `/tournament/${tournament._id}/comments/${c1._id}/react`, { body: { type: 'dislike' } });
  reactJson = await r.json();
  if (reactJson.likes !== 0 || reactJson.dislikes !== 1 || !reactJson.userDisliked) {
    flag(`Expected switching like->dislike to be mutually exclusive (likes=0, dislikes=1), got likes=${reactJson.likes} dislikes=${reactJson.dislikes}`);
  } else {
    log('  Like/dislike correctly mutually exclusive — disliking removed the existing like.');
  }

  r = await httpReq(bystander3Actor, 'POST', `/tournament/${tournament._id}/comments/${c1._id}/report`, { body: {} });
  if (r.status !== 200) flag(`Comment report failed: ${r.status} ${await r.text()}`);
  const commentAfterReport = await TournamentComment.findById(c1._id).select('hidden').lean();
  if (!commentAfterReport.hidden) flag('Expected a reported comment to be hidden immediately (no threshold), but hidden is not true');
  else log('  Reported comment correctly auto-hidden immediately.');

  r = await httpReq(bystander1Actor, 'DELETE', `/tournament/${tournament._id}/comments/${c1._id}`);
  if (r.status !== 200) flag(`Comment delete failed: ${r.status} ${await r.text()}`);
  const [remainingComment, remainingReplies, remainingReports] = await Promise.all([
    TournamentComment.findById(c1._id).lean(),
    TournamentComment.countDocuments({ parentId: c1._id }),
    TournamentCommentReport.countDocuments({ tournamentCommentId: c1._id }),
  ]);
  if (remainingComment) flag('Expected the deleted comment to be gone');
  if (remainingReplies !== 0) flag(`Expected both replies cascade-deleted with the parent, found ${remainingReplies} remaining`);
  if (remainingReports !== 0) flag(`Expected the comment's report cascade-deleted, found ${remainingReports} remaining`);
  if (!remainingComment && remainingReplies === 0 && remainingReports === 0) {
    log('  Comment deletion correctly cascaded to both replies and the pending report.');
  }

  log('\n=== Phase 9: Tournament-level loop-in ===');
  r = await httpReq(bystander1Actor, 'POST', `/tournament/${tournament._id}/loop-in`, { body: {} });
  let loopJson = await r.json();
  if (loopJson.loopedIn !== true) flag(`Expected loopedIn:true on first toggle, got ${JSON.stringify(loopJson)}`);
  let loopCount = await TournamentLoop.countDocuments({ tournamentId: tournament._id, userId: bystander1._id });
  if (loopCount !== 1) flag(`Expected 1 TournamentLoop doc after looping in, found ${loopCount}`);

  r = await httpReq(bystander1Actor, 'POST', `/tournament/${tournament._id}/loop-in`, { body: {} });
  loopJson = await r.json();
  if (loopJson.loopedIn !== false) flag(`Expected loopedIn:false on second toggle (un-loop), got ${JSON.stringify(loopJson)}`);
  loopCount = await TournamentLoop.countDocuments({ tournamentId: tournament._id, userId: bystander1._id });
  if (loopCount !== 0) flag(`Expected 0 TournamentLoop docs after toggling off, found ${loopCount}`);
  else log('  Tournament-level loop-in correctly toggles on/off.');

  r = await httpReq(ctx.organizerActor, 'POST', `/tournament/${tournament._id}/loop-in`, { body: {} });
  if (r.status !== 400) flag(`Expected the organizer looping in on their own tournament to be blocked (400), got ${r.status}`);
  else log('  Organizer correctly blocked from looping in on their own tournament.');

  log('\n=== Phase 10: Tournament report (including the admin moderation queue) ===');
  r = await httpReq(bystander2Actor, 'POST', `/tournament/${tournament._id}/report`, { body: {} });
  if (r.status !== 200) flag(`Tournament report failed: ${r.status} ${await r.text()}`);
  const reportCount = await TournamentReport.countDocuments({ tournamentId: tournament._id, reportedBy: bystander2._id });
  if (reportCount !== 1) flag(`Expected 1 TournamentReport doc, found ${reportCount}`);

  r = await httpReq(bystander2Actor, 'POST', `/tournament/${tournament._id}/report`, { body: {} });
  if (r.status !== 409) flag(`Expected a duplicate tournament report to be rejected (409), got ${r.status}`);
  else log('  Duplicate tournament report correctly rejected (409).');

  r = await httpReq(ctx.organizerActor, 'POST', `/tournament/${tournament._id}/report`, { body: {} });
  if (r.status !== 400) flag(`Expected the organizer reporting their own tournament to be blocked (400), got ${r.status}`);
  else log('  Organizer correctly blocked from reporting their own tournament.');

  log('\n=== Phase 11: Verifying the report surfaces in /admin/moderation\'s "Tournaments" tab (real admin HTTP session) ===');
  const adminUser = await makeUser({ tag: 'socialadmin', idVerified: true });
  await User.updateOne({ _id: adminUser._id }, { $set: { role: 'founder' } });
  const adminActor = newActor();
  const adminLoginRes = await httpReq(adminActor, 'POST', '/admin/login', { body: { email: adminUser.email.value, password: PASSWORD } });
  if (adminLoginRes.status !== 302) throw new Error(`Admin login failed: ${adminLoginRes.status} ${await adminLoginRes.text()}`);

  const modRes = await httpReq(adminActor, 'GET', '/admin/moderation?tab=tournaments');
  const modHtml = await modRes.text();
  if (modRes.status !== 200) flag(`Expected /admin/moderation?tab=tournaments to return 200, got ${modRes.status}`);
  else if (!modHtml.includes(tournament.name)) {
    flag(`Reported tournament "${tournament.name}" did not appear in the admin moderation "Tournaments" tab`);
  } else {
    log('  Reported tournament correctly appears in /admin/moderation\'s "Tournaments" tab (verified over a real admin HTTP session).');
  }

  log("\n=== Phase 11b: Admin actually resolving the queued reports (not just seeing them) ===");
  // Tournament report: dismiss it.
  const dismissRes = await httpReq(adminActor, 'POST', `/admin/moderation/tournament-reports/${tournament._id}/dismiss`, { body: {} });
  if (dismissRes.status !== 302) flag(`Expected the tournament-report dismiss action to redirect (302), got ${dismissRes.status}`);
  const dismissedReport = await TournamentReport.findOne({ tournamentId: tournament._id, reportedBy: bystander2._id }).lean();
  if (dismissedReport?.status !== 'rejected') flag(`Expected the tournament report's status to be "rejected" after dismissal, got "${dismissedReport?.status}"`);
  else log('  Tournament report correctly dismissed (status -> rejected) via the real admin route.');

  // Comment reports: two fresh comments (c1 was already deleted in Phase 8's cascade-delete
  // test), one resolved via approve (deletes the comment), one via reject (un-hides it).
  r = await httpReq(bystander1Actor, 'POST', `/tournament/${tournament._id}/comments`, { body: { body: 'This one will be approved away' } });
  const c2 = await r.json();
  r = await httpReq(bystander2Actor, 'POST', `/tournament/${tournament._id}/comments/${c2._id}/report`, { body: {} });
  if (r.status !== 200) flag(`Reporting comment c2 failed: ${r.status}`);

  r = await httpReq(bystander1Actor, 'POST', `/tournament/${tournament._id}/comments`, { body: { body: 'This one will be rejected (kept)' } });
  const c3 = await r.json();
  r = await httpReq(bystander3Actor, 'POST', `/tournament/${tournament._id}/comments/${c3._id}/report`, { body: {} });
  if (r.status !== 200) flag(`Reporting comment c3 failed: ${r.status}`);

  const approveCommentRes = await httpReq(adminActor, 'POST', `/admin/moderation/comment-reports/${c2._id}/approve`, { body: { commentType: 'tournament' } });
  if (approveCommentRes.status !== 302) flag(`Expected the comment-report approve action to redirect (302), got ${approveCommentRes.status}`);
  const [c2AfterApprove, c2ReportAfterApprove, ownerNotif] = await Promise.all([
    TournamentComment.findById(c2._id).lean(),
    TournamentCommentReport.findOne({ tournamentCommentId: c2._id, reportedBy: bystander2._id }).lean(),
    Notification.findOne({ userId: bystander1._id, type: 'comment_removed' }).lean(),
  ]);
  if (c2AfterApprove) flag('Expected the approved (removed) comment to be deleted, but it still exists');
  if (c2ReportAfterApprove?.status !== 'approved') flag(`Expected the comment report's status to be "approved", got "${c2ReportAfterApprove?.status}"`);
  if (!ownerNotif) flag('Expected a comment_removed notification to the comment\'s owner after admin approved its removal');
  if (!c2AfterApprove && c2ReportAfterApprove?.status === 'approved' && ownerNotif) {
    log('  Approving a comment report correctly deletes the comment, marks the report "approved", and notifies its owner.');
  }

  const rejectCommentRes = await httpReq(adminActor, 'POST', `/admin/moderation/comment-reports/${c3._id}/reject`, { body: { commentType: 'tournament' } });
  if (rejectCommentRes.status !== 302) flag(`Expected the comment-report reject action to redirect (302), got ${rejectCommentRes.status}`);
  const [c3AfterReject, c3ReportAfterReject] = await Promise.all([
    TournamentComment.findById(c3._id).lean(),
    TournamentCommentReport.findOne({ tournamentCommentId: c3._id, reportedBy: bystander3._id }).lean(),
  ]);
  if (!c3AfterReject) flag('Expected a rejected-report comment to still exist, but it was deleted');
  else if (c3AfterReject.hidden) flag('Expected a rejected-report comment to be un-hidden, but hidden is still true');
  if (c3ReportAfterReject?.status !== 'rejected') flag(`Expected the comment report's status to be "rejected", got "${c3ReportAfterReject?.status}"`);
  if (c3AfterReject && !c3AfterReject.hidden && c3ReportAfterReject?.status === 'rejected') {
    log('  Rejecting a comment report correctly keeps the comment (un-hidden) and marks the report "rejected".');
  }

  log('\n=== Phase 12: Profile trophy counters — verifying the underlying data condition ===');
  // routes/pages.js computes firstPrizes/secondPrizes/thirdPrizes from exactly these
  // eliminated/knockoutRound combinations — verified directly against the just-closed
  // tournament's real placements rather than scraping the rendered profile HTML.
  const finalMatch = await TournamentMatch.findOne({ tournamentId: tournament._id, knockoutRound: 'Final' }).lean();
  const thirdMatch = await TournamentMatch.findOne({ tournamentId: tournament._id, knockoutRound: '3rd' }).lean();
  const firstTE  = finalMatch.entryIdA.toString() === finalMatch.winnerId.toString() ? finalMatch.tournamentEntryIdA : finalMatch.tournamentEntryIdB;
  const secondTE = finalMatch.entryIdA.toString() === finalMatch.winnerId.toString() ? finalMatch.tournamentEntryIdB : finalMatch.tournamentEntryIdA;
  const thirdTE  = thirdMatch.entryIdA.toString() === thirdMatch.winnerId.toString() ? thirdMatch.tournamentEntryIdA : thirdMatch.tournamentEntryIdB;

  const [firstDoc, secondDoc, thirdDoc] = await Promise.all([
    TournamentEntry.findById(firstTE).select('eliminated knockoutRound userId').lean(),
    TournamentEntry.findById(secondTE).select('eliminated knockoutRound userId').lean(),
    TournamentEntry.findById(thirdTE).select('eliminated knockoutRound userId').lean(),
  ]);
  if (firstDoc.eliminated || firstDoc.knockoutRound !== 'Final') flag(`1st place should satisfy "!eliminated && knockoutRound===Final" (firstPrizes++), got eliminated=${firstDoc.eliminated} knockoutRound=${firstDoc.knockoutRound}`);
  if (!secondDoc.eliminated || secondDoc.knockoutRound !== 'Final') flag(`2nd place should satisfy "eliminated && knockoutRound===Final" (secondPrizes++), got eliminated=${secondDoc.eliminated} knockoutRound=${secondDoc.knockoutRound}`);
  if (thirdDoc.eliminated || thirdDoc.knockoutRound !== '3rd') flag(`3rd place should satisfy "!eliminated && knockoutRound===3rd" (thirdPrizes++), got eliminated=${thirdDoc.eliminated} knockoutRound=${thirdDoc.knockoutRound}`);
  if (!firstDoc.eliminated && firstDoc.knockoutRound === 'Final' && secondDoc.eliminated && secondDoc.knockoutRound === 'Final' && !thirdDoc.eliminated && thirdDoc.knockoutRound === '3rd') {
    log('  All three placements satisfy exactly the data condition routes/pages.js reads for firstPrizes/secondPrizes/thirdPrizes.');
  }

  // Sanity-check the winner's profile page still renders (200) with this tournament placement
  // data present — a regression check, not a scrape for the exact trophy-count wording.
  const winnerUser = await User.findById(firstDoc.userId).select('username').lean();
  const profileRes = await httpReq(bystander1Actor, 'GET', `/${winnerUser.username.value}`);
  if (profileRes.status !== 200) flag(`Expected the 1st-place winner's profile page to render (200), got ${profileRes.status}`);

  printSummary(tournament._id);
}

// ------------------------------------------------------------- scenario: orphaned-entry-crash ---
// Follow-up to Batch B's open-phase-edges finding (§14.4 in the report). The first run of this
// scenario CONFIRMED a real, severe crash: approving a candidate whose Entry was deleted let the
// tournament reach cooldown-expiry, where generateGroupMatches() dereferences the dangling
// entryId and throws — but only *after* activateTournament()'s atomic status claim had already
// flipped the tournament to 'active', permanently wedging it (nothing re-enters activation from
// 'active'). Fixed at the root cause: routes/api.js's approve route now checks the underlying
// Entry still exists before allowing approval (rejecting an orphaned candidate is still allowed —
// that remains the organizer's normal way to clear a dead entry from the queue). This scenario
// now verifies the fix.
async function runOrphanedEntryCrashScenario() {
  await mongoose.connect(MONGO_URI);
  log(`Connected to ${MONGO_URI}. Server assumed running at ${BASE_URL}.`);

  const setup = await setupThroughSubmission({ submitCount: 8, size: 8 });
  const { tournament, organizerActor } = setup;

  log("\n=== Phase 4: Deleting one submitted candidate's Entry while still pending ===");
  const entries = await TournamentEntry.find({ tournamentId: tournament._id }).lean();
  const doomed = entries[0];
  const valid = entries.slice(1);
  await Entry.deleteOne({ _id: doomed.entryId });
  log(`  Deleted Entry ${doomed.entryId} (TournamentEntry ${doomed._id} stays "pending" for now).`);

  log('\n=== Phase 5: Force open-phase deadline -> cooldown ===');
  await tournamentOpenExpiry(tournament._id);
  const afterOpen = await Tournament.findById(tournament._id).select('status').lean();
  if (afterOpen.status !== 'cooldown') throw new Error(`Expected "cooldown", got "${afterOpen.status}"`);

  log('\n=== Phase 6: Organizer attempts to approve the orphaned candidate (should now be blocked) ===');
  const approveOrphanRes = await httpReq(organizerActor, 'POST', `/api/tournaments/${tournament._id}/entries/${doomed._id}/approve`, { body: {} });
  if (approveOrphanRes.status !== 409) {
    flag(`Expected approving an orphaned candidate to be blocked (409), got ${approveOrphanRes.status}: ${(await approveOrphanRes.text()).slice(0, 200)}`);
  } else {
    log('  Approving the orphaned candidate correctly blocked (409) — the crash-causing state is now unreachable.');
  }
  const doomedAfterBlockedApprove = await TournamentEntry.findById(doomed._id).select('approvalStatus').lean();
  if (doomedAfterBlockedApprove.approvalStatus !== 'pending') {
    flag(`Expected the orphaned candidate to remain "pending" after the blocked approve attempt, got "${doomedAfterBlockedApprove.approvalStatus}"`);
  }

  log("\n=== Phase 7: Rejecting the orphaned candidate instead (must still work) ===");
  const rejectOrphanRes = await httpReq(organizerActor, 'POST', `/api/tournaments/${tournament._id}/entries/${doomed._id}/reject`, { body: {} });
  if (rejectOrphanRes.status !== 200) flag(`Expected rejecting the orphaned candidate to still succeed (200), got ${rejectOrphanRes.status}`);
  else log('  Rejecting the orphaned candidate still works — organizers retain a way to clear a dead entry from the queue.');

  log('\n=== Phase 8: Approving the 7 remaining valid candidates ===');
  for (const te of valid) {
    const r = await httpReq(organizerActor, 'POST', `/api/tournaments/${tournament._id}/entries/${te._id}/approve`, { body: {} });
    if (r.status !== 200) flag(`Approve failed for valid TournamentEntry ${te._id}: ${r.status} ${await r.text()}`);
  }
  const approvedCount = await TournamentEntry.countDocuments({ tournamentId: tournament._id, approvalStatus: 'approved' });
  if (approvedCount !== 7) flag(`Expected 7 approved (the 8th was rejected as orphaned), found ${approvedCount}`);

  log('\n=== Phase 9: Forcing the cooldown deadline — with only 7/8 approved, the cap can never be reached ===');
  let thrown = null;
  try {
    await tournamentCooldownExpiry(tournament._id);
  } catch (err) {
    thrown = err;
  }
  if (thrown) {
    flag(`tournamentCooldownExpiry() still threw even after the fix: ${thrown.message}\n${thrown.stack}`);
  }

  const finalTournament = await Tournament.findById(tournament._id).lean();
  if (thrown) {
    log(`  Tournament status="${finalTournament.status}" after the unexpected throw.`);
  } else if (finalTournament.status !== 'canceled' || finalTournament.cancelReason !== 'cooldown_incomplete') {
    flag(`Expected the tournament to cleanly auto-cancel ("canceled"/"cooldown_incomplete") since only 7/8 could ever be approved, got status="${finalTournament.status}" cancelReason="${finalTournament.cancelReason}"`);
  } else {
    log('  Tournament correctly auto-canceled (cooldown_incomplete) instead of crashing or wedging — losing one candidate to a dead Entry now just shrinks the pool below the cap, a normal and recoverable outcome.');
  }

  printSummary(tournament._id);
}

// ------------------------------------------------------------------ scenario: concurrent-closes ---
// Every other scenario in this report closes matches strictly one at a time, so the atomic-claim
// guards scattered through jobs/tournamentJobs.js (`findOneAndUpdate` status-transition claims,
// specifically meant to survive two callers racing) have never actually been contended by two
// simultaneous callers. This scenario deliberately fires two closeContest() calls concurrently
// (via Promise.all, not sequentially) at the two points in the pipeline where a real race is
// architecturally possible: both groups' final match closing at once (racing whose resolveGroup()
// call triggers generateKnockoutBracket()), and both semifinals closing at once (racing whose
// handleKnockoutMatchClose() call creates the Final/3rd-place matches).
async function runConcurrentClosesScenario() {
  await mongoose.connect(MONGO_URI);
  log(`Connected to ${MONGO_URI}. Server assumed running at ${BASE_URL}.`);

  const ctx = await setupThroughActiveGroupStage();
  const { tournament, voterActor, groupMatches, activeAt, jurors } = ctx;

  log("\n=== Phase 7: Playing every group match except each group's very last match ===");
  // Each group of 4 plays 2 matches per round (a group of 4's round-robin has 2 pairs/round, not
  // 1), so "the final round" still has 2 matches per group, not 1 — the last-match-per-group
  // boundary doesn't line up with a round boundary. Play rounds 1-2 fully, then in round 3 close
  // one match per group up front (sequentially, not the race target) and leave exactly the last
  // match of each group for the actual concurrent-close test below.
  const rounds = bucketByRound(groupMatches, activeAt.getTime());
  for (let r = 0; r < rounds.length - 1; r++) await playRound(rounds[r], r, pickWinner, voterActor);

  const lastRoundIdx = rounds.length - 1;
  const opened = [];
  for (const m of rounds[lastRoundIdx]) {
    const stillScheduled = await TournamentMatch.findById(m._id).select('status').lean();
    if (stillScheduled.status !== 'scheduled') flag(`Last-round match ${m._id} was not "scheduled" before forcing it open (was "${stillScheduled.status}")`);
    const opened1 = await forceOpenMatch(m._id);
    if (opened1) opened.push(opened1);
  }
  if (opened.length !== 4) throw new Error(`Expected 4 matches in the final round (2 per group), found ${opened.length}`);

  const byGroup = {};
  for (const m of opened) (byGroup[m.groupId.toString()] ||= []).push(m);
  const groupIds = Object.keys(byGroup);
  if (groupIds.length !== 2) throw new Error(`Expected exactly 2 groups in the final round, found ${groupIds.length}`);

  // Close the first match of each group up front (sequential, not under test) so exactly one
  // match remains open per group.
  for (const gid of groupIds) {
    await castVoteAndClose(voterActor, byGroup[gid][0], pickWinner(byGroup[gid][0]));
  }
  const lastMatchPerGroup = groupIds.map(gid => byGroup[gid][1]);

  log("\n=== Phase 8: Casting votes for each group's true final match, then closing them CONCURRENTLY ===");
  for (const m of lastMatchPerGroup) {
    const r = await httpReq(voterActor, 'POST', `/api/contests/${m.contestId}/vote`, { body: { entryId: pickWinner(m).toString() } });
    if (r.status !== 200) flag(`Vote on ${m._id} failed: ${r.status} ${await r.text()}`);
  }
  // The real race: both calls fire together, not one-after-the-other. Whichever group's
  // resolveGroup() call sees BOTH groups already 'complete' is the one that should — and only
  // that one should — trigger generateKnockoutBracket()'s atomic stage:'group'->'knockout' claim.
  await Promise.all(lastMatchPerGroup.map(m => closeContest(m.contestId)));

  log('\n=== Phase 9: Verifying the concurrent group-completion race resolved cleanly (no duplicates) ===');
  const completedGroups = await poll(async () => {
    const n = await TournamentGroup.countDocuments({ tournamentId: tournament._id, status: 'complete' });
    return n === 2 ? n : null;
  }, { timeoutMs: 8000, label: 'both TournamentGroups status === complete' }).catch(async () => TournamentGroup.countDocuments({ tournamentId: tournament._id, status: 'complete' }));
  if (completedGroups !== 2) flag(`Expected both groups "complete" after the concurrent close, found ${completedGroups}/2`);
  else log('  Both groups correctly reached "complete" — no group got stuck or double-processed by the race.');

  const sfMatches = await poll(async () => {
    const ms = await TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: 'SF' }).lean();
    return ms.length > 0 ? ms : null;
  }, { timeoutMs: 8000, label: 'SF matches created' }).catch(() => TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: 'SF' }).lean());
  if (sfMatches.length !== 2) {
    flag(`Expected exactly 2 SF matches after the concurrent group-completion race, found ${sfMatches.length} — a duplicate count here would mean generateKnockoutBracket()'s atomic claim did NOT survive two simultaneous resolveGroup() callers`);
  } else {
    log('  Exactly 2 SF matches created — generateKnockoutBracket()\'s stage:\'group\'->\'knockout\' atomic claim correctly fired exactly once despite both groups completing at the same instant.');
  }
  const knockoutStage = await Tournament.findById(tournament._id).select('stage').lean();
  if (!['knockout', 'finale'].includes(knockoutStage.stage)) flag(`Expected tournament.stage to have advanced past "group", got "${knockoutStage.stage}"`);

  log("\n=== Phase 10: Casting votes for both semifinals, then closing them CONCURRENTLY ===");
  for (const m of sfMatches) {
    const r = await httpReq(voterActor, 'POST', `/api/contests/${m.contestId}/vote`, { body: { entryId: pickWinner(m).toString() } });
    if (r.status !== 200) flag(`Vote on SF ${m._id} failed: ${r.status} ${await r.text()}`);
  }
  await Promise.all(sfMatches.map(m => closeContest(m.contestId)));

  log('\n=== Phase 11: Verifying the concurrent SF-advancement race resolved cleanly (no duplicate Final/3rd) ===');
  const finalMatches = await poll(async () => {
    const ms = await TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: 'Final' }).lean();
    return ms.length > 0 ? ms : null;
  }, { timeoutMs: 8000, label: 'Final match(es) created' }).catch(() => TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: 'Final' }).lean());
  const thirdMatches = await TournamentMatch.find({ tournamentId: tournament._id, knockoutRound: '3rd' }).lean();
  if (finalMatches.length !== 1) {
    flag(`Expected exactly 1 Final match after the concurrent SF-close race, found ${finalMatches.length} — a duplicate here would mean lastKnockoutRoundAdvanced's atomic claim did NOT survive two simultaneous SF closes`);
  } else {
    log('  Exactly 1 Final match created — the SF-advancement atomic claim correctly fired exactly once despite both semifinals closing at the same instant.');
  }
  if (thirdMatches.length !== 1) flag(`Expected exactly 1 3rd-place match, found ${thirdMatches.length}`);

  log('\n=== Phase 12: Closing Final + 3rd normally, then verifying close + payout has no duplicate side effects ===');
  await castVoteAndClose(voterActor, finalMatches[0], pickWinner(finalMatches[0]));
  await castVoteAndClose(voterActor, thirdMatches[0], pickWinner(thirdMatches[0]));

  const closedTournament = await poll(async () => {
    const t = await Tournament.findById(tournament._id).lean();
    return t.status === 'closed' ? t : null;
  }, { label: 'tournament.status === closed' }).catch(async () => {
    flag('Tournament did not auto-close after Final+3rd closed — had to call closeTournament() manually');
    await closeTournament(tournament._id);
    return Tournament.findById(tournament._id).lean();
  });
  if (closedTournament.status !== 'closed') throw new Error('Tournament never reached "closed" status');

  const prizeNotifs = await Notification.countDocuments({ type: 'tournament_prize_awarded', 'payload.tournamentId': tournament._id });
  if (prizeNotifs !== 3) flag(`Expected exactly 3 tournament_prize_awarded notifications (a race-induced double-payout would show up as more), found ${prizeNotifs}`);
  else log('  Exactly 3 prizes awarded — no duplicate payout from either concurrent race.');

  const refundOrPrizeTxCount = await WalletTransaction.countDocuments({ type: 'tournament_prize_payout', 'referenceId': tournament._id });
  if (refundOrPrizeTxCount !== 3) flag(`Expected exactly 3 tournament_prize_payout WalletTransaction docs, found ${refundOrPrizeTxCount} — a duplicate would indicate a race-induced double-credit`);

  const bannedJurors = await User.countDocuments({ _id: { $in: jurors.map(j => j._id) }, juryBanned: true });
  if (bannedJurors !== 0) flag(`${bannedJurors} juror(s) incorrectly banned in a tie-free run`);

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

  const comments = await TournamentComment.find({ tournamentId: { $in: tournamentIds } }).select('_id').lean();
  const commentIds = comments.map(c => c._id);

  await Promise.all([
    TournamentCommentReport.deleteMany({ tournamentCommentId: { $in: commentIds } }),
    TournamentComment.deleteMany({ tournamentId: { $in: tournamentIds } }),
    TournamentReport.deleteMany({ tournamentId: { $in: tournamentIds } }),
    TournamentLoop.deleteMany({ tournamentId: { $in: tournamentIds } }),
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
  'group-tie-organizer': runGroupTieOrganizerScenario,
  'group-tie-coinflip': runGroupTieCoinflipScenario,
  'group-tie-2way': runTwoWayTiebreakerScenario,
  'open-underfill-cancel': runOpenUnderfillCancelScenario,
  'creation-boundaries': runCreationBoundariesScenario,
  'open-phase-edges': runOpenPhaseEdgesScenario,
  'cooldown-edges': runCooldownEdgesScenario,
  'knockout-tie': runKnockoutTieScenario,
  'boundary-sizes': runBoundarySizesScenario,
  'social-layer': runSocialLayerScenario,
  'orphaned-entry-crash': runOrphanedEntryCrashScenario,
  'concurrent-closes': runConcurrentClosesScenario,
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
