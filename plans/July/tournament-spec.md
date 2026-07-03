# Tournament Spec — All Things Aprons

## Overview

Tournaments are a structured competition format built on top of H2H contests. A tournament consists of a **group stage** (round-robin within groups) followed by a **knockout stage** (single elimination). The format mirrors soccer's World Cup structure.

---

## Valid Participant Counts

Only these five sizes are supported. Each produces clean group divisions and a power-of-2 knockout bracket with no byes.

| Players | Group size | Groups | Group matches | Knockout teams | Knockout matches | Total matches |
|---|---|---|---|---|---|---|
| 4 | 4 | 1 | 6 | 2 | 1 | 7 |
| 8 | 4 | 2 | 12 | 4 | 4 | 16 |
| 12 | 3 | 4 | 12 | 8 | 8 | 20 |
| 16 | 4 | 4 | 24 | 8 | 8 | 32 |
| 24 | 3 | 8 | 24 | 16 | 16 | 40 |

---

## Lifecycle

```
Creation → Open (3 days) → Cooldown (24h) → Active → Closed
```

### Creation
- Organizer sets: thumbnail (required), tournament name (unique, 3–60 chars, letters/numbers/spaces only), description (optional, ≤220 chars), participant cap (one of the 5 valid sizes), open-phase length (1–3 days), visibility (public or private — see "Private Tournaments" below for the lightweight version shipped now), eligibility criteria, jury members, prize pool
- Organizer deposits full prize pool in CHL at creation time
- Tournament is not visible to candidates until after creation is complete
- Creation is a 4-step form with session-persisted drafts — an incomplete draft can be saved at any step and resumed later from `/tournaments` (Draft tab)

### Open Phase
- Candidates submit their entry for review
- Duration: always runs the full organizer-set length (1–3 days) — does not end early when the participant cap fills, since the organizer may still reject some candidates during Cooldown review and others deserve the full window to apply
- Minimum candidates required: the organizer's chosen participant cap (4, 8, 12, 16, or 24) — group/knockout math needs the exact count, no byes allowed
- If fewer candidates have submitted than the chosen cap by the end of the open phase → tournament auto-cancelled, CHL refunded (this check is on raw submissions, since nothing has been approved/rejected yet)

### Cooldown Phase
- Duration: 24 hours
- Organizer approves or rejects pending candidates
- Organizer must approve exactly the cap number of candidates — no byes, so the group/knockout bracket needs the exact count
- Group assignments and match schedule auto-generate once all candidates are reviewed and the cap is met
- Organizer can launch early if review is complete before 24h
- If organizer fails to complete review within 24h → tournament auto-cancelled, CHL refunded
- If organizer realizes they can't approve enough candidates to hit the cap (e.g. too many had to be rejected), they can choose to cancel the tournament themselves — also refunded

### Active Phase
- Group stage runs first; all group matches can run in parallel across groups
- Knockout stage begins once all group stage matches are closed and standings finalized
- Each H2H contest has a 24h voting window

### Closed
- Final match completed
- Prizes distributed automatically to winners' `earnedCHL` (AAC pool)
- Tournament locked as read-only

---

## Organizer

### Who Can Create a Tournament
- `idVerified: true`
- No active bans
- No active reports
- More than 250 followers
- Has contributed in at least 5 contests
- Fewer than 3 concurrent tournaments (`open`/`cooldown`/`active`) — implemented in `middleware/requireOrganizerEligibility.js`

### Organizer Rules
- Single organizer per tournament — no co-organizers
- Cannot compete as a contestant in their own tournament
- Selects all jury members at creation time
- Can cast a tie-breaking vote if the jury fails to reach quorum (see Tie Resolution)

---

## Contestants

### Eligibility
- Must be `idVerified: true` (platform-enforced, always required)
- Must meet any additional organizer-defined criteria (optional). Criteria options:
  - Rating average (min threshold)
  - Number of ratings backing the avg
  - Number of followers
  - Age
  - Sex
  - Number of entries
  - Account age
  - Any combination of the above

### Entry
- Each contestant submits one entry during the open phase
- That single entry represents them in every H2H contest throughout the tournament
- No entry fee

### Forfeits & Inactivity
- Ghosting mid-tournament is not a problem — the entry is already submitted and matches run without contestant interaction
- Account ban or account deletion mid-tournament = forfeit
- Forfeit counts as a loss for the forfeited player; opponent auto-advances

---

## Group Stage

### Format
Round-robin within each group. Every player plays every other player in their group exactly once.

### Scoring
- Win = 1 point
- Loss = 0 points

### Advancement
Top 2 players from each group advance to the knockout stage.

### Group Stage Ranking Tiebreaker Chain
Applied when two or more players in a group are tied on points:

