# Tournament Implementation Plan — Detailed

> Supersedes Phase 7/8 in `july-action-plan.md`.
> Spec source: `plans/July/tournament-spec.md`.
> Written against actual codebase structure as of 2026-07-02.

**Status (as of 2026-07-02): Not started.** `models/Tournament.js` and `models/TournamentEntry.js` are still the pre-plan schemas (`type`, `entryWindowHours`, `fundsHeld`, `reviewStatus`, `pending_funds`/`pending_review` status values) — none of Phase 1's schema changes have landed. No files from Phases 1–9 exist yet (`routes/tournaments.js`, `jobs/tournamentJobs.js`, `utils/tournamentScheduler.js`, `utils/tournamentEligibility.js`, `middleware/requireOrganizerEligibility.js`, `models/TournamentGroup.js`, `models/TournamentMatch.js`, `models/TournamentJury.js`, `models/TournamentJuryVote.js`, `views/tournaments/*`). The only tournament-related views present (`views/admin/tournaments/index.ejs`, `review.ejs`) are skeletons reflecting the **old, superseded** design (admin review queue, `pending_review`) and will need to be repurposed per Phase 9I once this plan is implemented. Next step: Phase 1 (schema).

---

## Codebase reference

```
models/           — Mongoose schemas
routes/api.js     — All JSON API routes
routes/pages.js   — All page routes (GET, returns HTML)
routes/wallet.js  — Wallet-specific routes (mounted at /wallet)
jobs/agenda.js    — Agenda instance (shared singleton)
jobs/contestJobs.js — close_contest / void_expired_contest logic
jobs/sweeper.js   — 15-min sweeper pattern (copy for tournament sweeper)
jobs/walletJobs.js  — Monthly payout jobs
middleware/requireAuth.js     — Must be logged in
middleware/requireDomain.js   — Admin role gate
middleware/injectRightPanelData.js — Adds rightPanel data to res.locals
utils/            — Pure logic utilities (no Express, no Mongoose models if avoidable)
views/            — EJS templates
views/partials/   — Reusable partials
views/admin/tournaments/ — Already has index.ejs and review.ejs (skeletons)
```

---

## Phase 1 — Schema: Revise Existing Models + Create 4 New Models

### 1A. Revise `models/Tournament.js`

**What to remove:**
- `type` field (`platform | user_organized`) — tournaments are always user-organized now
- `entryWindowHours` — replaced by fixed `openDeadline`
- `cooldownHours` — replaced by fixed 24h
- `roundWindowHours` — H2H window is always 24h
- `fundsHeld` — replaced by `prizePool.funded`
- `reviewStatus` — admin review step removed
- `missedReviews` — removed (different cancellation logic)
- `entryDeadline`, `roundsStartAt` — replaced by `openDeadline`, `cooldownDeadline`, `activeAt`
- `prizeSlotSchema` with `entryId` embedded — prizes don't have an entry until close

**What to change:**
- `status` enum: remove `pending_funds`, `pending_review` → new enum: `'open' | 'cooldown' | 'active' | 'closed' | 'canceled'`
- `prizes` schema: change to `{ first: Number, second: Number, third: Number }` (amounts in CHL, not cents)
- `participantCount` → rename to `size`, add enum validation `[4, 8, 12, 16, 24]`

**What to add:**
```js
size:                 { type: Number, enum: [4, 8, 12, 16, 24], required: true }
groupSize:            { type: Number, required: true }   // derived at creation: 3 for 12/24, 4 for 4/8/16
groupCount:           { type: Number, required: true }   // size / groupSize

prizes: {
  first:  { type: Number, required: true, min: 1000 },  // in CHL
  second: { type: Number, required: true, min: 400 },
  third:  { type: Number, required: true, min: 100 },
  funded: { type: Boolean, default: false },             // true once SB deducted
}

eligibilityCriteria:  { type: [criteriaSchema], default: [] }
// criteriaSchema: { field: String, operator: String, value: mongoose.Schema.Types.Mixed }
// field options: 'ratingAvg' | 'ratingCount' | 'followerCount' | 'age' | 'sex' | 'entryCount' | 'accountAgeDays'
// operator options: 'gte' | 'lte' | 'eq'

openDeadline:         { type: Date, required: true }     // createdAt + 3 days
cooldownDeadline:     { type: Date }                     // set when open phase closes
activeAt:             { type: Date }                     // set when cooldown resolves

cancelReason:         { type: String, default: null }    // 'insufficient_candidates' | 'cooldown_expired' | 'organizer_action'

prizes.winnersSet:    { type: Boolean, default: false }  // true once 1st/2nd/3rd are determined
```

**Updated indexes:**
```js
tournamentSchema.index({ status: 1 });
tournamentSchema.index({ createdBy: 1 });
tournamentSchema.index({ openDeadline: 1, status: 1 });
tournamentSchema.index({ cooldownDeadline: 1, status: 1 });
```

---

### 1B. Revise `models/TournamentEntry.js`

**What to keep:** `tournamentId`, `entryId`, `userId`, `approvalStatus`, `wins`, `losses`, `totalVotes`, `eliminated`, `submittedAt`, `reviewedAt`

**What to remove:** nothing

**What to add:**
```js
groupId:       { type: mongoose.Schema.Types.ObjectId, ref: 'TournamentGroup', default: null }
groupPoints:   { type: Number, default: 0 }   // wins in group stage only
groupRank:     { type: Number, default: null } // 1 or 2 — populated after group resolves
knockoutRound: { type: String, default: null } // 'R16' | 'QF' | 'SF' | '3rd' | 'Final' — how far they got
```

**Updated indexes:**
```js
tournamentEntrySchema.index({ tournamentId: 1, entryId: 1 }, { unique: true });
tournamentEntrySchema.index({ tournamentId: 1, approvalStatus: 1 });
tournamentEntrySchema.index({ tournamentId: 1, groupId: 1 });
tournamentEntrySchema.index({ tournamentId: 1, eliminated: 1 });
```

---

### 1C. Create `models/TournamentGroup.js`

```js
const tournamentGroupSchema = new mongoose.Schema({
  tournamentId: { type: ObjectId, ref: 'Tournament', required: true },
  label:        { type: String, required: true },  // 'A', 'B', 'C', ...
  memberIds:    [{ type: ObjectId, ref: 'TournamentEntry' }],
  status:       { type: String, enum: ['active', 'complete'], default: 'active' },
}, { timestamps: true });

tournamentGroupSchema.index({ tournamentId: 1 });
tournamentGroupSchema.index({ tournamentId: 1, status: 1 });
```

---

### 1D. Create `models/TournamentMatch.js`

```js
const tournamentMatchSchema = new mongoose.Schema({
  tournamentId:      { type: ObjectId, ref: 'Tournament', required: true },
  contestId:         { type: ObjectId, ref: 'Contest', required: true },
  stage:             { type: String, enum: ['group', 'knockout'], required: true },
  groupId:           { type: ObjectId, ref: 'TournamentGroup', default: null },
  knockoutRound:     { type: String, enum: ['R16', 'QF', 'SF', '3rd', 'Final'], default: null },
  entryIdA:          { type: ObjectId, ref: 'Entry', required: true },
  entryIdB:          { type: ObjectId, ref: 'Entry', required: true },
  tournamentEntryIdA: { type: ObjectId, ref: 'TournamentEntry', required: true },
  tournamentEntryIdB: { type: ObjectId, ref: 'TournamentEntry', required: true },
  winnerId:          { type: ObjectId, ref: 'Entry', default: null },
  loserTournamentEntryId: { type: ObjectId, ref: 'TournamentEntry', default: null },
  status:            { type: String, enum: ['scheduled', 'active', 'tie', 'closed'], default: 'scheduled' },
  tieStatus:         { type: String, enum: ['jury_pending', 'organizer_pending', 'resolved'], default: null },
  isTiebreakerMatch: { type: Boolean, default: false },  // true for 2-player group rank tiebreaker
  scheduledAt:       { type: Date, required: true },
  openedAt:          { type: Date, default: null },
}, { timestamps: true });

tournamentMatchSchema.index({ tournamentId: 1, stage: 1 });
tournamentMatchSchema.index({ tournamentId: 1, groupId: 1 });
tournamentMatchSchema.index({ contestId: 1 }, { unique: true });
tournamentMatchSchema.index({ tournamentId: 1, status: 1 });
tournamentMatchSchema.index({ tournamentId: 1, knockoutRound: 1 });
```

---

### 1E. Create `models/TournamentJury.js`

```js
const tournamentJurySchema = new mongoose.Schema({
  tournamentId: { type: ObjectId, ref: 'Tournament', required: true },
  userId:       { type: ObjectId, ref: 'User', required: true },
  missedVotes:  { type: Number, default: 0 },
}, { timestamps: true });

tournamentJurySchema.index({ tournamentId: 1, userId: 1 }, { unique: true });
tournamentJurySchema.index({ tournamentId: 1 });
// NOTE: never populate userId in any API response — jury identity must stay hidden
```

