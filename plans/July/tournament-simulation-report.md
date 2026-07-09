# Tournament Simulation Report

**Date:** 2026-07-08
**Harness:** `scripts/simulateTournament.js` — supports multiple scenarios via `--scenario=<name>` (default `happy-path`), plus a `--cleanup` mode in the same file.
**Status:** 15 scenarios have now been run, closing out every item that was ever in the backlog, including all 5 residual items from the second pass (§21 is essentially empty). **Two genuine product bugs were found and fixed:** a declined juror still barred from unrelated voting (§8.3), and — the most serious finding in this entire report — approving a candidate whose `Entry` was deleted let a tournament reach cooldown-expiry, where bracket generation dereferences the dangling reference and throws, but only *after* the tournament's status had already atomically flipped to `active`, **permanently wedging it** with no possible retry (§19, `orphaned-entry-crash`). Both are fixed and re-verified. Several harness bugs were found and fixed along the way, most following one recurring pattern: a fire-and-forget side effect (§4.3, §14.3, §16.3, §17 — four separate instances of the same class of race) plus one process-hanging `agenda` event-listener bug (§15.1).

**Scenario summary:**

| Scenario | Flag | Result |
|---|---|---|
| Happy path (no ties, no cancellations) | *(default)* | ✅ Clean — see §3 |
| 3+-way group-ranking boundary tie, resolved by jury quorum | `--scenario=group-tie` | ✅ Clean — see §7 |
| Organizer/jury barred from regular H2H voting while tournament is active | `--scenario=voting-restriction` | ✅ Clean — one bug found, fixed, and re-verified — see §8 |
| 3+-way tie, ambiguous jury plurality → organizer resolves within 3h | `--scenario=group-tie-organizer` | ✅ Clean — see §9 |
| 3+-way tie, total non-engagement → 6h + 3h both expire → coin flip | `--scenario=group-tie-coinflip` | ✅ Clean — see §10 |
| Plain 2-way group-ranking tie → ordinary extra H2H tiebreaker match | `--scenario=group-tie-2way` | ✅ Clean — see §11 |
| Open-phase under-fill → auto-cancel + full prize-pool refund | `--scenario=open-underfill-cancel` | ✅ Clean — see §12 |
| Creation-wizard boundaries (eligibility, jury size, private visibility, inline funding) | `--scenario=creation-boundaries` | ✅ Clean — see §13 |
| Open-phase edges (self-submit blocked, wildcard auto-draft, mid-review deletion) | `--scenario=open-phase-edges` | ✅ Clean — the crash this surfaced is fixed, see §14 + §19 |
| Cooldown edges (review-timeout cancel, approve-during-open, over-rejection self-cancel) | `--scenario=cooldown-edges` | ✅ Clean — one harness hang found and fixed — see §15 |
| Match-level knockout tie + live notification-render check | `--scenario=knockout-tie` | ✅ Clean — see §16 |
| Boundary tournament sizes 4/12/16/24 (including the deepest bracket, R16-first) | `--scenario=boundary-sizes` | ✅ Clean — see §17 |
| Social layer + admin resolution actions (comments, loop-in, reports, admin queue, profile trophies) | `--scenario=social-layer` | ✅ Clean — see §18 |
| Orphaned-approved candidate driven through to group generation | `--scenario=orphaned-entry-crash` | ⚠️→✅ **Confirmed a severe crash + permanent wedge, then fixed and re-verified** — see §19 |
| Genuinely concurrent match closes racing atomic claims | `--scenario=concurrent-closes` | ✅ Clean — see §20 |

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

One tournament size (8 players — mid-sized, exercises both a multi-round group stage *and* a multi-round knockout bracket with a 3rd-place match), zero forced ties, no cancellations, no rejected candidates. This is deliberately the simplest possible "everything goes right" path, run first to (a) prove the harness itself is correct before layering in edge cases, and (b) establish a clean baseline. This report has since grown to cover 12 further scenarios (§7–§18), closing out essentially the entire original edge-case backlog; what's left is tracked in §19.

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

**Not exercised by the happy-path run itself** — but every one of these gaps has since been closed by a later scenario in this same report, cross-referenced here rather than left as an open punch list: 2-way group ties (§11) and 3+-way group ties in all three resolution paths (§7, §9, §10); knockout-stage match ties (§16); under-filled open phase / auto-cancellation (§12) and cooldown review timeout / over-rejection self-cancel (§15); jury decline/miss-vote/permanent-ban (§9, §10 — positive case; §12, §15 — negative case); the organizer/jury regular-H2H voting restriction (§8); tournament sizes other than 8 (§17, sizes 4 and 12 specifically — 16/24 remain a deliberate residual, §19); private-visibility tournaments, jury-size and eligibility boundaries, and insufficient-funds inline funding (§13); wildcard-stain auto-draft and organizer self-submission (§14); the comment/report/loop-in social layer and admin moderation queue (§18). Genuinely concurrent match closes racing each other's atomic claims remain unexercised — every scenario in this report closes matches one at a time (see §19).

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

## 9. Scenario 4 — group-tie: ambiguous jury plurality → organizer resolves

**Flag:** `--scenario=group-tie-organizer`
**Result:** ✅ Clean on the first attempt — no harness bugs, no product bugs.

### 9.1 What this scenario adds beyond Scenario 2 (§7)

Scenario 2 proved the "jury reaches a decisive plurality" path. This scenario forces the same 3-way tie (extracted into a shared `forceGroupTie()` helper, reused by both this and the coin-flip scenario below — Phases 1–7b are now identical code across §7/§9/§10, not copy-pasted) but drives it through the harder paths: an **ambiguous** jury vote, the **6h expiry penalty**, and the **organizer's decision window**.