1. **Rating average** — entry with higher avg rating ranks higher
2. **Number of raters** — entry backed by more raters ranks higher
3. **Total votes received** — votes accumulated across all group stage H2Hs
4. **Jury vote** — jury members vote to decide placement
5. **Coin flip** — platform random pick

### Two-Player Tie for 2nd Place
If two players are tied for 2nd place, they play an additional H2H contest. **Both still qualify for the knockout stage** — the result of the extra match determines their seeding only.

### Three-Way Tie
Uses the same tiebreaker chain above (rating avg → raters → votes → jury → coin flip). Since the three players have already played each other, no additional match is run — the chain resolves it statistically.

---

## Knockout Stage

Single elimination. Lose once = eliminated. No second chances.

### Structure (by knockout field size)
| Knockout teams | Rounds |
|---|---|
| 2 | Final only |
| 4 | Semis → 3rd place match → Final |
| 8 | QF → SF → 3rd place match → Final |
| 16 | R16 → QF → SF → 3rd place match → Final |

### 3rd Place Match
Required in all tournaments with 4+ knockout teams, since prizes cover 1st, 2nd, and 3rd place.

### Grand Final
Standard single elimination — lose = eliminated. No bracket reset.

---

## H2H Contests Inside a Tournament

- Each match is a standard H2H contest with a **24h voting window**
- Community votes determine who wins each contest
- Contributions (CHL) are enabled on all tournament H2Hs — viewers can contribute to contestants at any time
- Contributions settle immediately when each H2H closes — no waiting for the tournament to end
- The entry with the most votes wins the H2H

---

## Tie Resolution (H2H Result)

When two entries finish a 24h H2H with equal votes:

1. **Jury vote** — jury has 6 hours to cast votes; 3 votes required (quorum)
2. **Organizer vote** — if jury quorum not met, organizer has 3 hours to cast a deciding vote
3. **Platform coin flip** — if organizer also fails, platform picks randomly

---

## Jury

### Selection & Size
- Organizer selects jury members at tournament creation time
- Minimum 5, maximum 7 jury members

### Rules
- Jury members cannot vote in regular H2H contests during the tournament
- Jury identity is **never revealed** — not to contestants, not to the public, not even after the tournament ends
- Jury members may have real relationships with contestants (follow, contributor, etc.) — anonymity mitigates this
- No compensation — intentional, to avoid influence

### Notifications
- When a jury member votes, the receiving contestant gets an anonymous notification only: "You received 1 jury vote"
- No information about who voted or how others voted is revealed

### Miss Penalty
- A jury member who fails to vote within their 6h window is **permanently barred from serving as a jury member in any future tournament**
- They remain on the current tournament's jury and can still vote in future ties within the same tournament

---

## Prizes

### Minimums (organizer can set higher)
| Place | Minimum |
|---|---|
| 1st | $1,000 |
| 2nd | $400 |
| 3rd | $100 |

### Rules
- Organizer sets custom prize amounts at creation time — minimums above must be met
- 1st > 2nd > 3rd must hold
- Funded entirely from the organizer's `purchasedCHL` (SB — Spending Balance). `earnedCHL` (AAC) cannot be used — it is reserved for cash out only
- Credited to winners' `earnedCHL` (AAC pool) automatically when the tournament closes
- Auto-refunded to organizer's `purchasedCHL` if the tournament is cancelled at any stage

### Inline Funding Flow
During tournament creation, at the prize-setting step:
1. Organizer enters 1st / 2nd / 3rd amounts
2. Platform checks organizer's SB balance against the total
3. If SB is sufficient → creation continues
4. If SB is short → a payment link appears inline for the exact shortfall amount (tournament-gated, available to organizer-eligible accounts only, capped at $500 per transaction)
5. If shortfall exceeds $500 → multiple sequential payment steps are shown in the same flow with a clear count (e.g. "3 payments of $500 required")
6. Once fully funded → creation continues

---

## Group & Match Scheduling

- Group assignments: random draw, auto-generated during cooldown phase
- Match schedule: auto-generated by algorithm during cooldown phase
- Matches within the same group can run in parallel (no player can be in two matches simultaneously — algorithm accounts for this)
- Matches across different groups always run in parallel

---

## Data Model (Reference)

Key collections needed:

| Collection | Purpose |
|---|---|
| `tournaments` | Tournament document: organizer, settings, lifecycle status, jury members (hashed/private), prize pool |
| `tournament_entries` | One per approved contestant: `tournamentId`, `entryId`, `userId`, group assignment |
| `tournament_groups` | Group definitions: `tournamentId`, group label, member list |
| `tournament_matches` | Each scheduled H2H: `tournamentId`, `contestId`, stage (group/knockout), round, participants |
| `tournament_jury` | Jury members: `tournamentId`, `userId` — never exposed via API |
| `tournament_jury_votes` | Tie-breaking votes: `tournamentId`, `matchId`, `jurorId`, vote cast |

