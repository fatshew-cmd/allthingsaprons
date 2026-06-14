# Feed — Ratings Tab: Milestone Breakdown

## Milestone 1 — Feed route: query entries + build rated map
**Status: Done**

Implemented in `/feed` handler in `routes/pages.js`. Queries up to 150 entries (excluding own), runs parallel lookups for already-rated entries, follows, velocity (ratings in last 6h), active contests, and `UserAffinity`. Passes shaped `feedEntries` to view.

---

## Milestone 2 — feed.ejs: render the Ratings tab content
**Status: Done**

`feed.ejs` renders the Ratings tab with `#feed-ratings` div looping over `feedEntries` via `partials/entryCard`. Empty state shown when no entries. Tab switching JS hides/shows all three content divs.

---

## Milestone 3 — entryCard: pre-lock already-rated tiles on render
**Status: Done**

`entryCard` accepts `userRating`. On DOMContentLoaded, panels with a pre-existing rating are locked via `lockRatingPanel(eid, score)`.

---

## Milestone 4 — Load more
**Status: Not started**

- Add `GET /api/feed?page=N` — returns JSON: entries with owner info, `userRating` per entry, `hasMore` flag
- Client side: on "Load more" button click, fetch next page, build card HTML from a JS template function, append to `#feed-ratings`
- Disable/hide the button when `hasMore` is false

> Milestones 1–3 are complete. Milestone 4 is lower priority — starting with a single page of entries is acceptable for now.
