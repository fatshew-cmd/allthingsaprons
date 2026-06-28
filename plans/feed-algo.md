# Feed Recommendation Algorithm
**Version 2.0 — June 28, 2026**

---

## Overview

The feed loads 30 entries per page. The split between social (T1) and discovery (T2) is dynamic — T1 fills as many slots as it can, T2 backfills the rest. No T1 cap, no T2 floor. T2 is purely backup on the feed page.

Pagination continues from the same ranked list using the same session preference snapshot — no recompute mid-session. Already-served entry IDs are excluded from subsequent loads.

> Note: hashtags are called **stains** on the platform.

---

## Two-Tier Structure

### T1 — Followed Users
Entries from creators the viewer follows.

The session preferences bucket acts as a **selector**, not a ranker. It filters the pool of followed users' recent entries down to the most relevant ones based on the viewer's current stain affinity. T1 is not a competition between creators — it is about surfacing the right entries from the social graph.

Within the filtered T1 pool, entries are ordered by:
```
recencyDecay + ratingAvg/10 + ratingVelocity
```

Entries the user has already interacted with are excluded.

### T2 — Discovery
Entries from creators the viewer does not follow.

This is where the ranking competition happens. The algo guesses which unknown creators are most likely to resonate with the viewer. T2 is also a pipeline into T1 — consistent positive interactions with a T2 creator builds creator affinity and may eventually lead the user to follow them.

### Cold Start Fallback (User)
New users with no follows and no ratings have empty T1 and no stain affinity to drive T2. Fallback: sort by `ratingAvg` + recency, capped at 2 entries per creator.

---

## Pre-Filters (Applied Before Scoring)

Before the candidate pool is built, hard filters are applied based on the viewer's preferences:

| Filter | Condition | Source |
|---|---|---|
| Mature content | Exclude entries flagged `mature: true` if `user.privacySettings.showMatureContent === false` | User privacy settings |
| AI-generated content | Exclude entries flagged `aiGenerated: true` if `user.privacySettings.showAiContent === false` | User privacy settings |

These are gates, not scoring signals — matching entries are excluded entirely, not just downranked.

---

## Candidate Pool

Before scoring, pull the **150 most recently submitted entries** from the DB, excluding the current user's own entries and entries already served this session:

```js
Entry.find({
  userId: { $ne: currentUserId },
  _id: { $nin: alreadyServedIds }
})
  .sort({ createdAt: -1 })
  .limit(150)
  .lean()
```

150 gives enough headroom to produce 30 well-scored results after T1/T2 splitting and diversity capping. Expand when daily entry volume warrants it.

---

## T2 Scoring Formula

### Base Score (Additive)
```
baseScore = (ratingAvg/10     × 0.35)
          + (stainAffinity    × 0.25)
          + (creatorAffinity  × 0.20)
          + (ratingVelocity   × 0.12)
          + (commentVelocity  × 0.05)
          + (recencyDecay     × 0.03)
```

All weights sum to 1.0. Recency is last intentionally — a genuinely great old entry can still surface if it scores well on the other signals.

`commentVelocity` = `min(log(1 + commentsInLast6Hours) / log(51), 1.0)`. Normalized to [0, 1] — `log(51)` is the divisor so that 50 comments in 6 hours saturates the signal at 1.0. An entry generating active discussion is a signal of engagement worth surfacing, but kept at a low weight so it doesn't override quality signals.

### Boost Multipliers (Applied After Base Score)
```
surgeMultiplier = min(log(1 + currentVelocity / max(historicalBaseline, 1)), 10)

finalScore = baseScore × surgeMultiplier × unratedBoost × entryColdStartBoost × contestBoost
```

`currentVelocity` = combined ratings + comments in the last 24h. `historicalBaseline` = average daily activity over the entry's lifetime excluding the last 24h. A dormant entry suddenly getting traction produces a high surge; a consistently active entry hovers around `log(2) ≈ 0.69`.

| Boost | Value | Purpose |
|---|---|---|
| `unratedBoost` | `1.5` if unrated, `0.8` if already rated | Prioritizes actionable entries; drives the rating loop |
| `entryColdStartBoost` | `1.8` if `ratingCount < 3`, else `1.0` | Guarantees new entries a forced exposure window before they can compete on quality |
| `contestBoost` | `1.2` if in an active H2H, else `1.0` | Small lift for entries currently in a live contest |

> All boost values and weight constants are tunable by founder admins post-launch.

---

## Post-Processing

After scoring, before returning results:
- Cap at **2 entries per creator** — prevents prolific users from monopolizing the feed regardless of score
- Sort descending by `finalScore`, fill T1 slots first, then T2

---

## User's Personal Stain Affinity Profile