---

### 1F. Create `models/TournamentJuryVote.js`

```js
const tournamentJuryVoteSchema = new mongoose.Schema({
  tournamentId:      { type: ObjectId, ref: 'Tournament', required: true },
  matchId:           { type: ObjectId, ref: 'TournamentMatch', required: true },
  jurorId:           { type: ObjectId, ref: 'User', required: true },
  votedForEntryId:   { type: ObjectId, ref: 'Entry', required: true },
}, { timestamps: true });

tournamentJuryVoteSchema.index({ matchId: 1, jurorId: 1 }, { unique: true });
tournamentJuryVoteSchema.index({ matchId: 1 });
```

---

### 1G. Add `juryBanned` to `models/User.js`

In the User schema, add one field:
```js
juryBanned: { type: Boolean, default: false }
```

This flag is set permanently after a jury member misses a vote. It prevents them from being selected as a jury member in future tournament creation flows.

---

### 1H. Mount new models in server.js

In `server.js`, after the existing model requires, add:
```js
require('./models/TournamentGroup');
require('./models/TournamentMatch');
require('./models/TournamentJury');
require('./models/TournamentJuryVote');
```

---

### Phase 1 exit criteria

- All 4 new model files exist and compile without error
- `Tournament.js` and `TournamentEntry.js` have updated schemas
- `User.js` has `juryBanned` field
- Server starts without Mongoose schema errors
- Existing contest flow is not broken (run a contest end-to-end to confirm)

---

## Phase 2 — Tournament Creation Flow

### 2A. Create `middleware/requireOrganizerEligibility.js`

This middleware runs before any tournament creation route. It checks all 5 organizer eligibility conditions and returns a JSON error or redirect if any fail.

```
Checks (in order):
1. req.user.idVerified === true
   → if false: redirect to /verify-identity
2. req.user.isBanned !== true
   → if banned: res.status(403).json({ error: 'Your account has an active ban.' })
3. Count UserReport docs where { reportedUserId: req.user._id, status: 'pending' } === 0
   → if > 0: res.status(403).json({ error: 'Your account has pending reports under review.' })
4. req.user.followerCount > 250
   → if not: res.status(403).json({ error: 'You need more than 250 followers to organize a tournament.' })
5. Count distinct contestId in ContestContribution where { userId: req.user._id } >= 5
   → if < 5: res.status(403).json({ error: 'You must have contributed to at least 5 contests.' })
```

Export as: `module.exports = requireOrganizerEligibility`

---

### 2B. Create `routes/tournaments.js`

New route file, mounted in `server.js` as:
```js
app.use('/tournaments', require('./routes/tournaments'));
```

All routes in this file require `requireAuth` middleware applied at the router level.

**Page routes:**

```
GET /tournaments
  → handler: fetch up to 20 tournaments sorted by createdAt desc, status in ['open','cooldown','active']
  → also fetch up to 5 recently closed (status: 'closed', closedAt within last 30 days)
  → render views/tournaments/index.ejs
  → pass: { openTournaments, activeTournaments, closedTournaments, user: req.user }

GET /tournaments/create
  → middleware: requireOrganizerEligibility
  → render views/tournaments/create.ejs
  → pass: { user: req.user, step: 1, errors: [], formData: {} }

GET /tournament/:id
  → fetch Tournament by _id, 404 if not found
  → fetch TournamentGroups for this tournament
  → fetch TournamentEntries (approvalStatus: 'approved') with entry + user populated
  → fetch TournamentMatches with contestId populated
  → if status === 'open': also fetch pending entry count, check if req.user already submitted
  → render views/tournaments/detail.ejs
  → pass: { tournament, groups, entries, matches, userEntry, isOrganizer, user: req.user }

GET /tournament/:id/review
  → middleware: verify req.user._id === tournament.createdBy, else 403
  → fetch all TournamentEntries with approvalStatus: 'pending', populate entryId (with media)
  → render views/tournaments/review.ejs
  → pass: { tournament, pendingEntries, user: req.user }

GET /tournament/:id/jury-vote/:matchId
  → verify req.user is a TournamentJury member for this tournament (query TournamentJury)
  → if no record found: 403
  → fetch TournamentMatch, verify status === 'tie' and tieStatus === 'jury_pending'
  → check TournamentJuryVote — if juror already voted this match: redirect to /tournament/:id with flash 'You already voted on this tie.'
  → fetch both entries (entryIdA, entryIdB) with their media
  → render views/tournaments/jury-vote.ejs
  → pass: { tournament, match, entryA, entryB } — DO NOT pass any jury identity info
```

---

### 2C. Creation flow — Step 1: Basics

`POST /tournaments/create/step1`

**Request body:**
```
name:          String, required, 3–80 chars
description:   String, optional, max 500 chars
size:          Number, must be in [4, 8, 12, 16, 24]
openDays:      Number, 1–3 (how many days open phase lasts, default 3)
```

**Validation (server-side):**
- `name` trimmed length 3–80: `'Tournament name must be between 3 and 80 characters.'`
- `size` not in valid list: `'Participant count must be 4, 8, 12, 16, or 24.'`
- `openDays` not 1, 2, or 3: `'Open phase must last 1 to 3 days.'`
- Any failure: re-render `views/tournaments/create.ejs` with `{ step: 1, errors, formData }`

**On success:**
- Store step 1 data in `req.session.tournamentDraft = { name, description, size, openDays }`
- Redirect to `GET /tournaments/create/step2`

---

### 2D. Creation flow — Step 2: Prizes + Inline Funding

`GET /tournaments/create/step2`
- Check `req.session.tournamentDraft` exists, else redirect to step 1
- Fetch `req.user.wallet.purchasedCHL` (SB balance)
- Render `views/tournaments/create.ejs` with `{ step: 2, sbBalance, user: req.user, errors: [], formData: {} }`

`POST /tournaments/create/step2`

**Request body:**
```
prizeFirst:   Number, min 1000
prizeSecond:  Number, min 400
prizeThird:   Number, min 100
```

**Validation:**
- `prizeFirst >= 1000`: `'1st place prize must be at least 1,000 CHL.'`
- `prizeSecond >= 400`: `'2nd place prize must be at least 400 CHL.'`
- `prizeThird >= 100`: `'3rd place prize must be at least 100 CHL.'`
- `prizeFirst > prizeSecond`: `'1st place prize must be greater than 2nd place.'`
- `prizeSecond > prizeThird`: `'2nd place prize must be greater than 3rd place.'`
- Any failure: re-render step 2 with errors

**SB balance check:**
- `total = prizeFirst + prizeSecond + prizeThird`
- Fetch `req.user.wallet.purchasedCHL`
- If `purchasedCHL >= total`: save to `req.session.tournamentDraft.prizes`, redirect to step 3
- If `purchasedCHL < total`:
  - `shortfall = total - purchasedCHL`
  - Re-render step 2 with `{ insufficientFunds: true, shortfall, total, sbBalance: purchasedCHL }`
  - View shows inline payment section (see 2E)

---

### 2E. Inline Tournament Funding

Only surfaces on step 2 when SB is insufficient. This is a tournament-gated $500-max top-up. Regular `/wallet/topup` is not used here.

`POST /tournaments/fund`

**Request body:**
```
amountCHL: Number — how many CHL to buy (must be > 0 and ≤ 500 CHL equivalent)
```

For now (CCBill stub): deduct from nothing, credit `purchasedCHL` directly (same pattern as `/wallet/checkout` stub).

Write a `WalletTransaction`:
```js
{
  userId:        req.user._id,
  type:          'topup',
  direction:     'credit',
  amountCHL:     amountCHL,
  amountUSD:     amountCHL * EXCHANGE_RATE,
  exchangeRate:  EXCHANGE_RATE,
  balanceBefore: currentSB,
  balanceAfter:  currentSB + amountCHL,
  status:        'completed',
  source:        'tournament_fund',
  referenceType: 'Tournament',
}
```

On success: redirect back to `GET /tournaments/create/step2` with updated SB.

When CCBill is live (Phase 9.1), this route redirects to CCBill with `returnUrl: /tournaments/create/step2` and `source=tournament_fund`.

---

### 2F. Creation flow — Step 3: Eligibility Criteria

`GET /tournaments/create/step3`
- Check `req.session.tournamentDraft.prizes` exists, else redirect to step 2
- Render `views/tournaments/create.ejs` with `{ step: 3, user: req.user }`

`POST /tournaments/create/step3`

**Request body:**
```
criteria: JSON array of { field, operator, value } objects (may be empty array)
```

**Validation per criterion:**
- `field` must be one of: `ratingAvg | ratingCount | followerCount | age | sex | entryCount | accountAgeDays`
- `operator` must be: `gte | lte | eq`
- `value` must be appropriate type for the field (number for numeric fields, string for sex)
- `sex` field only supports `operator: 'eq'`, value must be `'M' | 'F' | 'NB'`

