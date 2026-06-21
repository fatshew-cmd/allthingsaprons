# All Things Aprons — Platform Core Concepts

## Overview

All Things Aprons (ATA) is a media platform where registered users submit photos or videos that are subject to community engagement through three distinct systems: **Ratings**, **Contests**, and **Tournaments**. The entry is the central object everything else revolves around.

---

## 1. Entries

An entry is a photo or video submitted by a registered user to their profile. Every entry is automatically subject to ratings upon submission — this is a platform default, not opt-in, similar to how likes work on Instagram.

A user can submit up to **3 entries at once** in a single submission. Each entry is its own independent platform item — they are not bundled or grouped. Each one is individually subject to ratings, contests, and tournaments on its own merits.

An entry can participate in multiple contests or tournaments throughout its lifetime on the platform. Submitting to a contest or tournament does not remove the entry from ratings or other contests. An entry's participation in different systems is independent and additive.

Once submitted to a contest or tournament, an entry is locked and cannot be changed.

### 1.1 Tags

An entry owner can add up to six free-form text tags to their entry. Tags can be added, edited, or removed at any time — even after the entry is locked in a contest or tournament.

### 1.2 Take Ons

Any eligible user can initiate a **Take On** — a direct challenge targeting a specific existing entry for a H2H contest, rather than targeting a user as in the standard challenge flow.

**Visibility rule:** The Take On button is only shown on entries that have demonstrated contest intent — entries where the owner has either sent a nomination or accepted one. Entries with no contest history do not show the button at all.

**Owner toggle (`allowTakeOns`):** The entry owner controls whether their entry can be taken on. The toggle (`Allow Take Ons`) appears on the entry edit page as soon as the entry meets the visibility rule above. Default is **off** when the toggle first appears. The owner can flip it on or off at any time. The setting persists regardless of whether the entry's contests are currently active, closed, or voided — once the toggle has appeared, it stays.

**Eligibility to initiate:** same gate as a standard challenge — `idVerified: true` plus the contest eligibility thresholds (minEntries, minRatingCount, minWeightedAvg). A user cannot Take On their own entry.

**Flow:**
1. User clicks Take On on an entry → redirected to `/submit` with the target entry pre-selected as the opponent
2. User submits their own entry → creates a pending contest + nomination sent to the original entry owner
3. Entry owner accepts or declines within 24h (standard void deadline applies)
4. Accepted → contest goes live. Declined or ignored → contest voids.

---

## 2. Ratings

Ratings are the default engagement layer for every entry on the platform.

- **Scale:** 1–10 numeric score
- **Who can rate:** Registered users only
- **Deadline:** None — any entry can be rated at any time
- **Constraints:**
  - A user cannot rate the same entry more than once
  - A user cannot rate their own entry

Ratings are stored as individual records, preserving the full history per user per entry. This allows duplicate prevention, self-rating enforcement, average score calculation, and future features (rating history, edit capability, fraud detection).

---

## 2.5 Comments

Registered users can comment on any entry. Comments support one level of replies — a reply is displayed indented under its parent and automatically prefixed with @username of the parent commenter. Replying to a reply is not allowed.

### Moderation

- Any user can delete their own comment at any time.
- The entry owner can hide any comment on their entry. Hidden comments are not deleted — they are removed from public view and accessible only to the entry owner in a private "hidden comments" section.
- Any registered user (including the entry owner) can report a comment. Reports are stored for admin review.

### Notifications

- Commenting on an entry notifies the entry owner.
- Replying to a comment notifies the parent commenter.

---

## 3. Contests

A contest is a head-to-head (HTH) between exactly two entries. A voter is shown both entries and picks the one they prefer.

### 3.1 Visibility

| Type | Description |
|---|---|
| Public | Open voting — any registered user can vote |
| Private | Creator designates the opponent and a minimum of 5 specific voters |

### 3.2 Lifecycle

```
pending → active → closed
                 → void
```

| Status | Condition |
|---|---|
| `pending` | Contest created, waiting for the second entry to be submitted |
| `active` | Both entries submitted — 72-hour voting window begins |
| `void` | Only one entry submitted after 24 hours, or opponent declines nomination |
| `closed` | Voting window expired — winner determined by vote count |

- The **void deadline** is set to `created_at + 24 hours`. If a second entry is not submitted by then, the contest is voided.
- The **voting deadline** is set to `second entry submitted_at + 72 hours`. Voting closes at that point regardless of vote count. Even a single vote is counted.

