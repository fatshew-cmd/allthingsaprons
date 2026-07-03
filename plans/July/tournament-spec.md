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
- Organizer sets: tournament name, participant cap (one of the 5 valid sizes), eligibility criteria, jury members, prize pool
- Organizer deposits full prize pool in CHL at creation time
- Tournament is not visible to candidates until after creation is complete

### Open Phase
- Candidates submit their entry for review
- Duration: 3 days or until the participant cap is filled — whichever comes first
- Minimum candidates required: 4
- If fewer than 4 candidates after 3 days → tournament cancelled, CHL refunded

### Cooldown Phase
- Duration: 24 hours
- Organizer approves or rejects pending candidates
- Group assignments and match schedule auto-generate once all candidates are reviewed
- Organizer can launch early if review is complete before 24h
- If organizer fails to complete review within 24h → tournament cancelled, CHL refunded

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
