# Tournament Simulation Report

**Date:** 2026-07-08
**Harness:** `scripts/simulateTournament.js` — supports multiple scenarios via `--scenario=<name>` (default `happy-path`), plus a `--cleanup` mode in the same file.
**Status:** Three scenarios run so far — **happy path** (§3), **3+-way group-ranking tie** (§7), and **organizer/jury voting restriction** (§8) — all clean passes on the tournament state machine itself. One genuine (minor) product bug was found from the third scenario — a juror who declined their invite was still barred from unrelated voting — and has since been **fixed and re-verified** (§8.3). Several harness bugs were found and fixed along the way during the first two scenarios (documented below so they aren't rediscovered) — the third scenario had none. One small product-level testability observation surfaced as a byproduct of the happy-path run.

**Scenario summary:**

| Scenario | Flag | Result |
|---|---|---|
| Happy path (no ties, no cancellations) | *(default)* | ✅ Clean — see §3 |
| 3+-way group-ranking boundary tie, resolved by jury quorum | `--scenario=group-tie` | ✅ Clean — see §7 |
| Organizer/jury barred from regular H2H voting while tournament is active | `--scenario=voting-restriction` | ✅ Clean — one bug found, fixed, and re-verified — see §8 |

---

## 1. Why this exists

The tournament feature (`plans/July/tournament-implementation-plan.md`) is the most state-machine-heavy thing in the codebase: real-time deadlines (3-day open phase, 24h cooldown, 24h per match, 6h jury window, 3h organizer window), atomic-claim races between concurrently-closing matches, a 5-status lifecycle, and cascading side effects (group resolution → knockout bracket generation → prize payout) that all happen automatically off of a handful of trigger points.

The written spec and the "as-built" notes in the implementation plan describe what *should* happen at each transition, but nothing had actually driven a tournament through its full lifecycle end-to-end and checked that the database ends up in the state the spec promises. This simulation exists to do that — mechanically, repeatably, and without waiting multiple real days for deadlines to elapse.

The goal was **not** "does the code look right" (that's what reading the code tells you) — it was "if you actually run one, what happens." That distinction is what caught the double-increment bug documented in §4.3, which no amount of code review would have surfaced (it's a race condition that only exists at runtime).

---

## 2. Methodology

### 2.1 Why a scripted harness, not manual clicking

Real deadlines span from hours to days (24h cooldown, 6h jury window, 72h standalone-contest voting, 3-day open phase). Clicking through the UI as multiple test accounts in real time would take days per run and makes jury-anonymity and timing hard to verify by hand. A script can compress the entire lifecycle into seconds while still exercising real code.

### 2.2 Why hybrid (HTTP + direct function calls), not pure internal calls

Investigating the codebase first showed that **not everything is equally easy to call directly**:

- Most of the state-engine (submission eligibility, group/knockout resolution, tie chains, close/payout) is exported as plain functions from `jobs/tournamentJobs.js`, `jobs/contestJobs.js`, and `utils/tournamentScheduler.js` — callable directly from a standalone Node script with no HTTP involved.
- Candidate approve/reject, the creation wizard, entry submission, and voting exist **only** as inline route handlers in `routes/tournaments.js` and `routes/api.js` — there's no extracted util to call, so the only way to exercise that code at all is to actually hit the route.

So the harness is genuinely hybrid:

| Mechanism | Used for |
|---|---|
| **Real HTTP requests** (with per-actor session cookies, against the actual running `npm run dev` server) | Tournament creation wizard (steps 1–5), entry upload + tournament targeting, organizer approve, contest voting |
| **Direct function calls** (same Node process, same Mongo connection) | Forcing deadline-triggered transitions instantly instead of waiting real time: `tournamentOpenExpiry`, `tournamentCooldownExpiry`, `closeContest`, `closeTournament` (only used as a last-resort safety net — see §4.2) |
| **Replicated logic** (no exported function exists) | Forcing a scheduled group-stage round open early — see §5 |

This means the parts of the system most likely to contain real bugs (the actual request handlers) are exercised exactly as a real user's browser would exercise them — only the *waiting* is skipped, not the *logic*.

### 2.3 Data isolation

Every seeded document (organizer, contestants, jurors, voter) gets a `username`/`email` prefixed `__sim_`. `node scripts/simulateTournament.js --cleanup` finds everything tagged this way and cascade-deletes it (tournament, groups, matches, contests, votes, entries, notifications, wallet transactions, follows, contributions, the users themselves). The harness was run against the real local dev database (not a throwaway one), so this tagging is what keeps it from polluting real dev data.

### 2.4 Scope of this first run

One tournament size (8 players — mid-sized, exercises both a multi-round group stage *and* a multi-round knockout bracket with a 3rd-place match), zero forced ties, no cancellations, no rejected candidates. This is deliberately the simplest possible "everything goes right" path, run first to (a) prove the harness itself is correct before layering in edge cases, and (b) establish a clean baseline. This report has since grown to cover a second scenario (§7); the remaining edge cases (under-fill auto-cancel, cooldown timeout, boundary sizes 4/12/16/24, etc.) are tracked in §8.

---

## 3. Scenario 1 (happy path) — what the harness actually does, phase by phase

### Phase 1 — Seed users
Creates, directly via Mongoose (this part isn't "under test" — it's test fixture setup):
- **1 organizer** — `idVerified: true`, `wallet.purchasedCHL: 1000`, plus 260 fake `Follow` documents and 5 fake `ContestContribution` documents so it clears `middleware/requireOrganizerEligibility.js`'s real checks (>250 followers, contributed to ≥5 contests) without needing to actually run those flows first.
- **8 contestants** — `idVerified: true` (required to submit an entry).
- **6 jurors** — plain users, no special flags (within the 5–7 jury size range).
- **1 voter** — no special flags (voting doesn't require `idVerified`).

All actors log in over real HTTP (`POST /login`) to obtain a session cookie, which the harness's tiny cookie-jar helper (`newActor()`/`httpReq()`) attaches to every subsequent request for that actor.

### Phase 2 — Tournament creation (real HTTP, all 5 wizard steps)
Drives the organizer through the actual multi-step wizard exactly as a browser would:
- **Step 1 (Basics):** multipart POST with name, description, `size: 8`, `openDays: 1`, `visibility: public`, and a real (tiny, 1×1 PNG) thumbnail file — the route's real thumbnail-required / name-length / name-uniqueness / size-enum validation all run for real.
- **Step 2 (Prizes):** `prizeFirst: 350, prizeSecond: 100, prizeThird: 50` — the legal minimums. The route's real wallet-sufficiency check runs against the organizer's actual `purchasedCHL` balance.
- **Step 3 (Eligibility):** empty criteria array (`criteria: '[]'`) — "no criteria" is an explicitly valid choice per spec.
- **Step 4 (Jury):** the 6 seeded juror IDs, sent as a repeated `juryUserIds` form field (this needed a raw `URLSearchParams` body — see §4.1's note on why the generic helper couldn't express it).
- **Step 5 (Review/finalize):** POSTs to finalize, which internally debits the organizer's wallet, creates the `Tournament` document (`status: 'open'`), creates 6 `TournamentJury` documents (`status: 'pending'`), and schedules the real `tournament_open_expiry` agenda job.

The harness then looks the tournament up directly in Mongo by its (uniquely timestamped) name, rather than trying to parse it out of a redirect `Location` header — simpler and more robust.

**Verified after this phase:** tournament exists with `status: 'open'`; exactly 6 `TournamentJury` docs exist, all `status: 'pending'`.

### Phase 3 — Candidate submission (real HTTP, real file upload)
Each of the 8 contestants POSTs to `/api/entries` — the actual entry-upload endpoint — as a real multipart request (title + a tiny real image file + `tournamentId`). This is the real production code path: an entry is created, and because `tournamentId` was supplied, `submitEntryToTournament()` (`utils/tournamentSubmission.js`) runs for real, checking organizer/juror exclusion, `idVerified`, duplicate-submission, eligibility criteria, and the participant cap, then creates a `TournamentEntry` (`approvalStatus: 'pending'`).

**Verified after this phase:** exactly 8 `TournamentEntry` documents exist.

### Phase 4 — Force the open-phase deadline
Rather than waiting the real 1 day (`openDays: 1`), the harness calls `tournamentOpenExpiry(tournamentId)` directly — the exact function the real `tournament_open_expiry` agenda job calls when the deadline actually arrives. This:
- Auto-accepts every still-`pending` jury invite (the real "anyone who never responded gets auto-accepted" rule).
- Checks accepted-jury count ≥ 5 (`MIN_JURY`).
- Checks submitted-candidate count ≥ tournament size.
- Transitions `open → cooldown`, sets `cooldownDeadline`, and schedules the real `tournament_cooldown_expiry` job.

**Verified after this phase:** `status === 'cooldown'`; all 6 jury docs are now `status: 'accepted'`.

### Phase 5 — Organizer reviews candidates (real HTTP)
The organizer POSTs to `/api/tournaments/:id/entries/:eid/approve` for all 8 pending `TournamentEntry` docs — the real approve route, which checks organizer ownership, phase (`open`/`cooldown`), capacity, and fires a `tournament_entry_approved` notification per approval.

**Verified after this phase:** all 8 approved; exactly 8 `tournament_entry_approved` notifications exist.

### Phase 6 — Force the cooldown deadline
Calls `tournamentCooldownExpiry(tournamentId)` directly (same function the real 24h-later agenda job calls). This checks approved-count === tournament size exactly (no byes allowed), then calls `activateTournament()`, which:
- Flips `status → active`, `stage → group`, stamps `activeAt`.
- Calls `generateGroups()` — Fisher-Yates shuffles the 8 approved entries into 2 groups of 4 (`groupSize`/`groupCount` come from the fixed size→group-config table for size 8).
- Calls `generateGroupMatches()` per group — builds the round-robin schedule via the "circle method" (`circleMethodRounds()`), creating a `Contest` + `TournamentMatch` for every pairing. Round 1 is created already `active` with a live `Contest`; rounds 2–3 are created `scheduled` with a deferred `open_tournament_match` agenda job.

**Verified after this phase:** `status === 'active'`, `stage === 'group'`; exactly 2 `TournamentGroup` docs; exactly 12 group-stage `TournamentMatch` docs (2 groups × 3-round round-robin × 2 matches/round).

### Phase 7 — Playing out the group stage
This is the most involved phase. For each of the 3 rounds:
- **Round 1** matches are already `active` — nothing to force open.
- **Rounds 2–3** matches are `scheduled` — the harness replicates the `open_tournament_match` job's effect directly (see §5 for why this had to be duplicated rather than called).

For every match, the harness casts exactly one vote (from the single dedicated voter account) for a **deterministically chosen winner**: whichever of the two entries' MongoDB `_id` sorts lexicographically smaller always wins. Applied consistently across every match a group's 4 members play against each other, this produces a strict, tie-free ranking automatically — without the harness needing to know the (randomly shuffled) group composition or match schedule in advance. It's the same trick as assigning each of the 4 members a fixed rank 1–4 by fiat and having "the better-ranked player always wins": the harness doesn't need to compute that ranking up front, because a total order on IDs *is* one.

After the vote, the harness calls `closeContest(contestId)` directly (same function the real votingDeadline sweeper calls) and then polls the `TournamentMatch` document until its `status` actually reaches `closed` before moving on — see §4.3 for why polling, not a second direct call, is the correct way to wait here.

**Verified after this phase:** both `TournamentGroup` docs reach `status: 'complete'`; exactly 4 entries end up "advancing" (`groupRank` 1 or 2, `eliminated` not set) and exactly 4 "eliminated" (`eliminated: true`, no `groupRank` — see §4.4, this was a corrected assumption on the harness's part, not a bug).

### Phase 8 — Knockout stage
Once both groups are `complete`, `resolveGroup()`'s tail automatically calls `generateKnockoutBracket()`, which (for an 8-player tournament, field size 4) creates exactly 2 `SF` (semifinal) matches, already `active` immediately (knockout rounds don't use the deferred-open mechanism group-stage rounds 2–3 use — a full knockout round always opens all at once). The harness votes and closes both SF matches the same way as group matches.

Once both SF matches close, `handleKnockoutMatchClose()`'s SF branch automatically creates the `Final` (SF winners) and `3rd`-place (SF losers) matches simultaneously. The harness polls for their creation, then votes and closes both.

**Verified after this phase:** exactly 2 SF matches; `Final` and `3rd`-place matches both get created after SF closes.

### Phase 9 — Close + payout verification
Once `Final` and `3rd` both close, `handleKnockoutMatchClose()` calls `closeTournament()` automatically (whichever of the two closes last is the one that actually sees both decided and proceeds — the other backs off via an atomic status claim). The harness polls for `Tournament.status === 'closed'`, with a direct manual call to `closeTournament()` as a last-resort fallback if polling times out (mirroring the codebase's own pattern of calling it "speculatively from multiple sites").

**Verified after this phase — all passed with no discrepancies:**
- `status === 'closed'`, `prizes.winnersSet === true`.
- 1st-place winner's `wallet.earnedCHL` increased by exactly 350 CHL.
- 2nd-place winner's `wallet.earnedCHL` increased by exactly 100 CHL.
- 3rd-place winner's `wallet.earnedCHL` increased by exactly 50 CHL.
- Exactly 3 `tournament_prize_awarded` notifications.
- Exactly 8 `tournament_closed` notifications (one per approved participant).
- Exactly 4 `tournament_knockout_started` notifications (2 per SF match).
- Zero jurors ended up `juryBanned: true` (correct — no tie ever occurred in this run, so no juror was ever asked to vote, so none could have missed one).
- Zero `TournamentJuryVote` documents exist (correct, same reason).

---

## 4. Bugs found — and who they belong to

Four things went wrong across the iterations it took to get a clean run. **Three were bugs in the harness script itself**, caught and fixed by inspecting the actual database state after each failure rather than trusting the script's own success/failure signal. **One is a stale-documentation issue**, unrelated to this simulation but worth noting since it was found in the same session. None of the four turned out to be a bug in the tournament product code itself.

### 4.1 Agenda not ready when a job function tries to schedule a follow-up job
**Symptom:** `Cannot read properties of undefined (reading 'insertOne')` inside the `agenda` package, thrown from `transitionToCooldown()`.
**Cause:** `jobs/agenda.js` connects to MongoDB asynchronously in its constructor. Several of the job functions the harness calls directly (`transitionToCooldown`, `generateGroupMatches`, `generateKnockoutBracket`, `createBracketMatch`) lazily `require('../jobs/agenda')` and immediately call `agenda.schedule(...)` — fine in the real server, which explicitly `await`s `agenda.start()` before any request can reach this code, but the harness had no equivalent wait.
**Fix:** the harness now `require`s `jobs/agenda.js` itself at startup and waits for its `'ready'` event before doing anything else. No need to call `.start()` — scheduling a job is just an insert into the `agendaJobs` collection, which only needs the connection to be up, not the processor to be running.
**Verdict:** harness bug. The real server was never at risk — this only matters for code that talks to Agenda outside of an already-running server process.

### 4.2 Round-bucketing assumed round 1's `scheduledAt` matches exactly across both groups
**Symptom:** the harness detected 4 "rounds" instead of 3, with one bogus round's matches already `active` instead of `scheduled`.
**Cause:** in `utils/tournamentScheduler.js`'s `generateGroupMatches()`, round 1's `scheduledAt` is `new Date()` captured **independently inside each group's own call** to that function — so group A's round-1 matches and group B's round-1 matches land a few milliseconds apart. Rounds 2–3 use `tournament.activeAt` (a single value persisted once and re-read fresh from the DB by both calls), so those *do* line up exactly across groups. The harness's original bucketing (group matches by exact `scheduledAt.getTime()` equality) worked for rounds 2–3 but incorrectly split round 1 into two separate buckets.
**Fix:** bucket by `Math.round((scheduledAt - tournament.activeAt) / DAY_MS)` instead of raw timestamp equality — this rounds group A's and group B's round-1 matches (both within a few ms of `activeAt`) down to the same integer (`0`), while still correctly separating rounds 1/2/3.
**Verdict:** harness bug, and arguably a slightly surprising (but not wrong) product detail worth knowing: round-1 `scheduledAt` values are *not* guaranteed identical across groups in the same tournament the way rounds 2+ are. Nothing in the product actually depends on them being equal, so this isn't a product bug — it just means "group matches by scheduledAt" is not a safe pattern for any future tooling either.

### 4.3 Double-counted wins/losses/groupPoints from a race with a fire-and-forget call — the important one
**Symptom:** after fixing §4.2, the group stage produced entries with **4 wins in a 3-match round-robin** (verified by dumping raw match/entry documents with a throwaway inspection script) — a value that shouldn't be reachable at all. Downstream, this also meant `checkGroupComplete()`'s "are all matches closed" check ran against a genuinely inconsistent state and one of the two groups sporadically never resolved.
**Cause:** `jobs/contestJobs.js`'s `closeContest()` triggers the tournament-side hook like this:
> `handleTournamentMatchClose(contest._id, winnerEntryId, voteCounts).catch(err => {...})` — **fired, not awaited.**
This is intentional in production: `closeContest` itself is invoked from an agenda job or another fire-and-forget hook, so nothing is waiting on it synchronously anyway. But the harness's first version, after `await`ing `closeContest()`, also explicitly `await`ed `handleTournamentMatchClose()` itself again — reasoning that its top-of-function guard (`if (match.status === 'closed') return;`) made a second call safe/idempotent. That guard *is* correctly idempotent **once the first call's write has actually landed** — but the first call is fire-and-forget, so there's a window where **both** the internal call and the harness's explicit call read `match.status` as not-yet-`closed` and both proceed to `$inc` `wins`/`losses`/`groupPoints`. Classic check-then-act race, just one that only exists when something *outside* the request/job lifecycle tries to force synchronous completion of a fire-and-forget chain.
**Fix:** removed the harness's explicit redundant call entirely. Instead, after `closeContest()`, the harness polls (checks every 100ms, up to a few seconds) for the `TournamentMatch` document to actually reach `status: 'closed'` before moving on — waiting for the *effect* to land rather than trying to force it to happen synchronously a second time. The same polling approach was then needed in two more places for the same underlying reason: waiting for both `TournamentGroup` docs to reach `complete` (since `checkGroupComplete`/`resolveGroup` are themselves inside that same unawaited chain), and waiting for the `Final`/`3rd` matches to be created after both semifinals close (same reason, one level further down the cascade).
**Verdict:** harness bug — but a genuinely instructive one. The fire-and-forget pattern itself is a deliberate, reasonable choice in the product (so that closing a contest and responding to whoever cast the last vote doesn't block on unrelated tournament bookkeeping), and it's safe under real usage because nothing in the real app ever tries to force it to finish early. It's only a trap for *tooling that reaches into the system from outside* a normal request/job — worth remembering for any future scripts, tests, or admin tooling that calls these functions directly.

### 4.4 False-positive assertion: assumed every entry gets a `groupRank`
**Symptom:** "4 TournamentEntry docs have no groupRank after group stage completed" flagged as an anomaly.
**Cause:** the harness's own incorrect assumption. Reading `resolveGroup()` (`jobs/tournamentJobs.js`) directly shows this is by design: only the 2 *advancing* members per group get `groupRank` set (`1` or `2`); the 2 eliminated members get `eliminated: true` and their `groupRank` is left unset entirely — there's no `rank: 3` / `rank: 4` written anywhere.
**Fix:** corrected the assertion to check "4 advancing entries with `groupRank` 1 or 2" and "4 eliminated entries with no `groupRank`" separately, instead of "all 8 have some rank."
**Verdict:** not a bug at all — a documentation moment for whoever writes tooling against this schema next. `groupRank` absence means "eliminated," not "not yet computed."

---

## 5. One real product-level observation (not a bug)

While building the harness, one asymmetry in the job-definition pattern stood out: every tournament-related agenda job **except one** is defined as a thin `agenda.define(name, async job => await someExportedFunction(...))` wrapper around a standalone function that's also listed in `jobs/tournamentJobs.js`'s `module.exports` — meaning `tournamentOpenExpiry`, `tournamentCooldownExpiry`, `tournamentJuryExpiry`, `tournamentOrganizerVoteExpiry`, `resolveGroupJuryVote`, `resolveGroupOrganizerVote`, etc. can all be imported and called directly, exactly as this harness does throughout.

**`open_tournament_match` is the one exception.** Its entire ~25-line body (flip the match to `active`, open its `Contest` with a fresh `votingDeadline`, fire loop-in notifications) is written inline inside the `agenda.define('open_tournament_match', async job => {...})` call in `registerTournamentJobs()`, with no corresponding exported function. To force a group-stage round 2/3 open without waiting a real day, the harness had no choice but to **duplicate that logic** into its own `forceOpenMatch()` helper.

This isn't a functional bug — the job works correctly when the real agenda processor runs it. It's a small consistency/testability gap: if this function were extracted and exported the same way every sibling job handler already is, any future script, test, or admin tool that needs to force a match open (this harness, a future automated test suite, a support-tooling "unstick this tournament" admin action) could call it directly instead of re-deriving its behavior from reading the source. Low priority, but a one-line-diff fix (extract the body to a named `async function openTournamentMatch(matchId) {...}`, add it to `module.exports`, and have the `agenda.define` call it) whenever someone's touching that file next.

---

## 6. What this run does — and does not — tell you

**Confirmed working, for a clean 8-player run with no ties or cancellations:**
- The full creation wizard's real validation (thumbnail required, name uniqueness/length/charset, size/openDays enums, prize minimums-and-ordering, wallet-sufficiency, empty eligibility criteria, jury count bounds).
- Real entry upload → automatic tournament candidacy at upload time.
- Real organizer approve flow, including notification firing.
- The open→cooldown→active deadline chain, including jury auto-accept-on-no-response.
- Round-robin group scheduling (circle method) producing the correct match count and no double-booking within a round.
- Vote tallying and contest closing.
- Group ranking and advance/eliminate assignment.
- Cross-group knockout seeding, SF→Final/3rd bracket generation.
- Tournament close, exact prize crediting (full amount, no fee deduction — unlike standalone-contest contribution payouts, which take a 25% platform fee), and the full notification set.
- Zero unintended side effects on jury-ban state when no tie ever occurs.

**Not exercised by the happy-path run at all** (see the updated punch list in §9): 2-way or knockout ties, under-filled open phase / auto-cancellation, cooldown review timeout, organizer self-cancellation, jury decline/miss-vote/permanent-ban, the organizer/jury regular-H2H voting restriction, tournament sizes other than 8, private-visibility tournaments, wildcard-stain auto-draft, mid-tournament entry deletion, the comment/report/loop-in social layer, or genuinely concurrent match closes racing each other's atomic claims. The 3+-way group-ranking tie gap is now closed — see §7.

---

## 7. Scenario 2 — 3+-way group-ranking boundary tie

**Flag:** `--scenario=group-tie`
**Result:** ✅ Clean pass. This exercises the newest and, prior to this run, completely unexercised code in the tournament feature: `TournamentGroupTieVote`, `resolveGroupTieCluster`, `resolveGroupJuryVote`, and the jury-quorum branch of the 6h→3h→coin-flip chain for a *group ranking* dispute (distinct from `TournamentJuryVote`, which is the same chain applied to a single H2H match result).

### 7.1 What "forcing a tie" means mechanically

A group's ranking is decided by `resolveGroup()` (`jobs/tournamentJobs.js`) sorting members by `groupPoints → ratingAvg → ratingCount → totalVotesInGroup`, then checking whether the entry in the last advancing slot (index `ADVANCE_COUNT - 1`, i.e. index 1 for a group of 4 with 2 advancing) and the entry just below the cutoff (index 2) are identical on *all four* of those fields. If they are, every other member matching them on all four fields joins the disputed "cluster." A cluster of exactly 2 gets an ordinary tiebreaker H2H match; a cluster of 3 or more (this scenario) goes to the full jury/organizer/coin-flip chain.

To force a clean, deterministic 3-way tie without needing to know the (randomly shuffled) group composition in advance, the harness assigns each of a group's 4 members a "position" (0–3, taken from the order of `TournamentGroup.memberIds`) and applies a fixed rule to every match in that group:

- **Position 0 wins every match it plays.** Three wins → `groupPoints: 3`.
- **Positions 1, 2, and 3 form a rock-paper-scissors cycle** (1 beats 2, 2 beats 3, 3 beats 1). Each of them therefore wins exactly 1 of the 3 matches among the trio (their 4th match, against position 0, is always a loss) → `groupPoints: 1` each.
- Since every seeded entry is brand new, `ratingAvg`/`ratingCount` are `0`/`0` for all four, trivially tied.
- The harness casts exactly one vote per match (for the designated winner only), so `totalVotesInGroup` for positions 1–3 is exactly `1` each (their single win) — also trivially tied.

Result: positions 1, 2, and 3 are identical on all four of `resolveGroup`'s sort/tie fields, and that identical trio straddles the rank-2/rank-3 cutoff exactly. `resolveGroup` should detect a 3-member cluster disputing exactly 1 remaining slot (position 0 already took the other one). The tournament's other group is resolved with the ordinary lexicographic-ID rule from the happy path, so only one group ties — this keeps the scenario isolated and makes it unambiguous which group's behavior is under test.

### 7.2 Phase-by-phase result

**Phases 1–6** are byte-for-byte identical to the happy path (same setup function, `setupThroughActiveGroupStage()`) — see §3 for that detail. The scenario diverges starting at Phase 7.

**Phase 7 (group stage, forced tie):** all 12 group matches close successfully using the position-based winner rule for Group A and the lexicographic rule for Group B.

**Phase 7b (tie detection):** verified —
- Group B (clean) reaches `status: 'complete'` normally.
- Group A reaches `tieStatus: 'jury_pending'` instead of completing.
- `tiedEntryIds.length === 3`.
- `tieSlotsForCluster === 1` (only the rank-2 spot is disputed — position 0's rank-1 spot was never in question).
- `tieDeadline` is set (the 6h jury window).
- Exactly 6 `tournament_group_tie_jury` notifications fired — one per `accepted` juror, confirming `initiateGroupTieResolution()` notifies the whole jury, not just a subset.

**Phase 7c (jury resolves it):** 3 of the 6 jurors log in over real HTTP and each `POST /api/tournaments/:id/groups/:groupId/jury-vote` with the same `votedForTournamentEntryId` (the harness's designated "position 1" entry). Verified —
- All 3 votes accepted (`200`), each creating a `TournamentGroupTieVote`.
- The 3rd vote's request handler synchronously resolves the tie in-process (unlike the fire-and-forget contest-close chain used elsewhere, `resolveGroupJuryVote()` is directly `await`ed by the route) — Group A reaches `status: 'complete'`, `tieStatus: 'resolved'` by the time that HTTP response returns, no polling delay needed (a short poll was kept anyway as cheap insurance).
- Exactly 3 `TournamentGroupTieVote` documents exist for the group.
- Position 0 and the jury's chosen pick both end up `groupRank` 1 or 2 (not eliminated); the two non-selected tied members are `eliminated: true` with no `groupRank` — correctly mirroring the same "only advancers get a rank" rule confirmed in the happy path (§4.4).
- **Nobody was penalized:** all 6 jurors' `missedVotes` stayed at `0`, because resolution happened via quorum well inside the 6h window — `tournamentGroupJuryExpiry()` (the only place that increments `missedVotes`) never had a reason to fire. This confirms the "innocent until the deadline actually passes" behavior works correctly, not just its absence-of-tie counterpart already confirmed in the happy path.

**Phase 8–9 (knockout + close):** identical shared code path to the happy path (`playKnockoutAndVerifyClose()`) — the 4 advancing entries (2 from the clean group, 2 from the resolved tie) proceed through SF → Final/3rd exactly as before, and the tournament closes with correct prize crediting. The only assertion that differs from the happy path is the expected `TournamentGroupTieVote` count (3, not 0).

**No product bugs found.** The entire 3+-way tie chain — detection, cluster sizing, jury notification, quorum vote, decisive-plurality resolution, rank assignment, and the "no penalty for a timely resolution" behavior — worked exactly as `plans/July/tournament-implementation-plan.md`'s "Phase 7 — Group-Tie Extension" describes.

### 7.3 Harness bug found while building this scenario

**Symptom:** the first attempt produced `tieSlotsForCluster: 2` instead of the expected `1`, and the subsequent jury vote never resolved the tie (stayed `jury_pending`) even after all 3 jurors voted for the same entry.
**Cause:** an ID-space mix-up in the harness's own winner-picking helper. `TournamentGroup.memberIds` is an array of **`TournamentEntry`** ids, so the harness's `positionOf` lookup map was built keyed by those. But the helper then looked positions up using `match.entryIdA`/`match.entryIdB` — which are plain **`Entry`** ids (a different collection, different ID space entirely — see `models/TournamentMatch.js`, which stores both `entryIdA/B` *and* `tournamentEntryIdA/B` on every match specifically because callers need both). Every `positionOf.get(...)` call therefore silently returned `undefined`; `posA === 0`/`posB === 0` were never true, so "position 0 always wins" never actually applied, and the fallback cyclic-comparison logic (`undefined === 1`, etc.) was also always false — meaning the helper always just returned `entryIdB` unconditionally, regardless of position. That produced an uncontrolled, non-cyclic result that happened to leave *four* members tied (not the intended three), which is why `tieSlotsForCluster` came out as `2` instead of `1`.
**Fix:** changed the lookup to key off `match.tournamentEntryIdA`/`match.tournamentEntryIdB` (matching `positionOf`'s key space) while still *returning* `match.entryIdA`/`match.entryIdB` (the id the voting route actually needs).
**Verdict:** harness bug, caught by noticing the numbers didn't match hand-derived expectations (§7.1's math) rather than by a crash — worth remembering for any future tooling that mixes `TournamentEntry` and `Entry` ids, since `TournamentMatch` deliberately stores both and it's easy to grab the wrong one.

---

## 8. Scenario 3 — organizer/jury barred from regular H2H voting

**Flag:** `--scenario=voting-restriction`
**Result:** ✅ Clean. First run surfaced one genuine (minor) product bug (§8.3); fixed the same session and re-run confirmed the fix, with no regressions on the other three checks.

### 8.1 What this scenario is actually testing

This is a universal business rule from `CLAUDE.md`, not part of the tournament state machine: while a tournament is `open`/`cooldown`/`active`, its **organizer** and **jury** are barred from voting in an unrelated **standalone** H2H contest (`Contest.tournamentId` is `null`) — but voting on the tournament's **own** group/knockout matches (`Contest.tournamentId` set) is unaffected, since that's how those matches are normally decided in the first place. The check is inline in `POST /api/contests/:id/vote` (`routes/api.js`):

```js
if (!contest.tournamentId) {
  const juryTournamentIds = await TournamentJury.distinct('tournamentId', { userId });
  const [isActiveOrganizer, isActiveJuror] = await Promise.all([
    Tournament.exists({ createdBy: userId, status: { $in: ['open','cooldown','active'] } }),
    Tournament.exists({ _id: { $in: juryTournamentIds }, status: { $in: ['open','cooldown','active'] } }),
  ]);
  if (isActiveOrganizer || isActiveJuror) return res.status(403).json({ error: '...' });
}
```

Unlike the other two scenarios, this one doesn't need to play out any matches or force any deadline transitions beyond reaching `active` — it's a pure authorization-check probe. The harness calls `setupThroughActiveGroupStage()` and stops immediately after Phase 6 (tournament `active`/`group`, round-1 matches already live), then seeds one unrelated standalone `Contest` directly via Mongoose (two throwaway "bystander" users + entries — this fixture isn't under test, so there's no need to drive it through real contest-creation routes) to use as the vote target.

### 8.2 Phase-by-phase result

- **Phase 8:** the organizer attempts `POST /api/contests/:standaloneContestId/vote` → **correctly blocked, `403`**.
- **Phase 9:** an `accepted` juror attempts the same vote → **correctly blocked, `403`**.
- **Phase 10:** one juror's `TournamentJury.status` is flipped to `'declined'` (simulating them having actually declined the invite), then that juror attempts the same vote → **initially blocked incorrectly (`403`)**, see §8.3 — **now correctly allowed (`200`)** after the fix.
- **Phase 11 (control case):** the organizer and a different `accepted` juror both vote on the tournament's **own** live round-1 match instead → **both correctly allowed, `200`** — confirming the restriction is scoped to unrelated standalone contests specifically, not a blanket "can't vote on anything" block.

### 8.3 Bug found and fixed: a declined juror was still blocked

**What was found:** a juror who explicitly **declined** their jury invite (`TournamentJury.status: 'declined'`) was still blocked (`403`) from voting in an unrelated standalone contest, for as long as the tournament they declined stays `open`/`cooldown`/`active`.

**Why:** the restriction query, `TournamentJury.distinct('tournamentId', { userId })`, had no `status` filter at all — it matched on the mere *existence* of a `TournamentJury` record naming that user, regardless of whether it was `pending`, `accepted`, or `declined`. A user who was invited and declined never actually serves on the jury and has no ongoing conflict of interest, but the check couldn't distinguish them from someone actively judging.

**Why it mattered:** a real, if minor, over-restriction — it could silently block a real user from voting in an unrelated contest they have every right to participate in, for the full multi-day lifetime of a tournament they explicitly opted out of. Easy to miss because declining an invite reads, from the user's perspective, as "I'm done with this tournament" — they'd have no reason to expect it still affects them elsewhere on the platform.

**Verdict:** CONFIRMED product bug (verified directly via a real HTTP request/response, not inferred from reading the code). Low severity, narrow blast radius (only affects users who both (a) get invited to jury and (b) decline, which is presumably uncommon).

**Fix applied:** `routes/api.js`, the contest-vote handler — added `status: 'accepted'` to the `TournamentJury.distinct(...)` query's filter:

```js
// before
const juryTournamentIds = await TournamentJury.distinct('tournamentId', { userId: req.session.userId });
// after
const juryTournamentIds = await TournamentJury.distinct('tournamentId', { userId: req.session.userId, status: 'accepted' });
```

This mirrors how `initiateGroupTieResolution`/`initiateTieResolution` and every other jury-facing check in `jobs/tournamentJobs.js` already scope to `status: 'accepted'` jurors only — this was the one jury-related query in the codebase that didn't.

**Re-verified:** re-ran the scenario after the fix. The declined juror's vote now returns `200` (allowed) instead of `403`, and all three other checks (organizer blocked, accepted juror blocked, both allowed on their own tournament's match) still pass with no regressions.

### 8.4 No harness bugs this time

Unlike the first two scenarios, this one ran clean on the first attempt — no ID mix-ups, no race conditions, no false-positive assertions. The main reason is structural: this scenario never plays a match or forces a fire-and-forget cascade to resolve, so none of the timing traps documented in §4 and §7.3 were even reachable here.

---

## 9. Suggested next passes (not yet run)

Grouped by lifecycle phase, roughly in priority order. The 3+-way group-ranking tie and organizer/jury voting-restriction items from the original list are done (§7, §8, including the fix from §8.3) and removed below.

**Creation**
- Organizer eligibility boundaries (exactly 250 followers → rejected, 251 → allowed; exactly 5 vs 4 contest contributions; 3rd concurrent tournament blocked).
- Private-visibility tournament, reachable only by direct link.
- Insufficient `purchasedCHL` at step 2 → inline funding path, including the ">500 shortfall needs multiple payments" branch.
- Jury size boundaries: exactly 5 and exactly 7 accepted; attempting 4 or 8 rejected at the route level.

**Open phase**
- Fewer submissions than the size cap by the deadline → auto-cancel + refund (`insufficient_candidates` reason).
- Organizer attempting to submit their own entry → must be blocked (`checkTournamentPreflight`/`submitEntryToTournament` both check this — worth confirming the route-level UX matches).
- Wildcard-stain auto-draft: an entry uploaded *without* explicitly targeting the tournament, whose tags overlap the tournament's `wildcardStains`, should still auto-submit via `attemptTournamentAutoDraft`.
- A submitted candidate's `Entry` gets deleted mid-review.

**Cooldown**
- Organizer fails to reach exactly the size-cap of approvals within 24h → auto-cancel (`cooldown_incomplete`).
- Organizer can't reach the cap due to over-rejection → self-cancel path.
- Approving during `open` itself (not just `cooldown`) — the code explicitly supports this ("rolling basis").

**Active — group stage**
- A clean 2-way tie for the 2nd qualifying spot → ordinary tiebreaker H2H match (`isTiebreakerMatch: true`), not the jury chain. (The 3+-way variant is now covered — see §7 — but the simpler 2-way `createTiebreakerMatch` path is still unexercised.)
- The 3+-way tie's **organizer-fallback and coin-flip branches** — §7 only exercised the "jury reaches a decisive plurality" path. Still untested: jurors split their votes so the plurality itself is ambiguous at the cutoff (`resolveGroupJuryVote`'s ambiguity check, which this exact bug tripped by accident in §7.3 — worth deliberately re-triggering), the 6h jury window expiring with jurors penalized via `missedVotes`, the organizer's 3h decision window (`resolveGroupOrganizerVote`), and the organizer window expiring into `tournamentGroupOrganizerVoteExpiry`'s coin flip.
- A juror who never votes on a tie → `missedVotes` increment, then permanent `juryBanned: true` once the tournament closes (this run explicitly confirmed the *negative* case — nobody gets banned when no tie occurs — but never exercised the positive case).

**Active — knockout**
- A tie inside a knockout match (same chain as group-stage, but worth confirming the SF-loser-still-gets-3rd-place bookkeeping survives a tie specifically).
- Verify `tournament_knockout_started` actually renders correctly in `views/notifications.ejs` in a live browser session (the display case exists in code — confirmed in an earlier pass of this conversation — but this simulation only checked the `Notification` document was created, not that it renders).
- Mid-knockout `Entry` deletion.

**Close**
- A 4-player tournament specifically, to confirm no 3rd-place match/prize placement is created or expected (both runs so far used size 8, which always has a 3rd-place match).
- Sizes 12/16/24, to exercise `R16`/`QF` knockout rounds neither run's field-size-4 bracket ever reaches.

**Cross-cutting / social layer**
- Comments, likes/dislikes, reports, and loop-in on the tournament page across every lifecycle status including `closed`.
- Tournament report → confirm it now shows up in `/admin/moderation`'s "Tournaments" tab (this was verified to exist in code earlier in this session, but not exercised end-to-end by a simulation).
- Profile trophy counters (`firstPrizes`/`secondPrizes`/`thirdPrizes`) increment correctly after a real close (neither run checked the winners' profile pages).

---

## 10. How to run it

```bash
# Happy path (default scenario) — requires `npm run dev` already running on the port in .env
node scripts/simulateTournament.js

# 3+-way group-ranking tie scenario
node scripts/simulateTournament.js --scenario=group-tie

# Organizer/jury voting-restriction scenario
node scripts/simulateTournament.js --scenario=voting-restriction

# Remove all __sim_-tagged data created by any prior run/scenario
node scripts/simulateTournament.js --cleanup
```

Every scenario is idempotent to re-run repeatedly (each run creates freshly-timestamped `__sim_` users and a uniquely-named tournament), but always run `--cleanup` when you're done so dev-database browsing/admin views aren't cluttered with simulated tournaments. New scenarios are added to the `SCENARIOS` map at the bottom of `scripts/simulateTournament.js`, reusing `setupThroughActiveGroupStage()` (phases 1–6, identical across every scenario) and `playKnockoutAndVerifyClose()` (phases 8–9, identical once the group stage has resolved by whatever means the scenario exercises).
