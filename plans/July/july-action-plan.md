# July Action Plan

## Current State (July 1)

July opened with the search page fully wired and a round of dead code cleanup. The `Retag` model is gone. The `/take-on/:id` route now redirects to `/contest/:id` directly. Affinity source props are wired from all entryCard actions. Everything else is as closed June left it.

**What is done in July so far:**
- **Search** (`GET /api/search` + `views/search.ejs`) — users, entries, tags, contests; `#tag` prefix mode; category drill-down; People section reuses `getPeopleSubSections` from explore; excludes blocked users; `window.__ecSource = 'search'` wires the 1.3× affinity multiplier ✅
- **Right panel search typeahead** — form + dropdown in `rightPanel.ejs` hitting the same `GET /api/search` endpoint ✅
- **Affinity source prop** wired from `ecScript.ejs` + `entryCard.ejs` (rating, bookmark, comment, reply) ✅
- **Dead code purge** — `Retag.js`, `take-on.ejs`, `index.ejs`, all 4 migration scripts, `ui-ux-vision.md` deleted ✅
- **`/take-on/:id` simplified** — redirects to `/contest/:id`; standalone view removed ✅
- **Contest eligibility thresholds lowered** for testing (`minEntries` 5→3, `minRatingCount` 250→25) ✅

---

## Starting Point

June closed with the full standalone contest lifecycle, the chilli wallet economy, Phase 6 admin infrastructure, Feed v2, Explore, Bookmarks, and all content moderation done. The schema (`Tournament`, `TournamentEntry`) and all supporting infrastructure (agenda, wallet, contest close jobs, notification system, affinity updater) are already in place. July builds on top of everything without touching the June foundation.

---

## What Carries Over / Remains

| Item | Status |
|---|---|
| `Tournament` + `TournamentEntry` models | Fully built — no routes or views yet |
| Pre-launch test bypasses | **On hold — not yet, still actively testing.** Must revert before any public release (see below) |
| ~~`Retag` model~~ | Deleted 2026-07-01 — was never wired, no longer exists |
| ~~Search page~~ | **Done 2026-07-01** — see Current State above |
| Right panel — Ongoing Tournaments | Currently a skeleton — wired when tournaments are built (Phase 7) |
| Admin Analytics page | Sidebar entry exists in design only — low priority, end of July |

---

## Pre-Launch Reverts (do before any public release, not a phase gate)

**Status: on hold, not yet — decided 2026-07-01.** Still actively testing contest flows; the bypasses stay in place until testing wraps up. Do not implement this revert until explicitly asked.

Two test bypasses left from June that must eventually be removed before going live:

- Re-enable the **`status === 'active'`** check in `routes/api.js` (contest vote handler, commented out with `// TEMP`)
- Remove **`TEST_BYPASS_USERNAMES`** from `utils/contestEligibility.js` and `routes/api.js` (entry submission `idVerified` bypass)

Note: the self-vote guard (`isOwnEntry` check in the vote handler) was previously miscategorized as disabled — it is actually live and enforced, not a bypass.

Also as of 2026-07-01, contest eligibility thresholds were intentionally lowered for easier local testing: `minEntries` 5 → 3, `minRatingCount` 250 → 25 (`minWeightedAvg` unchanged at 7.4). These are separate from the bypass usernames and are not test-only hacks — they're the new working defaults in `utils/contestEligibility.js`, `models/PlatformSettings.js`, `routes/admin.js`, and `views/admin/settings.ejs`. Revisit whether these should go back up before launch.

These are not blocking July builds — they are blocking launch, and are currently paused pending further testing.

---

## July Phases

### Phase 7 — Tournaments (Player-Facing)

The largest remaining feature. Reuses Contest infrastructure, agenda, wallet, and notifications heavily — no new primitives needed.

#### Models (already done)

Both `Tournament` and `TournamentEntry` are schema-complete. No changes needed.

