# July Action Plan

## Current State (July 6/7, uncommitted — closes most gaps the entry below flagged)

Four gaps flagged in the entry below are now closed, all still uncommitted in the working tree:

- **3+-way group-ranking boundary tie**, previously left unresolved by design (`resolveGroup` just logged a warning and stopped), now runs the same 6h-jury → 3h-organizer → coin-flip chain as a match tie, capped at 9h total. New model `TournamentGroupTieVote` (one top-pick vote per juror, unique on `{groupId, jurorId}`); new `tieStatus`/`tieDeadline`/`tiedEntryIds`/`tieSlotsForCluster`/`tieResolvedOrder` fields on `TournamentGroup` (mirrors `TournamentMatch`'s tie fields). `resolveGroup` (`jobs/tournamentJobs.js`) now branches: a fresh 3+-way tie calls `resolveGroupTieCluster` → `initiateGroupTieResolution` (notifies jurors, 6h window); quorum-3 jury votes resolve via `resolveGroupJuryVote` unless the plurality itself leaves the advance/eliminate cutoff ambiguous, in which case it falls to `tournamentGroupJuryExpiry` → organizer 3h window (`resolveGroupOrganizerVote`) → `tournamentGroupOrganizerVoteExpiry` coin flip. Resolution is anchored to the stored snapshot (not recomputed live) so rating drift during the 6-9h window can't strand the group. New routes: `POST /api/tournaments/:id/groups/:groupId/jury-vote` and `.../organizer-vote`; new pages `GET /tournament/:id/group-jury-vote/:groupId` and `.../group-organizer-vote/:groupId` (views `group-jury-vote.ejs`/`group-organizer-vote.ejs`, sharing a new `views/partials/groupTieBreakPicker.ejs`, blind-judged same as the match-tie picker). Two new notification types (`tournament_group_tie_jury`, `tournament_group_tie_organizer`) have display cases in `notifications.ejs`. `jobs/sweeper.js` got matching crash-recovery sweeps for both new deadline fields.
- **`tournament_knockout_started`** now has a display case in `notifications.ejs` (was silently falling through to generic text).
- **`Tournament.viewCount`** increment restored in `GET /tournament/:id` (`routes/tournaments.js`) — had been removed since July 4 with an open question of "restore or drop the display"; restored.
- **Bracket/tree visualization** added to `detail.ejs`: knockout matches are now split out from the flat "Contests" list into a dedicated "Bracket" section grouped by round (R16/QF/SF/3rd/Final) with round labels, rendered as a horizontally-scrolling column-per-round layout with winner highlighting/crown icon.
- **Admin tournament management (Phase 8)** also substantially built: `GET /admin/tournaments` now runs a real query (status filter, organizer populate, prize pool, approved-participant-count aggregation) instead of the static placeholder; a new `GET /admin/tournaments/:id` (`views/admin/tournaments/detail.ejs`) shows full read-only state (groups, matches, jury count, approved count); a new `POST /admin/tournaments/:id/cancel` force-cancels an `open`/`cooldown` tournament via the existing `cancelTournament` job helper and logs a new `tournament_force_canceled` audit event type. The separate user-organized **review queue** (`/admin/tournaments/review`, sidebar "Review Queue" link) was removed rather than built out — the live `Tournament.status` enum (`open|cooldown|active|closed|canceled`) has no `pending_review` state for user-organized tournaments to sit in, so that page had nothing to query; `TOURNAMENT_STATUSES` used for the index filter is `['open','cooldown','active','closed','canceled']`. Not yet touched: no separate list/detail route restrictions beyond `requireDomain('tournaments')`, and Phase 8's originally-specced "Reject with refund" queue action doesn't apply for the same reason.

None of this is committed yet — last commit is still `dc69249`.

## Current State (July 6, even later still — verified against the working tree)

Correcting the staleness in the entry immediately below: **Phase 8 (prize payout + closing the tournament) is also built**, not "the only unstarted piece" as that entry says. `closeTournament` (`jobs/tournamentJobs.js`) fires from `handleKnockoutMatchClose` once the Final and (where applicable) 3rd-place match are both closed, credits 1st/2nd/3rd into winners' `earnedCHL`, sets `status: 'closed'`/`prizes.winnersSet: true`, fires `tournament_closed`/`tournament_prize_awarded` notifications, and bans jurors with `missedVotes > 0` via `User.juryBanned` — matching Phase 8's exit criteria essentially exactly, including the 7G jury-ban step. `jobs/sweeper.js` also has the Phase 8B tournament sweeper (crash-recovery net for the one-time deadline jobs) plus an unplanned bonus: `runTournamentMatchReconcileSweeper`, which re-fires the match-close handler for any `TournamentMatch` left stranded by a process crash mid-close.

With that corrected, **the entire backend tournament gameplay loop — creation through payout — is complete.** What's actually left, verified directly against the code rather than inferred from this doc's own prose: no bracket/tree visualization on `detail.ejs` (matches still render as one flat list); the `tournament_knockout_started` notification type fires but has no display case in `views/notifications.ejs` (falls through to a generic default — the one notification gap, not the eight this doc previously implied); `Tournament.viewCount` still isn't incremented anywhere; `views/admin/tournaments/index.ejs` and `review.ejs` are still static placeholder pages with no real query logic; and a 3+-way group-ranking boundary tie (as opposed to the handled 2-way case) is left unresolved by design. Full breakdown in `tournament-implementation-plan.md`'s status header and its "Phase 8 — As-Built" note.

## Current State (July 6, even later still — committed in `dc69249`)

**Phase 7 (jury/organizer/coin-flip tie resolution) shipped**, closing the gap the entry below flagged as "the real next step." A genuine match tie (group or knockout) now fires `initiateTieResolution` (`jobs/tournamentJobs.js`), which notifies every `accepted` juror (never revealing which entries are tied) and opens a 6h voting window. A juror votes via `POST /api/tournaments/:id/matches/:matchId/jury-vote`; reaching quorum (3 votes) resolves the match immediately. If 6h passes without quorum, non-voting *accepted* jurors get `missedVotes` incremented and the organizer gets a 3h window (`GET`/`POST .../organizer-vote`); if the organizer also doesn't act, a platform coin flip resolves it — no tie blocks progression more than 9h total, exactly per spec. Both vote pages share a new `views/partials/tieBreakPicker.ejs`; three new notification types (`tournament_tie_jury`, `tournament_tie_organizer`, `tournament_jury_vote_received`) all got display cases in `notifications.ejs` this time (unlike the still-missing `tournament_knockout_started` case flagged below). The shared picker briefly showed each entry's real title, missing the original "no entry titles" blind-judging requirement for jurors — fixed same-day by swapping the title spans for a static "Entry A"/"Entry B" label. Full breakdown in `tournament-implementation-plan.md`'s status header and its new "Phase 7 — As-Built" section.

Prize payout and closing the tournament (Phase 8, plus 7G's post-close jury ban for jurors with `missedVotes > 0`) is now the only unstarted piece of the tournament build.

## Current State (July 6, even later)

Correcting a same-day staleness: **Phase 6 (knockout bracket generation) also shipped in the 09:04 commit**, the same pass that shipped Phase 5 below — this doc and `tournament-implementation-plan.md` documented Phase 5 but didn't catch that the same commit's `jobs/tournamentJobs.js`/`utils/tournamentScheduler.js` changes went further. Once every group in a tournament resolves, `resolveGroup` calls the new `generateKnockoutBracket` (`utils/tournamentScheduler.js`), which cross-group-seeds the qualifiers (group *X* rank-1 vs group *Y* rank-2, and vice versa, to avoid an immediate round-robin rematch) into real `Contest`/`TournamentMatch` pairs at the correct round (`R16`/`QF`/`SF`/`Final`, derived from field size — covers all five valid tournament sizes). `handleKnockoutMatchClose` (`jobs/tournamentJobs.js`) then progresses the bracket round-by-round as matches close, using a new `Tournament.lastKnockoutRoundAdvanced` field to atomically claim each round's fan-out (guards against two matches in the same round closing in the same 15-min sweep and double-generating the next round) — `SF` fans out to **both** `Final` and `3rd`-place matches at once. A new `tournament_knockout_started` notification type was added to the enum and fires correctly, but **`views/notifications.ejs` was never given a display case for it** — it silently falls through to the generic "New notification" text, a real gap to fix. A knockout-stage tie hits the identical `status: 'tie'`/`jury_pending` flag a group-stage tie does — Phase 7 blocks it the same way, no special-casing for knockout. Once `Final`/`3rd` close, nothing further happens — Phase 8 (prize payout, `Tournament.status → 'closed'`) still doesn't exist, so a finished bracket today just stops with no podium. `detail.ejs`'s flat "Contests" list renders knockout matches once they exist but still has no bracket/tree grouping or round labels. Full breakdown in `tournament-implementation-plan.md`'s status header and its new "Phase 6 — As-Built" section.

Jury/organizer/coin-flip tie resolution (Phase 7) and prize payout (Phase 8) are still not started — these are now the real next steps, not Phase 6.

## Current State (July 6, later)

**Phase 5 (group-stage results & advancement) shipped**, closing the exact gap the entry above flagged as "the real next step." `jobs/contestJobs.js`'s `closeContest` now fires a fire-and-forget hook into a new `handleTournamentMatchClose` in `jobs/tournamentJobs.js` whenever a closing contest belongs to a tournament: it writes win/loss/tie back onto `TournamentMatch` and `$inc`s `wins`/`losses`/`totalVotes`/`groupPoints` onto the two `TournamentEntry` docs, then checks whether the group is complete. `resolveGroup` ranks a finished group (`groupPoints` → `ratingAvg` → `ratingCount` → `totalVotesInGroup`), sets `groupRank`/`eliminated`, and fires new `tournament_group_advance`/`tournament_eliminated` notifications (now rendered in `notifications.ejs`, which also picked up three pre-existing tournament notification types that had never had display cases). A genuine 2-way boundary tie is settled with an ordinary extra H2H tiebreaker match rather than invoking the jury system; anything messier (a true jury-dispute tie, or a 3+-way boundary tie) is flagged and left blocked for Phase 7. `jobs/sweeper.js` gained a reconciliation pass so a mid-flight crash between a tournament contest closing and the hook finishing can't strand a match. `detail.ejs`'s Groups section now shows each member's W-L/points/advance-eliminate status. Full breakdown in `tournament-implementation-plan.md`'s status header and its "Phase 5 — As-Built" section.

Knockout bracket generation (Phase 6) also shipped the same commit — see the entry above, which corrects this. Jury/organizer/coin-flip tie resolution (Phase 7) and prize payout (Phase 8) are still not started.

## Current State (July 6)

Correcting a staleness in this doc and `tournament-implementation-plan.md`: the "Phase 4-8 not started" line repeated at the end of every entry below was true when each entry was written, but **Phase 4 (group assignment + round-robin match scheduling) shipped later on July 5** in the same batch of work that did the "Watch"→"Loop" rename — it just never got reflected in this doc's own prose until now. `utils/tournamentScheduler.js` exists and is wired into `activateTournament` (`jobs/tournamentJobs.js`): on cooldown expiry (or an organizer's manual `POST /api/tournaments/:id/advance-now`), it shuffles approved candidates into `TournamentGroup`s and schedules a full round-robin per group (circle-method algorithm) as real `Contest`/`TournamentMatch` pairs — the first round opens immediately, later rounds open via a new `open_tournament_match` agenda job. Tournaments can now actually produce playable matchups instead of sitting at `active` with nothing to do.

**What's not done, and is now the real next step:** `jobs/contestJobs.js`'s `closeContest` never writes match results back onto `TournamentMatch`/`TournamentEntry` — no win/loss, no `groupPoints`, no tie flagging. So group matches can be played and voted on, but no group can ever be marked complete, and knockout bracket generation, tie resolution (jury → organizer → coin flip), and prize payout (Phases 5-8) all remain exactly as unbuilt as before. Full breakdown in `tournament-implementation-plan.md`'s status header and its new Phase 4 "As-Built" note.

Separately, the "Watch" feature was fully renamed to "Loop" across both contests and tournaments (`ContestWatch`→`ContestLoop`, `TournamentWatch`→`TournamentLoop`), and tournaments picked up a new, more granular **per-candidate loop-in** (`TournamentEntryLoop`) so a viewer can follow one specific contestant's match outcomes. **Committed in `0dfb964`:** `review.ejs`'s candidate rows were redesigned into fuller cards (avatar/follow button, follower/rating/nomination stats, larger entry thumbnail with caption), `detail.ejs`'s entry rail now pins the viewer's own entry outside the horizontal-scroll strip instead of scrolling away with it, the organizer's "revert an approval" action now cleans up the stale approval notification it leaves behind, and `jobs/agenda.js` was hardened (its own MongoClient instead of reusing mongoose's connection, plus error handlers) so a mongoose reconnect blip can't silently stop background jobs.