On success: save to `req.session.tournamentDraft.eligibilityCriteria`, redirect to step 4.

---

### 2G. Creation flow — Step 4: Jury Selection

`GET /tournaments/create/step4`
- Check `req.session.tournamentDraft.eligibilityCriteria` exists, else redirect to step 3
- Render `views/tournaments/create.ejs` with `{ step: 4, user: req.user }`

`POST /api/tournaments/search-users` (JSON, called from jury search typeahead)
- Params: `?q=<username_or_display_name>`
- Returns up to 10 users matching query, excluding `req.user._id` and users with `juryBanned: true`
- Response: `[{ _id, username, displayName, avatarUrl }]`
- Never expose `juryBanned` field in response

`POST /tournaments/create/step4`

**Request body:**
```
juryUserIds: Array of user _id strings
```

**Validation:**
- Length must be 5–7: `'You must select between 5 and 7 jury members.'`
- No duplicates
- No user is the organizer themselves: `'You cannot add yourself as a jury member.'`
- All userIds must resolve to real, non-banned, non-juryBanned users

On success: save to `req.session.tournamentDraft.juryUserIds`, call `finalizeTournamentCreation(req)`.

---

### 2H. `finalizeTournamentCreation(req)` — called after step 4

This function does all the writes atomically:

```
1. Derive groupSize and groupCount from size:
   size 4  → groupSize 4, groupCount 1
   size 8  → groupSize 4, groupCount 2
   size 12 → groupSize 3, groupCount 4
   size 16 → groupSize 4, groupCount 4
   size 24 → groupSize 3, groupCount 8

2. Compute openDeadline = new Date(now + openDays * 24 * 60 * 60 * 1000)

3. Deduct total prize pool from req.user.wallet.purchasedCHL:
   User.findOneAndUpdate(
     { _id: req.user._id, 'wallet.purchasedCHL': { $gte: totalPrize } },
     { $inc: { 'wallet.purchasedCHL': -totalPrize } }
   )
   If no document returned: return error 'Insufficient balance. Your wallet balance changed.'

4. Write WalletTransaction:
   {
     userId:        req.user._id,
     type:          'tournament_prize_hold',
     direction:     'debit',
     amountCHL:     totalPrize,
     amountUSD:     totalPrize * EXCHANGE_RATE,
     status:        'completed',
     source:        'tournament_creation',
     referenceType: 'Tournament',
     referenceId:   <tournament._id — set after step 5>
   }

5. Create Tournament document:
   {
     createdBy:           req.user._id,
     name, description, size, groupSize, groupCount,
     eligibilityCriteria,
     prizes:              { first, second, third, funded: true },
     status:              'open',
     openDeadline,
   }

6. Create TournamentJury documents (one per juryUserId):
   { tournamentId: tournament._id, userId, missedVotes: 0 }

7. Update WalletTransaction.referenceId = tournament._id

8. Schedule agenda job: 'tournament_open_expiry' at openDeadline
   data: { tournamentId: tournament._id.toString() }

9. Clear req.session.tournamentDraft

10. Redirect to /tournament/:id with flash 'Your tournament is live and accepting candidates.'
```

---

### Phase 2 exit criteria

- An eligible organizer can complete all 4 steps
- Tournament is created with `status: 'open'`, prizes funded, jury stored privately
- Ineligible users are blocked at each eligibility check with clear error messages
- `WalletTransaction` of type `tournament_prize_hold` exists after creation
- `TournamentJury` docs are created (not accessible via any public route)
- Agenda job `tournament_open_expiry` is scheduled at `openDeadline`
- Session draft is cleared on completion and on any error path that needs to reset

---

## Phase 3 — Open Phase & Candidate Management

### 3A. Eligibility criteria evaluation — `utils/tournamentEligibility.js`

New utility. Export one function:

```js
async function evaluateCriteria(user, entry, criteria) → { eligible: Boolean, failedCriteria: String[] }
```

For each criterion in `criteria`:
```
field: 'ratingAvg'       → compare entry.ratingAvg
field: 'ratingCount'     → compare entry.ratingCount
field: 'followerCount'   → query Follow.countDocuments({ followedId: user._id })
field: 'age'             → compute years from user.birthdate to now
field: 'sex'             → compare user.sex
field: 'entryCount'      → query Entry.countDocuments({ userId: user._id, status: 'active' })
field: 'accountAgeDays'  → compute days from user.createdAt to now

operator: 'gte' → value >= criterion.value
operator: 'lte' → value <= criterion.value
operator: 'eq'  → value === criterion.value
```

If `criteria` is empty array → return `{ eligible: true, failedCriteria: [] }`
Always enforce `user.idVerified === true` regardless of criteria array.

---

### 3B. Candidate submission route

In `routes/api.js`, add:

```
POST /api/tournaments/:id/submit
  middleware: requireAuth

  Steps:
  1. Fetch Tournament by _id. If not found: 404.
  2. If tournament.status !== 'open': 400 { error: 'This tournament is no longer accepting candidates.' }
  3. If req.user._id.toString() === tournament.createdBy.toString(): 403 { error: 'Organizers cannot enter their own tournament.' }
  4. If !req.user.idVerified: 403 { error: 'Identity verification is required to enter a tournament.' }
  5. Parse req.body.entryId. Fetch Entry by _id where userId === req.user._id.
     If not found: 400 { error: 'Entry not found or does not belong to you.' }
  6. Check TournamentEntry.exists({ tournamentId, userId: req.user._id })
     If exists: 400 { error: 'You have already submitted an entry to this tournament.' }
  7. Evaluate eligibilityCriteria via evaluateCriteria(req.user, entry, tournament.eligibilityCriteria)
     If not eligible: 400 { error: 'Your entry does not meet the eligibility criteria.', failedCriteria }
  8. Count approved TournamentEntries for this tournament.
     If count >= tournament.size: 400 { error: 'This tournament is already full.' }
  9. Create TournamentEntry:
     { tournamentId, entryId, userId: req.user._id, approvalStatus: 'pending', submittedAt: new Date() }
  10. Create Notification for organizer:
      { userId: tournament.createdBy, type: 'tournament_entry_submitted',
        payload: { tournamentId, entryId, url: '/tournament/' + tournamentId + '/review' } }
  11. Return 200 { success: true, message: 'Your entry has been submitted for review.' }
```

---

### 3C. Organizer approve/reject routes

In `routes/api.js`, add:

```
POST /api/tournaments/:id/entries/:eid/approve
  middleware: requireAuth

  Steps:
  1. Fetch Tournament. If not found: 404.
  2. If req.user._id.toString() !== tournament.createdBy.toString(): 403.
  3. If tournament.status !== 'open': 400 { error: 'Candidate review is only available during the open phase.' }
  4. Fetch TournamentEntry by { _id: eid, tournamentId }. If not found: 404.
  5. If entry.approvalStatus !== 'pending': 400 { error: 'This entry has already been reviewed.' }
  6. Count currently approved entries for this tournament.
     If count >= tournament.size: 400 { error: 'Tournament is already at capacity.' }
  7. Update TournamentEntry: { approvalStatus: 'approved', reviewedAt: new Date() }
  8. Create Notification for submitter:
     { userId: entry.userId, type: 'tournament_entry_approved',
       payload: { tournamentId, url: '/tournament/' + tournamentId } }
  9. Check if approved count now === tournament.size → trigger immediate cap-reached transition (see 3F)
  10. Return 200 { success: true }

POST /api/tournaments/:id/entries/:eid/reject
  middleware: requireAuth

  Steps:
  1–4: same as approve
  5. If entry.approvalStatus !== 'pending': 400
  6. Parse req.body.note (optional string, max 200 chars)
  7. Update TournamentEntry: { approvalStatus: 'rejected', reviewedAt: new Date() }
  8. Create Notification for submitter:
     { userId: entry.userId, type: 'tournament_entry_rejected',
       payload: { tournamentId, note: note || null, url: '/tournament/' + tournamentId } }
  9. Return 200 { success: true }
```

---

### 3D. Create `jobs/tournamentJobs.js`

New job file. Register all tournament agenda jobs here. Import and call `registerTournamentJobs(agenda)` in `server.js` alongside `registerContestJobs`.

---

### 3E. Open phase expiry job

In `jobs/tournamentJobs.js`:

```js
agenda.define('tournament_open_expiry', async job => {
  const { tournamentId } = job.attrs.data;
  const tournament = await Tournament.findOne({ _id: tournamentId, status: 'open' });
  if (!tournament) return; // already transitioned

  const approvedCount = await TournamentEntry.countDocuments({
    tournamentId: tournament._id,
    approvalStatus: 'approved',
  });

  if (approvedCount < 4) {
    // Cancel — not enough candidates
    await cancelTournament(tournament._id, 'insufficient_candidates');
    return;
  }

  // Enough candidates — move to cooldown
  await transitionToCooldown(tournament._id);
});
```

