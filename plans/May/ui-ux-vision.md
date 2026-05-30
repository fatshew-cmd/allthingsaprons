# AllThingsAprons — UI/UX Vision
**Session date:** 2026-05-26

---

## Platform Concept

A social platform where users rate and compete with media (images/videos) submitted by creators.

Future domain: **Marketplace** — rated items can eventually be listed for sale.

---

## Layout

Twitter-style **3-column layout** (desktop-first, responsive).

```
┌──────────────┬────────────────────────┬──────────────┐
│  Left Nav    │     Center (main)      │  Right Panel │
│  (sidebar)   │                        │  (context)   │
└──────────────┴────────────────────────┴──────────────┘
```

---

## Left Sidebar

Persistent navigation. Logo at top, main links in the middle, "Submit" CTA near the bottom (mirrors Twitter's "Post" button).

**Links:**
- Feed
- Search
- Leaderboard
- Marketplace *(future)*
- Profile
- Settings

On smaller screens: collapses to icon-only.

---

## Center Column

The active page content. Key pages:

| Route | Content |
|---|---|
| `/feed` | Main content feed — design TBD |
| `/leaderboard` | Top-rated items, filterable by category/time |
| `/search` | Search items, creators, tags |
| `/marketplace` | Browsable shop fed by rating scores *(future)* |
| `/profile/:id` | User's rating history, submitted items, stats |
| `/settings` | Account preferences |

---

## Right Panel (context-sensitive)

Default state: **Trending / Leaderboard** — top items right now.

When a user is actively viewing an entry: shifts to **Entry Detail** — community score breakdown, vote count, and a "Shop this" CTA slot (hidden until marketplace launches).

This approach means zero layout changes when the marketplace goes live — just unhide the CTA.

---

## Feed Interaction

Design TBD. The rating and contest card UI will be defined as part of the new UI build.

---

## Data Model

See `plans/May/platform-core-concepts.md` — authoritative source for all schema decisions.

---

## Next Steps

See `plans/June/june-action-plan.md`.