## Current State (July 5)

Candidate submission was reworked again, same day: the "Participate" modal/entry-picker from July 4 is gone. Every new upload (`/submit` or `/entries`) now resolves tournament candidacy at upload time via the new `utils/tournamentSubmission.js` — either explicitly (`?tournamentId=` on the upload flow, pre-checked with `checkTournamentPreflight` so the uploader sees an ineligibility message before picking media) or automatically, via a new **wildcard auto-draft**: any open tournament's `wildcardStains` (max 2, set at creation) that match one of the new entry's tags silently auto-submits it as a candidate (`autoSubmitted: true`). Organizer review (`review.ejs`) now runs across `open` **and** `cooldown`, not cooldown-only as the July 4 build had it, and shows a "Wildcard" badge on auto-drafted rows plus a username search box and sort dropdown. Reaching the participant cap no longer auto-activates or silently no-ops — it surfaces an explicit organizer choice via a confirmation modal ("Go live now" → new `POST /tournaments/:id/advance-now`, or "Not yet" → new `POST /tournaments/:id/entries/:eid/revert`), working the same way whether the cap is hit during `open` or `cooldown`. The `ratingAvg`/`ratingCount` eligibility criteria now evaluate a candidate's platform-wide weighted curator rating (`utils/weightedRating.js`, also now shared by `utils/contestEligibility.js`) instead of a specific entry's stats, since a fresh upload has no rating history yet.