---

### 3F. Cap-reached trigger

In the approve route handler (step 9), after incrementing approved count:

```js
const newApprovedCount = await TournamentEntry.countDocuments({
  tournamentId: tournament._id,
  approvalStatus: 'approved',
});

if (newApprovedCount >= tournament.size) {
  // Cancel the scheduled open_expiry job (it's no longer needed)
  await agenda.cancel({ name: 'tournament_open_expiry', 'data.tournamentId': tournamentId });
  await transitionToCooldown(tournament._id);
}
```

---

### 3G. `transitionToCooldown(tournamentId)` — in `jobs/tournamentJobs.js`

```js
async function transitionToCooldown(tournamentId) {
  const cooldownDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000); // now + 24h

  await Tournament.findByIdAndUpdate(tournamentId, {
    $set: { status: 'cooldown', cooldownDeadline },
  });

  // Schedule cooldown expiry job
  await agenda.schedule(cooldownDeadline, 'tournament_cooldown_expiry', {
    tournamentId: tournamentId.toString(),
  });

  // Notify organizer
  const tournament = await Tournament.findById(tournamentId).select('createdBy name').lean();
  await Notification.create({
    userId: tournament.createdBy,
    type:   'tournament_cooldown_started',
    payload: {
      tournamentId,
      cooldownDeadline,
      url: '/tournament/' + tournamentId,
    },
  });
}
```

---

### 3H. `cancelTournament(tournamentId, reason)` — in `jobs/tournamentJobs.js`

```js
async function cancelTournament(tournamentId, reason) {
  const tournament = await Tournament.findOneAndUpdate(
    { _id: tournamentId, status: { $in: ['open', 'cooldown'] } },
    { $set: { status: 'canceled', cancelReason: reason } },
  ).lean();

  if (!tournament) return; // already handled

  // Refund prize pool to organizer's purchasedCHL
  const total = tournament.prizes.first + tournament.prizes.second + tournament.prizes.third;
  const EXCHANGE_RATE = 0.20;

  const updatedUser = await User.findByIdAndUpdate(
    tournament.createdBy,
    { $inc: { 'wallet.purchasedCHL': total } },
    { new: true, select: 'wallet' },
  );

  const balanceAfter  = updatedUser.wallet.purchasedCHL;
  const balanceBefore = balanceAfter - total;

  await WalletTransaction.create({
    userId:        tournament.createdBy,
    type:          'tournament_prize_refund',
    direction:     'credit',
    amountCHL:     total,
    amountUSD:     +(total * EXCHANGE_RATE).toFixed(2),
    exchangeRate:  EXCHANGE_RATE,
    balanceBefore,
    balanceAfter,
    status:        'completed',
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
```

---

### Phase 3 exit criteria

- Candidates can submit entries during open phase
- Organizer can approve and reject from the review queue
- Approval at capacity immediately triggers cooldown transition
- Open phase expiry job fires at `openDeadline`: cancels if < 4, transitions to cooldown if ≥ 4
- Cancellation always refunds prize pool and notifies all parties
- Cooldown transition always notifies organizer and schedules `tournament_cooldown_expiry`

---

## Phase 4 — Cooldown: Group Assignment & Match Schedule

### 4A. Create `utils/tournamentScheduler.js`

This utility contains all group and match generation logic. No Express, no session — pure async functions that take IDs and write to the DB.

---

### 4B. `generateGroups(tournamentId)` in `utils/tournamentScheduler.js`

```
Steps:
1. Fetch all TournamentEntries where { tournamentId, approvalStatus: 'approved' }
2. Extract their _id values into an array: entryDocs
3. Shuffle with Fisher-Yates:
   for (let i = entryDocs.length - 1; i > 0; i--) {
     const j = Math.floor(Math.random() * (i + 1));
     [entryDocs[i], entryDocs[j]] = [entryDocs[j], entryDocs[i]];
   }
4. Fetch tournament.groupSize and tournament.groupCount
5. Split shuffled array into chunks of groupSize:
   const groups = [];
   for (let i = 0; i < entryDocs.length; i += tournament.groupSize) {
     groups.push(entryDocs.slice(i, i + tournament.groupSize));
   }
6. For each chunk (index i):
   a. label = String.fromCharCode(65 + i)  // 'A', 'B', 'C', ...
   b. Create TournamentGroup: { tournamentId, label, memberIds: chunk.map(e => e._id), status: 'active' }
   c. Update each TournamentEntry in chunk: { groupId: group._id }
7. Return array of created TournamentGroup docs
```

---

### 4C. `generateGroupMatches(groupId)` in `utils/tournamentScheduler.js`

```
Steps:
1. Fetch TournamentGroup by _id, populate memberIds as TournamentEntry docs (with entryId populated)
2. Fetch tournamentId from the group
3. Generate all unique pairs from memberIds array:
   const pairs = [];
   for (let i = 0; i < members.length; i++) {
     for (let j = i + 1; j < members.length; j++) {
       pairs.push([members[i], members[j]]);
     }
   }
   // Group of 3 → 3 pairs. Group of 4 → 6 pairs.

4. Schedule matches so no player is in two active matches simultaneously.
   Use a slot-based scheduler:
   - slots = []  (array of time slots, each slot holds matches that run simultaneously)
   - playerLastSlot = {}  (tracks the last slot index each player is assigned to)
   
   For each pair [A, B]:
     slotA = playerLastSlot[A._id] ?? -1
     slotB = playerLastSlot[B._id] ?? -1
     assignSlot = Math.max(slotA, slotB) + 1
     if (!slots[assignSlot]) slots[assignSlot] = []
     slots[assignSlot].push([A, B])
     playerLastSlot[A._id] = assignSlot
     playerLastSlot[B._id] = assignSlot

5. Compute scheduledAt for each slot:
   baseTime = now (time of cooldown launch)
   slot 0 → scheduledAt = baseTime
   slot 1 → scheduledAt = baseTime + 24h
   slot 2 → scheduledAt = baseTime + 48h
   ... etc.

6. For each pair in each slot:
   a. Create Contest document:
      {
        createdBy:      tournament.createdBy,
        tournamentId:   tournamentId,
        entries:        [
          { entryId: A.entryId, userId: A.userId },
          { entryId: B.entryId, userId: B.userId },
        ],
        status:         slot === 0 ? 'active' : 'scheduled',  // first slot opens immediately
        visibility:     'public',
        votingDeadline: scheduledAt + 24h,
        windowHours:    24,
        createdAt:      new Date(),
        lastActivityAt: new Date(),
      }
   b. Create TournamentMatch document:
      {
        tournamentId,
        contestId:              contest._id,
        stage:                  'group',
        groupId:                group._id,
        entryIdA:               A.entryId,
        entryIdB:               B.entryId,
        tournamentEntryIdA:     A._id,
        tournamentEntryIdB:     B._id,
        status:                 slot === 0 ? 'active' : 'scheduled',
        scheduledAt:            scheduledAt,
        openedAt:               slot === 0 ? new Date() : null,
      }

7. Schedule agenda job for each contest in slot 0:
   agenda.schedule(contest.votingDeadline, 'close_contest', { contestId: contest._id.toString() })

8. For slots > 0: schedule agenda job 'open_tournament_match' at scheduledAt
   data: { matchId: tournamentMatch._id.toString() }
   (This job opens the match and schedules its close_contest job — see Phase 4E)
```

---

### 4D. Cooldown expiry job

In `jobs/tournamentJobs.js`:

```js
agenda.define('tournament_cooldown_expiry', async job => {
  const { tournamentId } = job.attrs.data;
  const tournament = await Tournament.findOne({ _id: tournamentId, status: 'cooldown' });
  if (!tournament) return; // already launched or already canceled

  // Organizer did not launch manually in 24h → cancel
  await cancelTournament(tournament._id, 'cooldown_expired');
});
```

---

### 4E. Early launch route (organizer triggers before 24h)

In `routes/api.js`:

```
POST /api/tournaments/:id/launch
  middleware: requireAuth

  Steps:
  1. Fetch Tournament. If not found: 404.
  2. If req.user._id !== tournament.createdBy: 403.
  3. If tournament.status !== 'cooldown': 400 { error: 'Tournament is not in cooldown phase.' }
  4. Cancel the scheduled 'tournament_cooldown_expiry' job for this tournament.
  5. Call activateTournament(tournament._id)
  6. Return 200 { success: true, redirectUrl: '/tournament/' + tournament._id }
```

---

### 4F. `activateTournament(tournamentId)` in `jobs/tournamentJobs.js`

