# Feed — Ratings Tab: Milestone Breakdown

## Milestone 1 — Feed route: query entries + build rated map

In the `/feed` handler in `routes/pages.js`:
- Query 20 most recent entries where `userId != currentUser`, populate `userId` (username, displayName, avatar)
- Collect entry IDs, run `Rating.find({ userId: currentUserId, entryId: { $in: ids } })` to get what the user has already rated
- Build a `ratedMap` of `entryId → score`
- Pass `feedEntries` to the view — each entry shaped as `{ ...entry, owner: entry.userId, userRating: ratedMap[id] || null }`

---

## Milestone 2 — feed.ejs: render the Ratings tab content

- Add a `<div id="feed-ratings">` below the tab bar
- Loop over `feedEntries`, include `partials/entryCard` with `{ entry, owner, currentUserId, isFollowing: false }`
- Add an empty state when there are no entries
- Update the `switchMode` JS so it shows/hides the content div alongside the tab buttons

---

## Milestone 3 — entryCard: pre-lock already-rated tiles on render

- Add `userRating` as a variable the partial reads
- If set, add `data-user-rating="<score>"` to the rating panel `div`
- In the existing EC init script, scan for panels with that attribute on DOMContentLoaded and call `lockRatingPanel(eid, score)` immediately — same function already used after a live submission

---

## Milestone 4 — Load more

- Add `GET /api/feed?page=N` — returns JSON: entries with owner info, `userRating` per entry, `hasMore` flag
- Client side: on "Load more" button click, fetch next page, build card HTML from a JS template function, append to `#feed-ratings`
- Disable/hide the button when `hasMore` is false

> Milestones 1–3 are the core and can be done in a single session. Milestone 4 is lower priority — starting with a single page of 20 entries is fine for now.