### 3.3 Creation — Standalone Contests

Any registered user can create a standalone contest. Whether the creator nominates themselves determines the contest type:

**Creator self-nominates (standard HTH):**
The creator is one of the two contestants. They name a specific opponent. Only that one opponent can submit an entry. The contest is a closed 2-person head-to-head.

The nominated opponent has 24 hours to respond. Submitting an entry counts as accepting. Letting the deadline pass counts as declining, and the contest is voided.

**Creator does not self-nominate (open challenge — post-MVP):**
The creator is the organizer, not a contestant. The challenge is open for any registered user to accept. See Section 9.

**Creator initiates a Take On (see Section 1.2):**
The creator targets a specific existing entry (not just a user). The target entry must have `allowTakeOns: true`. The creator selects their own entry on the submission page. A pending contest is created and a nomination is sent to the targeted entry's owner. Standard 24h void deadline and acceptance rules apply.

### 3.4 Viewer Nominations

Any registered user (not necessarily a contestant) can nominate two other users for a head-to-head. Both nominated users receive a notification. The viewer can optionally include a message describing what they want the contest to be about. Both users must independently submit an entry within 24 hours, or the contest is voided.

### 3.5 Voting & Attribution

These are two independent mechanics that run in parallel on every contest.

#### Voting (determines the winner)

- A user gets **1 free vote every 12 hours**. The free vote resets at the 12-hour mark and does not accumulate — if unused, it does not carry over.
- A user can also cast a **paid vote** (spends credits) instead of using the free vote.
- A vote can only be cast for **one entry per contest**. Voting for both entries in the same contest is not allowed.
- A user cannot vote for their own entry.
- **Vote switching**: while the contest is live, a user can change which entry they voted for. The original vote is removed. If it was a free vote, the free vote is returned. If it was a paid vote, the credits are refunded. The user can then re-cast on the other entry.
- Adds to the entry's **vote count** only. Does not affect attribution.

#### Attribution (determines payout and voter ranking)

- Separate from voting. A user can contribute credits to **either or both entries** in the same contest — this does not conflict with the one-vote rule.
- A user cannot attribute credits to their own entry.
- Contribution amount is set via a **slider or input field** at the time of contributing. The UI shows the user's real-time rank among contributors for that entry as they adjust the amount, based on what others have already contributed. Credit balance is always visible for awareness.
- **Contributions are mutable while the contest is live**: the user can increase, decrease, or fully withdraw their contribution at any time. A full withdrawal returns the credits to the user's balance. Changes are locked in when the contest closes.
- Adds to the entry's **attribution total** and determines position in the **voter ranking list** (shown under each entry, sorted by contribution amount, highest first).
- Free votes carry no attribution value.
- **Cash-out minimum:** a contestant must have at least **100 credits ($20)** in attribution earnings before requesting a cash-out.

**Contest UI — two parallel stats:**
Each entry in a contest displays two independent metrics:
1. **Vote count bar** — total votes received (free + paid), determines the winner
2. **Attribution bar** — total credit value contributed by voters, determines payout and Apron tier

A contestant can win by vote count but be outpaced on attribution by their opponent — both metrics are visible and meaningful. The voter ranking list sits under each entry's attribution bar, sorted by contributor amount highest first.

**Attribution in tie-breaker chains (tournament contests only):**
Attribution is only open during the **original contest window**. If the original contest ends in a tie and enters the replay chain, attribution locks immediately — no new contributions are accepted during any replay. Replays are vote-only. Attribution pays out (75/25) when the chain **fully resolves**, whether by a replay producing a winner or by sudden death. This prevents contestants from colluding to manufacture ties and farm multiple attribution payout windows.

### 3.6 Contest Winner

The entry with the most votes at the end of the voting window wins. The metric is **total votes** — this applies to both standalone contests and tournament matchups.

#### Tie-breaker chain (tournament contests only)

If a standalone contest ends in a tie, the result stands as equality — no replay.

If a tournament contest ends in a tie, the following chain applies. Each replay halves the previous voting window:

| Round | Window |
|-------|:------:|
| Original contest | 72h |
| Replay 1 | 36h |
| Replay 2 | 18h |
| Replay 3 | 9h |
| Sudden Death | Organizer decides — final |

If all three replays end in a tie, the organizer picks the winner. No further voting. This decision is final and cannot be appealed.

