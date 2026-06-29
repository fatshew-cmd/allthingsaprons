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

## Milestone 4 — Infinite scroll
**Status: Done**

`GET /api/feed/entries?page=N` returns server-rendered HTML via `partials/feedEntryBlock.ejs` (not JSON) plus a `hasMore` flag. Client side uses `IntersectionObserver` on a sentinel element at the bottom of `#feed-container`; when it enters the viewport, the next page is fetched and inserted before the sentinel. Spinner shown during load. Sentinel removed when `hasMore` is false. Page counter is session-local (no mid-session recompute).

> All four milestones complete.
