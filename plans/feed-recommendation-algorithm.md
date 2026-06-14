# Feed Recommendation Algorithm
**Version 1.0 — June 13, 2026**

---

## Overview

The Ratings tab feed is personalized per user using a multi-signal scoring formula applied to a candidate pool of recent entries. The algorithm runs entirely in Node at feed load time using pre-computed affinity data — there is no real-time ML inference on the hot path.

---

## Candidate Pool

Pull the **150 most recently submitted entries** from the DB, excluding the current user's own entries:

```js
Entry.find({ userId: { $ne: currentUserId } })
  .sort({ createdAt: -1 })
  .limit(150)
  .lean()
```

150 is enough headroom to produce 20 well-scored results after diversity capping. Expand the pool when daily entry volume makes this insufficient.

---

## Scoring Formula

```
score = freshnessScore
      × followBoost
      × unratedBoost
      × coldStartBoost
      × contestBoost
      × (1 + velocityScore)
      × (1 + tagAffinityBoost)
      × (1 + creatorAffinityBoost)
```

All factors are multiplicative. Each one is described below.

---

### 1. Freshness Score
```
freshnessScore = 1 / (hoursOld + 2) ^ 1.5
```

| Age | Score |
|---|---|
| 0h | 1.0 |
| 24h | 0.08 |
| 48h | 0.03 |
| 1 week | ~0.003 |

Entries earn longevity through other signals, not by merely surviving.

---

### 2. Follow Boost
```
followBoost = isFollowing ? 2.0 : 1.0
```

Binary. The user explicitly opted in to see this creator's content.

---

### 3. Unrated Boost
```
unratedBoost = isUnrated ? 1.5 : 0.2
```

Unrated entries are actionable — they drive the rating loop. Already-rated entries are deprioritized but not excluded.

---

### 4. Cold Start Boost
```
coldStartBoost = ratingCount < 3 ? 1.8 : 1.0
```

Guarantees new entries get a forced exposure window before they have enough ratings to compete on quality.

---

### 5. Contest Boost
```
contestBoost = inActiveContest ? 1.2 : 1.0
```

Small lift for entries currently in a live H2H. Kept small — the H2H tab handles contest-first browsing; this is just a mild signal.

---

### 6. Velocity Score
```
velocityScore = log(1 + ratingsInLast6Hours) × 0.5
```

Additive within the parentheses so it cannot zero out the base score. Log-scaled to prevent a single viral entry from dominating the feed.

| Recent ratings | Contribution |
|---|---|
| 0 | +0.0 |
| 5 | +0.9 |
| 20 | +1.5 |
| 50 | +1.97 |

---

### 7. Tag Affinity Boost
```
tagAffinityBoost = min(matchingTagScore × 0.15, 0.6)
```

`matchingTagScore` is the sum of the user's stored affinity scores for tags present on the entry. Capped at `0.6` (i.e., `×1.6` max) so tag affinity cannot override freshness and social signals.

See [Affinity Profile](#affinity-profile) for how tag scores are built.

---

### 8. Creator Affinity Boost
```
creatorAffinityBoost = min(creatorAffinityScore × 0.2, 0.4)
```

Separate from the follow boost — captures implicit affinity toward creators the user has rated or voted for favorably, without necessarily following them. Capped at `0.4`.

---

## Post-Processing

After scoring, before returning the top 20:

- **Cap at 2 entries per creator** — prevents a prolific user from monopolizing the feed regardless of score.
- Sort descending by score, take top 20.

---

## Affinity Profile

### Storage

Stored in a dedicated `UserAffinity` collection (not embedded on `User` to avoid bloating every user query):

```js
{
  userId: ObjectId,
  history: [
    {
      timestamp: Date,
      tagScores: {
        "vintage":    0.82,
        "handmade":   0.61,
        "minimalist": -0.30,
      },
      creatorScores: {
        "<userId>": 0.75,
        "<userId>": 0.40,
      },
      source: "job_run"
    }
  ]
}
```

History is **append-only** — snapshots are never overwritten. The full history is preserved to observe how a user's taste evolves over time.

### Effective Score on Read

When computing `tagAffinityBoost` and `creatorAffinityBoost` at feed time, the effective score is derived from the history with **recency decay**:

```
effectiveScore = Σ (snapshot.score × decayFactor(snapshot.timestamp))

decayFactor(t) = e ^ (-λ × daysSince(t))   where λ = 0.1
```

Recent snapshots dominate. Snapshots older than ~30 days contribute negligibly. If a user goes fully inactive, all scores converge to zero and the feed falls back to pure recency and velocity signals.

### Update Job (every 30 minutes)

Runs only for users who had activity (ratings or votes) in the last 30 minutes. Completely idle users are skipped.

**Per active user:**
1. Pull all ratings submitted in the last 30 minutes
2. Pull all contest votes cast in the last 30 minutes
3. For each rating ≥ 7: add tag scores with weight `+0.15` per tag
4. For each rating ≤ 3: add tag scores with weight `-0.10` per tag (mild suppression)
5. For each contest vote cast: add tag scores with weight `+0.30` per tag, creator score `+0.30`
6. For each contest vote against (the entry not chosen): add tag scores with weight `-0.05`
7. Append a new snapshot to `UserAffinity.history` with the computed delta scores and current timestamp

**Vote signals are weighted 2× ratings** — a contest vote is a forced comparative choice, a stronger revealed preference than an absolute rating.

---

## Signal Summary

| Signal | Type | Weight | Notes |
|---|---|---|---|
| Freshness | Entry | Formula | Steep decay — primary ranking driver |
| Follow | Social (explicit) | ×2.0 | Binary, explicit opt-in |
| Unrated | Behavioral | ×1.5 / ×0.2 | Core driver of rating loop |
| Cold start | Entry | ×1.8 | Entries with < 3 ratings |
| Active contest | Entry | ×1.2 | Small lift only |
| Rating velocity | Entry | Additive | Log-scaled, 6h window |
| Tag affinity | Implicit preference | Additive, capped ×1.6 | From rating + vote history |
| Creator affinity | Implicit preference | Additive, capped ×1.4 | From rating + vote history, distinct from follow |

---

## What Is Explicitly Out of Scope

- **H2H / contest surfacing in the Ratings tab** — the H2H tab handles this. The Ratings tab does not push users toward contests.
- **ML inference at runtime** — no embedding models, no collaborative filtering. All signals are behavioral and computable from existing data.
- **Cross-user collaborative signals** ("users like you also liked") — post-MVP.

---

## Future Considerations

- Expand candidate pool beyond 150 when daily submission volume warrants it
- Add a followed-user guarantee: always include at least N entries from followed users regardless of score
- Tune boost/weight constants against real engagement data once volume exists
- Separate affinity decay rates for tag vs. creator scores if needed