### 3.7 Contest Aprons

Aprons are trophies awarded at contest close based on margin of victory. They apply to both standalone contests and tournament contests. They are distinct from the tournament placement prizes (Section 4.5).

#### Eligibility floor

The winner must reach **5,000 votes** to be eligible for any Apron. If the winner has fewer than 5,000 votes, no Apron is awarded regardless of the gap.

#### Tier thresholds

Gap percentage is calculated as: `(winner_votes - loser_votes) / loser_votes`

| Apron | Gap required | Example (loser = 5,000) |
|-------|:-----------:|:-----------------------:|
| Flannel | ≥ 49% | winner needs 7,450 votes |
| Denim | ≥ 68% | winner needs 8,400 votes |
| Velvet | ≥ 110% | winner needs 10,500 votes |

**Special case:** if winner ≥ 5,000 votes and loser < 5,000, winner earns a **Flannel** automatically (loser never cleared the floor).

If winner ≥ 5,000 but the gap falls below 49%, no Apron is awarded.

Only the highest qualifying tier is awarded — a 110% gap earns Velvet only, not all three.

#### Apron value & collection

Each Apron has an internal dollar value. Aprons are not paid out individually — payouts are triggered by collecting a minimum number per tier.

| Apron | Value each | Min. to cash out | Min. payout |
|-------|:----------:|:----------------:|:-----------:|
| Flannel | $10 | 5 | $50 |
| Denim | $20 | 10 | $200 |
| Velvet | $50 | 20 | $1,000 |

Each tier is an independent collection track. Tiers cannot be mixed toward a payout threshold.

#### Apron record

- **Lifetime total**: all Aprons ever won remain permanently on the user's profile as a historical record. Cashing out does not remove them from the total count.
- **Eligible balance**: `total won − already paid out`. This is what the platform uses to determine payout eligibility.

#### Forced monthly payout

The platform runs a monthly settlement. Any user whose eligible balance for a given tier meets or exceeds the minimum threshold is **automatically paid out** — no user action required. This caps the platform's accumulating liability.

If a user's eligible balance is below the minimum at month end, it carries over to the next month unchanged.

---

## 4. Tournaments

A tournament is an admin-created collection of contests where all participants compete against each other in a round-robin format with an elimination threshold.

### 4.1 Creation & Scheduling

Any registered user with **`idVerified: true`** can create a tournament. The organizer must also **commit the prize funds upfront** before the tournament goes live. The platform holds those funds until winners are determined. Admin-created tournaments are platform-funded.

The organizer sets the maximum number of participants and the prize structure (amounts per place).

**The organizer cannot participate as a contestant in their own tournament.** They organize and vote — they do not submit an entry.

**Lifecycle:**

```
open → cooldown → active → closed
```

| Status | Condition |
|---|---|
| `open` | Tournament announced. Users submit entries for organizer review. Entry window closes after 72 hours or when max capacity of **approved** entries is reached. |
| `cooldown` | Entry window closed. **3-hour** buffer before rounds begin. |
| `active` | All round-robin contests start simultaneously. Voting is live. |
| `closed` | All contests resolved. Winners and prizes determined. |

**Entry approval during `open` phase:**
Submitted entries are not automatically accepted. The organizer reviews each submission and approves or rejects it. Only approved entries participate in the tournament. The organizer is notified when a new entry is submitted for review.

Entry `approvalStatus` values:
- `pending` — submitted, awaiting organizer review
- `approved` — organizer approved, entry is locked into the tournament
- `rejected` — organizer rejected, user is notified and can resubmit or choose another tournament
- `timed_out` — organizer did not respond within **30 minutes**. Treated as a rejection for the submitting user — they return to `pending_submission` and can try again.

**Organizer accountability:**
Each `timed_out` entry increments the tournament's `missedReviews` counter. If the organizer accumulates **3 missed reviews**, the tournament is **immediately canceled**. There is no refund of committed funds. All users with `pending_approval` entries in the canceled tournament are returned to `pending_submission` and notified to choose another tournament.

Once an entry is approved, it is locked and cannot be changed.

### 4.2 Structure — Round-Robin with Elimination

Every entry competes against every other entry. All matchups start simultaneously when the tournament goes active. There is no fixed bracket — matchups are generated from the full confirmed participant list.

For N participants, there are `N × (N - 1) / 2` total matchups.

### 4.3 Elimination Rule

