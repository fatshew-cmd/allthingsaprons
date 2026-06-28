# Explore Page Algorithm
**Version 1.0 — June 28, 2026**

---

## Overview

The explore page is a multi-section discovery surface. Its goal is to expose the viewer to content and creators they have never interacted with. Everything on explore is new — followed creators and already-interacted-with content are excluded.

Unlike the feed, the explore page does not use a frozen session snapshot. It reads the viewer's current stain affinity profile at load time and uses it to score entry cards.

> Note: hashtags are called **stains** on the platform.

---

## Page Layout

The page interleaves entry card blocks with discovery interstitials in a repeating pattern:

```
8 entry cards
trending stains block
8 entry cards
suggested people sub-section
8 entry cards
trending stains block
8 entry cards
suggested people sub-section
...
```

**Infinite scroll** — entry cards keep loading in blocks of 8 with no hard stop.

**Interstitial fallback rules:**
- Trending stains and people sub-sections are pulled upfront and paginated through as the user scrolls
- When trending stains run out, that interstitial slot becomes entry cards
- People sub-sections can repeat as long as they still have at least 3 profiles to show
- When all interstitials are exhausted, the remaining scroll is pure entry cards — no empty blocks ever render

---

## Section 1 — Entry Cards

### Pre-Filters
Applied before scoring. Entries failing any filter are excluded entirely:

| Filter | Condition |
|---|---|
| Zero stains | Exclude entries with no stains — they cannot be personalized or ranked meaningfully |
| Own entries | Exclude the viewer's own entries |
| Already interacted | Exclude entries the viewer has already rated, commented on, or bookmarked |
| Already followed creator | Exclude entries from creators the viewer already follows |
| Mature content | Exclude if `entry.mature === true` and `user.privacySettings.showMatureContent === false` |
| AI-generated | Exclude if `entry.aiGenerated === true` and `user.privacySettings.showAiContent === false` |

### Two-Tier Structure

**T2 leads, T1 backfills** — the inverse of the feed.

- **T2 (Discovery):** entries from creators the viewer does not follow. This is the primary source on explore.
- **T1 (Social graph):** entries from followed creators used only to backfill when T2 cannot fill 8 slots. Still subject to the same pre-filters above — followed creator entries that pass all filters can backfill.

### T2 Scoring Formula

#### Base Score (Additive)
```
baseScore = (ratingAvg/10    × 0.35)
          + (stainAffinity   × 0.25)
          + (ratingVelocity  × 0.20)
          + (creatorAffinity × 0.12)
          + (commentVelocity × 0.05)
          + (recencyDecay    × 0.03)
```

`ratingVelocity` outranks `creatorAffinity` on explore — trending/hot content surfaces higher than social proximity. All weights sum to 1.0.

#### Stain Count Bonus
More stains = more recommendable. Applied as an additive bonus on top of the base score:

```
stainCountBonus = stainCount / maxStains   (maxStains = 6)
```

An entry with 6 stains scores `+1.0` bonus. An entry with 1 stain scores `+0.17`. This rewards creators who tag their entries thoroughly.

#### Surge Multiplier
```
surgeMultiplier = min(log(1 + currentVelocity / max(historicalBaseline, 1)), 10)
```

Detects entries going from dormant to active. `currentVelocity` = combined ratings + comments in the last 24h. `historicalBaseline` = average daily activity over the entry's lifetime excluding the last 24h. Capped at 10.

#### Final Score
```
finalScore = (baseScore + stainCountBonus) × surgeMultiplier × unratedBoost × entryColdStartBoost × contestBoost
```

| Boost | Value | Purpose |
|---|---|---|
| `unratedBoost` | `1.5` if unrated, `0.8` if already rated | Prioritizes actionable entries |
| `entryColdStartBoost` | `1.8` if `ratingCount < 3`, else `1.0` | Exposure window for new entries |
| `contestBoost` | `1.2` if in an active H2H, else `1.0` | Small lift for entries in live contests |

---

## Section 2 — Trending Stains

### Definition
A stain's global popularity score reflects how much traction it is getting platform-wide right now — independent of any viewer's personal affinity. A stain the viewer has never interacted with can and should appear here.

### Scoring (48h window)
A stain's trending score is driven by activity on entries carrying it:

- **Views** on those entries in the last 48h
- **Ratings** on those entries in the last 48h
- **Quality weight** — activity on a high-rated entry contributes more than the same activity on a low-rated entry (`ratingAvg/10` as multiplier)

```
stainTrendingScore = Σ (ratings + comments) × max(ratingAvg/10, 0.1)
                     across all entries carrying that stain, last 48h
```

### Two-Track Stain System
Stains have two completely separate scores:

| Score | Scope | Purpose |
|---|---|---|
| **Personal affinity** | Per user, 0–1 | Powers T2 personalization on feed and explore |
| **Global popularity** | Platform-wide | Powers trending stains section on explore |

### Interaction
Clicking a trending stain redirects to the search results page, filtered to that stain and ranked by the explore algo. Acts as if the viewer searched for that stain directly.

### Rendering
A trending stains block shows the top N stains by global popularity score for the current 48h window. When all available trending stains have been shown, this interstitial slot defaults to entry cards.

---

## Section 3 — Suggested People to Follow

### Rules
- Already-followed users are excluded from all sub-sections
- A sub-section only renders if it has at least 3 profiles to populate it
- Default view: 3 profile badges per sub-section
- "Show more" redirects to the shared search results page, filtered to that sub-section's criteria
- Sub-sections can repeat on scroll as long as they still have at least 3 profiles to show
- Time-sensitive sub-sections (Trending, Top Contributors, Most Voted) naturally exhaust faster due to the 48h window

### Sub-Sections

| Sub-section | Signal | Window |
|---|---|---|
| **Trending** | Follower surge — accounts gaining followers rapidly | 48h |
| **Top Rated** | High `ratingAvg` across a meaningful entry count | All time |
| **Active in Contests** | Recently participating in H2H contests | 48h |
| **Tournament Participants** | Recent tournament activity | 48h |
| **Top Contributors** | High CHL contributed to contests | 48h |
| **Most Voted** | High contest vote volume received | 48h |

Each sub-section has its own independent query. A creator can appear in multiple sub-sections simultaneously — that is expected and fine.

Sub-sections only render when there is enough data to feed them (minimum 3 profiles). Early in the platform's life, time-gated sub-sections may not appear until contest and tournament volume builds up.

---

## What Is Out of Scope for Explore

- Popular searches — deferred; query normalization is too complex for now
- Content the viewer already follows — explore is purely for discovery; followed creators surface on the leaderboard instead