Each user has a per-stain affinity score between `0` and `1`. This profile is **personal** — it has no effect on the entry's global score. The two are completely independent.

### Initialization
New stains start at `0`. The user must interact with an entry carrying that stain for it to earn a score.

### Update Formula
```
newAffinity = currentAffinity × (1 - learningRate) + newSignal × learningRate
```
- **learningRate:** `0.3` (default, tunable by founder admins)
- Recent interactions carry more weight than older ones by nature of the formula

### newSignal Values by Interaction Type

| Interaction | newSignal | Notes |
|---|---|---|
| Bookmark | `1.0` | Strongest explicit interest signal |
| Follow creator | `0.8` | Strong implicit creator endorsement — updates creatorScores only |
| Contest vote (for) | `0.9` | Forced comparative choice — updates stain + creator scores for voted entry |
| Contest contribution | `0.6` | Financial backing — strong endorsement of the entry's creator and stains |
| Comment | `0.7` | Active engagement without the explicit endorsement of a bookmark or vote |
| Rating ≥ 7 | `rating/10` | High upward push |
| Contest watch | `0.3` | Sustained interest — fires on both contestants' creatorScores |
| Profile visit | `0.05` | Awareness signal — updates creatorScores only |
| Profile visit via share link | `0.1` | Higher intent than direct visit — not yet wired (share link infrastructure pending) |
| Entry visit | `0.1` | Weak interest signal — updates stain + creator scores |
| Rating 5–6 | neutral | No significant affinity movement |
| Rating < 5 | `rating/10` | Mild downward pressure — not a content block |
| Contest vote (against) | `0.1` | Mild downward nudge on opponent's stain + creator scores |
| Unfollow creator | `0` | Pulls creatorScore down 30% — intentional disinterest signal |
| Take-on | TBD — not yet wired | Signal value undecided; route hook not implemented |

> Rating is the dominant platform signal. A low rating is a quality judgment, not a content penalty — similar entries are not blocked from the feed.

### Interaction Source Multiplier
The same interaction carries different weight depending on where it came from:

| Source | Multiplier |
|---|---|
| Search → interaction | Highest (user actively sought this content) |
| Share link → interaction | High |
| Feed → interaction | Baseline |

### Session Window & Decay
- Decay is **activity-based**, not time-based
- Profile refreshes every **3 cumulative real-world session hours**
- Session resets after **6 hours of inactivity**
- During a session, the preference snapshot is frozen — no mid-session recompute

### Storage
Stored in a dedicated `UserAffinity` collection (not embedded on `User` to avoid bloating every user query). History is append-only — snapshots are never overwritten, preserving a record of how a user's taste evolves:

```js
{
  userId: ObjectId,
  history: [
    {
      timestamp: Date,
      stainScores: {
        "vintage":    0.82,
        "handmade":   0.61,
        "minimalist": 0.20,
      },
      creatorScores: {
        "<userId>": 0.75,
        "<userId>": 0.40,
      },
      source: "session_refresh"
    }
  ]
}
```

### Update Job
Runs at the end of each session window (3 cumulative hours reached, or 6h inactivity resets the session). Only runs for users who had activity since the last snapshot.

**Per active user:**
1. Pull all interactions since last snapshot (ratings, bookmarks, contest votes, visits)
2. Apply `newSignal` values and source multipliers per interaction
3. Run affinity update formula per stain and creator touched
4. Append new snapshot to `UserAffinity.history`

---

## Global Entry Score (Separate from Personal Affinity)

Community-driven signals attached to the entry itself, not any viewer:

| Signal | Description |
|---|---|
| `ratingAvg` | Average rating across all raters |
| `ratingCount` | Total number of ratings |
| `ratingVelocity` | Ratings per unit time (momentum signal) |

These feed into the T2 formula independently of any viewer's personal affinity. A globally low-rated entry can still appear in a viewer's feed if their stain affinity for that entry is high — and vice versa.

---

## Tunable Constants (Founder Admin)

| Parameter | Default | Purpose |
|---|---|---|
| `learningRate` | `0.3` | How fast stain affinity reacts to new interactions |
| T2 base weights (w1–w5) | See formula | Relative importance of each scoring signal |
| `unratedBoost` | `1.5` / `0.8` | Rated vs unrated entry prioritization |
| `entryColdStartBoost` | `1.8` | Exposure window for new entries |
| `contestBoost` | `1.2` | Lift for entries in active H2H |

---

## What Is Out of Scope for Feed

- Heavy discoverability — that is the explore page's job (see `plans/explore-algo.md`)
- Trending / hot content prioritization — explore leads on velocity, feed leads on affinity
- ML inference at runtime — all signals are behavioral and computable from existing data
- Cross-user collaborative signals ("users like you also liked") — post-MVP