Separately, the tournament organizer/jury voting restriction described in `CLAUDE.md` (barred from regular H2H voting while a tournament is in progress) was actually wired into `POST /api/contests/:id/vote` for the first time — it had been documented but unenforced until today. A canceled tournament now 404s instead of staying viewable at `GET /tournament/:id`, the detail page swapped which action (Edit vs. Cancel) gets the prominent card slot, and cancellation now releases all `TournamentJury` records outright (no penalty, since jurors never reached the point of voting). Full breakdown in `tournament-implementation-plan.md`'s status header, "Phase 3 Extensions", and "Phase 2 Extensions" sections.

Group/knockout progression and prize payout (Phases 4–8) are still not started.

## Current State (July 4, later)

Candidate submission and organizer review are now live: a "Participate" button on the tournament detail page opens an entry picker gated by a new pre-submission eligibility check (`GET /api/tournaments/:id/eligibility`), and `POST /api/tournaments/:id/submit` creates the `TournamentEntry`. The organizer's existing `review.ejs` page (previously a shell with no backing routes) is now fully functional via `POST /api/tournaments/:id/entries/:eid/approve`/`reject`. Review is gated to the `cooldown` phase, not `open` — matches the "batch review, no per-entry timer" design this plan already called out as the target, but is a change from the earlier draft pseudocode in `tournament-implementation-plan.md`. Approving up to the tournament's participant cap immediately activates the tournament (skipping the rest of the 24h cooldown), reusing a newly-extracted `activateTournament` in `jobs/tournamentJobs.js` — which still only flips status, with no group/match generation (Phase 4 still not built). Three new notification types (`tournament_entry_submitted/approved/rejected`) render already. Full breakdown in `tournament-implementation-plan.md`'s "Phase 3 Extensions" section.

Group/knockout progression and prize payout (Phases 4–8) are still not started.

## Current State (July 4)