```js
async function activateTournament(tournamentId) {
  // Import scheduler inline to avoid circular deps
  const { generateGroups, generateGroupMatches } = require('../utils/tournamentScheduler');

  await Tournament.findByIdAndUpdate(tournamentId, {
    $set: { status: 'active', activeAt: new Date() },
  });

  const groups = await generateGroups(tournamentId);

  for (const group of groups) {
    await generateGroupMatches(group._id);
  }

  // Notify all approved contestants
  const entries = await TournamentEntry.find({
    tournamentId, approvalStatus: 'approved',
  }).select('userId').lean();

  const notifications = entries.map(e => ({
    userId:  e.userId,
    type:    'tournament_live',
    payload: { tournamentId, url: '/tournament/' + tournamentId },
  }));

  await Notification.insertMany(notifications, { ordered: false });
}
```

Also register the cooldown expiry transition into `activateTournament` — when `tournament_open_expiry` fires and transitions to cooldown, and subsequently `tournament_cooldown_expiry` fires, call `cancelTournament`. If organizer launches early, `activateTournament` is called instead.

---

### 4G. `open_tournament_match` job

For matches in slots > 0 (not immediate), an agenda job opens them when their scheduled time arrives:

```js
agenda.define('open_tournament_match', async job => {
  const { matchId } = job.attrs.data;

  const match = await TournamentMatch.findOne({ _id: matchId, status: 'scheduled' });
  if (!match) return;

  await TournamentMatch.findByIdAndUpdate(matchId, {
    $set: { status: 'active', openedAt: new Date() },
  });

  await Contest.findByIdAndUpdate(match.contestId, {
    $set: { status: 'active' },
  });

  const votingDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await Contest.findByIdAndUpdate(match.contestId, { $set: { votingDeadline } });

  await agenda.schedule(votingDeadline, 'close_contest', {
    contestId: match.contestId.toString(),
  });
});
```

---

### Phase 4 exit criteria

- After early launch or cooldown expiry (if not canceled), all groups are created, all group matches are scheduled or active
- Group stage slot 0 matches are immediately active with voting deadlines in 24h
- Later slots have scheduled `open_tournament_match` jobs
- `Tournament.status` is `'active'`
- All approved contestants receive `tournament_live` notification
- If organizer never launches in 24h, `cancelTournament` fires and everything refunds

---

## Phase 5 — Group Stage: Standings & Advancement

### 5A. Extend `jobs/contestJobs.js` — `closeContest` function

At the end of the existing `closeContest` function, after the earnings settlement block, add:

```js
// Tournament match hook
if (contest.tournamentId) {
  const { handleTournamentMatchClose } = require('../jobs/tournamentJobs');
  // Fire and forget — don't let tournament logic block or error the main close path
  handleTournamentMatchClose(contest._id, winnerEntryId).catch(err => {
    console.error('[closeContest] tournament hook failed for contest', contest._id, ':', err.message);
  });
}
```

---

### 5B. `handleTournamentMatchClose(contestId, winnerEntryId)` in `jobs/tournamentJobs.js`

```
Steps:
1. Fetch TournamentMatch by { contestId }. If not found: return.
2. If match.status === 'closed': return (already handled).

3. If winnerEntryId is null: TIE — handle separately (see Phase 7)
   Set match.status = 'tie', match.tieStatus = 'jury_pending'
   Save match.
   Call initiateTieResolution(match._id)
   Return early.

4. WINNER EXISTS:
   Determine winner TournamentEntry:
   winnerTE = match.tournamentEntryIdA if match.entryIdA === winnerEntryId, else match.tournamentEntryIdB
   loserTE  = the other one

5. Update TournamentMatch:
   { status: 'closed', winnerId: winnerEntryId, loserTournamentEntryId: loserTE }

6. Update winner TournamentEntry:
   $inc: { wins: 1, totalVotes: <winner vote count>, groupPoints: 1 (if stage === 'group') }

7. Update loser TournamentEntry:
   $inc: { losses: 1, totalVotes: <loser vote count> }

8. If match.stage === 'group':
   Call checkGroupComplete(match.groupId)

9. If match.stage === 'knockout':
   Call handleKnockoutMatchClose(match)
```

---

### 5C. `checkGroupComplete(groupId)` in `jobs/tournamentJobs.js`

```
Steps:
1. Fetch TournamentGroup by _id. If status === 'complete': return.
2. Count TournamentMatches where { groupId, stage: 'group', status: { $ne: 'closed' }, isTiebreakerMatch: false }
   If count > 0: group not done yet, return.
3. All group matches closed → call resolveGroup(groupId)
```

---

### 5D. `resolveGroup(groupId)` in `jobs/tournamentJobs.js`

```
Steps:
1. Fetch all TournamentEntries for this group (via groupId field).
2. Sort by groupPoints descending.
3. Call resolveGroupStandings(groupMembers) → returns ordered array [1st, 2nd, 3rd, ...]

resolveGroupStandings(members):
  a. Sort by groupPoints descending.
  b. Group members with equal groupPoints together.
  c. For each tied group (> 1 member), apply tiebreaker chain:
     i.   Sort by entry.ratingAvg descending
     ii.  If still tied: sort by entry.ratingCount descending
     iii. If still tied: compute totalVotesInGroup (sum of votes received in group stage matches)
           → query TournamentMatch where groupId, closed, entryIdA or entryIdB = member
           → sum ContestVote counts for each member
     iv.  If still tied: flag for jury vote (async — see below)
     v.   If still tied after jury: coin flip (Math.random())

  If steps i–iii resolve the tie:
     Assign ranks 1, 2, 3... based on sorted order

  If step iv required (jury vote for group placement):
     Create a special "group ranking" jury request (not a match tie — a ranking tie)
     Store in TournamentMatch with isTiebreakerMatch: true, stage: 'group'
     Pause group resolution until jury resolves it

4. Top 2 in resolved standings:
   Update TournamentEntry: { groupRank: 1 or 2 }
   Notify contestant: tournament_group_advance notification (you advanced)

5. Bottom member(s):
   Update TournamentEntry: { eliminated: true }
   Notify contestant: tournament_eliminated notification

6. Update TournamentGroup: { status: 'complete' }

7. Check if ALL groups in this tournament are now complete:
   Count TournamentGroups where { tournamentId, status: 'active' } — if 0:
   → All groups done → call generateKnockoutBracket(tournamentId) (Phase 6)
```

---

### 5E. Two-player tie for 2nd place (same groupPoints, both qualify)

This only happens when exactly 2 players are tied for a rank where both qualify (both would be rank 1 and 2 but points are equal). In this case:

Both advance regardless — but seeding order matters for knockout bracket.

Create an extra tiebreaker match:
```js
// In resolveGroupStandings, when top 2 are tied on all statistical measures:
const tiebreakerContest = await Contest.create({
  createdBy:      tournament.createdBy,
  tournamentId:   tournament._id,
  entries:        [{ entryId: A.entryId, userId: A.userId }, { entryId: B.entryId, userId: B.userId }],
  status:         'active',
  visibility:     'public',
  votingDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
  windowHours:    24,
});

const tiebreakerMatch = await TournamentMatch.create({
  tournamentId:      tournament._id,
  contestId:         tiebreakerContest._id,
  stage:             'group',
  groupId:           group._id,
  isTiebreakerMatch: true,
  entryIdA:          A.entryId,
  entryIdB:          B.entryId,
  tournamentEntryIdA: A._id,
  tournamentEntryIdB: B._id,
  status:            'active',
  scheduledAt:       new Date(),
  openedAt:          new Date(),
});

await agenda.schedule(tiebreakerContest.votingDeadline, 'close_contest', {
  contestId: tiebreakerContest._id.toString(),
});
```

When this tiebreaker closes (via `handleTournamentMatchClose`):
- Both get `groupRank` assigned (winner = 1, loser = 2)
- Group resolution continues

---

### Phase 5 exit criteria

- When a group stage contest closes, `handleTournamentMatchClose` fires
- Win/loss/votes/groupPoints update correctly on both TournamentEntry docs
- When all group matches for a group close, `resolveGroup` fires
- Top 2 are advanced, others eliminated with notifications
- Tiebreaker matches are created and resolved before group finalizes
- When all groups complete, knockout generation is triggered

---

## Phase 6 — Knockout Stage

### 6A. `generateKnockoutBracket(tournamentId)` in `utils/tournamentScheduler.js`

```
Steps:
1. Fetch tournament.groupCount and tournament.size

2. Determine knockout field size: groupCount × 2
   (each group contributes 2 qualifiers)

3. Fetch all TournamentEntries where { tournamentId, groupRank: { $in: [1, 2] } }
   Populate groupId to get group label

4. Organize by group: { A: [rank1, rank2], B: [rank1, rank2], ... }

5. Generate first-round pairings using cross-group seeding:
   Pair groups to avoid same-group rematches in round 1:
   - Pair group A rank1 vs group B rank2
   - Pair group B rank1 vs group A rank2
   - Pair group C rank1 vs group D rank2
   - Pair group D rank1 vs group C rank2
   ... etc. for all group pairs

6. Determine first knockout round label:
   fieldSize 2  → 'Final'
   fieldSize 4  → 'SF'
   fieldSize 8  → 'QF'
   fieldSize 16 → 'R16'

7. For each pairing, create Contest + TournamentMatch (same pattern as group matches):
   stage: 'knockout', knockoutRound: <round label>
   All first-round knockout matches open immediately (scheduledAt: now, status: 'active')
   votingDeadline: now + 24h
   Schedule close_contest job for each

8. Notify all qualifiers: tournament_knockout_started notification
```