**Key fields to note:**
- `Tournament.status`: `pending_funds | pending_review | open | cooldown | active | closed | canceled`
- `Tournament.type`: `platform` (admin-created, auto-funded) | `user_organized` (user-created, prize funds committed upfront)
- `Tournament.missedReviews`: incremented per `timed_out` entry; at 3 → tournament canceled, no refund
- `TournamentEntry.approvalStatus`: `pending | approved | rejected | timed_out`
- `TournamentEntry.totalVotes`: primary ranking metric — updated whenever a tournament contest closes
- `TournamentEntry.wins / losses`: for elimination threshold check

#### Lifecycle

```
User-organized:  pending_funds → pending_review → open → cooldown → active → closed
Platform:                                          open → cooldown → active → closed
```

---

#### Phase 7.1 — Creation + Prize Funds

**User-organized tournament creation:**
- `GET /tournaments/create` + `views/tournaments/create.ejs`
- Fields: name, description, maxParticipants, entry window (default 72h), cooldown (default 3h), round window (default 72h)
- Prize structure: 1st/2nd/3rd amounts (default $1,000 / $400 / $100 in chillies, organizer sets)
- `idVerified: true` required — redirect to `/verify-identity` if not
- Organizer cannot submit an entry to their own tournament (enforced at submission time, not creation)
- On creation: status → `pending_funds`. Prize commitment screen shows total chillies required.
- **Stub fund commitment:** same pattern as wallet checkout — deducts from wallet immediately, sets `fundsHeld: true`, status → `pending_review`. CCBill will replace this later. If wallet balance is insufficient, block creation and prompt top-up.
- On fund commitment: `WalletTransaction` (type: `tournament_prize_hold`, direction: `debit`) created; admin notified for review.

**Platform tournament creation (admin only, founder + superadmin):**
- `GET /admin/tournaments/create` + `views/admin/tournaments/create.ejs`
- Same fields but `type: platform`, `fundsHeld: true` set immediately (no payment step), status → `open` directly.
- No review step needed.

---

#### Phase 7.2 — Tournament Browse + Detail

- `GET /tournaments` + `views/tournaments/index.ejs` — browse open/active/recently-closed tournaments. Cards show name, entry count, prize pool, status, countdown.
- `GET /tournament/:id` + `views/tournaments/detail.ejs` — full detail page.
  - `open` phase: shows approved entries, pending review count, entry window countdown, submit entry CTA
  - `cooldown` phase: shows final participant list, rounds-start countdown
  - `active` phase: matchup grid (all contests in this tournament), elimination tracker, live leaderboard by totalVotes
  - `closed` phase: podium with 1st/2nd/3rd and vote counts
- Add tournament link to sidebar nav.

---

#### Phase 7.3 — Entry Submission During `open` Phase

- Submit entry to tournament from the tournament detail page or the standard `/submit` flow (pass `?tournamentId=<id>`)
- On submission: create `TournamentEntry` with `approvalStatus: pending`, `submittedAt: now`
- Entry owner cannot be the tournament organizer (enforced server-side)
- User can only submit one entry per tournament
- Entry must have `idVerified: true` owner
- Notify organizer: `tournament_entry_submitted` notification → links to the organizer's review queue

---

#### Phase 7.4 — Organizer Review

- `GET /tournament/:id/review` + `views/tournaments/review.ejs` — organizer only. Lists pending entries with media preview and 30-minute countdown per entry.
- `POST /api/tournaments/:id/entries/:eid/approve` — set `approvalStatus: approved`, `reviewedAt: now`. Notify submitter.
- `POST /api/tournaments/:id/entries/:eid/reject` — set `approvalStatus: rejected`, `reviewedAt: now`. Notify submitter with rejection message.
- Organizer can optionally add a rejection note.

**Organizer review timeout job (agenda):**
- Sweeper runs every 5 minutes. Finds `TournamentEntries` with `approvalStatus: pending` and `submittedAt < now - 30min`.
- For each: set `approvalStatus: timed_out`. Notify submitter (they can resubmit elsewhere).
- Increment `tournament.missedReviews`. If `missedReviews >= 3`:
  - Set `tournament.status: canceled`
  - Refund prize funds to organizer's wallet (`WalletTransaction` type: `tournament_prize_refund`)
  - Notify all `pending` submitters to try another tournament
  - Notify organizer their tournament was canceled