A full tournament social layer shipped that wasn't in either the original spec or the July 3 status note: tournament comments (one level of replies, likes/dislikes, report-and-auto-hide, edit/delete), a tournament-level watch/subscribe toggle, and a tournament-level report action. Four new models (`TournamentComment`, `TournamentCommentReport`, `TournamentReport`, `TournamentWatch`) and a large batch of new routes in `routes/tournaments.js`. The detail page also picked up a view counter and a `loadTournamentPlacements` helper that renders a podium once a tournament is `closed` (dead code today — no bracket generation exists yet to ever close a tournament that way). Full breakdown in `tournament-implementation-plan.md`'s "Phase 9 Extensions" section.

**Flagged gap (still true as of `dc69249`):** the view-counter increment (`Tournament.updateOne({ _id }, { $inc: { viewCount: 1 } })`) that was added in `GET /tournament/:id` has since been removed again — `tournament.viewCount` is still schema'd and still displayed on the detail page, but nothing increments it right now. Needs a decision: restore the increment or drop the display.

Candidate submission, approval, group/knockout progression, and prize payout (Phases 3–8) are still not started.

## Current State (July 3)

Tournament creation flow (Phase 2) grew a lot beyond its original scope: a 5th wizard step ("Review") before finalize, a full edit wizard so organizers can revise a live tournament (`open`/`cooldown` only) with wallet true-up and criteria re-checks, an organizer self-cancel route, and — new capability not previously planned at all — a jury invite/accept/decline flow plus organizer jury management/replace. The right panel's "Ongoing Tournaments" section (originally slated for Phase 7.7, after match generation existed) also shipped early since it only needed `Tournament.status === 'active'` to be a reachable state, not real matches. Full breakdown in `tournament-implementation-plan.md`'s status header and its new "Phase 2 Extensions" section. Candidate submission, approval, group/knockout progression, and prize payout (Phases 3–8) are still not started — and the agenda jobs that do exist (`jobs/tournamentJobs.js`) have a known gap: `tournament_cooldown_expiry` currently flips a tournament to `active` with no groups or matches generated, since Phase 4 doesn't exist yet.

## Current State (July 1)

July opened with the search page fully wired and a round of dead code cleanup. The `Retag` model is gone. The `/take-on/:id` route now redirects to `/contest/:id` directly. Affinity source props are wired from all entryCard actions. Everything else is as closed June left it.

**What is done in July so far:**
- **Search** (`GET /api/search` + `views/search.ejs`) — users, entries, tags, contests; `#tag` prefix mode; category drill-down; People section reuses `getPeopleSubSections` from explore; excludes blocked users; `window.__ecSource = 'search'` wires the 1.3× affinity multiplier ✅
- **Right panel search typeahead** — form + dropdown in `rightPanel.ejs` hitting the same `GET /api/search` endpoint ✅
- **Affinity source prop** wired from `ecScript.ejs` + `entryCard.ejs` (rating, bookmark, comment, reply) ✅
- **Dead code purge** — `Retag.js`, `take-on.ejs`, `index.ejs`, all 4 migration scripts, `ui-ux-vision.md` deleted ✅
- **`/take-on/:id` simplified** — redirects to `/contest/:id`; standalone view removed ✅
- **Contest eligibility thresholds lowered** for testing (`minEntries` 5→3, `minRatingCount` 250→25) ✅

---

## Starting Point

June closed with the full standalone contest lifecycle, the chilli wallet economy, Phase 6 admin infrastructure, Feed v2, Explore, Bookmarks, and all content moderation done. The schema (`Tournament`, `TournamentEntry`) and all supporting infrastructure (agenda, wallet, contest close jobs, notification system, affinity updater) are already in place. July builds on top of everything without touching the June foundation.

---

## What Carries Over / Remains