---

## Private Tournaments *(Future Version — Not in MVP)*

> This full invite-based feature is fully designed but deferred after the public tournament launch. Do not implement until explicitly prioritized.

> **Note — a lightweight version already shipped (2026-07-03), do not confuse the two.** `Tournament.visibility` (`'public' | 'private'`, default `'public'`) exists now, set via a toggle on Step 1 of creation. A private tournament today is simply excluded from the `/tournaments` browse listing for everyone except its organizer — it is **not** invite-only (no `tournament_invites` collection, no nomination/link invite flow, no size cap of 12, no permanent-results-privacy behavior), and self-submission during the `open` phase still works exactly as on a public tournament. Anyone who finds/guesses the direct URL can currently view and join it. The full invite-gated design below (slots, `tournament_invites`, unguessable IDs, permanent result privacy) remains unbuilt and deferred.

### What It Is

A private tournament is invite-only and entirely hidden from public discovery. Only people the organizer explicitly invites can participate. The results are permanently private — the tournament is never surfaced publicly — but prize placements (1st / 2nd / 3rd) still appear on winners' profiles regardless of tournament privacy.

---

### How It Differs From Public Tournaments

| Aspect | Public | Private |
|---|---|---|
| Browse page (`/tournaments`) | Visible | Not listed |
| Search | Appears in results | Never appears |
| Direct link | Anyone can view | Accessible only to invited users |
| Join method | Self-submit during `open` phase | Invitation only (nomination or invite link) |
| Max size | 4, 8, 12, 16, or 24 | 4, 8, or 12 only |
| Results page | Public after close | Permanently private |
| Prize placements on profiles | Yes | Yes — prizes always show, regardless of tournament privacy |
| Review step | Mandatory | Mandatory — link may reach unintended recipients |

---

### Invitation Methods

The organizer can invite participants in two ways — both can be used for the same tournament:

**1. Nomination (by username)**
- Organizer searches for a user by username and sends a direct nomination
- Can be sent at creation time or any time during the `open` phase
- Recipient gets a `tournament_nomination` notification with accept/decline options

**2. Invite Link**
- Organizer generates a unique tokenized link (e.g. `/tournament/invite/:token`)
- Organizer shares the link externally (DM, external chat, etc.)
- Visiting the link shows an invitation screen — accept or decline
- The link does not reveal any tournament content before acceptance
- The organizer can revoke a link token at any time

**Decline behavior:** An invited user who declines frees their slot. The organizer can re-invite someone else to fill it. The slot stays open until the tournament's `open` phase ends.

**Accepted users still submit their own entry** — acceptance is agreement to participate, not automatic enrollment. The contestant picks which of their entries to submit, exactly as in a public tournament.

---

### Participant Slot Management

- If an accepted user never submits during the `open` window, their slot stays open
- Organizer can rescind an accepted invitation and invite a replacement at any time before the slot is filled (i.e., before an entry is submitted)
- Once an entry is submitted, the slot is filled and cannot be reassigned

---

### Visibility Rules

- The tournament URL itself is not guessable (uses a private UUID-style ID or a separate slug)
- Unauthenticated users hitting a private tournament URL see a generic "not found" page — same as 404, no information leaked
- Authenticated users who were not invited also see a 404-equivalent
- Only invited (and accepted) users can see the tournament detail page
- The organizer always has full access

---

### Results & Privacy After Close

- The tournament results page is never made public — even after closing
- Only participants and the organizer can view results
- **Exception:** prize placements always show on each winner's public profile (same as public tournaments) — 1st / 2nd / 3rd appear on the profile trophy/prize section regardless of the tournament's privacy setting

---

### Schema Delta (when this is built)

New field on `Tournament`:
```js
visibility: { type: String, enum: ['public', 'private'], default: 'public' }
```

New collection — `tournament_invites`:
```js
{
  tournamentId:  ObjectId,  // ref: tournaments
  userId:        ObjectId,  // ref: users — who was invited (null if link-only, resolved on acceptance)
  invitedBy:     ObjectId,  // ref: users — always the organizer
  method:        String,    // 'nomination' | 'link'
  token:         String,    // unique token for link-based invites (indexed)
  status:        String,    // 'pending' | 'accepted' | 'declined' | 'revoked'
  sentAt:        Date,
  respondedAt:   Date,
}
```

Indexes: `{ tournamentId, userId }` unique on nominations; `{ token }` unique for link tokens.

New notification types:
| Type | Trigger | Recipient |
|---|---|---|
| `tournament_nomination` | Organizer nominates a user | Invitee |
| `tournament_invite_accepted` | Invitee accepts | Organizer |
| `tournament_invite_declined` | Invitee declines | Organizer |