**Entry window close (agenda):**
- When `tournament.entryDeadline` passes: status → `cooldown`, `roundsStartAt` set to `entryDeadline + cooldownHours`.
- Or when max approved capacity is reached: same transition.
- If fewer than 2 approved entries: cancel tournament + refund.

---

#### Phase 7.5 — Round Generation + Activation

**Cooldown → Active transition (agenda job):**
- At `roundsStartAt`: generate all round-robin matchups.
- For N approved entries: create `N × (N-1) / 2` `Contest` docs, all with `tournamentId`, `status: active`, `votingDeadline: now + roundWindowHours`, visibility: `public`.
- All matchups start simultaneously.
- Set `tournament.status: active`.
- Notify all participants: tournament is live.

**Matchup generation logic:**
- Take all `TournamentEntries` with `approvalStatus: approved`
- Generate every unique pair `(A, B)` where A ≠ B
- Create one `Contest` per pair with both entries embedded

---

#### Phase 7.6 — Contest Close Hook (extend existing `close_contest` job)

When a tournament contest closes (via the existing `close_contest` agenda job), add:
1. Update `TournamentEntry.wins / losses` and `TournamentEntry.totalVotes` for both contestants
2. **Elimination check:** `if wins < Math.floor((wins + losses) * 0.66)` → `eliminated: true`, notify contestant
3. **Tie-breaker chain:** if vote counts are equal, create a replay Contest with `parentContestId` set and `windowHours` halved. Chain: 72h → 36h → 18h → 9h. After 3 replays still tied → notify organizer to decide via sudden death.
4. **Tournament close check:** if all non-tie contests are resolved → determine winners by `totalVotes` → award prizes → set `tournament.status: closed`

**Winner determination:**
- Sort non-eliminated entries by `totalVotes` descending
- 1st: highest `totalVotes`
- 2nd: second highest
- 3rd: third highest
- Podium tie → organizer sudden death decision (notification sent)
- Credit prize amounts to winners' `earnedCHL`, create `WalletTransaction` (type: `tournament_prize_payout`)

**Attribution on tie-breaker chain:**
- Attribution locks immediately when a tournament contest ends in a tie
- No new contributions accepted during replays
- Pays out 75/25 when the chain fully resolves

---

#### Phase 7.7 — Right Panel — Ongoing Tournaments

Replace the current skeleton in `views/partials/rightPanel.ejs` with real data:
- `injectRightPanelData` middleware already runs — add `activeTournaments` query (up to 3, status: `active`, sorted by `roundsStartAt` desc)
- Show tournament name, entry count, prize pool badge, link to `/tournament/:id`

---

#### Phase 7.8 — Tournament Notifications

New notification types to add to the enum and render in `/notifications`:

| Type | Trigger | Recipient |
|---|---|---|
| `tournament_entry_submitted` | User submits entry | Organizer |
| `tournament_entry_approved` | Organizer approves | Submitter |
| `tournament_entry_rejected` | Organizer rejects | Submitter |
| `tournament_entry_timed_out` | Review window expired | Submitter |
| `tournament_canceled` | 3 missed reviews | Organizer + all pending submitters |
| `tournament_live` | Status → active | All approved participants |
| `tournament_eliminated` | Entry eliminated | Contestant |
| `tournament_tiebreaker` | Replay created | Both contestants |
| `tournament_tiebreaker_sudden_death` | 3 replays all tied | Organizer |
| `tournament_closed` | All contests resolved | All participants |
| `tournament_prize_awarded` | Winner determined | 1st/2nd/3rd |

---

#### Phase 7 Exit Criteria

A user can create a tournament, fund it, submit entries, review them as organizer, run a full round-robin, and determine winners by total votes — with automatic lifecycle transitions and correct prize payouts.