---

### 6B. `handleKnockoutMatchClose(match)` in `jobs/tournamentJobs.js`

Called from `handleTournamentMatchClose` when `match.stage === 'knockout'`.

```
Steps:
1. Fetch winner and loser TournamentEntry docs from match

2. Loser:
   Update TournamentEntry: { eliminated: true, knockoutRound: match.knockoutRound }
   Send notification: tournament_eliminated

3. Winner:
   Update TournamentEntry: { knockoutRound: match.knockoutRound }
   (will be updated to next round when that match is created)

4. Determine next round:
   'R16' → 'QF'
   'QF'  → 'SF'
   'SF'  → check: is this the SF that feeds the 3rd place match or the final?
            → both SF matches must close before next round can be created
   'Final' → tournament ends → call closeTournament(tournamentId) (Phase 8)
   '3rd'   → tournament ends → call closeTournament(tournamentId) (Phase 8)

5. For R16 → QF, QF → SF:
   Check if the "partner" match in this round is also closed:
   Count TournamentMatches where { tournamentId, knockoutRound: match.knockoutRound, status: 'closed' }
   If all matches in this round are now closed → generate next round matches

6. For SF round:
   When both SF matches are closed:
   a. Get both SF winners → create Final match
   b. Get both SF losers → create 3rd place match
   Both new matches open immediately

7. Create next-round match (when both slots are known):
   Contest + TournamentMatch, stage: 'knockout', knockoutRound: <next round>
   status: 'active', scheduledAt: now, votingDeadline: now + 24h
   Schedule close_contest job
```

---

### 6C. Round progression check — `allMatchesClosedInRound(tournamentId, round)`

Helper used in handleKnockoutMatchClose:

```js
async function allMatchesClosedInRound(tournamentId, round) {
  const openMatches = await TournamentMatch.countDocuments({
    tournamentId,
    knockoutRound: round,
    stage: 'knockout',
    status: { $ne: 'closed' },
  });
  return openMatches === 0;
}
```

---

### 6D. Advancing to next round — `createNextRoundMatch(tournamentId, round)`

```js
async function createNextRoundMatch(tournamentId, currentRound) {
  const roundMap = { 'R16': 'QF', 'QF': 'SF', 'SF': 'Final' };
  const nextRound = roundMap[currentRound];
  if (!nextRound) return;

  // Collect all winners from the current round
  const closedMatches = await TournamentMatch.find({
    tournamentId, knockoutRound: currentRound, stage: 'knockout', status: 'closed',
  }).lean();

  const winners = closedMatches.map(m => ({
    tournamentEntryId: m.tournamentEntryIdA.toString() === m.loserTournamentEntryId?.toString()
      ? m.tournamentEntryIdB
      : m.tournamentEntryIdA,
    entryId: m.winnerId,
  }));

  // Pair winners into next round matches (maintain bracket positioning)
  // winners[0] vs winners[1], winners[2] vs winners[3], etc.
  for (let i = 0; i < winners.length; i += 2) {
    const A = winners[i];
    const B = winners[i + 1];
    const teA = await TournamentEntry.findById(A.tournamentEntryId).select('userId entryId').lean();
    const teB = await TournamentEntry.findById(B.tournamentEntryId).select('userId entryId').lean();
    // Create Contest + TournamentMatch for this pairing (same pattern as before)
    // ... (same Contest + TournamentMatch creation as in generateKnockoutBracket)
  }
}
```

---

### Phase 6 exit criteria

- When all group stages complete, first knockout round is generated and all matches open
- Each knockout match close triggers the next round's match generation
- SF losers are automatically paired into a 3rd place match
- Finals close triggers `closeTournament`
- No manual intervention needed once the tournament is active

---

## Phase 7 — Tie Resolution System

### 7A. `initiateTieResolution(matchId)` in `jobs/tournamentJobs.js`

```
Steps:
1. Fetch TournamentMatch by _id. Fetch tournament.
2. Fetch all TournamentJury docs for this tournament.
3. Create Notification for each jury member:
   {
     userId: jury.userId,
     type:   'tournament_tie_jury',
     payload: { tournamentId, matchId, url: '/tournament/' + tournamentId + '/jury-vote/' + matchId }
   }
   NOTE: do not reveal which entries are tied in the notification payload.
4. Schedule agenda job 'tournament_jury_expiry' at now + 6h:
   data: { matchId: matchId.toString() }
```

---

### 7B. Jury vote route

In `routes/api.js`:

```
POST /api/tournaments/:id/jury-vote/:matchId
  middleware: requireAuth

  Steps:
  1. Fetch TournamentMatch by { _id: matchId, tournamentId: id }.
     If not found: 404.
  2. If match.status !== 'tie' or match.tieStatus !== 'jury_pending': 400 { error: 'No active jury vote for this match.' }
  3. Verify req.user is a jury member: TournamentJury.findOne({ tournamentId: id, userId: req.user._id })
     If not found: 403 { error: 'You are not a jury member for this tournament.' }
  4. Check TournamentJuryVote.exists({ matchId, jurorId: req.user._id })
     If exists: 400 { error: 'You have already cast your vote for this tie.' }
  5. Parse req.body.votedForEntryId. Must be match.entryIdA or match.entryIdB.
     If neither: 400 { error: 'Invalid entry selection.' }
  6. Create TournamentJuryVote: { tournamentId: id, matchId, jurorId: req.user._id, votedForEntryId }
  7. Notify each contestant ONLY how many votes they have received so far (not who voted):
     Count votes for entryIdA and entryIdB.
     Create Notification for entryA.userId:
       { type: 'tournament_jury_vote_received', payload: { matchId, voteCount: countA } }
     Create Notification for entryB.userId:
       { type: 'tournament_jury_vote_received', payload: { matchId, voteCount: countB } }
  8. Check if quorum reached: total votes cast >= 3
     If yes: call resolveJuryVote(matchId)
  9. Return 200 { success: true }
```

---

### 7C. `resolveJuryVote(matchId)` in `jobs/tournamentJobs.js`

```
Steps:
1. Fetch all TournamentJuryVotes for this matchId.
2. Count votes per entry:
   const counts = {};
   for (const vote of votes) {
     const key = vote.votedForEntryId.toString();
     counts[key] = (counts[key] || 0) + 1;
   }
3. Find entry with more votes:
   If counts[entryIdA] > counts[entryIdB] → winner = entryIdA
   If counts[entryIdB] > counts[entryIdA] → winner = entryIdB
   If equal (shouldn't happen with quorum of 3 but handle anyway):
     → do not resolve here, fall through to organizer vote
4. Cancel 'tournament_jury_expiry' job for this matchId.
5. Update TournamentMatch: { tieStatus: 'resolved', winnerId: winnerEntryId, status: 'closed' }
6. Resume normal match close flow: call handleTournamentMatchClose with the winner
```

---

### 7D. Jury vote expiry job

```js
agenda.define('tournament_jury_expiry', async job => {
  const { matchId } = job.attrs.data;

  const match = await TournamentMatch.findOne({ _id: matchId, tieStatus: 'jury_pending' });
  if (!match) return; // already resolved by quorum

  // Mark missed votes for non-voting jury members
  const allJurors  = await TournamentJury.find({ tournamentId: match.tournamentId });
  const votedIds   = await TournamentJuryVote.distinct('jurorId', { matchId: match._id });
  const votedSet   = new Set(votedIds.map(id => id.toString()));

  for (const juror of allJurors) {
    if (!votedSet.has(juror.userId.toString())) {
      await TournamentJury.findByIdAndUpdate(juror._id, { $inc: { missedVotes: 1 } });
    }
  }

  // Transition to organizer fallback
  await TournamentMatch.findByIdAndUpdate(matchId, {
    $set: { tieStatus: 'organizer_pending' },
  });

  // Notify organizer
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

  // Schedule organizer vote expiry at now + 3h
  await agenda.schedule(new Date(Date.now() + 3 * 60 * 60 * 1000), 'tournament_organizer_vote_expiry', {
    matchId: matchId.toString(),
  });
});
```

---

### 7E. Organizer tie vote route

In `routes/api.js`:

```
POST /api/tournaments/:id/organizer-vote/:matchId
  middleware: requireAuth

  Steps:
  1. Fetch tournament, verify req.user._id === tournament.createdBy. Else 403.
  2. Fetch TournamentMatch, verify tieStatus === 'organizer_pending'. Else 400.
  3. Parse req.body.votedForEntryId. Must be match.entryIdA or match.entryIdB.
  4. Cancel 'tournament_organizer_vote_expiry' job for this matchId.
  5. Resolve: Update match { tieStatus: 'resolved', winnerId: votedForEntryId, status: 'closed' }
  6. Call handleTournamentMatchClose with winner
  7. Return 200 { success: true }
```

---

### 7F. Organizer vote expiry job (coin flip)

```js
agenda.define('tournament_organizer_vote_expiry', async job => {
  const { matchId } = job.attrs.data;

  const match = await TournamentMatch.findOne({ _id: matchId, tieStatus: 'organizer_pending' });
  if (!match) return; // organizer voted in time

  // Coin flip
  const winnerId = Math.random() < 0.5 ? match.entryIdA : match.entryIdB;

  await TournamentMatch.findByIdAndUpdate(matchId, {
    $set: { tieStatus: 'resolved', winnerId, status: 'closed' },
  });

  await handleTournamentMatchClose(match._id, winnerId);
});
```

---

### 7G. Post-tournament jury ban

In `closeTournament` (Phase 8), after setting tournament status to 'closed':

```js
// Flag jury members who missed votes for permanent ban
const jurors = await TournamentJury.find({
  tournamentId, missedVotes: { $gt: 0 },
}).select('userId').lean();

if (jurors.length > 0) {
  await User.updateMany(
    { _id: { $in: jurors.map(j => j.userId) } },
    { $set: { juryBanned: true } },
  );
}
```

---

### Phase 7 exit criteria

- Any tie in any match (group or knockout) initiates the jury vote flow
- Jury members receive notification and can vote via the jury-vote page
- Quorum of 3 votes resolves immediately
- If 6h passes without quorum: non-voting jury members get `missedVotes` incremented, organizer gets 3h
- If 3h passes: platform coin flip resolves
- No tie can block tournament progression for more than 9 hours total
- After tournament close: jury members with `missedVotes > 0` get `juryBanned: true`

---

## Phase 8 — Prize Distribution & Tournament Close

### 8A. `closeTournament(tournamentId)` in `jobs/tournamentJobs.js`

```
Steps:
1. Fetch Tournament. If status already 'closed': return.

2. Fetch all knockout TournamentMatches for this tournament:
   Specifically the Final and 3rd place matches.

3. Determine placements:
   const finalMatch = TournamentMatch.findOne({ tournamentId, knockoutRound: 'Final', status: 'closed' })
   const thirdMatch = TournamentMatch.findOne({ tournamentId, knockoutRound: '3rd', status: 'closed' })

   firstEntry  = final winner's TournamentEntry
   secondEntry = final loser's TournamentEntry
   thirdEntry  = 3rd match winner's TournamentEntry

   (For 4-player tournament with only a Final: secondEntry is the finalist, no 3rd match)

4. If tournament.size === 4 (only 1 group, top 2 go to Final only):
   firstEntry  = final winner
   secondEntry = final loser
   thirdEntry  = null (no 3rd place prize for 4-player tournaments)

5. Credit prizes to earnedCHL:
   EXCHANGE_RATE = 0.20

   For each winner (first, second, third):
     prize = tournament.prizes.first / .second / .third
     updatedUser = User.findByIdAndUpdate(
       entry.userId,
       { $inc: { 'wallet.earnedCHL': prize } },
       { new: true, select: 'wallet' }
     )
     Write WalletTransaction:
       { type: 'tournament_prize_payout', direction: 'credit', amountCHL: prize,
         source: 'tournament_close', referenceId: tournamentId, referenceType: 'Tournament' }
     Create Notification:
       { type: 'tournament_prize_awarded', payload: { place: 1/2/3, amountCHL: prize, tournamentId } }

6. Set Tournament:
   { status: 'closed', 'prizes.winnersSet': true }

7. Notify all participants: tournament_closed notification

8. Apply jury ban (see Phase 7G)

9. Update right panel: no explicit action needed — panel query filters by status: 'active'
```

---

### 8B. Tournament sweeper (add to `jobs/sweeper.js`)

Add a new sweeper function alongside the existing contest sweeper. This handles any deadlines the one-time agenda jobs might have missed (server restart, etc.):

```js
async function runTournamentSweeper(agenda) {
  const now     = new Date();
  const horizon = new Date(now.getTime() + WINDOW_MS); // 15 min ahead

  // Sweep open phase deadlines
  const openExpiring = await Tournament.find({
    status: 'open',
    openDeadline: { $lte: horizon },
  }).select('_id openDeadline').lean();

  for (const t of openExpiring) {
    if (t.openDeadline <= now) {
      // Fire immediately
      const { tournamentOpenExpiry } = require('./tournamentJobs');
      await tournamentOpenExpiry(t._id);
    } else {
      const existing = await agenda.jobs({
        name: 'tournament_open_expiry',
        'data.tournamentId': t._id.toString(),
        nextRunAt: { $ne: null },
      });
      if (existing.length === 0) {
        await agenda.schedule(t.openDeadline, 'tournament_open_expiry', { tournamentId: t._id.toString() });
      }
    }
  }

  // Sweep cooldown deadlines (same pattern)
  // Sweep jury vote expiry (same pattern, checking TournamentMatch where tieStatus: 'jury_pending')
  // Sweep organizer vote expiry (same pattern, checking TournamentMatch where tieStatus: 'organizer_pending')
}
```

Add `runTournamentSweeper(agenda)` call inside the existing `startSweeper` function:
```js
agenda.define('contest_sweeper', async () => {
  await Promise.all([
    runVoidSweeper(agenda),
    runCloseSweeper(agenda),
    runTournamentSweeper(agenda),
  ]);
});
```

---

### Phase 8 exit criteria

- `closeTournament` fires after Final and 3rd place match both close
- 1st/2nd/3rd prize amounts are credited to winners' `earnedCHL`
- `WalletTransaction` records exist for each payout
- All participants receive `tournament_closed` notification
- Winners receive `tournament_prize_awarded` notification with their place and amount
- Tournament `status` is `'closed'`
- Jury members with missed votes are permanently flagged

---

## Phase 9 — Frontend, Admin & Notifications

### 9A. New view files to create

```
views/tournaments/index.ejs        — Browse tournaments (open, active, recently closed)
views/tournaments/detail.ejs       — Tournament detail (status-aware rendering)
views/tournaments/create.ejs       — Multi-step creation form (step 1–4)
views/tournaments/review.ejs       — Organizer candidate review queue
views/tournaments/jury-vote.ejs    — Anonymous jury voting interface
```

### 9B. `views/tournaments/index.ejs`

Sections:
- **Open:** cards showing name, size, spots filled / total, prize pool total, days remaining, "View" CTA
- **Active:** cards showing name, progress (group/knockout), prize pool, "Watch" CTA
- **Recently Closed:** cards showing name, winner username + avatar, prize pool, "Results" CTA

No participation action on this page — all actions happen on the detail page.

---

### 9C. `views/tournaments/detail.ejs` — status-aware rendering