| Item | Status |
|---|---|
| `Tournament` + `TournamentEntry` models | Superseded by `tournament-implementation-plan.md` — schema (Phase 1), creation flow (Phase 2, extended well beyond spec with an edit wizard + jury invite/accept/decline/replace + self-cancel), right panel wiring (Phase 9G), a social layer (comments/loop-in/report, Phase 9 Extensions), candidate submission + organizer approve/reject (Phase 3 Extensions, reworked 2026-07-05 to upload-time submission + wildcard auto-draft + explicit cap-reached choice), group assignment + round-robin match scheduling (Phase 4, done 2026-07-05 later), group-stage results/advancement (Phase 5, done 2026-07-06 later — a closing tournament match now writes win/loss/tie back onto `TournamentMatch`/`TournamentEntry` and groups resolve to advance/eliminate, with both a 2-way boundary tie (extra H2H match) and, as of 2026-07-06/7 uncommitted, a 3+-way boundary tie (full jury/organizer/coin-flip chain) now settled), knockout bracket generation (Phase 6, done the same 2026-07-06 commit as Phase 5 — cross-group-seeded bracket auto-generates once groups resolve and progresses round-by-round through Final/3rd, now with a real bracket visualization on `detail.ejs` as of the 07-06/7 uncommitted work), jury/organizer/coin-flip tie resolution (Phase 7, done 2026-07-06 later still — a genuine match tie runs the full 6h-jury → 3h-organizer → coin-flip chain, capped at 9h total), and prize payout (Phase 8, done — `closeTournament` credits winners and bans jurors with missed votes) are all live as of 2026-07-06; admin tournament management (also nominally Phase 8, `plans/July/july-action-plan.md`'s own Phase 8 section below) is now substantially built too (real `/admin/tournaments` list + new `/admin/tournaments/:id` detail + force-cancel), uncommitted as of 2026-07-06/7. See `tournament-implementation-plan.md`'s status header for the current breakdown, not this row. |
| Pre-launch test bypasses | **On hold — not yet, still actively testing.** Must revert before any public release (see below) |
| ~~`Retag` model~~ | Deleted 2026-07-01 — was never wired, no longer exists |
| ~~Search page~~ | **Done 2026-07-01** — see Current State above |
| Right panel — Ongoing Tournaments | Currently a skeleton — wired when tournaments are built (Phase 7) |
| Admin Analytics page | Sidebar entry exists in design only — low priority, end of July |

---

## Pre-Launch Reverts (do before any public release, not a phase gate)

**Status: on hold, not yet — decided 2026-07-01.** Still actively testing contest flows; the bypasses stay in place until testing wraps up. Do not implement this revert until explicitly asked.

Two test bypasses left from June that must eventually be removed before going live:

- Re-enable the **`status === 'active'`** check in `routes/api.js` (contest vote handler, commented out with `// TEMP`)
- Remove **`TEST_BYPASS_USERNAMES`** from `utils/contestEligibility.js` and `routes/api.js` (entry submission `idVerified` bypass)

Note: the self-vote guard (`isOwnEntry` check in the vote handler) was previously miscategorized as disabled — it is actually live and enforced, not a bypass.

Also as of 2026-07-01, contest eligibility thresholds were intentionally lowered for easier local testing: `minEntries` 5 → 3, `minRatingCount` 250 → 25 (`minWeightedAvg` unchanged at 7.4). These are separate from the bypass usernames and are not test-only hacks — they're the new working defaults in `utils/contestEligibility.js`, `models/PlatformSettings.js`, `routes/admin.js`, and `views/admin/settings.ejs`. Revisit whether these should go back up before launch.

These are not blocking July builds — they are blocking launch, and are currently paused pending further testing.

---

## July Phases

### Phase 7 — Tournaments (Player-Facing)

The largest remaining feature. Reuses Contest infrastructure, agenda, wallet, and notifications heavily — no new primitives needed.

#### Models (already done)

Both `Tournament` and `TournamentEntry` are schema-complete. No changes needed.

**Key fields to note:**
- `Tournament.status`: `pending_funds | pending_review | open | cooldown | active | closed | canceled`
- `Tournament.type`: `platform` (admin-created, auto-funded) | `user_organized` (user-created, prize funds committed upfront)
- `Tournament.missedReviews`: incremented per `timed_out` entry; at 3 → tournament canceled, no refund
- `TournamentEntry.approvalStatus`: `pending | approved | rejected | timed_out`
- `TournamentEntry.totalVotes`: primary ranking metric — updated whenever a tournament contest closes
- `TournamentEntry.wins / losses`: for elimination threshold check

#### Lifecycle

```
User-organized:  pending_funds → pending_review → open → cooldown → active → closed
Platform:                                          open → cooldown → active → closed
```

---

#### Phase 7.1 — Creation + Prize Funds

**User-organized tournament creation:**
- `GET /tournaments/create` + `views/tournaments/create.ejs`
- Fields: name, description, maxParticipants, entry window (default 72h), cooldown (default 3h), round window (default 72h)
- Prize structure: 1st/2nd/3rd amounts (default $1,000 / $400 / $100 in chillies, organizer sets)
- `idVerified: true` required — redirect to `/verify-identity` if not
- Organizer cannot submit an entry to their own tournament (enforced at submission time, not creation)
- On creation: status → `pending_funds`. Prize commitment screen shows total chillies required.
- **Stub fund commitment:** same pattern as wallet checkout — deducts from wallet immediately, sets `fundsHeld: true`, status → `pending_review`. CCBill will replace this later. If wallet balance is insufficient, block creation and prompt top-up.
- On fund commitment: `WalletTransaction` (type: `tournament_prize_hold`, direction: `debit`) created; admin notified for review.

**Platform tournament creation (admin only, founder + superadmin):**
- `GET /admin/tournaments/create` + `views/admin/tournaments/create.ejs`
- Same fields but `type: platform`, `fundsHeld: true` set immediately (no payment step), status → `open` directly.
- No review step needed.

---

#### Phase 7.2 — Tournament Browse + Detail

- `GET /tournaments` + `views/tournaments/index.ejs` — browse open/active/recently-closed tournaments. Cards show name, entry count, prize pool, status, countdown.
- `GET /tournament/:id` + `views/tournaments/detail.ejs` — full detail page.
  - `open` phase: shows approved entries, pending review count, entry window countdown, submit entry CTA
  - `cooldown` phase: shows final participant list, rounds-start countdown
  - `active` phase: matchup grid (all contests in this tournament), elimination tracker, live leaderboard by totalVotes
  - `closed` phase: podium with 1st/2nd/3rd and vote counts
- Add tournament link to sidebar nav.

---

#### Phase 7.3 — Entry Submission During `open` Phase ✅ (done 2026-07-04, reworked 2026-07-05 — see `tournament-implementation-plan.md`'s "Phase 3 Extensions")

~~Submit entry to tournament from the tournament detail page or the standard `/submit` flow.~~ The 2026-07-04 build used a "Participate" button + modal on the detail page for picking an already-uploaded entry. **As of 2026-07-05** that modal is gone: "Participate" now just links to `/submit?tournamentId=<id>` (the standard submit flow, exactly as originally specced here), and `GET /submit` runs a pre-check (`checkTournamentPreflight` in the new `utils/tournamentSubmission.js`) to surface ineligibility before upload instead of filtering an entry picker. Separately, any new entry (uploaded through either `/submit` or `/entries`, tournament-targeted or not) auto-drafts into any other open tournament whose `wildcardStains` match one of its tags — not in the original spec at all, see "Stains & wildcard auto-draft" in the implementation doc.

- Submit entry to tournament from the tournament detail page or the standard `/submit` flow (pass `?tournamentId=<id>`)
- On submission: create `TournamentEntry` with `approvalStatus: pending`, `submittedAt: now`
- Entry owner cannot be the tournament organizer (enforced server-side)
- User can only submit one entry per tournament
- Entry must have `idVerified: true` owner
- Notify organizer: `tournament_entry_submitted` notification → links to the organizer's review queue

---

#### Phase 7.4 — Organizer Review ✅ (done 2026-07-04, batch-reviewed during cooldown — no 30-min timer, see below)

`review.ejs` and its `GET /tournament/:id/review` route already existed as forward-compatible plumbing before today; the approve/reject POST routes that make it functional shipped today. Built per the batch-review design already noted in `tournament-implementation-plan.md`'s "What changes vs. old Phase 7/8" table (this was always the intended replacement for the 30-min timeout below, not a new divergence). **As of 2026-07-05**, review runs across both `open` and `cooldown` (not cooldown-only, as first built) so organizers of high-volume tournaments aren't forced to do it all inside the 24h window. No `missedReviews` counter, no 30-min timeout job, no `timed_out` approval status exist or are planned. Reaching the participant cap no longer auto-activates — it prompts the organizer with an explicit go-live-now/not-yet choice (see "Current State (July 5)" above). See `tournament-implementation-plan.md`'s "Phase 3 Extensions" for full detail.

- `GET /tournament/:id/review` + `views/tournaments/review.ejs` — organizer only. Lists pending entries with media preview and 30-minute countdown per entry.
- `POST /api/tournaments/:id/entries/:eid/approve` — set `approvalStatus: approved`, `reviewedAt: now`. Notify submitter.
- `POST /api/tournaments/:id/entries/:eid/reject` — set `approvalStatus: rejected`, `reviewedAt: now`. Notify submitter with rejection message.
- Organizer can optionally add a rejection note.

**Organizer review timeout job (agenda) — not built, superseded by batch review above:**
- Sweeper runs every 5 minutes. Finds `TournamentEntries` with `approvalStatus: pending` and `submittedAt < now - 30min`.
- For each: set `approvalStatus: timed_out`. Notify submitter (they can resubmit elsewhere).
- Increment `tournament.missedReviews`. If `missedReviews >= 3`:
  - Set `tournament.status: canceled`
  - Refund prize funds to organizer's wallet (`WalletTransaction` type: `tournament_prize_refund`)
  - Notify all `pending` submitters to try another tournament
  - Notify organizer their tournament was canceled

**Entry window close (agenda) — superseded, actual behavior is the `tournament_open_expiry`/`tournament_cooldown_expiry` jobs in `jobs/tournamentJobs.js`:**
- When `tournament.entryDeadline` passes: status → `cooldown`, `roundsStartAt` set to `entryDeadline + cooldownHours`.
- Or when max approved capacity is reached: same transition.
- If fewer than 2 approved entries: cancel tournament + refund.

---

#### Phase 7.5 — Round Generation + Activation

**Cooldown → Active transition (agenda job):**
- At `roundsStartAt`: generate all round-robin matchups.
- For N approved entries: create `N × (N-1) / 2` `Contest` docs, all with `tournamentId`, `status: active`, `votingDeadline: now + roundWindowHours`, visibility: `public`.
- All matchups start simultaneously.
- Set `tournament.status: active`.
- Notify all participants: tournament is live.

**Matchup generation logic:**
- Take all `TournamentEntries` with `approvalStatus: approved`
- Generate every unique pair `(A, B)` where A ≠ B
- Create one `Contest` per pair with both entries embedded

---

#### Phase 7.6 — Contest Close Hook (extend existing `close_contest` job)

When a tournament contest closes (via the existing `close_contest` agenda job), add:
1. Update `TournamentEntry.wins / losses` and `TournamentEntry.totalVotes` for both contestants
2. **Elimination check:** `if wins < Math.floor((wins + losses) * 0.66)` → `eliminated: true`, notify contestant
3. **Tie-breaker chain:** if vote counts are equal, create a replay Contest with `parentContestId` set and `windowHours` halved. Chain: 72h → 36h → 18h → 9h. After 3 replays still tied → notify organizer to decide via sudden death.
4. **Tournament close check:** if all non-tie contests are resolved → determine winners by `totalVotes` → award prizes → set `tournament.status: closed`

**Winner determination:**
- Sort non-eliminated entries by `totalVotes` descending
- 1st: highest `totalVotes`
- 2nd: second highest
- 3rd: third highest
- Podium tie → organizer sudden death decision (notification sent)
- Credit prize amounts to winners' `earnedCHL`, create `WalletTransaction` (type: `tournament_prize_payout`)

**Attribution on tie-breaker chain:**
- Attribution locks immediately when a tournament contest ends in a tie
- No new contributions accepted during replays
- Pays out 75/25 when the chain fully resolves

---

#### Phase 7.7 — Right Panel — Ongoing Tournaments ✅ (done 2026-07-03, ahead of schedule)

~~Replace the current skeleton in `views/partials/rightPanel.ejs` with real data~~ — done via `tournament-implementation-plan.md`'s Phase 9G, not this superseded Phase 7 breakdown. `injectRightPanelData` populates `activeTournaments` (limit 5, sorted by `activeAt` desc); `rightPanel.ejs` renders thumbnail-or-trophy-icon, name, and USD-formatted prize pool, linking to `/tournament/:id`. Shipped early since it only needed `Tournament.status: 'active'` to exist as a state, not real match data.

---

#### Phase 7.8 — Tournament Notifications

New notification types to add to the enum and render in `/notifications`:

| Type | Trigger | Recipient |
|---|---|---|
| `tournament_entry_submitted` | User submits entry | Organizer |
| `tournament_entry_approved` | Organizer approves | Submitter |
| `tournament_entry_rejected` | Organizer rejects | Submitter |
| `tournament_entry_timed_out` | Review window expired | Submitter |
| `tournament_canceled` | 3 missed reviews | Organizer + all pending submitters |
| `tournament_live` | Status → active | All approved participants |
| `tournament_eliminated` | Entry eliminated | Contestant |
| `tournament_tiebreaker` | Replay created | Both contestants |
| `tournament_tiebreaker_sudden_death` | 3 replays all tied | Organizer |
| `tournament_closed` | All contests resolved | All participants |
| `tournament_prize_awarded` | Winner determined | 1st/2nd/3rd |

---

#### Phase 7 Exit Criteria

A user can create a tournament, fund it, submit entries, review them as organizer, run a full round-robin, and determine winners by total votes — with automatic lifecycle transitions and correct prize payouts.

---

### Phase 8 — Admin Tournament Management ✅ mostly done (2026-07-06/7, uncommitted) — no review queue, see below

#### Pages

- **All Tournaments list:** ✅ `GET /admin/tournaments` + `views/admin/tournaments/index.ejs` — filterable by status (`open|cooldown|active|closed|canceled`), not paginated (capped at 200, sorted newest first) and not filterable by type (there's only one tournament type now — `pending_funds`/`pending_review`/`type: platform` vs `user_organized` never materialized as a real distinction in the live schema). Shows name, organizer, approved participant count, prize pool, status.
- **Tournament detail:** ✅ `GET /admin/tournaments/:id` + `views/admin/tournaments/detail.ejs` — full read-only view: groups (with members), matches, jury count, approved count, organizer details. Also has a "Force Cancel" action (`POST /admin/tournaments/:id/cancel`, shown only for `open`/`cooldown`) that calls the existing `cancelTournament` job helper and logs a `tournament_force_canceled` audit event.
- **User-organized review queue:** ❌ not built, and not applicable as specced — this assumed a `status: pending_review` state gating user-organized tournaments before they go live, but the live `Tournament.status` enum never grew that state (organizer-created tournaments go straight to `open`); there's nothing to review-queue. `views/admin/tournaments/review.ejs` and its sidebar "Review Queue" link were deleted rather than built out.

#### Admin sidebar

"All Tournaments" is present (founder + superadmin). "Review Queue" was removed — see above.

#### Exit criteria

Admin can browse all platform tournaments, drill into full tournament state (groups/matches/jury), and force-cancel a stuck `open`/`cooldown` tournament. Pre-launch review of user-organized tournaments was dropped as a concept, not deferred.

---

### Phase 9 — Financial System Completion

#### Phase 9.1 — CCBill Integration

Replace the stub `/wallet/checkout` with a real CCBill redirect. All other wallet infrastructure (WalletTransaction, ContestContribution, ContestPayout, MonthlySnapshot, background jobs) remains unchanged.

**Scope:**
- Verify CCBill ToS covers the platform's content category + escrow/payout requirements
- Implement CCBill redirect from `/wallet/checkout` (pass package, amount, user identifier)
- Handle CCBill callback/webhook: verify signature, credit `purchasedCHL`, write `WalletTransaction`
- Error handling: failed payment → flash + redirect back to `/wallet/topup`
- Tournament prize fund commitment via same CCBill flow (organizer pays at creation time)

**Note:** The fake stub (`POST /wallet/checkout` → immediate credit) and the tournament prize commitment stub (wallet deduct) both remain in place until CCBill is live and verified.

---

#### Phase 9.2 — Apron Trophy System

Contest trophies awarded at contest close based on margin of victory. Applies to both standalone and tournament contests.

**New model — `Apron`:**
```js
{
  userId:       ObjectId,  // ref: users — winner
  contestId:    ObjectId,  // ref: contests
  tier:         String,    // 'flannel' | 'denim' | 'velvet'
  value:        Number,    // in cents: 1000 (flannel) | 2000 (denim) | 5000 (velvet)
  paidOut:      Boolean,   // default: false
  paidOutAt:    Date,
  createdAt:    Date,
}
```

Indexes: `{ userId, tier }`, `{ contestId }`, `{ userId, paidOut }`

**Award logic (extend `close_contest` job):**
After setting `winnerEntryId`, check:
1. Winner must have ≥ 5,000 votes
2. `gap = (winnerVotes - loserVotes) / loserVotes`
3. Tier: ≥ 110% → Velvet, ≥ 68% → Denim, ≥ 49% → Flannel
4. Special case: winner ≥ 5,000 and loser < 5,000 → automatic Flannel
5. If no tier qualifies: no Apron awarded
6. Create `Apron` doc, fire `apron_awarded` notification to winner

**Profile display:**
- Show lifetime Apron counts by tier on the winner's profile (all viewers)
- Only the highest tier from each contest counts — no stacking multiple tiers per contest

**Monthly auto-settlement (agenda job — `settle_aprons`):**
- Runs on the 1st alongside `snapshot_monthly_balances`
- For each user: group unpaid Aprons by tier
- If count meets tier minimum (Flannel: 5, Denim: 10, Velvet: 20): credit `earnedCHL` with tier value × count, mark docs as `paidOut`
- If below minimum: carry over (no action)
- Write `WalletTransaction` (type: `apron_payout`) per tier settled
- Fire `apron_settled` notification

**New notification types:** `apron_awarded`, `apron_settled`

---

#### Phase 9.3 — Vote Economics (free vote 12h window + paid votes)

Currently every user gets one vote per contest freely. The designed system has a 12-hour free vote reset across all contests, plus paid votes using chillies.

**Schema changes:**
- `User.lastFreeVoteAt: Date` — tracks when the free vote was last used (null if never used)
- `ContestVote.isPaid: Boolean` (default `false`) — whether chillies were spent
- `ContestVote.amountCHL: Number` (default `0`) — chillies spent on a paid vote

**Free vote logic:**
- On vote: check if `now - user.lastFreeVoteAt > 12h` (or `lastFreeVoteAt` is null)
- If eligible: cast free vote, set `User.lastFreeVoteAt = now`
- If not eligible: must cast paid vote (spend chillies). User sees "Your free vote resets in Xh Ym" on the contest page.

**Paid vote logic:**
- Amount is user-determined (any amount ≥ 1 chilli)
- Debit wallet (`purchasedCHL` first, then `earnedCHL`), write `WalletTransaction` (type: `paid_vote`)
- Paid votes do NOT affect the vote count differently from free votes — all votes are equal in determining the winner
- Attribution (ContestContribution) remains separate

**Vote switching:**
- User changes their vote while contest is live
- Previous vote removed. If it was a free vote: `User.lastFreeVoteAt` reset to what it was before (or null). If paid: chillies refunded to wallet.
- New vote cast under normal rules

**Note:** This phase depends on CCBill being live (Phase 9.1) since paid votes require a funded wallet. If 9.1 slips, implement the free vote 12h window first (no CCBill dependency) and add paid votes once CCBill lands.

---

### Phase 10 — Polish + Miscellaneous

#### Phase 10.1 — Admin Analytics Page

`GET /admin/analytics` + `views/admin/analytics.ejs` — founder + superadmin.

Metrics to expose:
- New users (by day/week/month)
- Entries submitted (by day/week/month)
- Active contests count
- Contest close rate (closed vs voided)
- Total chillies in circulation (sum of all `purchasedCHL + earnedCHL`)
- Top-rated entries this week
- Most active users (by contest participation)

Data sourced from direct MongoDB aggregations — no external analytics service.

---

#### Phase 10.2 — Retag

`models/Retag.js` is scaffolded but not wired. Defer until explicitly prioritized — the mechanic isn't documented in the platform spec well enough to build without a design session.

---

#### Phase 10.3 — Search ✅ (done 2026-07-01)

~~Wire up the existing `/search` stub with real query logic.~~

**Route:** `GET /search?q=<query>&type=<entries|users|stains>`

**Results:**
- **Entries:** search `title`, `caption`, `tags` (text index already on Entry model). Show as entry cards.
- **Users:** search `username.value`, `displayName.value` (prefix match). Show as user rows with follow state.
- **Stains (tags):** aggregate most-used tags matching the query. Show as clickable stain pills that re-run the search scoped to that tag.

**UI:** tabbed results (Entries | People | Stains), search input in the existing header. No infinite scroll for July — paginated results with "Show more" is fine.

**Affinity:** fire `updateStainAffinity` when a user clicks through from a stain result (`signal = 0.15`).

---

#### Phase 10.4 — Dependency Phone-Home Audit

Triggered 2026-07-02: noticed `dotenv` (v17.4.2) prints self-promotional console output on every boot and bundles agent-targeted `skills/*/SKILL.md` files nudging toward its paid sibling product `dotenvx`/`vestauth`. Confirmed that specific package isn't actually wired into anything (no `dotenvx`/`vestauth` in `package.json` or source — just marketing text), but it's a live example of a dependency embedding this kind of content, worth a broader look.

**Scope:**
- Audit `package.json` dependency tree for packages that make network calls beyond their stated purpose (telemetry, analytics pings, update checkers) not disclosed as opt-in
- Check for postinstall/preinstall scripts across `node_modules` that could exfiltrate data or run unexpected code
- Flag any bundled `SKILL.md` / agent-instruction files shipped inside dependencies (beyond the known `dotenv` one) that could influence AI-assisted development sessions
- Not urgent — no known compromise, just hygiene. Low priority, end of July or later.

---

## What Is NOT In July

| Feature | Reason |
|---|---|
| Open Challenges | Post-MVP — explicitly deferred after tournaments are solid |
| Marketplace | Post-MVP |
| Ratings Challenge | Removed from design — replaced by 3-replay chain |
| Apron audience filter for Announcements | Requires Apron data to exist first — wire once Phase 9.2 is done (post-month) |
| **Private Tournaments** | Post-MVP — fully designed and documented in `tournament-spec.md` (see "Private Tournaments" section). Invite-only, not publicly discoverable, max 12 participants, permanent result privacy (prizes still show on winner profiles). Do not implement until explicitly prioritized. |

---

## End-of-July Target

By July 31, the platform should support:
- Full user-organized and platform tournament lifecycle end-to-end
- Admin tournament review and management
- Real CCBill payment for wallet top-ups and tournament prize commitments
- Apron trophies awarded at contest close with monthly auto-settlement
- 12-hour free vote window + paid vote support
- Search wired with real results
- All pre-launch test bypasses reverted

The platform will be functionally complete and ready for controlled launch.