---

### Phase 8 — Admin Tournament Management

#### Pages

- **All Tournaments list:** `GET /admin/tournaments` + `views/admin/tournaments/index.ejs` — paginated, filterable by status and type. Shows name, organizer, participant count, prize pool, status.
- **Tournament detail:** `GET /admin/tournaments/:id` + `views/admin/tournaments/detail.ejs` — full read-only view of a tournament's state: participants, matchup results, prize pool, organizer details.
- **User-organized review queue:** `GET /admin/tournaments?tab=review` — lists tournaments with `status: pending_review` and `type: user_organized`. Approve moves status → `open`. Reject with message refunds prize funds and notifies organizer.
  - `POST /admin/tournaments/:id/approve`
  - `POST /admin/tournaments/:id/reject`

#### Admin sidebar

Add "All Tournaments" and "Review Queue" to the sidebar under the Tournaments section (founder + superadmin, as per the June sidebar design).

#### Exit criteria

Admin can review user-organized tournaments before they go live, browse all platform tournaments, and see full contest histories within each tournament.

---

### Phase 9 — Financial System Completion

#### Phase 9.1 — CCBill Integration

Replace the stub `/wallet/checkout` with a real CCBill redirect. All other wallet infrastructure (WalletTransaction, ContestContribution, ContestPayout, MonthlySnapshot, background jobs) remains unchanged.

**Scope:**
- Verify CCBill ToS covers the platform's content category + escrow/payout requirements
- Implement CCBill redirect from `/wallet/checkout` (pass package, amount, user identifier)
- Handle CCBill callback/webhook: verify signature, credit `purchasedCHL`, write `WalletTransaction`
- Error handling: failed payment → flash + redirect back to `/wallet/topup`
- Tournament prize fund commitment via same CCBill flow (organizer pays at creation time)

**Note:** The fake stub (`POST /wallet/checkout` → immediate credit) and the tournament prize commitment stub (wallet deduct) both remain in place until CCBill is live and verified.

---

#### Phase 9.2 — Apron Trophy System

Contest trophies awarded at contest close based on margin of victory. Applies to both standalone and tournament contests.

**New model — `Apron`:**
```js
{
  userId:       ObjectId,  // ref: users — winner
  contestId:    ObjectId,  // ref: contests
  tier:         String,    // 'flannel' | 'denim' | 'velvet'
  value:        Number,    // in cents: 1000 (flannel) | 2000 (denim) | 5000 (velvet)
  paidOut:      Boolean,   // default: false
  paidOutAt:    Date,
  createdAt:    Date,
}
```

Indexes: `{ userId, tier }`, `{ contestId }`, `{ userId, paidOut }`

**Award logic (extend `close_contest` job):**
After setting `winnerEntryId`, check:
1. Winner must have ≥ 5,000 votes
2. `gap = (winnerVotes - loserVotes) / loserVotes`
3. Tier: ≥ 110% → Velvet, ≥ 68% → Denim, ≥ 49% → Flannel
4. Special case: winner ≥ 5,000 and loser < 5,000 → automatic Flannel
5. If no tier qualifies: no Apron awarded
6. Create `Apron` doc, fire `apron_awarded` notification to winner

**Profile display:**
- Show lifetime Apron counts by tier on the winner's profile (all viewers)
- Only the highest tier from each contest counts — no stacking multiple tiers per contest

**Monthly auto-settlement (agenda job — `settle_aprons`):**
- Runs on the 1st alongside `snapshot_monthly_balances`
- For each user: group unpaid Aprons by tier
- If count meets tier minimum (Flannel: 5, Denim: 10, Velvet: 20): credit `earnedCHL` with tier value × count, mark docs as `paidOut`
- If below minimum: carry over (no action)
- Write `WalletTransaction` (type: `apron_payout`) per tier settled
- Fire `apron_settled` notification

**New notification types:** `apron_awarded`, `apron_settled`

---