**When `status === 'open'`:**
- Tournament name, description, eligibility criteria list
- Prize pool display: 1st / 2nd / 3rd amounts
- Approved entries grid (entry card thumbnails, username)
- Pending count ("X entries awaiting review")
- Open phase countdown
- "Submit Your Entry" button (if user is eligible and hasn't submitted)
  - On click: opens entry picker modal (fetch user's entries, pick one, POST to /api/tournaments/:id/submit)
- If user already submitted: show submission status badge (pending / approved / rejected)

**When `status === 'cooldown'`:**
- Confirmed participant list (approved entries)
- "Tournament starts in Xh Ym" countdown to launch
- Prize pool display

**When `status === 'active'`:**

Two sub-sections toggle via tab:

*Groups tab:*
- One standings table per group
- Columns: Rank, Entry (thumbnail + username), W, L, Pts
- Highlight top 2 (will advance)
- Each row links to the entry page
- Active matches listed below each group table as H2H contest cards (same entryCard partial, with vote buttons)

*Bracket tab (only shown once knockout begins):*
- Visual bracket showing knockout rounds
- Each matchup shows entry thumbnails, vote counts (live)
- Advancing players highlighted
- Eliminated players greyed out

**When `status === 'closed'`:**
- Podium: 1st / 2nd / 3rd with entry thumbnail, username, prize amount
- Full bracket results
- Total matches played, total votes cast across tournament

---

### 9D. `views/tournaments/create.ejs` — multi-step form

Single EJS file that renders differently based on `step` variable (1–4).

**Step 1 — Basics:**
- Input: Tournament Name
- Input: Description (optional)
- Dropdown: Participant cap [4, 8, 12, 16, 24]
- Radio: Open phase duration [1 day / 2 days / 3 days]
- "Continue" button → POST /tournaments/create/step1

**Step 2 — Prizes:**
- Three number inputs: 1st (min 1,000), 2nd (min 400), 3rd (min 100)
- Live total display (JS computed as user types)
- SB balance display: "Your balance: X CHL"
- If balance sufficient: green checkmark, "Continue" button
- If balance insufficient: red shortfall message, inline payment section:
  - "You need X more CHL" 
  - Payment button: "Buy X CHL — $Y" → POST /tournaments/fund
  - If shortfall > 500: show multiple payment steps ("3 payments required")
- "Continue" button → POST /tournaments/create/step2

**Step 3 — Eligibility:**
- "Add Criterion" button → shows a row with [field dropdown] [operator dropdown] [value input]
- Max 5 criteria
- "No criteria" option clearly available (empty array is valid)
- "Skip / Continue" button → POST /tournaments/create/step3

**Step 4 — Jury:**
- Search box with typeahead (hits POST /api/tournaments/search-users)
- Selected jury members shown as pill tags with avatar and remove button
- Count indicator: "X of 5–7 selected"
- "Confirm & Create Tournament" button (disabled until 5–7 selected) → POST /tournaments/create/step4
- Step 4 success → redirect to /tournament/:id

---

### 9E. `views/tournaments/review.ejs`

- Lists pending entries with:
  - Entry thumbnail (video or image)
  - Entry title + caption
  - Submitter username + avatar
  - Entry rating avg + count
  - "Approve" button (green) + "Reject" button (red, opens note modal)
- Count: "X pending, Y approved, Z/N slots filled"
- If no pending entries and tournament is still open: "No entries awaiting review"
- Auto-refresh every 60s (or use SSE if preferred) so new submissions appear without reload

---

### 9F. `views/tournaments/jury-vote.ejs`

Critical: this page must reveal nothing about jury identity.

- Header: "A match in [Tournament Name] is tied. Your vote is needed."
- Side-by-side entry display: Entry A and Entry B — thumbnail, rating avg only. No usernames. No entry titles. Just the media.
- Vote button under each entry: "Vote for this entry"
- Submit → POST /api/tournaments/:id/jury-vote/:matchId with { votedForEntryId }
- After submit: "Your vote has been cast." — no result shown.
- No navigation to the main tournament page from this screen (to avoid jury members knowing who they're judging)

---

### 9G. Update `views/partials/rightPanel.ejs`

Replace the existing tournament skeleton (currently commented-out or empty):

```html
<% if (locals.activeTournaments && activeTournaments.length > 0) { %>
  <div class="right-panel-section">
    <h3>Ongoing Tournaments</h3>
    <% activeTournaments.forEach(t => { %>
      <a href="/tournament/<%= t._id %>" class="tournament-card-mini">
        <span class="tournament-name"><%= t.name %></span>
        <span class="tournament-prize">$<%= ((t.prizes.first + t.prizes.second + t.prizes.third) * 0.20).toFixed(0) %> pool</span>
        <span class="tournament-status"><%= t.status %></span>
      </a>
    <% }) %>
  </div>
<% } %>
```

Update `middleware/injectRightPanelData.js` to add:
```js
const Tournament = require('../models/Tournament');
const activeTournaments = await Tournament.find({ status: 'active' })
  .sort({ activeAt: -1 })
  .limit(3)
  .select('name prizes status activeAt')
  .lean();
res.locals.activeTournaments = activeTournaments;
```

---

### 9H. Update `views/partials/sidebar.ejs`

Add "Tournaments" link in the main nav, below Contests:
```html
<a href="/tournaments" class="sidebar-link <% if (currentPath === '/tournaments') { %>active<% } %>">
  Tournaments
</a>
```

---

### 9I. Admin pages

**Update `views/admin/tournaments/index.ejs`** (skeleton exists):
- Table: Tournament Name | Organizer | Size | Status | Prize Pool | Created At | Actions
- Filter by status (open / cooldown / active / closed / canceled)
- Each row links to detail view
- No review/approve/reject actions (admin review step was removed)

**Update `views/admin/tournaments/review.ejs`** (skeleton exists):
- Repurpose as a read-only admin detail view
- Shows full tournament state: groups, matches, standings, jury member count (not identities), prize pool
- "Force Cancel" button for founder/superadmin only (in extreme cases)

Add admin routes in `routes/admin.js`:
```
GET /admin/tournaments          → middleware: requireDomain('tournaments'), render index
GET /admin/tournaments/:id      → middleware: requireDomain('tournaments'), render detail
POST /admin/tournaments/:id/cancel  → middleware: requireDomain(null) [founder only], call cancelTournament
```

---

### 9J. Notification types to add to `models/Notification.js`

Add to the `type` enum:
```
'tournament_entry_submitted'
'tournament_entry_approved'
'tournament_entry_rejected'
'tournament_cooldown_started'
'tournament_live'
'tournament_group_advance'
'tournament_eliminated'
'tournament_tie_jury'
'tournament_tie_organizer'
'tournament_jury_vote_received'
'tournament_closed'
'tournament_prize_awarded'
'tournament_canceled'
```

In `views/notifications.ejs`, add rendering cases for each new type. Pattern:
- `tournament_prize_awarded` → "You won [place] place in [tournament name] — [amount] CHL awarded"
- `tournament_eliminated` → "Your entry was eliminated in the [round] round of [tournament name]"
- `tournament_live` → "The tournament [name] is now live — your first match starts soon"
- etc.

---

### 9K. Mount `routes/tournaments.js` in `server.js`

```js
app.use('/tournaments', require('./routes/tournaments'));
```

Add after the existing route mounts (after `app.use('/wallet', ...)`, before the 404 handler).

Also add `registerTournamentJobs` call:
```js
const { registerTournamentJobs } = require('./jobs/tournamentJobs');
registerTournamentJobs(agenda);
```

---

### Phase 9 exit criteria

- Full tournament lifecycle is navigable via browser from creation to close
- All 5 view files render correctly at each lifecycle state
- Jury vote page reveals no user identity information
- Right panel shows active tournaments for all logged-in users
- Admin can browse all tournaments and view full detail (read-only)
- All 13 new notification types render correctly in `/notifications`
- Sidebar shows Tournaments link

---

## Build Order Summary

| Phase | Files Created | Files Modified |
|---|---|---|
| 1 | `models/TournamentGroup.js`, `models/TournamentMatch.js`, `models/TournamentJury.js`, `models/TournamentJuryVote.js` | `models/Tournament.js`, `models/TournamentEntry.js`, `models/User.js`, `server.js` |
| 2 | `middleware/requireOrganizerEligibility.js`, `routes/tournaments.js` | `server.js` |
| 3 | `jobs/tournamentJobs.js` (start), `utils/tournamentEligibility.js` | `routes/api.js` |
| 4 | `utils/tournamentScheduler.js` | `jobs/tournamentJobs.js` |
| 5 | — | `jobs/contestJobs.js`, `jobs/tournamentJobs.js` |
| 6 | — | `jobs/tournamentJobs.js`, `utils/tournamentScheduler.js` |
| 7 | — | `jobs/tournamentJobs.js`, `routes/api.js` |
| 8 | — | `jobs/tournamentJobs.js`, `jobs/sweeper.js` |
| 9 | `views/tournaments/index.ejs`, `views/tournaments/detail.ejs`, `views/tournaments/create.ejs`, `views/tournaments/review.ejs`, `views/tournaments/jury-vote.ejs` | `views/partials/rightPanel.ejs`, `views/partials/sidebar.ejs`, `views/admin/tournaments/index.ejs`, `views/admin/tournaments/review.ejs`, `views/notifications.ejs`, `middleware/injectRightPanelData.js`, `routes/admin.js`, `models/Notification.js` |

---

## What changes vs. old Phase 7/8

| Old spec | New spec | Impact |
|---|---|---|
| Round-robin, 66% win threshold | Group stage + knockout | `TournamentMatch` replaces simple win tracking; group scheduler new |
| Winner = highest totalVotes | Winner = grand final winner | `closeTournament` logic changed |
| 30-min per-review clock per entry | 3-day open window, batch review | No `missedReviews` counter; no 30-min agenda jobs |
| Replay chain (72h→36h→18h→9h) | Jury → organizer → coin flip | `TournamentJury`, `TournamentJuryVote` models new; tie jobs new |
| Admin review (`pending_review`) | No admin review | Remove `pending_review` status, `reviewStatus`, `fundsHeld` |
| Fixed prizes $1k/$400/$100 | Flexible prizes with minimums | `prizes` schema changed to plain Numbers |
| Single top-up max $200 | Tournament-gated $500 top-up | New `/tournaments/fund` route |
| No jury | 5–7 member anonymous jury | Two new models, new jobs, new view |
| `pending_funds` lifecycle state | Prizes funded inline at creation | `fundsHeld` removed; `prizes.funded` replaces it |
