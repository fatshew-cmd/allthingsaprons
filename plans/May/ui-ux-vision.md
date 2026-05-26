# AllThingsAprons — UI/UX Vision
**Session date:** 2026-05-26

---

## Platform Concept

A social platform where users rate media (images/videos) submitted by creators.
Two core interaction modes:
- **Rate** — single item, scored by the user
- **Compare** — head-to-head between two items, user picks a winner

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
| `/feed` | Card-by-card rating loop (Rate or Compare mode toggle at top) |
| `/leaderboard` | Top-rated items, filterable by category/time |
| `/search` | Search items, creators, tags |
| `/marketplace` | Browsable shop fed by rating scores *(future)* |
| `/profile/:id` | User's rating history, submitted items, stats |
| `/settings` | Account preferences |

---

## Right Panel (context-sensitive)

Default state: **Trending / Leaderboard** — top items right now.

When a user is actively rating an item: shifts to **Item Detail** — community score breakdown, vote count, comments, and a "Shop this" CTA slot (hidden until marketplace launches).

This approach means zero layout changes when the marketplace goes live — just unhide the CTA.

---

## Feed Interaction (Card Loop)

Located in the center column. Two modes toggled at the top of the feed:

### Rate Mode
- Full (or near-full) card showing item media
- Star rating input below (1–5)
- Community average bar shown after submission
- Skip button

### Compare Mode
- Two cards side by side with a VS badge between them
- Tap to pick a winner
- After pick: reveal community percentage split
- "Too close to call" skip option

Both modes advance to the next item/pair automatically after action.

---

## Data Model (planned, not yet built)

```js
// Item
{
  mediaUrl: String,
  mediaType: 'image' | 'video',
  title: String,
  description: String,
  tags: [String],
  creator: { type: ObjectId, ref: 'User' },
  ratingScore: Number,       // aggregated average
  ratingCount: Number,
  price: Number,             // null until marketplace
  isListed: Boolean,         // marketplace toggle
  createdAt: Date,
}

// Rating
{
  user:   { type: ObjectId, ref: 'User' },
  item:   { type: ObjectId, ref: 'Item' },
  mode:   'rate' | 'compare',
  score:  Number,            // 1–5 for rate; 1 (won) / 0 (lost) for compare
  createdAt: Date,
}
```

---

## Prototype

A standalone visual prototype was built at `public/prototype.html`.
Open at `http://localhost:3000/prototype.html` while the server is running.

Demonstrates: card enter/exit animations, star rating, compare pick + community reveal, bottom nav (mobile layout).

---

## Next Steps (when building)

1. Build the 3-column layout shell (EJS layout partial or `layout.ejs`)
2. Create the `Item` and `Rating` Mongoose models
3. Build the `/feed` route + card loop UI (Rate mode first, Compare second)
4. Wire right panel to show item stats during rating
5. Leaderboard page
6. Marketplace domain (later phase)