#### Phase 9.3 — Vote Economics (free vote 12h window + paid votes)

Currently every user gets one vote per contest freely. The designed system has a 12-hour free vote reset across all contests, plus paid votes using chillies.

**Schema changes:**
- `User.lastFreeVoteAt: Date` — tracks when the free vote was last used (null if never used)
- `ContestVote.isPaid: Boolean` (default `false`) — whether chillies were spent
- `ContestVote.amountCHL: Number` (default `0`) — chillies spent on a paid vote

**Free vote logic:**
- On vote: check if `now - user.lastFreeVoteAt > 12h` (or `lastFreeVoteAt` is null)
- If eligible: cast free vote, set `User.lastFreeVoteAt = now`
- If not eligible: must cast paid vote (spend chillies). User sees "Your free vote resets in Xh Ym" on the contest page.

**Paid vote logic:**
- Amount is user-determined (any amount ≥ 1 chilli)
- Debit wallet (`purchasedCHL` first, then `earnedCHL`), write `WalletTransaction` (type: `paid_vote`)
- Paid votes do NOT affect the vote count differently from free votes — all votes are equal in determining the winner
- Attribution (ContestContribution) remains separate

**Vote switching:**
- User changes their vote while contest is live
- Previous vote removed. If it was a free vote: `User.lastFreeVoteAt` reset to what it was before (or null). If paid: chillies refunded to wallet.
- New vote cast under normal rules

**Note:** This phase depends on CCBill being live (Phase 9.1) since paid votes require a funded wallet. If 9.1 slips, implement the free vote 12h window first (no CCBill dependency) and add paid votes once CCBill lands.

---

### Phase 10 — Polish + Miscellaneous

#### Phase 10.1 — Admin Analytics Page

`GET /admin/analytics` + `views/admin/analytics.ejs` — founder + superadmin.

Metrics to expose:
- New users (by day/week/month)
- Entries submitted (by day/week/month)
- Active contests count
- Contest close rate (closed vs voided)
- Total chillies in circulation (sum of all `purchasedCHL + earnedCHL`)
- Top-rated entries this week
- Most active users (by contest participation)

Data sourced from direct MongoDB aggregations — no external analytics service.

---

#### Phase 10.2 — Retag

`models/Retag.js` is scaffolded but not wired. Defer until explicitly prioritized — the mechanic isn't documented in the platform spec well enough to build without a design session.

---

#### Phase 10.3 — Search ✅ (done 2026-07-01)

~~Wire up the existing `/search` stub with real query logic.~~

**Route:** `GET /search?q=<query>&type=<entries|users|stains>`

**Results:**
- **Entries:** search `title`, `caption`, `tags` (text index already on Entry model). Show as entry cards.
- **Users:** search `username.value`, `displayName.value` (prefix match). Show as user rows with follow state.
- **Stains (tags):** aggregate most-used tags matching the query. Show as clickable stain pills that re-run the search scoped to that tag.

**UI:** tabbed results (Entries | People | Stains), search input in the existing header. No infinite scroll for July — paginated results with "Show more" is fine.

**Affinity:** fire `updateStainAffinity` when a user clicks through from a stain result (`signal = 0.15`).

---

## What Is NOT In July

| Feature | Reason |
|---|---|
| Open Challenges | Post-MVP — explicitly deferred after tournaments are solid |
| Marketplace | Post-MVP |
| Ratings Challenge | Removed from design — replaced by 3-replay chain |
| Apron audience filter for Announcements | Requires Apron data to exist first — wire once Phase 9.2 is done (post-month) |

---

## End-of-July Target

By July 31, the platform should support:
- Full user-organized and platform tournament lifecycle end-to-end
- Admin tournament review and management
- Real CCBill payment for wallet top-ups and tournament prize commitments
- Apron trophies awarded at contest close with monthly auto-settlement
- 12-hour free vote window + paid vote support
- Search wired with real results
- All pre-launch test bypasses reverted

The platform will be functionally complete and ready for controlled launch.