After every contest closes, the elimination threshold is checked for each entry involved.

**Rule:** An entry must win at least **66%** of its completed contests to remain in the tournament.

**Threshold calculation:** `floor(contests_played × 0.66)`

If an entry's win count falls below this threshold, it is immediately marked as eliminated.

**Examples:**

| Contests played | Required wins (floor) | Eliminated if wins ≤ |
|---|---|---|
| 1 | 0 | — (can't be eliminated on first) |
| 2 | 1 | 0 |
| 3 | 1 | 0 |
| 4 | 2 | 1 |
| 5 | 3 | 2 |
| 6 | 3 | 2 |
| 10 | 6 | 5 |

The floor function is intentionally forgiving in early rounds and tightens as the tournament progresses.

### 4.4 Winner Determination

The tournament winner is the entry with the **highest total votes accumulated across all its contests**. This is the primary metric — not win/loss record, not elimination standing, but raw vote count across the tournament.

2nd and 3rd place follow the same metric: 2nd highest total votes, 3rd highest.

If two entries are tied for the same podium position, the organizer decides via **sudden death** — their call is final.

### 4.5 Prizes

Three prizes are awarded at tournament close:

| Place | Prize | Value |
|---|---|---|
| 1st | Golden Apron | $1,000 |
| 2nd | Silver Apron | $400 |
| 3rd | Red Apron | $100 |

---

## 5. Contestant Payouts & Credits _(designed; implementation deferred — supersedes the old "Vote Economics" model)_

**Correction to the prior design:** the platform does not pay voters. Votes have monetary value, but that value is paid to the **contestant** (the entry owner being voted for), not the person casting the vote. This applies uniformly — standalone contests and tournament contests are treated the same way.

**Funding mechanism — credits:**

- Credits are the platform's internal currency, purchased with real money via the payment processor (see Section 9).
- **Exchange rate: 1 credit = $0.20 (i.e. $1 = 5 credits).** This rate is set at platform discretion and subject to adjustment.
- Ratings remain free. Credits are spent on **paid votes** and **attribution contributions** (see Section 3.5).
- Funding contestant payouts from purchased credits bounds total payout exposure: the platform can never owe more than what voters have actually paid in.

**Credit packages:**

| Pack | Credits | Notes |
|-----:|:-------:|-------|
| $20 | 100 | Minimum purchase |
| $50 | 250 | — |
| $100 | 500 | — |
| Custom | 100–2,500 | $20 min / $500 max |

**Split:** at contest close, attribution credits received by an entry are split **75% to the contestant, 25% to the platform**.

**Relationship to tournament prizes (Section 4.5):** unchanged and additive. The organizer's upfront prize-fund commitment covers only the fixed 1st/2nd/3rd placement prizes (Golden/Silver/Red Apron). It does not need to cover per-vote contestant payouts — those are funded by credit spend, not by the organizer or platform.

**All financial system decisions are locked** (as of June 17). See Section 9 for remaining open items (CCBill ToS verification, credit schema modeling).

---

## 6. Users & Access

| Role | Capabilities |
|---|---|
| Anonymous | No access — redirected to signup. There is no read-only browsing mode. |
| Registered | Full platform access immediately after signup: browse, rate entries, comment, follow, message, vote in contests, nominate others. Submitting an entry or creating a user-organized tournament additionally requires ID verification (see below). |
| Admin | All of the above + create platform-funded tournaments, approve user-organized tournaments |

"Organizer" is not a role — it is a label applied contextually to the creator of a specific tournament. A registered user becomes the organizer of any tournament they create, and their votes in that tournament are worth $0.01 instead of $0.001.

### No Onboarding Gate — Access Is Immediate

A new user gets full platform access the moment their account is created (after the inline email OTP step during signup — see below). There is no mandatory sequence of steps blocking access, and no admin review queue standing between signup and using the platform.

This is a deliberate choice: ID verification collects PII (selfie + government ID), and review work doesn't scale to "every signup" without dedicated staff. Big platforms scope identity verification to users with real creator/monetization intent, not casual viewers — ATA follows the same pattern. A user can browse, rate, comment, vote, and even receive contest nominations without ever verifying their identity. The verification gate only appears at the point where it matters: submitting an entry.

**Post-signup gate:**

| Requirement | When required | How |
|---|---|---|
| Email confirmation | During signup — before account is created | OTP sent via **Resend** to the provided email. User enters OTP on the signup page. Account is only created once OTP is verified. |

Email confirmation is synchronous and inline — it is a step within the signup form, not a post-signup async flow. `emailConfirmed` will always be `true` by the time an account exists.

**ID Verification — Scoped to Submission, Not Onboarding**

ID verification is not part of account creation. It is only triggered when a registered user attempts to submit an entry (or create a user-organized tournament) without `idVerified: true` — they're redirected to the verification flow at that point, not before. The flow:

1. Generate an 8-character verification code.
2. Upload a selfie with the code visibly held (5-minute window before code expires).
3. Upload a government-issued ID document (passport, driver's license, or national ID).
4. Submission sets `idVerificationStatus: 'pending'`. An admin reviews manually and sets `idVerified: true`, which advances the user to `pending_submission`.

Abuse prevention: each code generation increments `idVerifyFailedAttempts`. After 3 failed attempts, the account is temporarily blocked for 2 hours (`idVerifyBlockedUntil`).

`idVerified: true` is also a prerequisite for creating a user-organized tournament (see Section 4.1).

---

## 7. Universal Constraints

These apply across the entire platform, regardless of system:

- Anonymous users cannot access any platform page — redirected to signup
- Registered users have full platform access immediately — no onboarding confinement
- A user cannot rate or vote for their own entry, anywhere
- A user cannot rate the same entry more than once
- A user cannot vote in the same contest more than once

---

## 8. Data Model (MongoDB)

**Embed vs. reference decisions:**
- **Embed** when data is small, bounded, and always accessed with its parent.
- **Reference** (separate collection) when data is large, unbounded, or queried independently.

---

### Collection: `users`

```js
{
  _id: ObjectId,
  username: String,              // unique index
  email: String,                 // unique index
  passwordHash: String,
  displayName: String,
  bio: String,
  avatar: String,                // path to uploaded avatar file
  banner: String,                // path to uploaded banner file

  // Profile attributes
  sex: String,                   // 'male' | 'female' | 'other' | 'prefer-not-to-say'
  orientation: String,
  location: String,
  url: String,
  birthdate: Date,

  // Account status
  accountStatus: String,         // 'active' | 'invited' | 'banned'
  role: String,                  // 'user' | 'admin'
  emailConfirmed: Boolean,       // always true post-signup — OTP verified inline during registration via Resend

  // Identity verification
  idVerified: Boolean,           // default: false — required to create a tournament
  idVerificationStatus: String,  // 'none' | 'pending'
  idSelfieUrl: String,           // path to uploaded selfie file
  idDocUrl: String,              // path to uploaded government ID file
  idVerificationCode: String,    // 8-char code user holds in selfie
  idVerifyFailedAttempts: Number, // default: 0 — incremented each time a code is generated
  idVerifyBlockedUntil: Date,    // set to +2h after 3 failed attempts; null when not blocked

  wallet: {
    balanceCents: Number,        // default: 0 — accumulated payouts from votes received as a contestant (see Section 5)
    updatedAt: Date
  },
  // creditBalance / credit ledger — not yet modeled (see Section 5 open questions)

  createdAt: Date,
  updatedAt: Date
}
```

**Indexes:** `email` (unique), `username` (unique)

`wallet` is embedded — it is always fetched alongside the user and is a 1-to-1 relationship.

`accountStatus` only gates banned/invited accounts (see `requireAuth`). It is not used to confine new users — registration grants full access immediately. `idVerified` is the only gate, and it only applies at the point of entry submission or tournament creation.

---

### Collection: `entries`

```js
{
  _id: ObjectId,
  userId: ObjectId,      // ref: users
  mediaUrl: String,
  mediaType: String,     // 'photo' | 'video'
  caption: String,       // optional
  tags: [String],        // max 6 — owner-only, editable at any time
  ratingCount: Number,   // default: 0 — denormalized, updated on each new rating
  ratingAvg: Number,     // default: 0 — denormalized, updated on each new rating
  allowTakeOns: Boolean, // default: false — toggle visible only once entry has contest history; persists after contests close
  createdAt: Date
}
```

**Indexes:** `userId`

`ratingCount` and `ratingAvg` are stored on the entry for fast display without aggregating the `ratings` collection on every page load.

---

### Collection: `ratings`

```js
{
  _id: ObjectId,
  entryId: ObjectId,   // ref: entries
  userId: ObjectId,    // ref: users — the rater
  score: Number,       // 1–10
  createdAt: Date
}
```

**Indexes:** `{ entryId, userId }` unique — enforces no duplicate ratings per user per entry

Application enforces: `userId` must not equal `entry.userId` (no self-rating).

---

### Collection: `comments`

```js
{
  _id: ObjectId,
  entryId: ObjectId,    // ref: entries
  userId: ObjectId,     // ref: users — commenter
  parentId: ObjectId,   // ref: comments — null if top-level; set if reply (one level only)
  body: String,
  hidden: Boolean,      // default: false — entry owner can hide
  createdAt: Date
}
```

**Indexes:** `entryId`, `parentId`

Application enforces: `parentId` must reference a top-level comment (no chaining replies).

---

### Collection: `comment_reports`

```js
{
  _id: ObjectId,
  commentId: ObjectId,   // ref: comments
  reportedBy: ObjectId,  // ref: users
  createdAt: Date
}
```

**Indexes:** `{ commentId, reportedBy }` unique — one report per user per comment

---

### Collection: `contests`

```js
{
  _id: ObjectId,
  createdBy: ObjectId,          // ref: users
  visibility: String,           // 'public' | 'private'
  status: String,               // 'pending' | 'active' | 'void' | 'closed'
  tournamentId: ObjectId,       // ref: tournaments — null if standalone
  parentContestId: ObjectId,    // ref: contests — null unless tie-breaker replay
  windowHours: Number,          // default: 72 — halved on each replay
  voidDeadline: Date,           // createdAt + 24h
  votingDeadline: Date,         // 2nd entry submittedAt + windowHours
  winnerEntryId: ObjectId,      // ref: entries — null until closed

  // Embedded — always exactly 2, small, always loaded with the contest
  entries: [
    {
      entryId: ObjectId,   // ref: entries
      userId: ObjectId,    // ref: users — denormalized for ownership checks
      submittedAt: Date
    }
  ],

  // Embedded — private contests only, min 5, bounded list of user refs
  designatedVoters: [ObjectId],  // ref: users

  createdAt: Date
}
```

**Indexes:** `tournamentId`, `status`, `voidDeadline`, `votingDeadline`

Rules enforced at application level:
- Contests with a `tournamentId` cannot have `visibility: 'private'`
- `designatedVoters` must have at least 5 entries for private contests
- `parentContestId` is only set on tie-breaker replay contests

---

### Collection: `contest_votes`

```js
{
  _id: ObjectId,
  contestId: ObjectId,   // ref: contests
  entryId: ObjectId,     // ref: entries — the entry voted for, and the payout recipient (see Section 5)
  userId: ObjectId,      // ref: users — the voter, spends credits to cast this vote
  valueCents: Number,    // amount paid out to the voted entry's owner at cast time — exceptions/exact split TBD, see Section 5
  createdAt: Date
}
```

**Indexes:** `{ contestId, userId }` unique — enforces one vote per user per contest

Application enforces: voter's `userId` must not equal the voted entry's `userId`.

---

### Collection: `nominations`

```js
{
  _id: ObjectId,
  contestId: ObjectId,     // ref: contests
  nominatorId: ObjectId,   // ref: users — who nominated
  nomineeId: ObjectId,     // ref: users — who was nominated
  message: String,         // optional — viewer-added context
  expiresAt: Date,         // createdAt + 24h
  status: String,          // 'pending' | 'accepted' | 'void'
  createdAt: Date
}
```

**Indexes:** `contestId`, `nomineeId`, `expiresAt`

A viewer nomination creates 2 documents sharing the same `contestId` (one per nominee). A creator challenge creates 1 document (opponent only).

---

### Collection: `tournaments`

```js
{
  _id: ObjectId,
  createdBy: ObjectId,           // ref: users
  type: String,                  // 'platform' | 'user_organized'
  name: String,
  description: String,           // optional

  participantCount: Number,      // max participants

  // Time config (hours)
  entryWindowHours: Number,      // default: 72
  cooldownHours: Number,         // default: 3
  roundWindowHours: Number,      // default: 72

  // Computed deadlines
  entryDeadline: Date,           // createdAt + entryWindowHours
  roundsStartAt: Date,           // entryDeadline + cooldownHours

  // Embedded — always exactly 3 prizes, static once set
  prizes: {
    first:  { amountCents: Number, entryId: ObjectId },  // entryId null until awarded
    second: { amountCents: Number, entryId: ObjectId },
    third:  { amountCents: Number, entryId: ObjectId }
  },

  fundsHeld: Boolean,       // default: false — true once payment confirmed
  reviewStatus: String,     // 'pending_review' | 'approved' | 'rejected' — user_organized only
  missedReviews: Number,    // default: 0 — increments on each timed_out entry. At 3 → tournament canceled, no refund
  status: String,           // 'pending_funds' | 'pending_review' | 'open' | 'cooldown' | 'active' | 'closed' | 'canceled'
  createdAt: Date
}
```

**Indexes:** `status`, `createdBy`

User-organized lifecycle: `pending_funds` → `pending_review` → `open` → `cooldown` → `active` → `closed`

Platform lifecycle: starts directly at `open`.

---

### Collection: `tournament_entries`

```js
{
  _id: ObjectId,
  tournamentId: ObjectId,      // ref: tournaments
  entryId: ObjectId,           // ref: entries
  userId: ObjectId,            // ref: users — denormalized for quick lookup
  approvalStatus: String,      // 'pending' | 'approved' | 'rejected' | 'timed_out'
  wins: Number,                // default: 0 — only relevant once approved and tournament is active
  losses: Number,              // default: 0
  totalVotes: Number,          // default: 0 — accumulated across all tournament contests — primary ranking metric
  eliminated: Boolean,         // default: false
  submittedAt: Date,
  reviewedAt: Date             // nullable — set when organizer approves or rejects
}
```

**Indexes:** `{ tournamentId, entryId }` unique, `{ tournamentId, approvalStatus }`

Only entries with `approvalStatus: 'approved'` participate in the tournament rounds.

Elimination check runs after every contest closes:
`if wins < Math.floor((wins + losses) * 0.66) → eliminated = true`

`totalVotes` is updated whenever a contest involving this entry closes. Winner = highest `totalVotes` among non-eliminated entries.

---

### ~~Collection: `ratings_challenges`~~ _(removed — Ratings Challenge mechanic replaced by 3-replay chain, see Section 3.6)_

```js
{
  _id: ObjectId,
  contestId: ObjectId,   // ref: contests — the tied contest this resolves
  windowHours: Number,   // from tournament's ratingsChallengeHours
  deadline: Date,        // createdAt + windowHours
  status: String,        // 'active' | 'closed'
  winnerUserId: ObjectId, // ref: users — null until closed

  // Embedded — max 6 entries (3 per contestant × 2 contestants), small, always loaded together
  entries: [
    {
      entryId: ObjectId,    // ref: entries
      userId: ObjectId,     // ref: users — which contestant submitted it
      submittedAt: Date
    }
  ],

  createdAt: Date
}
```

Max 3 embedded entries per `userId` enforced at application level.

---

### ~~Collection: `ratings_challenge_votes`~~ _(removed — see above)_

```js
{
  _id: ObjectId,
  challengeId: ObjectId,   // ref: ratings_challenges
  entryId: ObjectId,       // ref: entries — entry being rated
  userId: ObjectId,        // ref: users — rater
  score: Number,           // 1–10
  createdAt: Date
}
```

**Indexes:** `{ challengeId, entryId, userId }` unique — no duplicate ratings

Application enforces: `userId` must not equal the submitting contestant's `userId` for that entry (no self-rating).

---

---

## 9. Announcements

Announcements are platform communications created by superadmins only. They are used to promote deals, upcoming contests, platform news, or to target specific user segments with relevant messaging.

### 9.1 Creation

A superadmin creates an announcement using a reusable template containing:
- **Title**
- **Description**
- **Thumbnail / cover image**
- **Redirect link** (optional — where the user goes on click)
- **Audience filters** (see below)
- **Status:** `draft` | `active` | `expired`
- **publishedAt**, **expiresAt**

### 9.2 Audience Filters

Filters are applied at load time against `req.currentUser`. Combinable — a superadmin can stack multiple filters. Non-exhaustive list:

- Location
- Follower count (min / max)
- Aprons collected (tier and/or quantity)
- Declared sex
- Age gate (minimum age derived from `birthdate`)
- Sexual orientation
- Has participated in at least one contest
- Has participated in at least one tournament

### 9.3 Delivery — Pull at Load Time

Announcements are not pushed to user queues at publish time. Instead, on each page load the panel queries all active, non-expired announcements and evaluates their filters against the current user in memory. Announcements the user has already dismissed are excluded via the `announcement_dismissals` table.

One announcement is shown at a time. If the user has multiple matching announcements queued, dismissing the current one surfaces the next.

### 9.4 Data Model

**Collection: `announcements`**

```js
{
  _id: ObjectId,
  createdBy: ObjectId,       // ref: users — superadmin only
  title: String,
  description: String,
  thumbnailUrl: String,
  redirectUrl: String,       // optional
  filters: {
    location: String,                  // optional
    followerCountMin: Number,          // optional
    followerCountMax: Number,          // optional
    apronTier: String,                 // 'flannel' | 'denim' | 'velvet' — optional
    apronCountMin: Number,             // optional
    sex: String,                       // optional
    ageMin: Number,                    // optional
    orientation: String,               // optional
    hasContestHistory: Boolean,        // optional
    hasTournamentHistory: Boolean,     // optional
  },
  status: String,            // 'draft' | 'active' | 'expired'
  publishedAt: Date,
  expiresAt: Date,           // optional — null means no expiry
  createdAt: Date
}
```

**Collection: `announcement_dismissals`**

```js
{
  _id: ObjectId,
  announcementId: ObjectId,  // ref: announcements
  userId: ObjectId,          // ref: users
  dismissedAt: Date
}
```

**Indexes:** `{ announcementId, userId }` unique on `announcement_dismissals`; `status` + `expiresAt` on `announcements`

---

## 10. Right Panel

The right panel is a persistent sidebar visible on all platform pages (xl+ screens). It is not a feed — it is a contextual utility column. Sections are ordered by platform priority, top to bottom.

### 10.1 Section Order

| # | Section | Status |
|---|---|---|
| 1 | Ongoing Tournaments | Skeleton until July — tournaments not yet built |
| 2 | Announcements | Pull at load time — see Section 9 |
| 3 | People to Follow | Algorithmic suggestions |

### 10.2 Ongoing Tournaments

Shows active tournament cards with a cover badge and tournament title. Limited to 3–5 at a time. Links to the tournament page. Skeleton state until the tournament system is built (July scope).

### 10.3 Announcements

Pulls active announcements matching the current user's profile (see Section 9.3). One shown at a time. Dismissable — next queued announcement surfaces on dismiss.

### 10.4 People to Follow

Algorithmic suggestions based on global platform signals:
- Follower count
- Aprons won (tier and total count)
- Entry submission volume combined with rating rank

Shows users the current user does not already follow. Excludes the current user themselves.

---

## 11. Open Questions

- **Payment processor:** CCBill selected as first option. Epoch does not support US-based businesses. Verify CCBill's current ToS covers the platform's content category and escrow/payout requirements before integrating. Now also the processor for credit purchases (Section 5), which pulls payment integration earlier than originally planned.
- **Follow system:** A `follows` collection exists in the data model (follower/followee user relationships) but the feature is not yet documented. Scope, UI surface, and notification behavior TBD.
- **Credits & contestant payouts (Section 5):** fully locked — exchange rate (1 credit = $0.20), 75/25 split, bundle pricing ($20/$50/$100/custom up to $500), attribution locked to original contest window only, all votes equal regardless of voter role.
- **Apron payout funding source (Section 3.7):** funded from general platform resources — primarily the 25% cut from credit attribution spend, supplemented by sponsors or available reserves as needed. The collection thresholds (5/10/20) are intentionally designed to defer large payout events, giving the platform time to accumulate revenue before significant obligations come due.

## 12. Post-MVP: Open Challenges

An open challenge is created when the creator **does not self-nominate** — they are the organizer, not a contestant. The challenge is open for any registered user to submit an entry.

Conversion rules based on how many users accept:

- If acceptors total 2 → treated as a standard standalone contest between those two users. The creator remains organizer only, not a contestant.
- If a third user accepts → the contest is **automatically converted into a user-organized tournament**.

**Conversion rules:**
- The original creator becomes the tournament organizer and **cannot participate as a contestant**.
- Creator must commit prize funds during the **3-hour cooldown period** that begins at conversion. If funds are not committed before cooldown ends, the tournament is voided and all participants are notified.
- The tournament then follows the standard user-organized lifecycle: `pending_funds → pending_review → open → cooldown → active → closed`.
- **ID verification is required** before a user can launch an open challenge. No exceptions.

This feature is post-MVP and will be revisited once the standard tournament flow is stable.
