# Feed — Ratings Tab: Milestone Breakdown

## Milestone 1 — Feed route: query entries + build rated map
**Status: Not started**

In the `/feed` handler in `routes/pages.js`:
- Query 20 most recent entries where `userId != currentUser`, populate `userId` (username, displayName, avatar)
- Collect entry IDs, run `Rating.find({ userId: currentUserId, entryId: { $in: ids } })` to get what the user has already rated
- Build a `ratedMap` of `entryId → score`
- Pass `feedEntries` to the view — each entry shaped as `{ ...entry, owner: entry.userId, userRating: ratedMap[id] || null }`

---

## Milestone 2 — feed.ejs: render the Ratings tab content
**Status: Partially done — tab scaffold built, content div not started**

Done:
- Tab bar with 3 buttons (Ratings, Head To Head, Tournaments)
- `switchMode` JS toggling `tab-active` / `tab-inactive` classes

Still needed:
- Add a `<div id="feed-ratings">` below the tab bar
- Loop over `feedEntries`, include `partials/entryCard` with `{ entry, owner, currentUserId, isFollowing: false }`
- Add an empty state when there are no entries
- Update `switchMode` to show/hide the content div alongside the tab buttons

---

## Milestone 3 — entryCard: pre-lock already-rated tiles on render
**Status: Not started — rating interactivity is fully built, pre-lock wiring is not**

The card already has `lockRatingPanel(eid, score)` and all live-rating logic. Still needed:
- Accept `userRating` as a variable in the partial
- If set, add `data-user-rating="<score>"` to the rating panel `div`
- On DOMContentLoaded, scan for panels with that attribute and call `lockRatingPanel(eid, score)` immediately

---

## Milestone 4 — Load more
**Status: Not started**

- Add `GET /api/feed?page=N` — returns JSON: entries with owner info, `userRating` per entry, `hasMore` flag
- Client side: on "Load more" button click, fetch next page, build card HTML from a JS template function, append to `#feed-ratings`
- Disable/hide the button when `hasMore` is false

> Milestones 1–3 are the core and can be done in a single session. Milestone 4 is lower priority — starting with a single page of 20 entries is fine for now.