- **Phase 7c:** instead of 3 jurors voting for the same entry, they each vote for a **different** one of the 3 tied entries — a 1-1-1 split. `resolveGroupJuryVote`'s ambiguity check (`counts[order[cutoff-1]] === counts[order[cutoff]]`) is specifically designed to catch this: quorum (3 votes) is reached, but since the top two vote-getters are tied at 1 vote each, there's no genuine plurality for the disputed slot. **Confirmed:** the group correctly stays `jury_pending` — this is the exact ambiguity branch the original group-tie scenario's own harness bug (§7.3) had accidentally tripped over before it was diagnosed and fixed.
- **Phase 7d:** `tournamentGroupJuryExpiry()` is called directly to force the 6h window to elapse. **Confirmed:** the 3 jurors who never voted are penalized with `missedVotes: 1`; the 3 who *did* vote (even though their votes didn't resolve anything) are correctly **not** penalized; `tieStatus` transitions to `organizer_pending`; exactly 1 `tournament_group_tie_organizer` notification fires to the organizer.
- **Phase 7e:** the organizer resolves it via the real `POST /api/tournaments/:id/groups/:groupId/organizer-vote` route, submitting a full ordering of the 3 tied entries. **Confirmed:** `200`, group reaches `status: 'complete'`/`tieStatus: 'resolved'`, and ranks land exactly as expected (position 0 + the organizer's first-ranked pick advance; the other two eliminated with no `groupRank`).
- **Phases 8–9 (knockout/close):** identical to every other scenario, but this is the first run where `playKnockoutAndVerifyClose()`'s banned-juror check had to be **generalized** — earlier scenarios always expected zero bans; this one deliberately expects the 3 non-voting jurors to end up `juryBanned: true` once the tournament closes (the ban itself is applied by `closeTournament()`, not by the jury-expiry step — `missedVotes > 0` is just the marker it reads). **Confirmed:** exactly those 3 are banned, the 3 who voted are not.

No harness bugs and no product bugs this time — every mechanic (ambiguity detection, the missedVotes penalty, the organizer route, and the deferred ban-at-close) worked exactly as `plans/July/tournament-implementation-plan.md`'s "Phase 7 — Group-Tie Extension" describes.

---

## 10. Scenario 5 — group-tie: total non-engagement → coin flip

**Flag:** `--scenario=group-tie-coinflip`
**Result:** ✅ Clean on the first attempt — no harness bugs, no product bugs.

### 10.1 What this scenario adds

The most extreme case in the chain: **nobody** — no juror, no organizer — ever acts on the tie. This confirms the platform's "a tie can never block progression more than 9h total" guarantee holds even in total non-engagement, not just when someone eventually shows up.

Using the same `forceGroupTie()` setup as §9, this scenario casts **zero** jury votes at all, then:
- **Phase 7c:** forces the 6h jury window to expire (`tournamentGroupJuryExpiry()`) with no votes cast. **Confirmed:** all 6 accepted jurors are penalized with `missedVotes: 1` (nobody voted, so nobody is exempt); `tieStatus` transitions to `organizer_pending` as usual.
- **Phase 7d:** forces the 3h organizer window to also expire untouched (`tournamentGroupOrganizerVoteExpiry()`). **Confirmed:** the group resolves via the platform's random coin flip — `tieStatus: 'resolved'`, `status: 'complete'`. Position 0 (never part of the tie) always advances regardless of the flip's outcome; exactly 1 of the 3 tied entries wins the coin flip and advances alongside it; the other 2 are eliminated. (Which of the 3 wins is random by design, so the assertions check structural correctness — exactly 1 advances, exactly 2 eliminated — rather than a specific identity.)
- **Phases 8–9 (knockout/close):** all **6** jurors — the entire jury for this tournament — end up `juryBanned: true` once the tournament closes, since all 6 missed their vote. **Confirmed** exactly as expected, no unexpected exemptions.

No harness bugs and no product bugs. Between this scenario and §9, every branch of the group-ranking tie chain described in the implementation plan's "Phase 7 — Group-Tie Extension" has now been exercised at least once: decisive jury plurality (§7), ambiguous jury plurality → organizer decides (§9), and total non-engagement → coin flip (§10).

---

## 11. Scenario 6 — plain 2-way group-ranking tiebreaker match

**Flag:** `--scenario=group-tie-2way`
**Result:** ✅ Clean on the first attempt — no harness bugs, no product bugs.

### 11.1 Why this needed a different setup than §7/§9/§10

`resolveGroup()` has two entirely separate branches once it detects a boundary tie: a cluster of exactly 2 gets an ordinary extra H2H match (`createTiebreakerMatch`) with no jury or organizer involvement at all; a cluster of 3+ gets the full jury/organizer/coin-flip chain the previous three scenarios exercised. This scenario targets the 2-way branch specifically.

Getting a *clean* 2-way tie turned out to be less trivial than it sounds. In a 4-player round robin, every match produces exactly one win, for 6 total wins split across the 4 players. Working through the integer constraints: if the top and bottom ranks are to be uniquely determined (not part of the tie) and the middle two are tied at some value Y, the only possible split is `X + 2Y + Z = 6` with `X > Y > Z ≥ 0` — and no integer solution exists (Y=1 forces X=4, which exceeds the maximum of 3 wins per player; every other Y forces a negative Z). So a clean 2-way boundary tie **cannot** be produced from match wins (`groupPoints`) alone with the other two ranks uniquely decided.

The workaround: reuse the same 3-way cyclic win pattern from §7/§9/§10 (one player sweeps at 3 points; the other three cycle at 1 point each — this distribution *is* achievable, as those scenarios proved), then directly bump two of the three 1-point players' `Entry.ratingAvg`/`ratingCount` (`resolveGroup`'s next tiebreak fields after `groupPoints`) to an equal, higher value. That pulls those two together and above the third on the full sort, narrowing the disputed cluster from 3 members down to exactly 2 — the third is pushed to a clean, uncontested last place instead of joining the tie. This fixture manipulation (directly writing to `Entry.ratingAvg`) isn't under test; only `resolveGroup`'s 2-way branch and `createTiebreakerMatch` are.

### 11.2 Phase-by-phase result

- **Phase 7:** two of the three eventual 1-point entries get `ratingAvg: 5, ratingCount: 3` (the third stays at the default `0`/`0`).
- **Phase 8:** group stage plays out with the same cyclic pattern as the 3+-way scenarios.
- **Phase 9:** **Confirmed** — a `TournamentMatch` with `isTiebreakerMatch: true` is created, pairing *exactly* the two differentiated entries (verified by comparing sorted ID pairs), `stage: 'group'`, and critically **no `tieStatus` is ever set** — confirming this is a structurally different code path from the jury chain, not just a smaller version of it. Group A correctly stays `status: 'active'` (not `'complete'`) while paused on this match.
- **Phase 10:** the tiebreaker match is voted on and closed like any other match. **Confirmed:** the group then resolves to `complete`, with ranks assigned exactly as predicted — rank 1 = the clean 3-0 sweep, rank 2 = the tiebreaker's winner, and both the tiebreaker's loser and the third (differentiated-away) entry end up eliminated with no `groupRank`.
- **Knockout/close:** identical shared path to every other scenario. **Confirmed:** zero `TournamentGroupTieVote`/`TournamentJuryVote` documents and zero banned jurors — a plain tiebreaker match never involves the jury at all, unlike every other tie scenario in this report.

No harness bugs and no product bugs. This closes out group-stage tie coverage entirely: both the 2-way (§11) and every branch of the 3+-way (§7, §9, §10) resolution paths now have a passing simulation.

---

## 12. Scenario 7 — open-phase under-fill → auto-cancel + refund

**Flag:** `--scenario=open-underfill-cancel`
**Result:** ✅ Clean on the first attempt — no harness bugs, no product bugs.

### 12.1 What this scenario is testing, and why the setup had to change

Every scenario before this one needed the full 8-candidate roster to reach `active`, so the shared setup helper was hard-coded to submit all 8. This is the first scenario that needed something the old setup couldn't do: submit *fewer* than the size cap. The fix was a small refactor, not new test logic — `setupThroughActiveGroupStage()`'s first three phases (seed users, run the creation wizard, submit candidates) were extracted into a new `setupThroughSubmission({ submitCount })`, parameterized on how many of the 8 seeded contestants actually submit. `setupThroughActiveGroupStage()` now just calls it with `submitCount: 8` and continues as before — every earlier scenario was re-run after this refactor to confirm no regression.

This scenario calls `setupThroughSubmission({ submitCount: 5 })` — 5 of 8 contestants submit, leaving the tournament under the cap — then forces the open-phase deadline directly via `tournamentOpenExpiry()` (the same function every other scenario uses to reach `cooldown`). With `submittedCount < tournament.size`, that function's own logic branches into `cancelTournament(tournamentId, 'insufficient_candidates')` instead.

### 12.2 Phase-by-phase result

- **Phase 3:** 5/8 candidates submit (confirmed via `TournamentEntry` count). The organizer's `purchasedCHL` is confirmed at exactly `500` right after creation (started at `1000`, debited the full `350+100+50` prize pool at finalize) — a baseline check before the refund, so the later "refunded back to 1000" assertion is meaningful rather than assumed.
- **Phase 4:** `tournamentOpenExpiry()` is called. **Confirmed:** `Tournament.status` becomes `'canceled'` (not `'cooldown'`), with `cancelReason: 'insufficient_candidates'` set exactly as `cancelTournament()` writes it.
- **Phase 5:** **Confirmed** — all 6 `TournamentJury` documents are deleted outright (not marked `declined` or penalized) — jurors who never actually got to serve owe no penalty, consistent with the doc's note on `cancelTournament()`.
- **Phase 6:** **Confirmed** — the organizer's `purchasedCHL` is refunded back to exactly `1000`, and a `WalletTransaction` with `type: 'tournament_prize_refund'` and `amountCHL: 500` exists as the audit trail.
- **Phase 7:** **Confirmed** — exactly 6 `tournament_canceled` notifications fire (1 to the organizer + 1 to each of the 5 contestants who actually submitted). The 3 contestants who never got around to submitting are correctly **not** notified — they never joined this tournament, so a cancellation notice would be spurious. Also confirmed: zero jurors end up `juryBanned` (the tournament never reached the point of any jury service, so there's nothing to penalize).

No harness bugs and no product bugs. Every side effect of `cancelTournament()` — status transition, jury release, wallet refund with audit trail, and notification targeting (submitters only, not the whole contestant pool) — worked exactly as the code promises.

---

## 13. Scenario 8 — creation-wizard boundaries

**Flag:** `--scenario=creation-boundaries`
**Result:** ✅ Clean. One harness bug found and fixed (§13.3); no product bugs.

### 13.1 What this bundles

Six independent probes against the creation wizard's validation, none of which need the tournament to progress past creation — each uses its own minimal fixture organizer(s) rather than the shared 8-contestant/6-juror setup, since group/match generation is irrelevant to what's being tested here.

### 13.2 Phase-by-phase result

- **Follower-count boundary:** exactly 250 followers → **correctly blocked** (`302` redirect from `GET /tournaments/create/step1`); 251 → **correctly allowed** (`200`).
- **Contest-contribution boundary:** 4 contributions → **correctly blocked**; 5 → **correctly allowed**.
- **Concurrent-tournament boundary:** an organizer with 2 pre-existing `open`/`cooldown`/`active` tournaments (seeded as bare fixture `Tournament` docs) → **still allowed** a 3rd (`200`); with 3 existing → **correctly blocked** from a 4th (`302`).
- **Jury size boundary:** 4 and 8 candidates → **correctly rejected** (`200`, error re-render); 5 and 7 → **correctly accepted** (`302`) — all four probes reuse one organizer's session/draft in sequence, since a failed `step4` attempt doesn't mutate the session draft.
- **Private-visibility tournament:** created with `visibility: 'private'`; **confirmed** excluded from a non-organizer's `/tournaments` browse listing (the name never appears in the response HTML) while still **reachable by direct link** (`GET /tournament/:id` returns `200` for that same non-organizer) — exactly the "hidden from discovery, not access-gated" behavior the spec describes.
- **Insufficient-funds inline funding:** an organizer with `0` CHL attempts a `1000+200+100 = 1300` CHL prize pool. **Confirmed:** step2 renders the insufficient-funds branch with the correct shortfall; a single `1300` CHL top-up attempt (over the 500-per-request cap) is **rejected outright** — the balance stays at `0`, proving multiple payments are a real server-side requirement, not just a UI suggestion; three separate top-ups (`500+500+300`) correctly accumulate to `1300`; step2 then succeeds.

### 13.3 Harness bug: wrong assumption about the insufficient-funds page text

**Symptom:** the insufficient-funds check flagged a false anomaly even though the route returned exactly the expected `200`.
**Cause:** the harness assumed the rendered page would contain the literal substring `"1300"` and the word `"insufficient"`. Neither is true: `views/tournaments/create.ejs` formats the shortfall via `.toLocaleString()` (so `1300` renders as `"1,300"`, with a comma), and the template never uses the word "insufficient" at all — it reads "You need X more to fund this prize pool."
**Fix:** changed the substring checks to look for `"1,300"` and `"more to fund this prize pool"` instead.
**Verdict:** harness bug, caught by reading the actual EJS template rather than guessing at its wording — a reminder that scraping rendered HTML for assertions is inherently more fragile than checking the underlying data/response code, and worth double-checking the source before trusting a text-substring assumption.

---

## 14. Scenario 9 — open-phase edges

**Flag:** `--scenario=open-phase-edges`
**Result:** ✅ Clean. One harness bug found and fixed (§14.3); one genuine product finding surfaced here (§14.4) that turned out to be the most serious bug in this whole report — followed all the way through to a confirmed crash and a root-cause fix in §19, and this scenario's own assertion was updated afterward to expect the fixed (`409`) behavior instead of the old silent `200`.

### 14.1 What this bundles

Three independent open-phase probes, each using its own lightweight fixture tournament (built with a local `createTournament()` helper, not the shared 8-contestant setup) since none of them need a full group stage to exist.

### 14.2 Phase-by-phase result

- **Organizer self-submission:** the organizer uploads an entry targeting their own tournament. **Confirmed:** the upload itself succeeds (`200`), but `tournamentSubmission.success` is `false` with reason `"Organizers cannot enter their own tournament."`, and zero `TournamentEntry` docs exist for the organizer — the block is enforced at the submission-decision level, not the upload level (an intentional design choice: the entry still gets created for the organizer's own feed/profile, it just never becomes a tournament candidacy).
- **Wildcard-stain auto-draft:** a fresh entry tagged `"brunch"`, uploaded *without* explicitly targeting a tournament whose `wildcardStains: ['brunch']` — **confirmed** to auto-draft (`TournamentEntry` created with `autoSubmitted: true`) purely from the tag match. A control entry tagged `"unrelated"` — **confirmed** does *not* auto-draft.
- **Mid-review `Entry` deletion:** see §14.4.

### 14.3 Harness bug: another fire-and-forget race, this time on auto-draft

**Symptom:** the wildcard-stain match case initially reported "no `TournamentEntry` was created" even though the tag correctly matched.
**Cause:** `attemptTournamentAutoDraft(entry, actor).catch(() => {})` is explicitly fire-and-forget in the entry-upload route — its own comment states it "must never affect the entry-creation response." The harness checked for the resulting `TournamentEntry` immediately after the HTTP response returned, racing the not-yet-finished background call — the same class of bug as §4.3 and (later) §16.3/§17.5, just on a different fire-and-forget call.
**Fix:** poll for the `TournamentEntry` to appear (short timeout) instead of checking immediately; the non-matching control case also got a brief fixed wait so it's testing a real negative, not just "didn't check long enough."
**Verdict:** harness bug. Worth noting as a pattern by now: any assertion checked immediately after an HTTP response that triggers a documented-as-fire-and-forget side effect needs to poll, not check-and-conclude.

### 14.4 Finding, later confirmed as a severe crash and fixed: approving a candidate whose `Entry` was deleted succeeded silently

**What was found here:** a candidate submits, then (simulating self-deletion, moderation removal, or any other path to a deleted `Entry`) their underlying `Entry` document is deleted while their `TournamentEntry` is still `pending`. The organizer then approves that `TournamentEntry` via the real route — **it succeeded** (`200`, `{success:true, capReached:false}`), and the `TournamentEntry`'s `approvalStatus` flipped to `"approved"` with no validation that the `Entry` it points to still exists.

This scenario deliberately stopped at the review action itself — it didn't yet drive the tournament all the way to group generation to see whether the dangling reference actually breaks anything downstream. A dedicated follow-up scenario (`--scenario=orphaned-entry-crash`, §19) did exactly that, and **confirmed a real crash that permanently wedges the tournament** — the approve route has since been fixed to reject this case outright (`409`), and this scenario's own assertion below was updated to match the fixed behavior. See §19 for the full story.

---

## 15. Scenario 10 — cooldown edges

**Flag:** `--scenario=cooldown-edges`
**Result:** ✅ Clean, after fixing one significant harness bug (§15.1 — a real process hang, not just a wrong assertion). No product bugs.

### 15.1 Harness bug: a real hang, from reusing the shared setup twice in one process

**Symptom:** the process appeared to freeze indefinitely right after printing this scenario's own "Tournament A" header — no further output for several minutes. A parallel `curl` to the dev server confirmed it was still responding fine, so the hang was inside the harness script itself, not the app.
**Cause:** this is the first scenario needing **two** separate tournaments in one process run (Tournament A for the cooldown-timeout case, Tournament B for the approve-during-open/self-cancel case), so it calls the shared `setupThroughSubmission()` helper twice. Each call independently did `agenda.once('ready', resolve)` to wait for the `agenda` package's Mongo connection — but `agenda`'s `'ready'` event fires **exactly once ever**. The first call's wait resolved fine; the second call's `.once('ready', ...)` registered a listener for an event that had already happened and would never fire again, so that `await` never resolved — an infinite hang, not a crash, which is why it produced no error output at all.
**Fix:** introduced a module-level `ensureAgendaReady()` helper backed by a single cached promise (`agendaReadyPromise`), and replaced every ad-hoc `agenda.once('ready', ...)` registration across the whole script (3 call sites: `setupThroughSubmission`, the `creation-boundaries` scenario, the `open-phase-edges` scenario) with a call to it. Any number of calls, from any scenario, now share the same one-time wait safely.
**Verdict:** harness bug — the same underlying lesson as §4.3 (code outside a long-running server can't blindly assume "register a listener, then await it" patterns are safe to repeat), just manifesting as a silent infinite hang instead of a data race, and only surfaced now because this was the first scenario to call the shared setup more than once per process. Every earlier scenario was re-run afterward to confirm this refactor caused no regressions.

### 15.2 What this scenario tests

Two fixture tournaments, run sequentially in one process (safe now that §15.1 is fixed):

**Tournament A — cooldown review-timeout auto-cancel:** all 8 submit, forced into `cooldown`, organizer approves only 5 (leaving 3 `pending`), then the 24h cooldown deadline is forced via `tournamentCooldownExpiry()` directly. **Confirmed:** `status: 'canceled'`, `cancelReason: 'cooldown_incomplete'`; all 6 jury docs released; organizer's `purchasedCHL` refunded back to `1000`; exactly 9 `tournament_canceled` notifications (organizer + all 8 submitters — both `approved` and `pending` count per `cancelTournament()`'s own query, and none were rejected in this branch).

**Tournament B — approve-during-open, then self-cancel after over-rejection:** the organizer approves 1 candidate while the tournament is **still `open`** (not yet `cooldown`) — **confirmed** `200` success and the tournament correctly stays `open` afterward (a single approval doesn't itself transition status), proving review really does run "on a rolling basis" as the code comments claim. The open deadline is then forced, reaching `cooldown`; the organizer rejects 4 more of the remaining 7 (1 approved + 4 rejected + 3 pending = 8, but only 3 pending remain — reaching the exact 8-approved cap is now mathematically impossible, no byes allowed). The organizer calls the real self-cancel route (`POST /tournament/:id/cancel`). **Confirmed:** `200` success, `status: 'canceled'`, `cancelReason: 'organizer_canceled'`; jury released; refund; exactly 5 `tournament_canceled` notifications (organizer + the 1 approved + 3 still-pending — the 4 already-rejected candidates got their own rejection notice earlier instead, correctly excluded here).

No product bugs surfaced in either tournament — every side effect of `cancelTournament()` behaved identically regardless of *why* it was triggered (timeout vs. organizer choice), which is exactly what the shared function's design implies should happen.

---

## 16. Scenario 11 — knockout-stage match tie

**Flag:** `--scenario=knockout-tie`
**Result:** ✅ Clean. One harness bug found and fixed (§16.3, same fire-and-forget-race class as §4.3/§14.3); no product bugs.

### 16.1 What this tests

The **match-level** tie chain — `TournamentJuryVote`, `initiateTieResolution`, `resolveJuryVote` — applied to a semifinal instead of a group-ranking dispute. This is a structurally distinct model/code path from the **group-ranking** tie chain (`TournamentGroupTieVote`) exercised in §7/§9/§10/§11; nothing in this report had exercised the match-level chain until now (the happy path and every size/social scenario deliberately never tie a match). Also specifically confirms the SF-loser-still-gets-a-3rd-place-match bookkeeping survives an *actual* tie at that round, not just a clean win/loss.

### 16.2 Mechanics and phase-by-phase result

Both groups resolve cleanly (the happy path's lexicographic-ID rule, reused as-is). Once the 2 SF matches exist, the harness casts a genuine **1-1 vote split** on the first one (a second dedicated voter casts for the opposite entry) instead of every other scenario's single-decisive-vote pattern.

**Confirmed:**
- The contest closes with `winnerEntryId: null` on the 1-1 split (not a decisive winner).
- The match flips to `status: 'tie'`, `tieStatus: 'jury_pending'`, `tieDeadline` set.
- 6 jurors are notified (`tournament_tie_jury` — see §16.3 for how this assertion had to be fixed).
- 3 jurors vote the same entry via `POST /api/tournaments/:id/matches/:matchId/jury-vote`; the tie resolves by quorum (`winnerId` set to the jury's choice, `tieStatus: 'resolved'`) — the 3rd vote's route handler awaits `resolveJuryVote()` directly, so this resolves synchronously, not via the fire-and-forget chain.
- **The SF tie's loser is correctly *not* marked `eliminated`** — unlike a QF/R16/Final/3rd loser would be — since they still have the 3rd-place match ahead of them.
- The other SF closes normally; Final and 3rd-place matches get created; the tied SF's loser is confirmed to be one of the two entries seeded into the 3rd-place match.
- The tournament closes normally with correct prize crediting; 0 jurors banned (the tie resolved well within the 6h window); 0 `TournamentGroupTieVote` documents exist (confirming this run never touches the group-ranking chain at all, only the match-level one).

### 16.3 Harness bug: the same fire-and-forget notification race, on a different notification

**Symptom:** the first attempt reported 0 `tournament_tie_jury` notifications instead of the expected 6, despite the match correctly reaching `status: 'tie'` moments earlier.
**Cause:** `initiateTieResolution()` — which inserts the 6 juror notifications — runs a step *after* the match's status write, both inside the same fire-and-forget chain `closeContest` kicks off. Polling for `status === 'tie'` (which the harness already did, correctly) only proves that first step landed; it says nothing about whether the *later* notification-insert step has also finished.
**Fix:** poll for the notification count itself (`Notification.countDocuments(...) === 6`) instead of inferring "the whole chain is done" from an earlier field's state.
**Verdict:** harness bug — by this point in the session, a recognizable pattern: any fire-and-forget chain with multiple sequential side effects needs each side effect polled for individually; reaching one milestone in the chain doesn't imply a later one has landed too.

### 16.4 Addendum — `tournament_knockout_started` confirmed rendering on a live page

A later pass (see §21's now-closed backlog item) added a final phase to this same scenario: after the tournament closes, the harness fetches `GET /notifications` as a real logged-in recipient of a `tournament_knockout_started` notification and checks the response HTML directly, rather than relying on a code read of `views/notifications.ejs`'s `case` statement. **Confirmed:** the response contains the exact copy `"You've advanced to the knockout stage — your next match is starting"`. This closes the one remaining "confirmed only via code read" gap that had been sitting in this report's backlog since the happy-path scenario (§3).

---

## 17. Scenario 12 — boundary tournament sizes

**Flag:** `--scenario=boundary-sizes`
**Result:** ✅ Clean overall. Required a genuine (not test-only) refactor of the shared setup helpers, plus one harness bug (§17.5, same fire-and-forget-race class as §4.3/§14.3/§16.3) found while extending this scenario to sizes 16 and 24. No product bugs anywhere in this scenario.

### 17.1 Why this needed a refactor, and the size math

Every prior scenario hardcoded 8 contestants, `size: '8'` in the creation form, and "2 groups / 12 matches" assertions. This scenario generalized `setupThroughSubmission()` and `setupThroughActiveGroupStage()` to accept a `size` parameter (defaulting to `8`, so every earlier scenario's behavior is unchanged), backed by a local `GROUP_CONFIG` table mirroring `routes/tournaments.js`'s own fixed size→group-shape mapping, plus a generalized expected-group-match-match count (`groupCount * (groupSize * (groupSize - 1) / 2)`, the standard round-robin match-count formula, which holds regardless of whether `groupSize` is odd or even).

The two sizes chosen exercise structurally different bracket shapes: **size 4** (`groupSize: 4, groupCount: 1` — a single group, field size 2, so the group's own rank-1-vs-rank-2 pairing *is* the Final directly, no SF and no 3rd-place match at all) and **size 12** (`groupSize: 3, groupCount: 4` — the first *odd* groupSize this report has exercised, needing `circleMethodRounds()`'s bye-padding logic, and field size 8, so the first knockout round is QF, not SF).

### 17.2 Tournament A: size 4

**Confirmed:** the single group's round-robin plays out cleanly; 0 SF matches are ever created; the group's rank-1-vs-rank-2 pairing becomes the `Final` match *directly* (per `generateKnockoutBracket()`'s `groupCount === 1` special case); 0 `"3rd"`-place matches are ever created (`closeTournament()`'s `needsThird = tournament.size !== 4` check correctly short-circuits); exactly 2 `tournament_prize_awarded` notifications (not 3); 1st/2nd place correctly credited 350/100 CHL.

### 17.3 Tournament B: size 12

**Confirmed:** all 4 groups of 3 play out cleanly (the round-robin bye-padding for an odd group size works correctly — 3 real matches per group across 3 rounds, one bye seat sitting out each round); all 4 groups reach `complete`, advancing 8 entries; the **first** knockout round is **QF** (4 matches), not SF; all 4 QF losers are correctly marked `eliminated: true` (unlike an SF loser); QF winners correctly advance into exactly 2 SF matches; SF closes normally; Final + 3rd-place matches get created and close normally; the tournament closes with all 3 prizes correctly awarded.

### 17.4 Correction: sizes 16 and 24 were *not* redundant, and were later run

This report originally claimed sizes 16 and 24 would "mostly re-confirm mechanisms this pass already exercises" and deferred them as low-value. **That claim was wrong**, caught by actually working out `KNOCKOUT_ROUND_BY_FIELD_SIZE` for every size rather than eyeballing group shape alone:

| Size | `groupCount` | Field size (`groupCount × 2`) | First knockout round |
|---|---|---|---|
| 4 | 1 | 2 | `Final` directly |
| 8 | 2 | 4 | `SF` |
| 12 | 4 | 8 | `QF` |
| **16** | 4 | 8 | **`QF`** (same depth as 12, larger/even groups) |
| **24** | 8 | 16 | **`R16`** — the *only* size with 4 knockout rounds |

Size 16 does share size 12's QF-first depth (moderate value — even-`groupSize` round-robin with 4 groups, not new by itself). But **size 24 reaches `R16`**, a full bracket depth (`R16 → QF → SF → Final/3rd`) nothing else in this report gets anywhere near — genuinely new ground, not a re-confirmation. Both were added to this same scenario (Tournaments C and D) via a new shared helper, `playGroupsAndKnockoutForBoundarySize()`, that walks an arbitrary number of knockout rounds one at a time (closing every match in the current round, then polling for the next round — half as many matches — to appear), reusable for any future size.

**Confirmed for size 16** (4 groups of 4, `groupSize` even): all 4 groups resolve cleanly; QF is correctly the first knockout round (4 matches); QF winners advance into exactly 2 SF matches; tournament closes with 3 prizes.

**Confirmed for size 24** (8 groups of 3, the largest tournament and the deepest bracket in this report): all 8 groups resolve cleanly (round-robin bye-padding holds at 8 groups, not just 4); **R16 is correctly the first knockout round** (8 matches); R16 winners advance into 4 QF matches; QF winners advance into 2 SF matches; SF winners/losers correctly produce Final + 3rd; tournament closes with 3 prizes. The full four-round descent (`R16 → QF → SF → Final`) worked exactly as `jobs/tournamentJobs.js`'s generic `KNOCKOUT_NEXT_ROUND` advance logic describes — this code path had never been reached by anything else in this report.

### 17.5 Harness bug: yet another fire-and-forget race, on the `eliminated` flag this time

**Symptom:** on the first run of the extended scenario, size 16's QF round reported 3 eliminated losers instead of the expected 4.
**Cause:** the same recurring class of bug (§4.3, §14.3, §16.3): `TournamentEntry.eliminated` is set inside `handleKnockoutMatchClose()`, which runs *after* `TournamentMatch.status` flips to `'closed'` within the same fire-and-forget chain `closeContest` kicks off. `castVoteAndClose()` already polls for `status === 'closed'` before returning, but that doesn't guarantee the *separate*, later `eliminated` write for that match has landed yet — checking the eliminated count immediately after the round's matches all report `closed` can catch it mid-write.
**Fix:** poll for the eliminated count itself (`TournamentEntry.countDocuments({knockoutRound, eliminated:true}) === expectedCount`) instead of checking immediately after closing the round.
**Verdict:** harness bug — the fourth distinct instance of this exact race pattern in this report. At this point it's less "a bug" than a standing rule for this codebase's tooling: closing a match and any *later* side effect chained off that close (a notification, a flag on a different document, anything not written in the same synchronous step as the status flip) need their own poll, never inferred from the match's own status.

---

## 18. Scenario 13 — social layer

**Flag:** `--scenario=social-layer`
**Result:** ✅ Clean on the first attempt — no harness bugs, no product bugs.

### 18.1 What this tests

Comments (post / reply-reparenting / edit / react / report / delete), tournament-level loop-in, tournament reports (including verifying the report actually surfaces in `/admin/moderation`'s "Tournaments" tab over a **real admin HTTP session**, not just a code read), and the profile trophy-counter data condition — all run against one tournament taken all the way to a real close first (reusing the happy-path flow as an un-tested fixture), so the trophy check has genuine 1st/2nd/3rd placements to verify against.

### 18.2 Phase-by-phase result

**Comments:** a top-level comment, a reply to it, and then a reply *to that reply* are posted in sequence. **Confirmed:** the reply-to-a-reply correctly re-parents to the **original top-level comment** (not the reply it was nominally posted under) — the platform stays at exactly one level of nesting even under a 3-deep posting attempt, exactly matching `effectiveParentId`'s intent. Editing a comment sets `editedAt`. Liking then disliking the same comment is **confirmed mutually exclusive** — the dislike correctly removes the prior like rather than stacking. Reporting a comment **auto-hides it immediately**, no threshold. Deleting a comment **cascades** to both its replies and its pending report — all three are gone afterward.

**Loop-in:** toggles a `TournamentLoop` doc on, then off, correctly. The organizer is **correctly blocked** (`400`) from looping in on their own tournament.

**Tournament report:** creates a `TournamentReport` successfully; a duplicate report from the same user is **correctly rejected** (`409`); the organizer is **correctly blocked** (`400`) from reporting their own tournament. The report is then confirmed to actually **appear in `/admin/moderation?tab=tournaments`** — this required seeding a `founder`-role user and logging in through the real, separate admin session flow (`POST /admin/login`, which sets `req.session.adminId` rather than reusing the regular user session) — going one step further than this session's earlier code-read-only confirmation that this queue exists (see the conversation history before this report's scenarios began).

**Admin resolution actions (added in a later pass, closing out §21's last residual item):** confirming a report *reaches* the queue isn't the same as confirming a moderator can actually *act* on it, so this scenario was extended with three more real admin actions. **Confirmed:** `POST /admin/moderation/tournament-reports/:tid/dismiss` flips the `TournamentReport`'s `status` to `'rejected'`. For comments, two fresh comments were posted and reported (the original comment from earlier in this scenario had already been deleted by the cascade-delete test) — one resolved via `POST /admin/moderation/comment-reports/:id/approve` (`commentType: 'tournament'`), which **correctly deletes the `TournamentComment`**, marks its report `'approved'`, and fires a `comment_removed` notification to the comment's owner; the other resolved via the `/reject` counterpart, which **correctly keeps the comment** (un-hiding it, `hidden: false`) and marks its report `'rejected'`.

**Profile trophy counters:** rather than scraping the rendered profile page for exact wording (unknown in advance, and fragile to assert against), the harness verified directly against the precise data condition `routes/pages.js`'s computation reads: 1st place satisfies `!eliminated && knockoutRound === 'Final'`, 2nd place satisfies `eliminated && knockoutRound === 'Final'`, 3rd place satisfies `!eliminated && knockoutRound === '3rd'`. **All three placements matched their expected condition exactly.** A lightweight regression check also confirmed the winner's profile page still renders `200` with this tournament's placement data present.

### 18.3 No bugs, with one scope caveat

No harness bugs, no product bugs. Worth being explicit about the trophy-counter check's actual boundary: it confirms the *data* the profile route reads is correct, not that the *rendered page* displays it correctly — if the EJS template itself had, say, an off-by-one or a swapped label independent of the underlying data, this check would not catch it. That's a deliberate scope choice (avoiding a fragile HTML-text assertion), not an oversight, but it's a real gap between "verified" and "visually confirmed in a browser."

---

## 19. Scenario 14 — orphaned-approved candidate driven through to group generation

**Flag:** `--scenario=orphaned-entry-crash`
**Result:** ⚠️→✅ **The most important finding in this entire report.** First run confirmed a real, severe crash that permanently wedges a tournament. Fixed at the root cause in `routes/api.js`; re-run confirms the fix, and the original `open-phase-edges` scenario (§14) was re-verified afterward to still pass with the fixed behavior.

### 19.1 What this follows up on, and why it mattered enough to finish

§14.4 found that approving a `TournamentEntry` whose underlying `Entry` had been deleted succeeded silently, with no validation — but stopped there, at the review action itself. This scenario picked up exactly where that one stopped: drive the same orphaned-but-approved candidate all the way through `tournamentCooldownExpiry()` → `activateTournament()` → `generateGroups()` → `generateGroupMatches()`, and get an actual crash-or-not verdict instead of a suspicion.

### 19.2 First run: confirmed crash, and something worse than a crash

The first run wrapped `tournamentCooldownExpiry()` in a `try/catch` to observe rather than let the harness itself die, and it threw:

```
TypeError: Cannot read properties of null (reading '_id')
    at generateGroupMatches (utils/tournamentScheduler.js:97:32)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async activateTournament (jobs/tournamentJobs.js:84:5)
    at async tournamentCooldownExpiry (jobs/tournamentJobs.js:882:3)
```

The exact line: `generateGroupMatches()` populates `TournamentEntry.entryId` and then accesses `A.entryId._id` directly when building each `Contest`'s `entries` array — a deleted `Entry` populates to `null`, and `null._id` throws.

That alone would just be a bug. What made it worse, and what the harness specifically checked for afterward: `activateTournament()`'s atomic status claim (`{status:'cooldown'} → {status:'active', stage:'group', ...}`) **commits before** `generateGroupMatches()` runs and throws. Inspecting the tournament after the crash confirmed exactly that — **`status: 'active'`**, with only 2 of the intended groups partially created and 1 match. Because `tournamentCooldownExpiry()`'s own re-entry guard only fires from `status: 'cooldown'`, and this tournament's status had already moved past that, **nothing in the system could ever retry activation for it again — it was permanently stuck**, not just erroring out in a retryable way.

### 19.3 The fix

Root-caused rather than patched at the crash site: `routes/api.js`'s candidate-approve route now checks that the underlying `Entry` still exists (`Entry.exists({_id: entry.entryId})`) before allowing approval, rejecting with `409` if not. **Rejecting** an orphaned candidate is deliberately left untouched — that remains the organizer's ordinary way to clear a dead entry from the review queue; only *approving* one is blocked, since only an approved orphan can ever reach `generateGroupMatches()`.

```js
// routes/api.js, inside POST /tournaments/:id/entries/:eid/approve
const underlyingEntryExists = await Entry.exists({ _id: entry.entryId });
if (!underlyingEntryExists) {
  return res.status(409).json({ error: "This candidate's entry no longer exists and cannot be approved. Reject it instead." });
}
```

### 19.4 Re-verification, and the natural downstream consequence

The scenario was rewritten to exercise the *fixed* behavior directly, and re-run clean:
- Approving the orphaned candidate → **correctly blocked** (`409`); its `TournamentEntry` stays `pending`.
- Rejecting it instead → **still works** (`200`) — organizers retain their normal path to clear a dead entry.
- With the orphan rejected, only 7 of the 8 seeded candidates remain approvable. Forcing the cooldown deadline no longer crashes — instead, `tournamentCooldownExpiry()` correctly finds `approvedCount !== tournament.size` and **auto-cancels** (`status: 'canceled'`, `cancelReason: 'cooldown_incomplete'`) exactly the same well-tested path §15's Tournament A already exercises. Losing one candidate to a dead `Entry` now just shrinks the pool below the cap — a normal, recoverable outcome instead of a silent time bomb.

The happy path and `open-phase-edges` (§14) were both re-run after this fix to confirm no regressions in the normal approval flow or in that scenario's own (now-updated) assertion.

---

## 20. Scenario 15 — genuinely concurrent match closes

**Flag:** `--scenario=concurrent-closes`
**Result:** ✅ Clean. No harness bugs (once the group-shape assumption below was corrected before the first real run), no product bugs — every atomic claim tested held under real concurrency.

### 20.1 What this tests, and why it's different from every other scenario

Every scenario before this one closes matches strictly one at a time — `castVoteAndClose()` closes and polls to confirm one match fully before moving to the next. That means the atomic-claim guards scattered through `jobs/tournamentJobs.js` (`findOneAndUpdate` calls that only let one of several possible simultaneous callers proceed — e.g. `generateKnockoutBracket()`'s `{stage:'group'} → {stage:'knockout'}` claim, or `lastKnockoutRoundAdvanced`'s per-round claim) had never actually been *contended*: nothing had ever given two callers a real chance to race each other. This scenario deliberately does, using `Promise.all()` instead of sequential `await`s at the two points in the pipeline where a genuine race is architecturally possible.

**Getting the setup right required correcting a wrong assumption of my own first:** a group of 4 plays 2 matches per round (not 1), so "the last round" isn't the same as "each group's last match" — leaving exactly one match open per group needed identifying matches by `groupId` explicitly and closing one match per group up front (sequential, not the race target) before racing the two true final matches.

### 20.2 Race 1: both groups' final matches, closed concurrently

Both groups' last matches are voted on, then closed via `Promise.all([closeContest(a), closeContest(b)])` — genuinely concurrent DB operations, not two fast sequential ones. **Confirmed:** both `TournamentGroup` docs correctly reach `status: 'complete'` (neither stuck, neither double-processed), and — the actual point of the test — **exactly 2** `SF` matches exist afterward, not 4. `generateKnockoutBracket()`'s atomic `stage` claim correctly let only one of the two simultaneous `resolveGroup()` calls (whichever one's `findOneAndUpdate` won the race) generate the bracket.

### 20.3 Race 2: both semifinals, closed concurrently

Same pattern, one level up: both SF matches are voted on, then closed via `Promise.all`. **Confirmed:** exactly **1** `Final` match and exactly **1** `3rd`-place match exist afterward, not 2 of each — `lastKnockoutRoundAdvanced`'s atomic claim correctly let only one of the two simultaneous `handleKnockoutMatchClose()` calls fan out to create the next round.

### 20.4 Close, and no duplicate side effects

Final and 3rd-place close normally (sequential — no further race needed at this depth), and the tournament closes correctly: exactly 3 `tournament_prize_awarded` notifications and exactly 3 `tournament_prize_payout` `WalletTransaction` documents — a race-induced double-credit would have shown up as more than 3 of either. Zero jurors banned (tie-free run).

**No product bugs.** Both atomic-claim mechanisms this scenario specifically targeted held correctly under genuine concurrent DB writes, not just the sequential-only usage every other scenario in this report happens to exercise.

---

## 21. Suggested next passes (not yet run)

Every item from both passes of the backlog — the original list and all 5 residual items surfaced by finishing it — is now done. What's left is no longer "things we haven't tried," it's a short list of items that sit outside what a DB/HTTP-level simulation harness can reach at all:

- **Pixel/visual browser confirmation** — this report's rendering checks (§16.4, and the trophy-counter data-condition check in §18) confirm the correct *text*/*data* is present in a real HTTP response, not that a real browser lays it out correctly. A genuine E2E/visual-regression pass is a different tool than this one.
- **Adversarial/malicious input fuzzing** — every scenario here drives the system through valid-shaped requests (even the "edge cases" are legitimate business states, not malformed payloads). Security-focused fuzzing of these same routes is a distinct exercise.
- **Load/stress testing at scale** — this report's concurrency test (§20) proves 2 simultaneous callers race safely; it says nothing about behavior under dozens or hundreds of simultaneous tournaments/matches.
- **Multi-process concurrency** — §20's race is real (genuine interleaved DB operations), but still within one Node process. The actual production deployment may run multiple server processes/instances against the same MongoDB; that's a stronger and different form of concurrency than anything simulated here.

None of these are suspected bugs — they're categorically different kinds of testing (visual, security, performance) than the state-machine-correctness focus this whole report has had.

---

## 22. How to run it

```bash
# Happy path (default scenario) — requires `npm run dev` already running on the port in .env
node scripts/simulateTournament.js

# 3+-way group-ranking tie scenario (decisive jury plurality)
node scripts/simulateTournament.js --scenario=group-tie

# Organizer/jury voting-restriction scenario
node scripts/simulateTournament.js --scenario=voting-restriction

# 3+-way tie, ambiguous jury plurality -> organizer resolves within 3h
node scripts/simulateTournament.js --scenario=group-tie-organizer

# 3+-way tie, total non-engagement -> 6h + 3h both expire -> coin flip
node scripts/simulateTournament.js --scenario=group-tie-coinflip

# Plain 2-way tie -> ordinary extra H2H tiebreaker match
node scripts/simulateTournament.js --scenario=group-tie-2way

# Open-phase under-fill -> auto-cancel + full prize-pool refund
node scripts/simulateTournament.js --scenario=open-underfill-cancel

# Creation-wizard boundaries (eligibility, jury size, private visibility, inline funding)
node scripts/simulateTournament.js --scenario=creation-boundaries

# Open-phase edges (self-submit blocked, wildcard auto-draft, mid-review Entry deletion)
node scripts/simulateTournament.js --scenario=open-phase-edges

# Cooldown edges (review-timeout cancel, approve-during-open, over-rejection self-cancel)
node scripts/simulateTournament.js --scenario=cooldown-edges

# Match-level knockout tie (jury quorum + SF-loser-still-gets-3rd-place)
node scripts/simulateTournament.js --scenario=knockout-tie

# Boundary tournament sizes (4-player no-3rd-place; 12-player QF-first bracket)
node scripts/simulateTournament.js --scenario=boundary-sizes

# Social layer + admin resolution actions (comments, loop-in, reports, admin queue, profile trophies)
node scripts/simulateTournament.js --scenario=social-layer

# Orphaned-approved candidate driven through to group generation (the severe crash + fix)
node scripts/simulateTournament.js --scenario=orphaned-entry-crash

# Genuinely concurrent match closes racing atomic claims
node scripts/simulateTournament.js --scenario=concurrent-closes

# Remove all __sim_-tagged data created by any prior run/scenario
node scripts/simulateTournament.js --cleanup
```

Every scenario is idempotent to re-run repeatedly (each run creates freshly-timestamped `__sim_` users and a uniquely-named tournament), but always run `--cleanup` when you're done so dev-database browsing/admin views aren't cluttered with simulated tournaments. New scenarios are added to the `SCENARIOS` map at the bottom of `scripts/simulateTournament.js`, reusing `setupThroughSubmission()`/`setupThroughActiveGroupStage()` (phases 1–6, parameterized by `size` and `submitCount`, shared across every scenario) and `playKnockoutAndVerifyClose()` (phases 8–9, identical once the group stage has resolved by whatever means the scenario exercises). Agenda's one-time `'ready'` wait is centralized in `ensureAgendaReady()` — never register a fresh `agenda.once('ready', ...)` listener directly (see §15.1).
