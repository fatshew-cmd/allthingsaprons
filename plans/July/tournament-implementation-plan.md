# Tournament Implementation Plan — Detailed

> Supersedes Phase 7/8 in `july-action-plan.md`.
> Spec source: `plans/July/tournament-spec.md`.
> Written against actual codebase structure as of 2026-07-02.

**Status (as of 2026-07-06, later — currently uncommitted in the working tree): Phase 1 done, Phase 2 done and substantially extended beyond spec (edit wizard, jury invite/accept/decline, jury replace, self-cancel), Phase 3 substantially reworked (candidate submission moved to upload-time, no more post-hoc "pick an entry" picker; organizer approve/reject run on a rolling basis across both `open` and `cooldown`, not cooldown-only — see "Phase 3 Extensions" below), Phase 4 built (group assignment + round-robin group match scheduling, wired into `activateTournament`), Phase 5 built (group-stage match results recorded, groups resolve to advancement/elimination — see "Phase 5 — As-Built"), Phase 6 built the same commit as Phase 5 (cross-group-seeded knockout bracket auto-generates and progresses round by round — see "Phase 6 — As-Built"). **Phase 7 (tie resolution) is now built** — a genuine match tie (group or knockout) fires `initiateTieResolution`, which notifies accepted jurors and opens a 6h voting window; a juror casts a vote via `POST /api/tournaments/:id/matches/:matchId/jury-vote`, and reaching quorum (3 votes) resolves the match immediately through `resolveJuryVote`. If 6h passes without quorum, `tournament_jury_expiry` increments `missedVotes` on every non-voting *accepted* juror and hands off to the organizer for 3h (`tournament_tie_organizer` notification, `POST /api/tournaments/:id/matches/:matchId/organizer-vote`); if the organizer also doesn't act, `tournament_organizer_vote_expiry` resolves it with a platform coin flip — no tie blocks progression more than 9h total, exactly as specced. See the new "Phase 7 — As-Built" note below the Phase 6 section for full as-built detail, including several divergences from this doc's original 7A–7G draft (route URL shape, shared view partial, where `status`/`winnerId` actually get written). An initial gap where the shared vote picker showed each entry's real title — missing the "no entry titles" blind-judging requirement — was caught and fixed same-day (see the Phase 7 as-built note). Phase 8 (prize payout, closing the tournament) is not started — see the gap called out below.**

- **Phase 1 (schema) — done.** `models/Tournament.js`, `models/TournamentEntry.js`, `models/TournamentGroup.js`, `models/TournamentMatch.js`, `models/TournamentJury.js`, `models/TournamentJuryVote.js` all exist and are mounted in `server.js`. `Tournament` also picked up fields beyond the original 1A spec: `thumbnailUrl` (required), `visibility` (`'public' | 'private'`, default `'public'`) — see the Step 1 section below and the "Private Tournaments" note in `tournament-spec.md` — and `viewCount` (default `0`; see "Phase 9 Extensions" below for a flagged gap — it's currently not incremented anywhere). `Tournament.eligibilityCriteria` gained an `isFollower` field option beyond the original 7 (eq/true only — "must follow the organizer"). `TournamentJury` gained `status: 'pending' | 'accepted' | 'declined'` (default `'pending'`) and `respondedAt` — jury membership is now an invite a user accepts/declines, not an unconditional assignment (see the new jury invite/manage flow below, which didn't exist in the original spec at all). `User.js` gained a `{ idVerified: 1, accountStatus: 1 }` index (perf support for `requireOrganizerEligibility`'s checks). `WalletTransaction.type` enum has `'tournament_prize_refund'`; `WalletTransaction.source` enum gained `'tournament_cancel'` and `'tournament_edit'` (2026-07-05 — `cancelTournament`/`finalizeTournamentEdit` already wrote these values; now formally declared, closing the same kind of gap `tournament_prize_refund` had). **New 2026-07-04/05:** `Tournament.stains` (`[String]`, max 6, free-form like an entry's tags, purely descriptive/browsable) and `Tournament.wildcardStains` (`[String]`, max 2 — see "Stains & wildcard auto-draft" under Phase 3 Extensions below) and `Tournament.stage` (`'group' | 'knockout' | 'finale'`, default `null`, set to `'group'` by `activateTournament`, `'knockout'` once `generateKnockoutBracket` runs, `'finale'` once the Final/3rd-place matches are created — see "Phase 6 — As-Built" below). `Tournament` also gained `lastKnockoutRoundAdvanced` (`'R16' | 'QF' | 'SF'`, default `null`, 2026-07-06) — an atomic-claim field guarding bracket-round advancement, not a display field. `TournamentEntry` gained `autoSubmitted` (`Boolean`, default `false`) to distinguish a wildcard-drafted candidate from one the user explicitly submitted.
- **Phase 2 (creation flow) — done and extended well beyond spec.** `middleware/requireOrganizerEligibility.js` and `routes/tournaments.js` exist and are mounted. Built behavior diverges from the original 2A/2C spec in several places — see those sections below for the as-built details (6 eligibility checks not 5, redirect+flash instead of JSON 403, thumbnail + visibility + live name-uniqueness check added to Step 1, tighter length limits, session-persisted draft with step-resume). **New beyond original spec, built 2026-07-03 — see "Phase 2 Extensions" section immediately below Phase 2 exit criteria:** a 5th wizard step ("Review") before finalize; a full **edit wizard** (`GET/POST /tournament/:id/edit` + `/edit/step1`–`/step5`) letting the organizer revise a live `open`/`cooldown` tournament, with wallet true-up, criteria re-checks that drop now-ineligible candidates, and jury diffing; an organizer **self-cancel** route (`POST /tournament/:id/cancel`) that now also releases (deletes) every `TournamentJury` record outright on cancellation (2026-07-05 — no penalty is owed since jurors never actually reached the point of voting); a **jury invite/accept/decline** flow (`GET /tournament/:id/jury-invite`, `POST /tournament/:id/jury-invite/respond`); and a **jury management/replace** flow for organizers (`GET /tournament/:id/jury/manage`, `POST /tournament/:id/jury/replace`) usable while `status: 'open'`. **2026-07-05:** `GET /tournament/:id` now 404s for `status: 'canceled'` tournaments (previously stayed viewable); on the detail page, the organizer's "Edit tournament" action moved into the main CTA row (a full card, was previously a small icon button) and "Cancel" was demoted to the small icon button in the secondary row (was previously the main-row card CTA) — a pure UI swap, no behavior change to either route.
- **Phase 9 (frontend) — partially done, ahead of schedule in places.** `views/tournaments/index.ejs`, `create.ejs` (now 5 steps + edit mode), `detail.ejs` (organizer actions — cancel, edit, manage jury — are wired, plus a full social layer) are live. **9G (right panel) is done** — `middleware/injectRightPanelData.js` populates `activeTournaments` (limit 5) and `views/partials/rightPanel.ejs` renders it — despite Phase 9 nominally following Phases 3–8, this had no dependency on match generation so it shipped early. **New 2026-07-04, not in the original spec at all — see "Phase 9 Extensions" section below 9C:** tournament comments (nested one level, like the platform `Comment` model), comment likes/dislikes, comment reports (auto-hide pending moderation), a tournament-level watch/subscribe toggle, and a tournament-level report action. New views not in the original 9A list: `views/tournaments/jury-invite.ejs`, `views/tournaments/jury-manage.ejs`, and a shared `views/partials/avatarJsHelpers.ejs` script partial. **New 2026-07-05:** `views/tournaments/index.ejs` browse cards rebuilt (bigger thumbnail, organizer avatar/name/username row with an inline Follow/Following button sourced from a per-card `isFollowing`/`isSelf` flag the route now computes, view count, participant size, live stage label when `active`, first-prize amount, a live-updating deadline countdown for `open`/`cooldown` cards, a "Closed Nd ago" label for closed cards, and stain/wildcard-stain badges); `views/tournaments/detail.ejs` and `index.ejs` both render `wildcardStains` as a distinct badge (tag icon + copy-to-clipboard button) from plain `stains` (shown as plain `#text`); `views/tournaments/review.ejs` gained a search box (by username) and a sort dropdown (recent/oldest/rating/ratingCount/followers), plus a "Wildcard" badge on auto-drafted candidate rows. `jury-vote.ejs` still exists only as a page shell (renders, no backing POST action). **New 2026-07-05 (later):** `detail.ejs` now renders a **Groups** section (horizontally-scrollable cards per `TournamentGroup`, showing each member's avatar/name/entry thumbnail) and a **Contests** section (match cards keyed off `TournamentMatch.status` — `scheduled`/`active`/`tie`/`closed` — showing the scheduled date for not-yet-open matches and an `isWinner` highlight driven by `TournamentMatch.winnerId`; that highlight was dead code when this line was written but is now live, since Phase 5 (below) started writing `winnerId` on every non-tied match close). No standings table, leaderboard, or bracket/tree visualization exists yet — knockout matches (Phase 6, below) render in this same flat list with no round grouping or labels — just a generic `boxicons:bracket` empty-state icon when there are no matches at all. A whole-tournament loop-in toggle (`TournamentLoop`, renamed from `TournamentWatch`) ships alongside a new, more granular **per-candidate loop-in** (`TournamentEntryLoop`, `POST /tournament/:id/entry/:teId/loop-in` — not a rename, a wholly new capability) so a viewer can follow one contestant's match outcomes specifically; both notify via the new `utils/tournamentEntryLoop.js`'s `notifyEntryLoopedIn` helper when a match goes live or closes. **2026-07-06 (early, committed in `0dfb964`):** `review.ejs` candidate rows redesigned into cards — avatar/username/follow-toggle button, a followers/avg-rating/nominations stat row, a larger entry thumbnail with caption and rating/take-on-count icons, approve/reject moved under the stat column — and `detail.ejs`'s entry rail now pins the viewer's own entry outside the horizontal-scroll container (it previously scrolled away with everything else via `sticky left-0`, which didn't survive fast scrolling well). **Later the same day:** `detail.ejs`'s Groups section extended again to show each member's W-L record, `groupPoints`, and an Advanced/Eliminated tag once a group resolves (see "Phase 5 — As-Built" below).
- **Phase 3 (open phase & candidate management) — reworked 2026-07-05, see "Phase 3 Extensions" below for the full as-built shape.** Candidate submission is no longer a standalone action on an already-uploaded entry — it now happens at the moment an entry is uploaded (either the uploader explicitly targets an open tournament, or a fresh entry auto-drafts into any open tournament whose `wildcardStains` match one of its tags). Organizer approve/reject now runs across both `open` and `cooldown` (previously cooldown-only), and reaching the participant cap no longer silently skips (or fails to skip) a phase — it surfaces an explicit organizer choice (go live now via the new `advance-now` route, or decline via the new `revert` route) in both phases alike. Tournament `ratingAvg`/`ratingCount` eligibility criteria now evaluate a candidate's platform-wide weighted curator rating (`utils/weightedRating.js`) rather than any specific entry's stats, since a brand-new upload has no rating history of its own. `utils/tournamentEligibility.js` was never created as its own file — its job is split between `utils/estimateParticipantPool.js` (organizer-facing pool estimate) and the new `utils/tournamentSubmission.js` (actual submission + pre-upload preflight). `utils/tournamentScheduler.js` still doesn't exist — no group generation, match scheduling, standings, knockout progression, tie resolution, or prize distribution exists yet.
- **Phase 4 done as of 2026-07-05 (later); Phases 5 and 6 done as of 2026-07-06 (see below); Phases 7–8 not started.** `utils/tournamentScheduler.js` now exists (140 lines, exports `generateGroups`, `generateGroupMatches`, `circleMethodRounds`) and is fully wired: `activateTournament` (in `jobs/tournamentJobs.js`) atomically flips `cooldown → active`, stamps `stage: 'group'`, then calls `generateGroups` (Fisher-Yates shuffle, chunked into `groupSize`-sized `TournamentGroup` docs, back-filling `groupId` onto each member's `TournamentEntry`) followed by `generateGroupMatches` per group — a standard "circle method" round-robin (diverges from this doc's original greedy slot-scheduler draft in 4C below, but delivers the same guarantee: nobody double-booked in a round, in the minimum possible number of rounds). The first round's `Contest`/`TournamentMatch` docs are created `active` immediately; later rounds are `scheduled` and opened by a new agenda job, `open_tournament_match` (not in the original Phase 4 draft), which flips them active and gives the `Contest` a fresh 24h `votingDeadline` — relying on the existing 15-min contest sweeper to close it, rather than explicitly scheduling `close_contest` the way 4C's draft assumed. `activateTournament` is reachable two ways: the `tournament_cooldown_expiry` agenda job, and the organizer-triggered `POST /api/tournaments/:id/advance-now` (this doc's draft 4E assumed a `/launch` route reachable only from `cooldown`; the real route is named `advance-now`, lives in `routes/api.js`, and works from `open` or `cooldown` alike — see "Phase 3 Extensions" above).

  **Phase 5 — As-Built (2026-07-06).** `jobs/contestJobs.js`'s `closeContest` now fires a fire-and-forget hook into `jobs/tournamentJobs.js`'s `handleTournamentMatchClose(contestId, winnerEntryId)` whenever a closing contest has a `tournamentId`. It writes the result onto `TournamentMatch` (`status`/`winnerId`/`loserTournamentEntryId`) and `$inc`s `wins`/`losses`/`totalVotes`/`groupPoints` on the two `TournamentEntry` docs, then calls `checkGroupComplete`/`resolveGroup` (also in `tournamentJobs.js`). `resolveGroup` ranks a group's members (`groupPoints` → `ratingAvg` → `ratingCount` → `totalVotesInGroup`), assigns `groupRank`/`eliminated`, fires `tournament_group_advance`/`tournament_eliminated` notifications (both added to `Notification`'s type enum, with matching cases in `views/notifications.ejs` — which also picked up the previously-missing cases for `tournament_live`/`tournament_entry_match_live`/`tournament_entry_match_closed`, a pre-existing gap fixed incidentally), and marks the `TournamentGroup` `complete`. `detail.ejs`'s Groups section now renders each member's W-L/points/advanced-eliminated status.

  One thing was deliberately **not** built this pass, by explicit scope decision: a genuine match tie (`winnerEntryId` null) is flagged `status: 'tie', tieStatus: 'jury_pending'` and left there — no jury/organizer/coin-flip chain exists yet (that's still Phase 7), so a tied match (and its whole group) stays blocked until Phase 7 ships. The one exception: a 2-way tie for a qualifying spot *is* handled (plan section 5E) via an ordinary extra H2H tiebreaker match (`isTiebreakerMatch: true`), since that's just another vote, not a jury dispute; a 3+-way boundary tie, or a tiebreaker match that itself ties, is also left flagged/unresolved.

  **Phase 6 — As-Built (2026-07-06, same commit as Phase 5).** `resolveGroup`'s tail (in `jobs/tournamentJobs.js`), once every `TournamentGroup` for a tournament is `complete`, calls `generateKnockoutBracket(tournamentId)` (new in `utils/tournamentScheduler.js`). It atomically claims the `'group' → 'knockout'` stage transition (`findOneAndUpdate` guarded on `stage: 'group'`, so two groups finishing in the same sweep can't both trigger it), derives the round label from field size (`groupCount * 2` → `Final`/`SF`/`QF`/`R16`, covering all five valid tournament sizes 4/8/12/16/24), and cross-group-seeds the bracket — group *X*'s rank-1 plays group *Y*'s rank-2 and vice versa, avoiding an immediate rematch of two entries that already played each other in the round-robin (a lone leftover group, `groupCount === 1`, pairs its own rank-1 vs rank-2 directly, which for a 4-player tournament *is* the Final). Each pairing becomes a real `Contest`/`TournamentMatch` (`stage: 'knockout'`), opened immediately with a 24h `votingDeadline` scheduled via the existing `close_contest` agenda job — no new `open_tournament_match`-style deferred-open step, since a full knockout round always opens all at once. A new `tournament_knockout_started` notification fires to both entries per match (added to `Notification`'s enum) alongside the existing `tournament_entry_match_live` loop-in notification — **but `views/notifications.ejs` was never given a `case 'tournament_knockout_started'`, so it silently falls through to the generic "New notification"/bell-icon default; this needs a display case added.**

  Progression after that lives in `handleTournamentMatchClose` → `handleKnockoutMatchClose` (`jobs/tournamentJobs.js`), fired the same way group matches are (via `closeContest`'s fire-and-forget hook, now branching on `match.stage`). It records win/loss and `knockoutRound` onto both `TournamentEntry` docs, flags the loser `eliminated: true` (except an SF loser, who still has the 3rd-place match ahead), and once every match in the current round is `closed`, atomically claims advancement via `Tournament.lastKnockoutRoundAdvanced` (new field, `findOneAndUpdate` guarded so two matches closing in the same sweep can't both fan out) and calls `createBracketMatch` for each advancing pair — `R16 → QF`, `QF → SF`, and `SF → Final` + `SF → 3rd` simultaneously (stamping `stage: 'finale'` on the tournament). A knockout-stage tie hits the exact same `status: 'tie'`/`jury_pending` flag as a group-stage tie — still blocked on Phase 7, no special-cased handling for knockout. Once `Final`/`3rd` close, `handleKnockoutMatchClose` returns without doing anything further — **Phase 8 (`closeTournament`, prize payout, `Tournament.status → 'closed'`) still doesn't exist**, so a tournament that finishes its bracket today just stops there with no podium, no `prizes.winnersSet`, no `earnedCHL` credit.

  On the frontend, `detail.ejs`'s "Contests" section (referenced above) still renders every `TournamentMatch` as one flat list regardless of `stage`/`knockoutRound` — knockout matches show up in it once created, but there's no bracket/tree grouping, no round labels, and no visual separation from group-stage matches. The "no bracket/tree visualization exists yet" line above is still accurate even though bracket *data* now exists.

  **Phase 7 — As-Built (2026-07-06, later; currently uncommitted).** `handleTournamentMatchClose` (`jobs/tournamentJobs.js`) no longer just flags a tie and stops — the tie branch now atomically claims `status → 'tie'` (`findOneAndUpdate` guarded on `status: { $nin: ['tie', 'closed'] }`, so a fire-and-forget call racing `sweeper.js`'s crash-recovery reconciliation can't double-fire) and calls the new `initiateTieResolution(matchId)`, which notifies every `accepted` `TournamentJury` member with a `tournament_tie_jury` notification (payload never reveals which entries are tied) and schedules a new `tournament_jury_expiry` agenda job 6h out.

  A juror votes via `POST /api/tournaments/:id/matches/:matchId/jury-vote` (`routes/api.js`) — **note the URL shape is `/matches/:matchId/jury-vote`, not this doc's original draft `/jury-vote/:matchId`**. It verifies the match is actually `tie`/`jury_pending`, verifies the caller has an `accepted` `TournamentJury` record, records a `TournamentJuryVote` (relying on its `{matchId, jurorId}` unique index to reject a double-vote with a friendly error rather than checking existence first), and fires a `tournament_jury_vote_received` notification to each contestant with only *their own* running vote count (never the opponent's, never who voted) so the tally can't be reconstructed from the two notifications together. Once total votes reach quorum (3), it calls the new `resolveJuryVote(matchId, votes)` (the route passes the votes it already fetched, to avoid a second identical query) — this tallies the votes, and if one side has strictly more, atomically claims `tieStatus: 'jury_pending' → 'resolved'`, cancels the `tournament_jury_expiry` job, and calls `handleTournamentMatchClose(contestId, winnerEntryId)` again with the actual winner (this second call is what actually sets `match.status = 'closed'`/`winnerId`/loser bookkeeping — `resolveJuryVote` itself never writes those fields, diverging from this doc's original 7C draft, which had `resolveJuryVote` set them directly). A genuine 3-way vote split at exactly quorum (which "shouldn't happen" per the original design note) is left tied for the organizer stage rather than erroring.

  `tournament_jury_expiry` (new agenda job, `jobs/tournamentJobs.js`) fires at the 6h mark: it atomically claims `tieStatus: 'jury_pending' → 'organizer_pending'` first (so a juror's vote reaching quorum in the same instant can't race it), then increments `missedVotes` on every `accepted` juror who never voted — **not every juror regardless of status, as this doc's original 7D draft had it**, since a `pending`/`declined` juror was never eligible to vote in the first place and shouldn't be penalized. It notifies the organizer (`tournament_tie_organizer`, linking to a new `/tournament/:id/organizer-vote/:matchId` page) and schedules `tournament_organizer_vote_expiry` 3h out.

  The organizer decides via `GET /tournament/:id/organizer-vote/:matchId` (`routes/tournaments.js`, organizer-only, requires `tieStatus: 'organizer_pending'`, redirects with a flash if either contestant's `Entry` was deleted mid-tournament) + `POST /api/tournaments/:id/matches/:matchId/organizer-vote` — same URL-shape divergence as the juror route. It atomically claims `tieStatus: 'organizer_pending' → 'resolved'`, cancels the pending expiry job, and calls `handleTournamentMatchClose` with the organizer's pick. If the organizer doesn't act in time, `tournament_organizer_vote_expiry` claims the same transition and calls `handleTournamentMatchClose` with a `Math.random() < 0.5` coin flip — so a tie can never block progression more than 9h total (6h jury + 3h organizer), exactly per spec.

  On the frontend, the two vote pages share one new partial, `views/partials/tieBreakPicker.ejs` (not in the original 9F plan, which only drafted a standalone `jury-vote.ejs`) — `views/tournaments/jury-vote.ejs` was gutted down to a thin wrapper passing `endpoint: 'jury-vote'`, and a new `views/tournaments/organizer-vote.ejs` passes `endpoint: 'organizer-vote'`. The picker initially showed each entry's real title alongside its thumbnail, missing the 9F draft's "No usernames. No entry titles. Just the media" requirement — **fixed same-day**: the title spans now render a static "Entry A"/"Entry B" label instead of `entry.title`, so neither juror nor organizer sees anything but the media. Three new notification types (`tournament_tie_jury`, `tournament_tie_organizer`, `tournament_jury_vote_received`) were added to `Notification`'s enum and all three have display cases in `views/notifications.ejs` (icons: `boxicons:group`, `boxicons:crown`, `boxicons:bar-chart-alt-2`) — unlike the still-unaddressed `tournament_knockout_started` gap from Phase 6, these three did not get missed.

  `resolveGroup`'s unresolvable-boundary-tie warning (3+-way group-ranking ties) was reworded to clarify that the jury system only ever breaks a *match* tie, not a group-ranking tie beyond the already-handled 2-way case — that gap is unchanged, just described more precisely now.

  `views/admin/tournaments/index.ejs` and `review.ejs` (the admin one) are still skeletons reflecting the old, superseded design (admin review queue, `pending_review`) and still need repurposing per Phase 9I — this is distinct from the now-functional player-facing `views/tournaments/review.ejs`. `routes/tournaments.js`'s `loadTournamentPlacements` helper (derives 1st/2nd/3rd from `Final`/`3rd`-place `TournamentMatch` docs, wired into the detail route for `status === 'closed'`) and `routes/pages.js`'s profile trophy counters (`firstPrizes`/`secondPrizes`/`thirdPrizes`, keyed off `eliminated`/`knockoutRound`) are now genuinely forward-compatible dead code rather than unreachable-in-principle: `Final`/`3rd` `TournamentMatch` docs and `knockoutRound` values are actually written now, but `Tournament.status` never reaches `'closed'` so `loadTournamentPlacements`'s gate never fires and the profile counters never see a `knockoutRound` past what's set — both still need Phase 8 to ever activate.

  Phase 8 (prize payout — `Tournament.status` never reaches `'closed'`, `prizes.winnersSet` is never set, no `earnedCHL` credit exists; the only tournament-related wallet movement live today is the prize-pool *refund* on cancellation, plus the jury-ban step from 7G, which hasn't been wired since it was drafted to run inside `closeTournament`) remains fully unbuilt.

Next step: Phase 8 (prize payout + closing the tournament, including 7G's post-close jury ban for jurors with `missedVotes > 0`) so a finished bracket actually produces a podium and credits winners.

---

## Codebase reference

```
models/           — Mongoose schemas
routes/api.js     — All JSON API routes
routes/pages.js   — All page routes (GET, returns HTML)
routes/wallet.js  — Wallet-specific routes (mounted at /wallet)
jobs/agenda.js    — Agenda instance (shared singleton)
jobs/contestJobs.js — close_contest / void_expired_contest logic
jobs/sweeper.js   — 15-min sweeper pattern (copy for tournament sweeper)
jobs/walletJobs.js  — Monthly payout jobs
middleware/requireAuth.js     — Must be logged in
middleware/requireDomain.js   — Admin role gate
middleware/injectRightPanelData.js — Adds rightPanel data to res.locals
utils/            — Pure logic utilities (no Express, no Mongoose models if avoidable)
views/            — EJS templates
views/partials/   — Reusable partials
views/admin/tournaments/ — Already has index.ejs and review.ejs (skeletons)
```

---

## Phase 1 — Schema: Revise Existing Models + Create 4 New Models

### 1A. Revise `models/Tournament.js`

**What to remove:**
- `type` field (`platform | user_organized`) — tournaments are always user-organized now
- `entryWindowHours` — replaced by fixed `openDeadline`
- `cooldownHours` — replaced by fixed 24h
- `roundWindowHours` — H2H window is always 24h
- `fundsHeld` — replaced by `prizePool.funded`
- `reviewStatus` — admin review step removed
- `missedReviews` — removed (different cancellation logic)
- `entryDeadline`, `roundsStartAt` — replaced by `openDeadline`, `cooldownDeadline`, `activeAt`
- `prizeSlotSchema` with `entryId` embedded — prizes don't have an entry until close

**What to change:**
- `status` enum: remove `pending_funds`, `pending_review` → new enum: `'open' | 'cooldown' | 'active' | 'closed' | 'canceled'`
- `prizes` schema: change to `{ first: Number, second: Number, third: Number }` (amounts in CHL, not cents)
- `participantCount` → rename to `size`, add enum validation `[4, 8, 12, 16, 24]`

**What to add:**
```js
size:                 { type: Number, enum: [4, 8, 12, 16, 24], required: true }
groupSize:            { type: Number, required: true }   // derived at creation: 3 for 12/24, 4 for 4/8/16
groupCount:           { type: Number, required: true }   // size / groupSize

prizes: {
  first:  { type: Number, required: true, min: 1000 },  // in CHL
  second: { type: Number, required: true, min: 400 },
  third:  { type: Number, required: true, min: 100 },
  funded: { type: Boolean, default: false },             // true once SB deducted
}

eligibilityCriteria:  { type: [criteriaSchema], default: [] }
// criteriaSchema: { field: String, operator: String, value: mongoose.Schema.Types.Mixed }
// field options: 'ratingAvg' | 'ratingCount' | 'followerCount' | 'age' | 'sex' | 'entryCount' | 'accountAgeDays'
// operator options: 'gte' | 'lte' | 'eq'

openDeadline:         { type: Date, required: true }     // createdAt + 3 days
cooldownDeadline:     { type: Date }                     // set when open phase closes
activeAt:             { type: Date }                     // set when cooldown resolves

cancelReason:         { type: String, default: null }    // 'insufficient_candidates' | 'cooldown_expired' | 'organizer_action'

prizes.winnersSet:    { type: Boolean, default: false }  // true once 1st/2nd/3rd are determined
```

**Updated indexes:**
```js
tournamentSchema.index({ status: 1 });
tournamentSchema.index({ createdBy: 1 });
tournamentSchema.index({ openDeadline: 1, status: 1 });
tournamentSchema.index({ cooldownDeadline: 1, status: 1 });
```

---

### 1B. Revise `models/TournamentEntry.js`

**What to keep:** `tournamentId`, `entryId`, `userId`, `approvalStatus`, `wins`, `losses`, `totalVotes`, `eliminated`, `submittedAt`, `reviewedAt`

**What to remove:** nothing

**What to add:**
```js
groupId:       { type: mongoose.Schema.Types.ObjectId, ref: 'TournamentGroup', default: null }
groupPoints:   { type: Number, default: 0 }   // wins in group stage only
groupRank:     { type: Number, default: null } // 1 or 2 — populated after group resolves
knockoutRound: { type: String, default: null } // 'R16' | 'QF' | 'SF' | '3rd' | 'Final' — how far they got
```

**Updated indexes:**
```js
tournamentEntrySchema.index({ tournamentId: 1, entryId: 1 }, { unique: true });
tournamentEntrySchema.index({ tournamentId: 1, approvalStatus: 1 });
tournamentEntrySchema.index({ tournamentId: 1, groupId: 1 });
tournamentEntrySchema.index({ tournamentId: 1, eliminated: 1 });
```

---

### 1C. Create `models/TournamentGroup.js`

```js
const tournamentGroupSchema = new mongoose.Schema({
  tournamentId: { type: ObjectId, ref: 'Tournament', required: true },
  label:        { type: String, required: true },  // 'A', 'B', 'C', ...
  memberIds:    [{ type: ObjectId, ref: 'TournamentEntry' }],
  status:       { type: String, enum: ['active', 'complete'], default: 'active' },
}, { timestamps: true });

tournamentGroupSchema.index({ tournamentId: 1 });
tournamentGroupSchema.index({ tournamentId: 1, status: 1 });
```

---

### 1D. Create `models/TournamentMatch.js`

```js
const tournamentMatchSchema = new mongoose.Schema({
  tournamentId:      { type: ObjectId, ref: 'Tournament', required: true },
  contestId:         { type: ObjectId, ref: 'Contest', required: true },
  stage:             { type: String, enum: ['group', 'knockout'], required: true },
  groupId:           { type: ObjectId, ref: 'TournamentGroup', default: null },
  knockoutRound:     { type: String, enum: ['R16', 'QF', 'SF', '3rd', 'Final'], default: null },
  entryIdA:          { type: ObjectId, ref: 'Entry', required: true },
  entryIdB:          { type: ObjectId, ref: 'Entry', required: true },
  tournamentEntryIdA: { type: ObjectId, ref: 'TournamentEntry', required: true },
  tournamentEntryIdB: { type: ObjectId, ref: 'TournamentEntry', required: true },
  winnerId:          { type: ObjectId, ref: 'Entry', default: null },
  loserTournamentEntryId: { type: ObjectId, ref: 'TournamentEntry', default: null },
  status:            { type: String, enum: ['scheduled', 'active', 'tie', 'closed'], default: 'scheduled' },
  tieStatus:         { type: String, enum: ['jury_pending', 'organizer_pending', 'resolved'], default: null },
  isTiebreakerMatch: { type: Boolean, default: false },  // true for 2-player group rank tiebreaker
  scheduledAt:       { type: Date, required: true },
  openedAt:          { type: Date, default: null },
}, { timestamps: true });

tournamentMatchSchema.index({ tournamentId: 1, stage: 1 });
tournamentMatchSchema.index({ tournamentId: 1, groupId: 1 });
tournamentMatchSchema.index({ contestId: 1 }, { unique: true });
tournamentMatchSchema.index({ tournamentId: 1, status: 1 });
tournamentMatchSchema.index({ tournamentId: 1, knockoutRound: 1 });
```

---

### 1E. Create `models/TournamentJury.js`

```js
const tournamentJurySchema = new mongoose.Schema({
  tournamentId: { type: ObjectId, ref: 'Tournament', required: true },
  userId:       { type: ObjectId, ref: 'User', required: true },
  missedVotes:  { type: Number, default: 0 },
}, { timestamps: true });

tournamentJurySchema.index({ tournamentId: 1, userId: 1 }, { unique: true });
tournamentJurySchema.index({ tournamentId: 1 });
// NOTE: never populate userId in any API response — jury identity must stay hidden
```

---

### 1F. Create `models/TournamentJuryVote.js`

```js
const tournamentJuryVoteSchema = new mongoose.Schema({
  tournamentId:      { type: ObjectId, ref: 'Tournament', required: true },
  matchId:           { type: ObjectId, ref: 'TournamentMatch', required: true },
  jurorId:           { type: ObjectId, ref: 'User', required: true },
  votedForEntryId:   { type: ObjectId, ref: 'Entry', required: true },
}, { timestamps: true });

tournamentJuryVoteSchema.index({ matchId: 1, jurorId: 1 }, { unique: true });
tournamentJuryVoteSchema.index({ matchId: 1 });
```

---

### 1G. Add `juryBanned` to `models/User.js`

In the User schema, add one field:
```js
juryBanned: { type: Boolean, default: false }
```

This flag is set permanently after a jury member misses a vote. It prevents them from being selected as a jury member in future tournament creation flows.

---

### 1H. Mount new models in server.js

In `server.js`, after the existing model requires, add:
```js
require('./models/TournamentGroup');
require('./models/TournamentMatch');
require('./models/TournamentJury');
require('./models/TournamentJuryVote');
```

---

### Phase 1 exit criteria

- All 4 new model files exist and compile without error
- `Tournament.js` and `TournamentEntry.js` have updated schemas
- `User.js` has `juryBanned` field
- Server starts without Mongoose schema errors
- Existing contest flow is not broken (run a contest end-to-end to confirm)

---

## Phase 2 — Tournament Creation Flow

### 2A. Create `middleware/requireOrganizerEligibility.js` — **done, built as 6 checks**

This middleware runs before any tournament creation route. As built it checks **6** organizer eligibility conditions (the spec's original 5 plus the concurrent-tournament cap from `tournament-spec.md`'s "Who Can Create a Tournament" list) and redirects with a flash message — not a JSON 403 — if any fail (except the identity-verification check, which redirects to `/verify-identity` as originally specced):

```
Checks (in order, as implemented):
1. user.idVerified === true
   → if false: redirect to /verify-identity
2. user.accountStatus === 'banned'
   → if banned: redirect to /tournaments?flash=...&flashType=error ('Your account has an active ban.')
3. Count UserReport docs where { reportedUserId: userId, status: 'pending' } === 0
   → if > 0: same redirect+flash pattern ('Your account has pending reports under review.')
4. Follow.countDocuments({ followingId: userId }) > 250
   → if not: same pattern ('You need more than 250 followers to organize a tournament.')
5. ContestContribution.distinct('contestId', { contributorId: userId }).length >= 5
   → if < 5: same pattern ('You must have contributed to at least 5 contests.')
6. Tournament.countDocuments({ createdBy: userId, status: { $in: ['open','cooldown','active'] } }) < 3
   → if >= 3: same pattern ('You can only have 3 tournaments running at once. Wait for one to close before starting another.')
```

All 5 queries (report count, follower count, contribution count, concurrent-tournament count) run in parallel via `Promise.all`. `TEST_BYPASS_USERNAMES` (`celuiqui`, `storiesbyshews`) still short-circuits every check for local testing — tracked as a pre-launch revert in `july-action-plan.md`.

Export as: `module.exports = requireOrganizerEligibility`

---

### 2B. Create `routes/tournaments.js`

New route file, mounted in `server.js` as:
```js
app.use('/tournaments', require('./routes/tournaments'));
```

All routes in this file require `requireAuth` middleware applied at the router level.

**Page routes:**

```
GET /tournaments — done, with additions beyond spec
  → handler: fetch up to 20 tournaments sorted by createdAt desc, status in ['open','cooldown','active']
  → also fetch up to 5 recently closed (status: 'closed', updatedAt within last 30 days)
  → both queries also apply a visibility filter: { $or: [{ visibility: 'public' }, { visibility: { $exists: false } }, { createdBy: currentUser._id }] } — public tournaments plus the viewer's own private ones
  → render views/tournaments/index.ejs
  → pass: { openTournaments, activeTournaments, closedTournaments, draft: req.session.tournamentDraft || null, flash, flashType }
  → view renders a 4th tab ("Draft") showing the in-progress session draft (name, thumbnail, "Step N of 4 — tap to resume") if one exists

GET /tournaments/create — done, with step-resume added
  → middleware: requireOrganizerEligibility
  → if req.session.tournamentDraft.step > 1, redirect straight to /tournaments/create/step{N} instead of rendering step 1
  → render views/tournaments/create.ejs
  → pass: { user: req.user, step: 1, errors: [], formData: {} }

GET /tournament/:id
  → fetch Tournament by _id, 404 if not found
  → fetch TournamentGroups for this tournament
  → fetch TournamentEntries (approvalStatus: 'approved') with entry + user populated
  → fetch TournamentMatches with contestId populated
  → if status === 'open': also fetch pending entry count, check if req.user already submitted
  → render views/tournaments/detail.ejs
  → pass: { tournament, groups, entries, matches, userEntry, isOrganizer, user: req.user }

GET /tournament/:id/review
  → middleware: verify req.user._id === tournament.createdBy, else 403
  → fetch all TournamentEntries with approvalStatus: 'pending', populate entryId (with media)
  → render views/tournaments/review.ejs
  → pass: { tournament, pendingEntries, user: req.user }

GET /tournament/:id/jury-vote/:matchId
  → verify req.user is a TournamentJury member for this tournament (query TournamentJury)
  → if no record found: 403
  → fetch TournamentMatch, verify status === 'tie' and tieStatus === 'jury_pending'
  → check TournamentJuryVote — if juror already voted this match: redirect to /tournament/:id with flash 'You already voted on this tie.'
  → fetch both entries (entryIdA, entryIdB) with their media
  → render views/tournaments/jury-vote.ejs
  → pass: { tournament, match, entryA, entryB } — DO NOT pass any jury identity info
```

**New API route not in the original spec:** `GET /api/tournaments/check-name?name=...` (`routes/api.js`) — requires session auth, returns `{ available: boolean }` via a case-insensitive exact-match `Tournament.findOne`. Powers the live typeahead check on the Step 1 name field (debounced 450ms client-side). The same case-insensitive uniqueness check runs again server-side in `POST /tournaments/create/step1` before accepting the submission, so the client-side check is UX-only, not the enforcement point.

---

### 2C. Creation flow — Step 1: Basics — **done, expanded well beyond the original spec**

`POST /tournaments/create/step1` (now `multipart/form-data` via `upload.tournament.single('thumbnail')`, not urlencoded)

**Request body, as built:**
```
thumbnail:      File, required (image, max 5MB) — stored via middleware/upload.js `tournament` storage → public/uploads/tournaments/
                (removeThumbnail=1 clears a previously-drafted thumbnail with no new file attached)
visibility:     'public' | 'private', default 'public' — toggle switch in the UI
name:           String, required, 3–60 chars (spec said 80), letters/numbers/spaces only (new regex constraint),
                must be case-insensitively unique across all tournaments (new — checked both live via
                /api/tournaments/check-name and again server-side on submit)
description:    String, optional, max 220 chars (spec said 500)
size:           Number, must be in [4, 8, 12, 16, 24] — rendered as a radio-card list showing group/knockout
                breakdown and estimated duration per size, not a plain <select>
openDays:       Number, 1–3 (how many days open phase lasts, default 3) — rendered as a custom dropdown, not a <select>
```

**Validation (server-side):**
- `thumbnail` missing (no upload and no prior draft thumbnail): `'A tournament thumbnail is required.'`
- `name` trimmed length not 3–60: `'Tournament name must be between 3 and 60 characters.'`
- `name` fails `/^[A-Za-z0-9 ]+$/`: `'Tournament name may only contain letters, numbers, and spaces.'`
- `name` case-insensitively matches an existing tournament: `'A tournament with this name already exists.'`
- `size` not in valid list: `'Participant count must be 4, 8, 12, 16, or 24.'`
- `openDays` not 1, 2, or 3: `'Open phase must last 1 to 3 days.'`
- `description` over 220 chars: `'Description must be 220 characters or fewer.'`
- Any failure: re-render `views/tournaments/create.ejs` with `{ step: 1, errors, formData }` (formData now also carries `thumbnailUrl`, `visibility`)
- Client-side: submit button stays disabled until the name passes the live uniqueness check and a thumbnail is present — validation isn't purely server-round-trip

**On success:**
- Store step 1 data in `req.session.tournamentDraft = { name, description, thumbnailUrl, visibility, size, openDays, step: 1 }` — every step now also stamps `step: N` on the draft so `GET /tournaments/create` can resume at the right step, and the "Draft" tab on `/tournaments` can show progress
- Redirect to `GET /tournaments/create/step2`
- "Save as Draft" (`intent=draft`) now submits via `fetch` (to support the multipart thumbnail) and shows a toast instead of redirecting to `/tournaments` with a flash querystring

---

### 2D. Creation flow — Step 2: Prizes + Inline Funding

`GET /tournaments/create/step2`
- Check `req.session.tournamentDraft` exists, else redirect to step 1
- Fetch `req.user.wallet.purchasedCHL` (SB balance)
- Render `views/tournaments/create.ejs` with `{ step: 2, sbBalance, user: req.user, errors: [], formData: {} }`

`POST /tournaments/create/step2`

**Request body:**
```
prizeFirst:   Number, min 1000
prizeSecond:  Number, min 400
prizeThird:   Number, min 100
```

**Validation:**
- `prizeFirst >= 1000`: `'1st place prize must be at least 1,000 CHL.'`
- `prizeSecond >= 400`: `'2nd place prize must be at least 400 CHL.'`
- `prizeThird >= 100`: `'3rd place prize must be at least 100 CHL.'`
- `prizeFirst > prizeSecond`: `'1st place prize must be greater than 2nd place.'`
- `prizeSecond > prizeThird`: `'2nd place prize must be greater than 3rd place.'`
- Any failure: re-render step 2 with errors

**SB balance check:**
- `total = prizeFirst + prizeSecond + prizeThird`
- Fetch `req.user.wallet.purchasedCHL`
- If `purchasedCHL >= total`: save to `req.session.tournamentDraft.prizes`, redirect to step 3
- If `purchasedCHL < total`:
  - `shortfall = total - purchasedCHL`
  - Re-render step 2 with `{ insufficientFunds: true, shortfall, total, sbBalance: purchasedCHL }`
  - View shows inline payment section (see 2E)

---

### 2E. Inline Tournament Funding

Only surfaces on step 2 when SB is insufficient. This is a tournament-gated $500-max top-up. Regular `/wallet/topup` is not used here.

`POST /tournaments/fund`

**Request body:**
```
amountCHL: Number — how many CHL to buy (must be > 0 and ≤ 500 CHL equivalent)
```

For now (CCBill stub): deduct from nothing, credit `purchasedCHL` directly (same pattern as `/wallet/checkout` stub).

Write a `WalletTransaction`:
```js
{
  userId:        req.user._id,
  type:          'topup',
  direction:     'credit',
  amountCHL:     amountCHL,
  amountUSD:     amountCHL * EXCHANGE_RATE,
  exchangeRate:  EXCHANGE_RATE,
  balanceBefore: currentSB,
  balanceAfter:  currentSB + amountCHL,
  status:        'completed',
  source:        'tournament_fund',
  referenceType: 'Tournament',
}
```

On success: redirect back to `GET /tournaments/create/step2` with updated SB.

When CCBill is live (Phase 9.1), this route redirects to CCBill with `returnUrl: /tournaments/create/step2` and `source=tournament_fund`.

---

### 2F. Creation flow — Step 3: Eligibility Criteria

`GET /tournaments/create/step3`
- Check `req.session.tournamentDraft.prizes` exists, else redirect to step 2
- Render `views/tournaments/create.ejs` with `{ step: 3, user: req.user }`

`POST /tournaments/create/step3`

**Request body:**
```
criteria: JSON array of { field, operator, value } objects (may be empty array)
```

**Validation per criterion:**
- `field` must be one of: `ratingAvg | ratingCount | followerCount | age | sex | entryCount | accountAgeDays`
- `operator` must be: `gte | lte | eq`
- `value` must be appropriate type for the field (number for numeric fields, string for sex)
- `sex` field only supports `operator: 'eq'`, value must be `'M' | 'F' | 'NB'`

On success: save to `req.session.tournamentDraft.eligibilityCriteria`, redirect to step 4.

---

### 2G. Creation flow — Step 4: Jury Selection

`GET /tournaments/create/step4`
- Check `req.session.tournamentDraft.eligibilityCriteria` exists, else redirect to step 3
- Render `views/tournaments/create.ejs` with `{ step: 4, user: req.user }`

`POST /api/tournaments/search-users` (JSON, called from jury search typeahead)
- Params: `?q=<username_or_display_name>`
- Returns up to 10 users matching query, excluding `req.user._id` and users with `juryBanned: true`
- Response: `[{ _id, username, displayName, avatarUrl }]`
- Never expose `juryBanned` field in response

`POST /tournaments/create/step4`

**Request body:**
```
juryUserIds: Array of user _id strings
```

**Validation:**
- Length must be 5–7: `'You must select between 5 and 7 jury members.'`
- No duplicates
- No user is the organizer themselves: `'You cannot add yourself as a jury member.'`
- All userIds must resolve to real, non-banned, non-juryBanned users

On success: save to `req.session.tournamentDraft.juryUserIds`, call `finalizeTournamentCreation(req)`.

---

### 2H. `finalizeTournamentCreation(req)` — called after step 4

This function does all the writes atomically:

```
1. Derive groupSize and groupCount from size:
   size 4  → groupSize 4, groupCount 1
   size 8  → groupSize 4, groupCount 2
   size 12 → groupSize 3, groupCount 4
   size 16 → groupSize 4, groupCount 4
   size 24 → groupSize 3, groupCount 8

2. Compute openDeadline = new Date(now + openDays * 24 * 60 * 60 * 1000)

3. Deduct total prize pool from req.user.wallet.purchasedCHL:
   User.findOneAndUpdate(
     { _id: req.user._id, 'wallet.purchasedCHL': { $gte: totalPrize } },
     { $inc: { 'wallet.purchasedCHL': -totalPrize } }
   )
   If no document returned: return error 'Insufficient balance. Your wallet balance changed.'

4. Write WalletTransaction:
   {
     userId:        req.user._id,
     type:          'tournament_prize_hold',
     direction:     'debit',
     amountCHL:     totalPrize,
     amountUSD:     totalPrize * EXCHANGE_RATE,
     status:        'completed',
     source:        'tournament_creation',
     referenceType: 'Tournament',
     referenceId:   <tournament._id — set after step 5>
   }

5. Create Tournament document:
   {
     createdBy:           req.user._id,
     name, description, size, groupSize, groupCount,
     eligibilityCriteria,
     prizes:              { first, second, third, funded: true },
     status:              'open',
     openDeadline,
   }

6. Create TournamentJury documents (one per juryUserId):
   { tournamentId: tournament._id, userId, missedVotes: 0 }

7. Update WalletTransaction.referenceId = tournament._id

8. Schedule agenda job: 'tournament_open_expiry' at openDeadline
   data: { tournamentId: tournament._id.toString() }

9. Clear req.session.tournamentDraft

10. Redirect to /tournament/:id with flash 'Your tournament is live and accepting candidates.'
```

---

### Phase 2 exit criteria

- An eligible organizer can complete all 4 steps
- Tournament is created with `status: 'open'`, prizes funded, jury stored privately
- Ineligible users are blocked at each eligibility check with clear error messages
- `WalletTransaction` of type `tournament_prize_hold` exists after creation
- `TournamentJury` docs are created (not accessible via any public route)
- Agenda job `tournament_open_expiry` is scheduled at `openDeadline`
- Session draft is cleared on completion and on any error path that needs to reset

---

## Phase 2 Extensions — built 2026-07-03, beyond original spec

None of this was in the original plan. It grew out of Phase 2 while building the creation wizard and is documented here rather than renumbered into Phase 2A–2H above.

### Step 5 — Review (new wizard step)

`GET/POST /tournaments/create/step5` — inserted before finalize. Requires `draft.juryUserIds.length >= 5` (else redirect to step4). Renders a summary of Basics/Prizes/Eligibility/Jury with "Edit" links back to each step. `POST` with `intent: 'draft'` just flashes "Draft saved."; otherwise calls `finalizeTournamentCreation(req)` (unchanged from 2H) and redirects to the new tournament. The wizard is now **5 steps, not 4** — `views/tournaments/index.ejs`'s Draft-tab resume copy and `create.ejs`'s step indicator both reflect this.

`finalizeTournamentCreation` also now sends a `tournament_jury_invite` notification to each selected juror (payload includes `url: '/tournament/:id/jury-invite'`), and wraps the whole write sequence in try/catch: on any failure it rolls back the wallet debit, deletes the half-created `Tournament` + `TournamentJury` docs + jury-invite notifications, and cancels the scheduled `tournament_open_expiry` job — best-effort, doesn't mask the original error.

### Jury invite / accept / decline flow

Jury membership is now opt-in. `TournamentJury.status` starts `'pending'`.

- `GET /tournament/:id/jury-invite` — juror-facing; requires a `pending` `TournamentJury` record for `req.currentUser` and tournament `status: 'open'`; renders `views/tournaments/jury-invite.ejs` (thumbnail, tournament name/size/prize pool, explanation of the tie-break duty and anonymity guarantee, "no response counts as acceptance" notice, Accept/Decline buttons).
- `POST /tournament/:id/jury-invite/respond` — body `{ action: 'accept' | 'decline' }`; atomically updates the record (`findOneAndUpdate` guarded on `status: 'pending'`) to `accepted`/`declined` + `respondedAt`. On decline, notifies the organizer with `tournament_jury_declined` (payload links to `/tournament/:id/jury/manage`).
- **Auto-accept on open expiry:** when `tournament_open_expiry` fires (see below), any juror who never responded is auto-accepted (`autoAcceptPendingJury`) — matches the jury-invite page's stated policy.
- The jury-vote route (`GET /tournament/:id/jury-vote/:matchId`) now requires the juror's `TournamentJury.status` to be `'accepted'`, not just present.

### Jury management / replace (organizer)

- `GET /tournament/:id/jury/manage` — organizer-only; lists every `TournamentJury` record (any status) with a status badge; renders `views/tournaments/jury-manage.ejs`. For each `declined` juror, while tournament is still `open`, shows an inline user-search ("Replace") hitting `POST /api/tournaments/search-users?excludeTournamentId=...`.
- `POST /tournament/:id/jury/replace` — body `{ oldUserId, newUserId }`; requires `status: 'open'`, organizer-only; `newUserId` can't be the organizer, an existing juror, banned, or `juryBanned`. Uses an atomic `findOneAndDelete({ status: 'declined', userId: oldUserId })` guard so two concurrent replace attempts can't double-replace the same slot. Inserts the new `TournamentJury` (`status: 'pending'`) and sends it a `tournament_jury_invite` notification.
- `GET /tournament/:id` (detail route) now computes `declinedJuryCount` for the organizer, surfaced on the detail page as a "Manage jury" card with an "N declined" badge, always visible to the organizer (not gated to `open` — though the replace action itself is).

### Edit wizard (organizer revises a live `open`/`cooldown` tournament)

New: `GET/POST /tournament/:id/edit` + `/edit/step1` through `/edit/step5`, reusing `views/tournaments/create.ejs` with `editing: true` (different step URLs, "Save Changes" instead of "Save as Draft", a per-step `trySaveNow` shortcut that finalizes immediately on `intent: 'save'` without walking the rest of the wizard). Only the organizer can reach it, and only while `status` is `open` or `cooldown`; `loadEditableTournament` enforces both and 403s/redirects otherwise.

`finalizeTournamentEdit(req, tournament)` — validates everything before any writes (no multi-doc transactions in this codebase):
- Re-fetches the tournament fresh; re-requires `open`/`cooldown`.
- Blocks shrinking `size` below the current approved-entry count; otherwise recomputes `groupSize`/`groupCount`.
- If still `open` and `openDays` changed: recomputes `openDeadline` (rejects if it lands in the past) and reschedules the `tournament_open_expiry` agenda job.
- **Wallet true-up:** `delta = newTotal - oldTotal` prize pool. Positive delta debits the wallet (guarded `findOneAndUpdate` on sufficient `purchasedCHL`) and logs a `tournament_prize_hold` (`source: 'tournament_edit'`); negative delta calls `creditWallet(...)` with `tournament_prize_refund`.
- **Criteria change:** if `eligibilityCriteria` changed, re-checks every `pending`/`approved` `TournamentEntry` via `estimateParticipantPool.meetsTournamentCriteria` (see below) — anyone who no longer qualifies is set to `approvalStatus: 'rejected'` and notified with `tournament_entry_removed`.
- **Jury diff:** computes added/removed juror sets; new jurors get a fresh `TournamentJury` (`status: 'pending'`) + `tournament_jury_invite` notification; removed jurors' records are deleted outright.
- Tournament fields are persisted last, once everything else has succeeded.

### Organizer self-cancel

`POST /tournament/:id/cancel` — organizer-only, while `status` is `open` or `cooldown`. Cancels whichever agenda job is pending (`tournament_open_expiry` or `tournament_cooldown_expiry`) and calls `cancelTournament(tournamentId, 'organizer_canceled')` — a new cancellation reason beyond the original spec's `insufficient_candidates`/`cooldown_expired`. The detail page shows this behind a confirmation modal that spells out the prize refund and candidate notifications before submitting.

### New utils: `utils/tournamentCriteria.js`, `utils/estimateParticipantPool.js`, `utils/wallet.js`

- **`utils/tournamentCriteria.js`** — just the shared constants (`CRITERIA_FIELDS` including `isFollower`, `CRITERIA_OPERATORS`, `SEX_VALUES`), imported by both `routes/tournaments.js` and `utils/estimateParticipantPool.js` so the field/operator lists can't drift between validation and evaluation.
- **`utils/estimateParticipantPool.js`** — exports `estimateParticipantPool(organizerId, criteria)`, an aggregation that estimates how many currently-registered users would qualify for a given criteria set today (only joins what the criteria set actually needs — plain age/sex/accountAgeDays/isFollower criteria run with zero `$lookup`s). Also exports `.meetsTournamentCriteria(userId, entryId, organizerId, criteria)`, a per-candidate re-check (used by the edit wizard's criteria-tightening path above). Backs the new API route below.
- **`utils/wallet.js`** — exports `creditWallet(userId, amountCHL, { pool, type, source, referenceId, referenceType })`, a shared helper that increments a wallet pool and writes the matching `WalletTransaction` in one call. `routes/tournaments.js`, `jobs/tournamentJobs.js`, and `routes/wallet.js` now all route wallet credits through this instead of hand-rolling the increment + transaction-write pair inline.

### New API routes (`routes/api.js`)

- `POST /api/tournaments/estimate-pool` — body `{ criteria }`; calls `estimateParticipantPool(req.currentUser._id, criteria)`, rounds the result for display (exact count shown under 10, else rounded to ~2 significant figures), returns `{ approxCount, exact }`. Powers the live "estimated participant pool" counter on the Step 3 (Eligibility) screen.
- `POST /api/tournaments/search-users` — now accepts `excludeTournamentId` (excludes users already on that tournament's jury) and restricts results to `role: 'user'`.
- `GET /api/tournaments/check-name` — now accepts `excludeId` so the edit wizard's name-uniqueness check doesn't collide with the tournament being edited.

### `jobs/tournamentJobs.js` — exists now, but only a partial/diverged Phase 3

This file exists (it didn't when this doc's status header was last fully accurate) and registers two agenda jobs, but they implement a simplified version of Phase 3's 3E/3G/3H, not the full spec below:

- **`tournament_open_expiry`**: auto-accepts any still-pending jury invites, then requires `acceptedJuryCount >= 5` (`MIN_JURY`) — else cancels with reason `'insufficient_jury'` (a cancellation reason not in the original spec, since jury accept/decline didn't exist yet when Phase 3 was written). Then requires `submittedCount >= tournament.size` (counts **all** `TournamentEntry` docs regardless of `approvalStatus`, since there's no `/submit` route yet to distinguish pending vs. approved in practice) — else cancels `'insufficient_candidates'`. Otherwise transitions to cooldown.
- **`tournament_cooldown_expiry`**: requires `approvedCount === tournament.size` exactly — else cancels `'cooldown_incomplete'` (spec's original `'cooldown_expired'` reason was renamed/repurposed). **Gap:** on success this sets `status: 'active'` directly. It does **not** call anything resembling `activateTournament`/`generateGroups` (Phase 4, not built yet), so a tournament reaching `active` today has no groups or matches — this needs to be wired up when Phase 4 lands, not left as-is.
- `cancelTournament(tournamentId, reason)` and `transitionToCooldown(tournamentId)` are implemented per the original 3G/3H shape (refund via `creditWallet`, notify organizer + pending/approved contestants), with `transitionToCooldown`'s status-filtered `findOneAndUpdate` guard already in place as designed.

No candidate submission route, no approve/reject routes, and no `utils/tournamentEligibility.js` exist yet — Phase 3's actual player-facing surface is still entirely unbuilt.

---

## Phase 3 — Open Phase & Candidate Management

### 3A. Eligibility criteria evaluation — `utils/tournamentEligibility.js`

New utility. Export one function:

```js
async function evaluateCriteria(user, entry, criteria) → { eligible: Boolean, failedCriteria: String[] }
```

For each criterion in `criteria`:
```
field: 'ratingAvg'       → compare entry.ratingAvg
field: 'ratingCount'     → compare entry.ratingCount
field: 'followerCount'   → query Follow.countDocuments({ followedId: user._id })
field: 'age'             → compute years from user.birthdate to now
field: 'sex'             → compare user.sex
field: 'entryCount'      → query Entry.countDocuments({ userId: user._id, status: 'active' })
field: 'accountAgeDays'  → compute days from user.createdAt to now

operator: 'gte' → value >= criterion.value
operator: 'lte' → value <= criterion.value
operator: 'eq'  → value === criterion.value
```

If `criteria` is empty array → return `{ eligible: true, failedCriteria: [] }`
Always enforce `user.idVerified === true` regardless of criteria array.

---

### 3B. Candidate submission route — **done 2026-07-04, see "Phase 3 Extensions" for as-built shape**

Original draft below assumed a single `/submit` call with no pre-check. As built, a `GET /api/tournaments/:id/eligibility` pre-check (not in this original draft) runs first so the entry picker only ever shows entries that would actually pass.

In `routes/api.js`, add:

```
POST /api/tournaments/:id/submit
  middleware: requireAuth

  Steps:
  1. Fetch Tournament by _id. If not found: 404.
  2. If tournament.status !== 'open': 400 { error: 'This tournament is no longer accepting candidates.' }
  3. If req.user._id.toString() === tournament.createdBy.toString(): 403 { error: 'Organizers cannot enter their own tournament.' }
  4. Check TournamentJury.exists({ tournamentId, userId: req.user._id })
     If exists: 403 { error: 'Jury members cannot enter the tournament they are serving on.' }
  5. If !req.user.idVerified: 403 { error: 'Identity verification is required to enter a tournament.' }
  6. Parse req.body.entryId. Fetch Entry by _id where userId === req.user._id.
     If not found: 400 { error: 'Entry not found or does not belong to you.' }
  7. Check TournamentEntry.exists({ tournamentId, userId: req.user._id })
     If exists: 400 { error: 'You have already submitted an entry to this tournament.' }
  8. Evaluate eligibilityCriteria via evaluateCriteria(req.user, entry, tournament.eligibilityCriteria)
     If not eligible: 400 { error: 'Your entry does not meet the eligibility criteria.', failedCriteria }
  9. Count approved TournamentEntries for this tournament.
     If count >= tournament.size: 400 { error: 'This tournament is already full.' }
  10. Create TournamentEntry:
     { tournamentId, entryId, userId: req.user._id, approvalStatus: 'pending', submittedAt: new Date() }
  11. Create Notification for organizer:
      { userId: tournament.createdBy, type: 'tournament_entry_submitted',
        payload: { tournamentId, entryId, url: '/tournament/' + tournamentId + '/review' } }
  12. Return 200 { success: true, message: 'Your entry has been submitted for review.' }
```

---

### 3C. Organizer approve/reject routes — **done 2026-07-04, but phase-gated on `cooldown` not `open`**

The draft below (and 3F just after it) still reflects an earlier assumption that review happens live during the `open` window. That was superseded by the "batch-review during cooldown" design (already called out in this doc's own "What changes vs. old Phase 7/8" table near the bottom) before this route was actually written — as built, both approve and reject require `tournament.status === 'cooldown'`, not `'open'`. See "Phase 3 Extensions" below for the exact as-built behavior, including a cap-reached trigger that calls `activateTournament` directly (not `transitionToCooldown` — the tournament is already past cooldown by the time approvals happen).

In `routes/api.js`, add:

```
POST /api/tournaments/:id/entries/:eid/approve
  middleware: requireAuth

  Steps:
  1. Fetch Tournament. If not found: 404.
  2. If req.user._id.toString() !== tournament.createdBy.toString(): 403.
  3. If tournament.status !== 'open': 400 { error: 'Candidate review is only available during the open phase.' }
  4. Fetch TournamentEntry by { _id: eid, tournamentId }. If not found: 404.
  5. If entry.approvalStatus !== 'pending': 400 { error: 'This entry has already been reviewed.' }
  6. Count currently approved entries for this tournament.
     If count >= tournament.size: 400 { error: 'Tournament is already at capacity.' }
  7. Update TournamentEntry: { approvalStatus: 'approved', reviewedAt: new Date() }
  8. Create Notification for submitter:
     { userId: entry.userId, type: 'tournament_entry_approved',
       payload: { tournamentId, url: '/tournament/' + tournamentId } }
  9. Check if approved count now === tournament.size → trigger immediate cap-reached transition (see 3F)
  10. Return 200 { success: true }

POST /api/tournaments/:id/entries/:eid/reject
  middleware: requireAuth

  Steps:
  1–4: same as approve
  5. If entry.approvalStatus !== 'pending': 400
  6. Parse req.body.note (optional string, max 200 chars)
  7. Update TournamentEntry: { approvalStatus: 'rejected', reviewedAt: new Date() }
  8. Create Notification for submitter:
     { userId: entry.userId, type: 'tournament_entry_rejected',
       payload: { tournamentId, note: note || null, url: '/tournament/' + tournamentId } }
  9. Return 200 { success: true }
```

---

### 3D. Create `jobs/tournamentJobs.js`

New job file. Register all tournament agenda jobs here. Import and call `registerTournamentJobs(agenda)` in `server.js` alongside `registerContestJobs`.

---

### 3E. Open phase expiry job

In `jobs/tournamentJobs.js`:

```js
agenda.define('tournament_open_expiry', async job => {
  const { tournamentId } = job.attrs.data;
  const tournament = await Tournament.findOne({ _id: tournamentId, status: 'open' });
  if (!tournament) return; // already transitioned

  const approvedCount = await TournamentEntry.countDocuments({
    tournamentId: tournament._id,
    approvalStatus: 'approved',
  });

  if (approvedCount < 4) {
    // Cancel — not enough candidates
    await cancelTournament(tournament._id, 'insufficient_candidates');
    return;
  }

  // Enough candidates — move to cooldown
  await transitionToCooldown(tournament._id);
});
```

---

### 3F. Cap-reached trigger

In the approve route handler (step 9), after incrementing approved count:

```js
const newApprovedCount = await TournamentEntry.countDocuments({
  tournamentId: tournament._id,
  approvalStatus: 'approved',
});

if (newApprovedCount >= tournament.size) {
  // Cancel the scheduled open_expiry job (it's no longer needed)
  await agenda.cancel({ name: 'tournament_open_expiry', 'data.tournamentId': tournamentId });
  await transitionToCooldown(tournament._id);
}
```

---

### 3G. `transitionToCooldown(tournamentId)` — in `jobs/tournamentJobs.js`

```js
async function transitionToCooldown(tournamentId) {
  const cooldownDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000); // now + 24h

  await Tournament.findByIdAndUpdate(tournamentId, {
    $set: { status: 'cooldown', cooldownDeadline },
  });

  // Schedule cooldown expiry job
  await agenda.schedule(cooldownDeadline, 'tournament_cooldown_expiry', {
    tournamentId: tournamentId.toString(),
  });

  // Notify organizer
  const tournament = await Tournament.findById(tournamentId).select('createdBy name').lean();
  await Notification.create({
    userId: tournament.createdBy,
    type:   'tournament_cooldown_started',
    payload: {
      tournamentId,
      cooldownDeadline,
      url: '/tournament/' + tournamentId,
    },
  });
}
```

---

### 3H. `cancelTournament(tournamentId, reason)` — in `jobs/tournamentJobs.js`

```js
async function cancelTournament(tournamentId, reason) {
  const tournament = await Tournament.findOneAndUpdate(
    { _id: tournamentId, status: { $in: ['open', 'cooldown'] } },
    { $set: { status: 'canceled', cancelReason: reason } },
  ).lean();

  if (!tournament) return; // already handled

  // Refund prize pool to organizer's purchasedCHL
  const total = tournament.prizes.first + tournament.prizes.second + tournament.prizes.third;
  const EXCHANGE_RATE = 0.20;

  const updatedUser = await User.findByIdAndUpdate(
    tournament.createdBy,
    { $inc: { 'wallet.purchasedCHL': total } },
    { new: true, select: 'wallet' },
  );

  const balanceAfter  = updatedUser.wallet.purchasedCHL;
  const balanceBefore = balanceAfter - total;

  await WalletTransaction.create({
    userId:        tournament.createdBy,
    type:          'tournament_prize_refund',
    direction:     'credit',
    amountCHL:     total,
    amountUSD:     +(total * EXCHANGE_RATE).toFixed(2),
    exchangeRate:  EXCHANGE_RATE,
    balanceBefore,
    balanceAfter,
    status:        'completed',
    source:        'tournament_cancel',
    referenceId:   tournamentId,
    referenceType: 'Tournament',
  });

  // Notify organizer
  await Notification.create({
    userId:  tournament.createdBy,
    type:    'tournament_canceled',
    payload: { tournamentId, reason, url: '/tournament/' + tournamentId },
  });

  // Notify all approved + pending contestants
  const entries = await TournamentEntry.find({
    tournamentId,
    approvalStatus: { $in: ['approved', 'pending'] },
  }).select('userId').lean();

  const contestantNotifications = entries
    .filter(e => e.userId.toString() !== tournament.createdBy.toString())
    .map(e => ({
      userId:  e.userId,
      type:    'tournament_canceled',
      payload: { tournamentId, reason, url: '/tournaments' },
    }));

  if (contestantNotifications.length > 0) {
    await Notification.insertMany(contestantNotifications, { ordered: false });
  }
}
```

---

### Phase 3 exit criteria

- Candidates can submit entries during open phase
- Organizer and jury members are blocked from submitting entries to their own tournament
- Organizer can approve and reject from the review queue
- Approval at capacity never *silently* skips a phase in either direction (as of 2026-07-05) — it surfaces an explicit organizer choice instead. Reaching the cap (in `open` **or** `cooldown`) returns `capReached: true` from the approve route; the organizer is then prompted to either go live immediately (`POST /tournaments/:id/advance-now` — skips straight to `active`, bypassing the rest of `open`+all of `cooldown`, or just the rest of `cooldown`) or decline (`POST /tournaments/:id/entries/:eid/revert` — sends that entry back to `pending`, no notification). Declining is a no-op safety net, not a stall: the normal sweepers (`tournament_open_expiry`, `tournament_cooldown_expiry`) still resolve the tournament correctly at their natural deadlines regardless of what the organizer chooses. See the "Cap-reached confirmation" paragraph under "Phase 3 Extensions" below for the as-built mechanics.
- Open phase expiry job fires at `openDeadline`: cancels if < 4, transitions to cooldown if ≥ 4
- Cancellation always refunds prize pool and notifies all parties
- Cooldown transition always notifies organizer and schedules `tournament_cooldown_expiry`

---

## Phase 3 Extensions — built 2026-07-04, reworked 2026-07-05, diverges from the original 3B/3C/3F draft above

The draft 3B/3C/3F sections above were written before "batch-review during cooldown" was settled as the target design (see the "What changes vs. old Phase 7/8" table further down — it already lists "3-day open window, batch review" as the replacement for "30-min per-review clock per entry"). The first as-built pass (2026-07-04) followed that "review happens during cooldown only" design and added a "Choose Your Entry" modal on the detail page for picking an already-uploaded entry to submit. **On 2026-07-05 this was reworked again**, in the direction described below — the modal-picker is gone, submission now always happens at upload time, and review runs across `open` and `cooldown` both. No `utils/tournamentEligibility.js` file was ever created — that job is now split across `utils/estimateParticipantPool.js` (organizer-facing pool estimate) and the new `utils/tournamentSubmission.js` (actual submission + preflight, see below).

### Submission moved to upload-time — `utils/tournamentSubmission.js` (new file)

The "pick one of your existing entries" flow (`GET /api/tournaments/:id/eligibility` returning a list of qualifying owned entries, `POST /api/tournaments/:id/submit` with an `entryId`) is gone. Every tournament candidacy is now resolved the moment an entry is created — there is no after-the-fact submission path. Three exports, all pure/reusable across both entry-creation routes (`POST /entries` in `routes/api.js` and `POST /submit` in `routes/pages.js`):

- **`checkTournamentPreflight(tournament, userId)`** — profile-level-only pre-check (status `open`, not-organizer, not-juror, `idVerified`, not-already-submitted, `evaluateTournamentCriteria` with `entryId: null` since no entry exists yet). Returns `{ eligible, reason, failedCriteria }`. Called by `GET /submit?tournamentId=...` (see below) so the upload page can show an explicit "you don't qualify" state before the uploader wastes an upload.
- **`submitEntryToTournament({ tournament, entry, actor, autoSubmitted })`** — the actual write: same guard order as the old submit route (status, organizer, juror, `idVerified`, already-submitted, `evaluateTournamentCriteria` now with the real `entryId`, capacity against `approvalStatus: 'approved'` count), then `TournamentEntry.create(...)` with `autoSubmitted` stamped, then the `tournament_entry_submitted` notification to the organizer (unchanged payload/link). Returns `{ success, reason }` instead of throwing.
- **`attemptTournamentAutoDraft(entry, actor)`** — called fire-and-forget right after every entry create. Finds every `status: 'open'` tournament (excluding ones the actor organizes) whose `wildcardStains` intersects the new entry's `tags`, and calls `submitEntryToTournament` with `autoSubmitted: true` for each match. Failures are swallowed per-tournament and never surface to the uploader — this must never affect the entry-creation response.

### Stains & wildcard auto-draft (new Tournament fields, Step 1 of creation wizard)

`Tournament.stains` (max 6) are purely descriptive, like an entry's tags — shown as plain `#text` on the browse list and detail page, no functional effect. `Tournament.wildcardStains` (max 2) drive `attemptTournamentAutoDraft` above: any brand-new entry tagged with one of them auto-submits as a candidate (`autoSubmitted: true`) while the tournament is `open`, no action required from the uploader. Both fields get the same chip-input UI on `create.ejs`'s Step 1 (dedicated add/remove-on-backspace/comma-split behavior, normalized lowercase/trimmed server-side via `normalizeStains`/`normalizeWildcardStains` in `routes/tournaments.js`). The review queue (`review.ejs`) shows a "Wildcard" badge (with the matching stain names) on any `autoSubmitted` candidate row, and the detail/index cards render `wildcardStains` as a tag-icon badge with a copy-to-clipboard button, visually distinct from plain `stains`.

### Curator-level weighted rating criteria — `utils/weightedRating.js` (new file)

The `ratingAvg`/`ratingCount` eligibility criteria fields used to evaluate the specific entry a candidate submitted. Since submission now always happens on a brand-new upload with no rating history, that no longer makes sense — they now evaluate the candidate's platform-wide weighted rating reputation instead: `getUserRatingStats(userId)` sums `ratingCount` and computes a ratings-weighted average across every entry the user owns, returning `{ weightedAvg, totalRatingCount, ratedEntryCount }`. Both `utils/estimateParticipantPool.js` (the organizer-facing pool-size estimate on Step 3) and `utils/contestEligibility.js` (the existing contest participation gate) were refactored to call this shared helper instead of each computing their own per-entry rollup — `contestEligibility.js`'s behavior is unchanged, just de-duplicated. `estimateParticipantPool.js` lost its old `PER_ENTRY_FIELDS`/`buildEntryCriteriaFilter`/`hasQualifyingEntry` machinery entirely (there's no longer a "does the user own a qualifying entry" query — `ratingAvg`/`ratingCount` are aggregated the same as any other profile-level field, via a `$sum`/`$divide` pipeline stage). Labels on both the creation wizard and the review summary now read "Average rating (curator)" / "Rating count (curator)" to make the profile-wide meaning explicit.

### `POST /api/tournaments/:id/entries/:eid/approve` and `.../reject` — done, now open-**and**-cooldown-gated

`loadPendingEntryForReview(req, res)` now accepts `tournament.status === 'open'` as well as `'cooldown'` (previously cooldown-only) — organizers of high-volume tournaments can review on a rolling basis instead of being stuck doing it all inside the 24h cooldown window.

### Cap-reached confirmation — reworked again 2026-07-05 (same day, second pass)

The first 07-05 pass (described above) scoped the old auto-skip to `cooldown` only, leaving `open` with no shortcut at all. That was replaced same-day with an explicit organizer decision in both phases, since the original rationale ("hitting the cap early must not cut off the rest of the open window") doesn't fully hold once the cap is reached — no *new* submissions can land past a full roster anyway (`submitEntryToTournament`'s own capacity check blocks them), so there was nothing left to protect by waiting silently.

- **Approve route** no longer auto-activates anything. It still commits the approval (and its `tournament_entry_approved` notification) unconditionally, then computes `capReached = approvedCount + 1 === tournament.size` and returns it in the JSON response — the decision of what happens next is deferred to the organizer.
- **`POST /tournaments/:id/entries/:eid/revert`** (new) — organizer-only, requires `approvalStatus: 'approved'` and tournament `open`/`cooldown`; sets the entry back to `pending` (`reviewedAt: null`). No notification — from the submitter's side nothing has actually changed, they're still pending.
- **`POST /tournaments/:id/advance-now`** (new) — organizer-only; re-validates `approvedCount === tournament.size` (guards against a stale prompt/race). From `open`: re-runs `autoAcceptPendingJury` + the same `acceptedJuryCount >= MIN_JURY` bar `tournament_open_expiry` would otherwise enforce (now exported from `jobs/tournamentJobs.js`, so it's the same constant everywhere), cancels the scheduled `tournament_open_expiry` job, and calls `activateTournament` — skipping `cooldown` entirely, not just fast-forwarding into it. From `cooldown`: cancels `tournament_cooldown_expiry` and calls `activateTournament`, same as the old behavior.
- **`views/tournaments/review.ejs`** — an approve response with `capReached: true` opens a confirmation modal ("Start the tournament now?") instead of just removing the row. "Go live now" calls `advance-now` and redirects to the tournament page; "Not yet" (or closing the modal) calls `revert`, leaving the row in the pending list unchanged.
- If the organizer ignores the prompt entirely (navigates away), nothing is stuck — the existing sweepers (`tournament_open_expiry` for the `open` case, `tournament_cooldown_expiry` for `cooldown`) still resolve the tournament correctly once their natural deadline arrives, exactly as before this change.

### `review.ejs` search + sort

`GET /tournament/:id/review` now accepts `?q=` (username substring, case-insensitive, regex-escaped) and `?sort=` (`recent | oldest | rating | ratingCount | followers`, default `recent`). Backed by a new shared `buildTournamentEntryPipeline(tournamentId, approvalStatus, sort, search)` in `routes/tournaments.js` (also usable for the detail page's own entries row) that joins in `Entry`, `User`, and a `followerCount` via `$lookup` on `Follow`.

### `activateTournament(tournamentId)` — extracted into `jobs/tournamentJobs.js`, exported

Previously inline inside the `tournament_cooldown_expiry` job handler; now a standalone exported function (status-filtered `findOneAndUpdate` on `{ status: 'cooldown' }` so a concurrent job run and a cap-reached route call can't double-activate) so both the sweeper job and the approve route above can call it. Sets `status: 'active'`, `activeAt`, and `stage: 'group'`, and — as of 2026-07-05 (later), superseding the gap this paragraph used to flag — **also calls `generateGroups`/`generateGroupMatches` from `utils/tournamentScheduler.js`** to actually produce groups and the first round of real matches. See the Phase 4 "As-Built" note below for the full behavior and the gap that replaced it (Phase 5: match results never get written back onto `TournamentMatch`/`TournamentEntry`).

### `views/tournaments/detail.ejs` / `routes/pages.js` — "Participate" now redirects to upload, not a modal

The "Participate" button (non-organizer, non-juror, no existing `TournamentEntry`, `status === 'open'`) is now a plain link to `/submit?tournamentId=<id>`, not a JS-driven modal. `GET /submit` (in `routes/pages.js`) reads `?tournamentId`, runs `checkTournamentPreflight`, and passes `targetTournament: { tournament, eligible, reason }` to the view so the upload page itself can surface an ineligibility message before the user picks media. `POST /submit` and `POST /entries` (in `routes/api.js`) both, after creating the `Entry`, call `submitEntryToTournament` if `req.body.tournamentId` was set (explicit target) and unconditionally fire-and-forget `attemptTournamentAutoDraft` (wildcard match against any other open tournament) — so a single upload can both explicitly target one tournament and auto-draft into others. The "Review candidates" CTA on the detail page is gated on `status === 'open' || status === 'cooldown'` (matching the route's new phase gate, see above), and now shows a pending-count badge. Detail route also computes `isJuror` (hides Participate from jury members) and no longer increments `tournament.viewCount` (see the flagged gap in "Phase 9 Extensions").

### Files touched, not previously listed

`utils/tournamentSubmission.js` (new, 137 lines); `utils/weightedRating.js` (new, 16 lines); `routes/api.js` (net -190 lines — old eligibility/submit routes replaced by calls into `tournamentSubmission.js`); `routes/pages.js` (`/submit` GET+POST wired to the same helpers); `utils/contestEligibility.js` (refactored onto `getUserRatingStats`); `utils/estimateParticipantPool.js` (per-entry rating machinery removed, replaced with profile-wide weighted rating pipeline stage); `models/Tournament.js` (`stains`, `wildcardStains`, `stage`); `models/TournamentEntry.js` (`autoSubmitted`); `jobs/tournamentJobs.js` (`activateTournament` also stamps `stage: 'group'`; `MIN_JURY` now exported); `views/tournaments/create.ejs`, `detail.ejs`, `index.ejs`, `review.ejs` (stain UI, participate-as-link, stage/deadline/follow card redesign, search+sort, cap-reached confirmation modal); `routes/api.js` (`POST .../revert` and `POST /tournaments/:id/advance-now`, new).

### Jury/organizer barred from voting in regular H2H contests — fixed 2026-07-05

`CLAUDE.md`'s jury rule ("cannot vote in regular H2H contests during the tournament") was documented from the start but had never actually been enforced — `POST /api/contests/:id/vote` had no tournament-awareness at all. Now fixed, and extended to organizers too (not just jury, per updated `CLAUDE.md`): before recording a vote, if `contest.tournamentId` is null (a "regular"/standalone contest, as opposed to a contest that's itself a tournament group/knockout match), the route checks `Tournament.exists({ createdBy: userId, status: { $in: ['open','cooldown','active'] } })` and, via `TournamentJury.distinct('tournamentId', { userId })`, whether any tournament the user serves as jury on (regardless of invite `status` — same no-status-filter convention as the entry-submission guards) is currently `open`/`cooldown`/`active`. Either match blocks the vote with a 403. Contests that *are* tournament matches (`tournamentId` set) are unaffected — that's the normal way group/knockout matches get decided, and jury tie-break votes are the separate `TournamentJuryVote` mechanism, not this endpoint. `DELETE /api/contests/:id/vote` (withdrawing a vote) was left untouched — the restriction is about casting new votes, not retracting one already cast before the person became jury/organizer.

---

## Phase 4 — Cooldown: Group Assignment & Match Schedule ✅ done 2026-07-05 (later)

**As-built summary:** the draft below (4A–4G) was implemented close to as-written for group generation and round-robin match scheduling, with three real divergences: (1) `generateGroupMatches` uses a "circle method" round-robin (`circleMethodRounds`) instead of the greedy slot-scheduler pseudocode in 4C — same guarantee (no double-booking, minimum rounds), different algorithm; (2) the early-launch route is `POST /api/tournaments/:id/advance-now` in `routes/api.js`, not `POST /api/tournaments/:id/launch`, and it works from `open` as well as `cooldown` (4E assumed cooldown-only); (3) `open_tournament_match` (4G) does not explicitly `agenda.schedule('close_contest', ...)` — it relies on the existing 15-min contest sweeper to close the match's `Contest` once its `votingDeadline` arrives, same as every other contest. `activateTournament` also stamps `stage: 'group'` on the tournament, not mentioned in 4F's draft. **What's still missing after Phase 4:** everything in Phase 5 — no code anywhere updates `TournamentMatch.status`/`winnerId` or `TournamentEntry.wins/losses/groupPoints` when a group-stage contest closes, so groups can never be marked `complete` and knockout generation (Phase 6) can never trigger. Read Phase 5 below as the actual next phase of work, not a "someday" section.

### 4A. Create `utils/tournamentScheduler.js`

This utility contains all group and match generation logic. No Express, no session — pure async functions that take IDs and write to the DB.

---

### 4B. `generateGroups(tournamentId)` in `utils/tournamentScheduler.js`

```
Steps:
1. Fetch all TournamentEntries where { tournamentId, approvalStatus: 'approved' }
2. Extract their _id values into an array: entryDocs
3. Shuffle with Fisher-Yates:
   for (let i = entryDocs.length - 1; i > 0; i--) {
     const j = Math.floor(Math.random() * (i + 1));
     [entryDocs[i], entryDocs[j]] = [entryDocs[j], entryDocs[i]];
   }
4. Fetch tournament.groupSize and tournament.groupCount
5. Split shuffled array into chunks of groupSize:
   const groups = [];
   for (let i = 0; i < entryDocs.length; i += tournament.groupSize) {
     groups.push(entryDocs.slice(i, i + tournament.groupSize));
   }
6. For each chunk (index i):
   a. label = String.fromCharCode(65 + i)  // 'A', 'B', 'C', ...
   b. Create TournamentGroup: { tournamentId, label, memberIds: chunk.map(e => e._id), status: 'active' }
   c. Update each TournamentEntry in chunk: { groupId: group._id }
7. Return array of created TournamentGroup docs
```

---

### 4C. `generateGroupMatches(groupId)` in `utils/tournamentScheduler.js`

```
Steps:
1. Fetch TournamentGroup by _id, populate memberIds as TournamentEntry docs (with entryId populated)
2. Fetch tournamentId from the group
3. Generate all unique pairs from memberIds array:
   const pairs = [];
   for (let i = 0; i < members.length; i++) {
     for (let j = i + 1; j < members.length; j++) {
       pairs.push([members[i], members[j]]);
     }
   }
   // Group of 3 → 3 pairs. Group of 4 → 6 pairs.

4. Schedule matches so no player is in two active matches simultaneously.
   Use a slot-based scheduler:
   - slots = []  (array of time slots, each slot holds matches that run simultaneously)
   - playerLastSlot = {}  (tracks the last slot index each player is assigned to)
   
   For each pair [A, B]:
     slotA = playerLastSlot[A._id] ?? -1
     slotB = playerLastSlot[B._id] ?? -1
     assignSlot = Math.max(slotA, slotB) + 1
     if (!slots[assignSlot]) slots[assignSlot] = []
     slots[assignSlot].push([A, B])
     playerLastSlot[A._id] = assignSlot
     playerLastSlot[B._id] = assignSlot

5. Compute scheduledAt for each slot:
   baseTime = now (time of cooldown launch)
   slot 0 → scheduledAt = baseTime
   slot 1 → scheduledAt = baseTime + 24h
   slot 2 → scheduledAt = baseTime + 48h
   ... etc.

6. For each pair in each slot:
   a. Create Contest document:
      {
        createdBy:      tournament.createdBy,
        tournamentId:   tournamentId,
        entries:        [
          { entryId: A.entryId, userId: A.userId },
          { entryId: B.entryId, userId: B.userId },
        ],
        status:         slot === 0 ? 'active' : 'scheduled',  // first slot opens immediately
        visibility:     'public',
        votingDeadline: scheduledAt + 24h,
        windowHours:    24,
        createdAt:      new Date(),
        lastActivityAt: new Date(),
      }
   b. Create TournamentMatch document:
      {
        tournamentId,
        contestId:              contest._id,
        stage:                  'group',
        groupId:                group._id,
        entryIdA:               A.entryId,
        entryIdB:               B.entryId,
        tournamentEntryIdA:     A._id,
        tournamentEntryIdB:     B._id,
        status:                 slot === 0 ? 'active' : 'scheduled',
        scheduledAt:            scheduledAt,
        openedAt:               slot === 0 ? new Date() : null,
      }

7. Schedule agenda job for each contest in slot 0:
   agenda.schedule(contest.votingDeadline, 'close_contest', { contestId: contest._id.toString() })

8. For slots > 0: schedule agenda job 'open_tournament_match' at scheduledAt
   data: { matchId: tournamentMatch._id.toString() }
   (This job opens the match and schedules its close_contest job — see Phase 4E)
```

---

### 4D. Cooldown expiry job

In `jobs/tournamentJobs.js`:

```js
agenda.define('tournament_cooldown_expiry', async job => {
  const { tournamentId } = job.attrs.data;
  const tournament = await Tournament.findOne({ _id: tournamentId, status: 'cooldown' });
  if (!tournament) return; // already launched or already canceled

  // Organizer did not launch manually in 24h → cancel
  await cancelTournament(tournament._id, 'cooldown_expired');
});
```

---

### 4E. Early launch route (organizer triggers before 24h)

In `routes/api.js`:

```
POST /api/tournaments/:id/launch
  middleware: requireAuth

  Steps:
  1. Fetch Tournament. If not found: 404.
  2. If req.user._id !== tournament.createdBy: 403.
  3. If tournament.status !== 'cooldown': 400 { error: 'Tournament is not in cooldown phase.' }
  4. Cancel the scheduled 'tournament_cooldown_expiry' job for this tournament.
  5. Call activateTournament(tournament._id)
  6. Return 200 { success: true, redirectUrl: '/tournament/' + tournament._id }
```

---

### 4F. `activateTournament(tournamentId)` in `jobs/tournamentJobs.js`

```js
async function activateTournament(tournamentId) {
  // Import scheduler inline to avoid circular deps
  const { generateGroups, generateGroupMatches } = require('../utils/tournamentScheduler');

  await Tournament.findByIdAndUpdate(tournamentId, {
    $set: { status: 'active', activeAt: new Date() },
  });

  const groups = await generateGroups(tournamentId);

  for (const group of groups) {
    await generateGroupMatches(group._id);
  }

  // Notify all approved contestants
  const entries = await TournamentEntry.find({
    tournamentId, approvalStatus: 'approved',
  }).select('userId').lean();

  const notifications = entries.map(e => ({
    userId:  e.userId,
    type:    'tournament_live',
    payload: { tournamentId, url: '/tournament/' + tournamentId },
  }));

  await Notification.insertMany(notifications, { ordered: false });
}
```

Also register the cooldown expiry transition into `activateTournament` — when `tournament_open_expiry` fires and transitions to cooldown, and subsequently `tournament_cooldown_expiry` fires, call `cancelTournament`. If organizer launches early, `activateTournament` is called instead.

---

### 4G. `open_tournament_match` job

For matches in slots > 0 (not immediate), an agenda job opens them when their scheduled time arrives:

```js
agenda.define('open_tournament_match', async job => {
  const { matchId } = job.attrs.data;

  const match = await TournamentMatch.findOne({ _id: matchId, status: 'scheduled' });
  if (!match) return;

  await TournamentMatch.findByIdAndUpdate(matchId, {
    $set: { status: 'active', openedAt: new Date() },
  });

  await Contest.findByIdAndUpdate(match.contestId, {
    $set: { status: 'active' },
  });

  const votingDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await Contest.findByIdAndUpdate(match.contestId, { $set: { votingDeadline } });

  await agenda.schedule(votingDeadline, 'close_contest', {
    contestId: match.contestId.toString(),
  });
});
```

---

### Phase 4 exit criteria

- After early launch or cooldown expiry (if not canceled), all groups are created, all group matches are scheduled or active
- Group stage slot 0 matches are immediately active with voting deadlines in 24h
- Later slots have scheduled `open_tournament_match` jobs
- `Tournament.status` is `'active'`
- All approved contestants receive `tournament_live` notification
- If organizer never launches in 24h, `cancelTournament` fires and everything refunds

---

## Phase 5 — Group Stage: Standings & Advancement

### 5A. Extend `jobs/contestJobs.js` — `closeContest` function

At the end of the existing `closeContest` function, after the earnings settlement block, add:

```js
// Tournament match hook
if (contest.tournamentId) {
  const { handleTournamentMatchClose } = require('../jobs/tournamentJobs');
  // Fire and forget — don't let tournament logic block or error the main close path
  handleTournamentMatchClose(contest._id, winnerEntryId).catch(err => {
    console.error('[closeContest] tournament hook failed for contest', contest._id, ':', err.message);
  });
}
```

---

### 5B. `handleTournamentMatchClose(contestId, winnerEntryId)` in `jobs/tournamentJobs.js`

```
Steps:
1. Fetch TournamentMatch by { contestId }. If not found: return.
2. If match.status === 'closed': return (already handled).

3. If winnerEntryId is null: TIE — handle separately (see Phase 7)
   Set match.status = 'tie', match.tieStatus = 'jury_pending'
   Save match.
   Call initiateTieResolution(match._id)
   Return early.

4. WINNER EXISTS:
   Determine winner TournamentEntry:
   winnerTE = match.tournamentEntryIdA if match.entryIdA === winnerEntryId, else match.tournamentEntryIdB
   loserTE  = the other one

5. Update TournamentMatch:
   { status: 'closed', winnerId: winnerEntryId, loserTournamentEntryId: loserTE }

6. Update winner TournamentEntry:
   $inc: { wins: 1, totalVotes: <winner vote count>, groupPoints: 1 (if stage === 'group') }

7. Update loser TournamentEntry:
   $inc: { losses: 1, totalVotes: <loser vote count> }

8. If match.stage === 'group':
   Call checkGroupComplete(match.groupId)

9. If match.stage === 'knockout':
   Call handleKnockoutMatchClose(match)
```

---

### 5C. `checkGroupComplete(groupId)` in `jobs/tournamentJobs.js`

```
Steps:
1. Fetch TournamentGroup by _id. If status === 'complete': return.
2. Count TournamentMatches where { groupId, stage: 'group', status: { $ne: 'closed' }, isTiebreakerMatch: false }
   If count > 0: group not done yet, return.
3. All group matches closed → call resolveGroup(groupId)
```

---

### 5D. `resolveGroup(groupId)` in `jobs/tournamentJobs.js`

```
Steps:
1. Fetch all TournamentEntries for this group (via groupId field).
2. Sort by groupPoints descending.
3. Call resolveGroupStandings(groupMembers) → returns ordered array [1st, 2nd, 3rd, ...]

resolveGroupStandings(members):
  a. Sort by groupPoints descending.
  b. Group members with equal groupPoints together.
  c. For each tied group (> 1 member), apply tiebreaker chain:
     i.   Sort by entry.ratingAvg descending
     ii.  If still tied: sort by entry.ratingCount descending
     iii. If still tied: compute totalVotesInGroup (sum of votes received in group stage matches)
           → query TournamentMatch where groupId, closed, entryIdA or entryIdB = member
           → sum ContestVote counts for each member
     iv.  If still tied: flag for jury vote (async — see below)
     v.   If still tied after jury: coin flip (Math.random())

  If steps i–iii resolve the tie:
     Assign ranks 1, 2, 3... based on sorted order

  If step iv required (jury vote for group placement):
     Create a special "group ranking" jury request (not a match tie — a ranking tie)
     Store in TournamentMatch with isTiebreakerMatch: true, stage: 'group'
     Pause group resolution until jury resolves it

4. Top 2 in resolved standings:
   Update TournamentEntry: { groupRank: 1 or 2 }
   Notify contestant: tournament_group_advance notification (you advanced)

5. Bottom member(s):
   Update TournamentEntry: { eliminated: true }
   Notify contestant: tournament_eliminated notification

6. Update TournamentGroup: { status: 'complete' }

7. Check if ALL groups in this tournament are now complete:
   Count TournamentGroups where { tournamentId, status: 'active' } — if 0:
   → All groups done → call generateKnockoutBracket(tournamentId) (Phase 6)
```

---

### 5E. Two-player tie for 2nd place (same groupPoints, both qualify)

This only happens when exactly 2 players are tied for a rank where both qualify (both would be rank 1 and 2 but points are equal). In this case:

Both advance regardless — but seeding order matters for knockout bracket.

Create an extra tiebreaker match:
```js
// In resolveGroupStandings, when top 2 are tied on all statistical measures:
const tiebreakerContest = await Contest.create({
  createdBy:      tournament.createdBy,
  tournamentId:   tournament._id,
  entries:        [{ entryId: A.entryId, userId: A.userId }, { entryId: B.entryId, userId: B.userId }],
  status:         'active',
  visibility:     'public',
  votingDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
  windowHours:    24,
});

const tiebreakerMatch = await TournamentMatch.create({
  tournamentId:      tournament._id,
  contestId:         tiebreakerContest._id,
  stage:             'group',
  groupId:           group._id,
  isTiebreakerMatch: true,
  entryIdA:          A.entryId,
  entryIdB:          B.entryId,
  tournamentEntryIdA: A._id,
  tournamentEntryIdB: B._id,
  status:            'active',
  scheduledAt:       new Date(),
  openedAt:          new Date(),
});

await agenda.schedule(tiebreakerContest.votingDeadline, 'close_contest', {
  contestId: tiebreakerContest._id.toString(),
});
```

When this tiebreaker closes (via `handleTournamentMatchClose`):
- Both get `groupRank` assigned (winner = 1, loser = 2)
- Group resolution continues

---

### Phase 5 exit criteria

- When a group stage contest closes, `handleTournamentMatchClose` fires
- Win/loss/votes/groupPoints update correctly on both TournamentEntry docs
- When all group matches for a group close, `resolveGroup` fires
- Top 2 are advanced, others eliminated with notifications
- Tiebreaker matches are created and resolved before group finalizes
- When all groups complete, knockout generation is triggered

---

## Phase 6 — Knockout Stage

### 6A. `generateKnockoutBracket(tournamentId)` in `utils/tournamentScheduler.js`

```
Steps:
1. Fetch tournament.groupCount and tournament.size

2. Determine knockout field size: groupCount × 2
   (each group contributes 2 qualifiers)

3. Fetch all TournamentEntries where { tournamentId, groupRank: { $in: [1, 2] } }
   Populate groupId to get group label

4. Organize by group: { A: [rank1, rank2], B: [rank1, rank2], ... }

5. Generate first-round pairings using cross-group seeding:
   Pair groups to avoid same-group rematches in round 1:
   - Pair group A rank1 vs group B rank2
   - Pair group B rank1 vs group A rank2
   - Pair group C rank1 vs group D rank2
   - Pair group D rank1 vs group C rank2
   ... etc. for all group pairs

6. Determine first knockout round label:
   fieldSize 2  → 'Final'
   fieldSize 4  → 'SF'
   fieldSize 8  → 'QF'
   fieldSize 16 → 'R16'

7. For each pairing, create Contest + TournamentMatch (same pattern as group matches):
   stage: 'knockout', knockoutRound: <round label>
   All first-round knockout matches open immediately (scheduledAt: now, status: 'active')
   votingDeadline: now + 24h
   Schedule close_contest job for each

8. Notify all qualifiers: tournament_knockout_started notification
```

---

### 6B. `handleKnockoutMatchClose(match)` in `jobs/tournamentJobs.js`

Called from `handleTournamentMatchClose` when `match.stage === 'knockout'`.

```
Steps:
1. Fetch winner and loser TournamentEntry docs from match

2. Loser:
   Update TournamentEntry: { eliminated: true, knockoutRound: match.knockoutRound }
   Send notification: tournament_eliminated

3. Winner:
   Update TournamentEntry: { knockoutRound: match.knockoutRound }
   (will be updated to next round when that match is created)

4. Determine next round:
   'R16' → 'QF'
   'QF'  → 'SF'
   'SF'  → check: is this the SF that feeds the 3rd place match or the final?
            → both SF matches must close before next round can be created
   'Final' → tournament ends → call closeTournament(tournamentId) (Phase 8)
   '3rd'   → tournament ends → call closeTournament(tournamentId) (Phase 8)

5. For R16 → QF, QF → SF:
   Check if the "partner" match in this round is also closed:
   Count TournamentMatches where { tournamentId, knockoutRound: match.knockoutRound, status: 'closed' }
   If all matches in this round are now closed → generate next round matches

6. For SF round:
   When both SF matches are closed:
   a. Get both SF winners → create Final match
   b. Get both SF losers → create 3rd place match
   Both new matches open immediately

7. Create next-round match (when both slots are known):
   Contest + TournamentMatch, stage: 'knockout', knockoutRound: <next round>
   status: 'active', scheduledAt: now, votingDeadline: now + 24h
   Schedule close_contest job
```

---

### 6C. Round progression check — `allMatchesClosedInRound(tournamentId, round)`

Helper used in handleKnockoutMatchClose:

```js
async function allMatchesClosedInRound(tournamentId, round) {
  const openMatches = await TournamentMatch.countDocuments({
    tournamentId,
    knockoutRound: round,
    stage: 'knockout',
    status: { $ne: 'closed' },
  });
  return openMatches === 0;
}
```

---

### 6D. Advancing to next round — `createNextRoundMatch(tournamentId, round)`

```js
async function createNextRoundMatch(tournamentId, currentRound) {
  const roundMap = { 'R16': 'QF', 'QF': 'SF', 'SF': 'Final' };
  const nextRound = roundMap[currentRound];
  if (!nextRound) return;

  // Collect all winners from the current round
  const closedMatches = await TournamentMatch.find({
    tournamentId, knockoutRound: currentRound, stage: 'knockout', status: 'closed',
  }).lean();

  const winners = closedMatches.map(m => ({
    tournamentEntryId: m.tournamentEntryIdA.toString() === m.loserTournamentEntryId?.toString()
      ? m.tournamentEntryIdB
      : m.tournamentEntryIdA,
    entryId: m.winnerId,
  }));

  // Pair winners into next round matches (maintain bracket positioning)
  // winners[0] vs winners[1], winners[2] vs winners[3], etc.
  for (let i = 0; i < winners.length; i += 2) {
    const A = winners[i];
    const B = winners[i + 1];
    const teA = await TournamentEntry.findById(A.tournamentEntryId).select('userId entryId').lean();
    const teB = await TournamentEntry.findById(B.tournamentEntryId).select('userId entryId').lean();
    // Create Contest + TournamentMatch for this pairing (same pattern as before)
    // ... (same Contest + TournamentMatch creation as in generateKnockoutBracket)
  }
}
```

---

### Phase 6 exit criteria

- When all group stages complete, first knockout round is generated and all matches open
- Each knockout match close triggers the next round's match generation
- SF losers are automatically paired into a 3rd place match
- Finals close triggers `closeTournament`
- No manual intervention needed once the tournament is active

---

## Phase 7 — Tie Resolution System ✅ (done 2026-07-06, later; currently uncommitted — see "Phase 7 — As-Built" note in the status header above for the as-built shape and its divergences from the draft below: `/api/tournaments/:id/matches/:matchId/jury-vote`+`/organizer-vote` URL shape rather than `/jury-vote/:matchId`+`/organizer-vote/:matchId`; `missedVotes` only increments for `accepted` jurors, not all; `resolveJuryVote` doesn't write `status`/`winnerId` itself, it re-delegates to `handleTournamentMatchClose`; the jury-vote/organizer-vote pages share a new `views/partials/tieBreakPicker.ejs` not drafted in 9F below — it briefly showed entry titles, missing the "no entry titles" anonymity bar 9F called for, but that was caught and fixed same-day)

### 7A. `initiateTieResolution(matchId)` in `jobs/tournamentJobs.js`

```
Steps:
1. Fetch TournamentMatch by _id. Fetch tournament.
2. Fetch all TournamentJury docs for this tournament.
3. Create Notification for each jury member:
   {
     userId: jury.userId,
     type:   'tournament_tie_jury',
     payload: { tournamentId, matchId, url: '/tournament/' + tournamentId + '/jury-vote/' + matchId }
   }
   NOTE: do not reveal which entries are tied in the notification payload.
4. Schedule agenda job 'tournament_jury_expiry' at now + 6h:
   data: { matchId: matchId.toString() }
```

---

### 7B. Jury vote route

In `routes/api.js`:

```
POST /api/tournaments/:id/jury-vote/:matchId
  middleware: requireAuth

  Steps:
  1. Fetch TournamentMatch by { _id: matchId, tournamentId: id }.
     If not found: 404.
  2. If match.status !== 'tie' or match.tieStatus !== 'jury_pending': 400 { error: 'No active jury vote for this match.' }
  3. Verify req.user is a jury member: TournamentJury.findOne({ tournamentId: id, userId: req.user._id })
     If not found: 403 { error: 'You are not a jury member for this tournament.' }
  4. Check TournamentJuryVote.exists({ matchId, jurorId: req.user._id })
     If exists: 400 { error: 'You have already cast your vote for this tie.' }
  5. Parse req.body.votedForEntryId. Must be match.entryIdA or match.entryIdB.
     If neither: 400 { error: 'Invalid entry selection.' }
  6. Create TournamentJuryVote: { tournamentId: id, matchId, jurorId: req.user._id, votedForEntryId }
  7. Notify each contestant ONLY how many votes they have received so far (not who voted):
     Count votes for entryIdA and entryIdB.
     Create Notification for entryA.userId:
       { type: 'tournament_jury_vote_received', payload: { matchId, voteCount: countA } }
     Create Notification for entryB.userId:
       { type: 'tournament_jury_vote_received', payload: { matchId, voteCount: countB } }
  8. Check if quorum reached: total votes cast >= 3
     If yes: call resolveJuryVote(matchId)
  9. Return 200 { success: true }
```

---

### 7C. `resolveJuryVote(matchId)` in `jobs/tournamentJobs.js`

```
Steps:
1. Fetch all TournamentJuryVotes for this matchId.
2. Count votes per entry:
   const counts = {};
   for (const vote of votes) {
     const key = vote.votedForEntryId.toString();
     counts[key] = (counts[key] || 0) + 1;
   }
3. Find entry with more votes:
   If counts[entryIdA] > counts[entryIdB] → winner = entryIdA
   If counts[entryIdB] > counts[entryIdA] → winner = entryIdB
   If equal (shouldn't happen with quorum of 3 but handle anyway):
     → do not resolve here, fall through to organizer vote
4. Cancel 'tournament_jury_expiry' job for this matchId.
5. Update TournamentMatch: { tieStatus: 'resolved', winnerId: winnerEntryId, status: 'closed' }
6. Resume normal match close flow: call handleTournamentMatchClose with the winner
```

---

### 7D. Jury vote expiry job

```js
agenda.define('tournament_jury_expiry', async job => {
  const { matchId } = job.attrs.data;

  const match = await TournamentMatch.findOne({ _id: matchId, tieStatus: 'jury_pending' });
  if (!match) return; // already resolved by quorum

  // Mark missed votes for non-voting jury members
  const allJurors  = await TournamentJury.find({ tournamentId: match.tournamentId });
  const votedIds   = await TournamentJuryVote.distinct('jurorId', { matchId: match._id });
  const votedSet   = new Set(votedIds.map(id => id.toString()));

  for (const juror of allJurors) {
    if (!votedSet.has(juror.userId.toString())) {
      await TournamentJury.findByIdAndUpdate(juror._id, { $inc: { missedVotes: 1 } });
    }
  }

  // Transition to organizer fallback
  await TournamentMatch.findByIdAndUpdate(matchId, {
    $set: { tieStatus: 'organizer_pending' },
  });

  // Notify organizer
  const tournament = await Tournament.findById(match.tournamentId).select('createdBy').lean();
  await Notification.create({
    userId:  tournament.createdBy,
    type:    'tournament_tie_organizer',
    payload: {
      tournamentId: match.tournamentId,
      matchId:      match._id,
      url:          '/tournament/' + match.tournamentId + '/organizer-vote/' + match._id,
    },
  });

  // Schedule organizer vote expiry at now + 3h
  await agenda.schedule(new Date(Date.now() + 3 * 60 * 60 * 1000), 'tournament_organizer_vote_expiry', {
    matchId: matchId.toString(),
  });
});
```

---

### 7E. Organizer tie vote route

In `routes/api.js`:

```
POST /api/tournaments/:id/organizer-vote/:matchId
  middleware: requireAuth

  Steps:
  1. Fetch tournament, verify req.user._id === tournament.createdBy. Else 403.
  2. Fetch TournamentMatch, verify tieStatus === 'organizer_pending'. Else 400.
  3. Parse req.body.votedForEntryId. Must be match.entryIdA or match.entryIdB.
  4. Cancel 'tournament_organizer_vote_expiry' job for this matchId.
  5. Resolve: Update match { tieStatus: 'resolved', winnerId: votedForEntryId, status: 'closed' }
  6. Call handleTournamentMatchClose with winner
  7. Return 200 { success: true }
```

---

### 7F. Organizer vote expiry job (coin flip)

```js
agenda.define('tournament_organizer_vote_expiry', async job => {
  const { matchId } = job.attrs.data;

  const match = await TournamentMatch.findOne({ _id: matchId, tieStatus: 'organizer_pending' });
  if (!match) return; // organizer voted in time

  // Coin flip
  const winnerId = Math.random() < 0.5 ? match.entryIdA : match.entryIdB;

  await TournamentMatch.findByIdAndUpdate(matchId, {
    $set: { tieStatus: 'resolved', winnerId, status: 'closed' },
  });

  await handleTournamentMatchClose(match._id, winnerId);
});
```

---

### 7G. Post-tournament jury ban

In `closeTournament` (Phase 8), after setting tournament status to 'closed':

```js
// Flag jury members who missed votes for permanent ban
const jurors = await TournamentJury.find({
  tournamentId, missedVotes: { $gt: 0 },
}).select('userId').lean();

if (jurors.length > 0) {
  await User.updateMany(
    { _id: { $in: jurors.map(j => j.userId) } },
    { $set: { juryBanned: true } },
  );
}
```

---

### Phase 7 exit criteria

- Any tie in any match (group or knockout) initiates the jury vote flow
- Jury members receive notification and can vote via the jury-vote page
- Quorum of 3 votes resolves immediately
- If 6h passes without quorum: non-voting jury members get `missedVotes` incremented, organizer gets 3h
- If 3h passes: platform coin flip resolves
- No tie can block tournament progression for more than 9 hours total
- After tournament close: jury members with `missedVotes > 0` get `juryBanned: true`

---

## Phase 8 — Prize Distribution & Tournament Close

### 8A. `closeTournament(tournamentId)` in `jobs/tournamentJobs.js`

```
Steps:
1. Fetch Tournament. If status already 'closed': return.

2. Fetch all knockout TournamentMatches for this tournament:
   Specifically the Final and 3rd place matches.

3. Determine placements:
   const finalMatch = TournamentMatch.findOne({ tournamentId, knockoutRound: 'Final', status: 'closed' })
   const thirdMatch = TournamentMatch.findOne({ tournamentId, knockoutRound: '3rd', status: 'closed' })

   firstEntry  = final winner's TournamentEntry
   secondEntry = final loser's TournamentEntry
   thirdEntry  = 3rd match winner's TournamentEntry

   (For 4-player tournament with only a Final: secondEntry is the finalist, no 3rd match)

4. If tournament.size === 4 (only 1 group, top 2 go to Final only):
   firstEntry  = final winner
   secondEntry = final loser
   thirdEntry  = null (no 3rd place prize for 4-player tournaments)

5. Credit prizes to earnedCHL:
   EXCHANGE_RATE = 0.20

   For each winner (first, second, third):
     prize = tournament.prizes.first / .second / .third
     updatedUser = User.findByIdAndUpdate(
       entry.userId,
       { $inc: { 'wallet.earnedCHL': prize } },
       { new: true, select: 'wallet' }
     )
     Write WalletTransaction:
       { type: 'tournament_prize_payout', direction: 'credit', amountCHL: prize,
         source: 'tournament_close', referenceId: tournamentId, referenceType: 'Tournament' }
     Create Notification:
       { type: 'tournament_prize_awarded', payload: { place: 1/2/3, amountCHL: prize, tournamentId } }

6. Set Tournament:
   { status: 'closed', 'prizes.winnersSet': true }

7. Notify all participants: tournament_closed notification

8. Apply jury ban (see Phase 7G)

9. Update right panel: no explicit action needed — panel query filters by status: 'active'
```

---

### 8B. Tournament sweeper (add to `jobs/sweeper.js`)

Add a new sweeper function alongside the existing contest sweeper. This handles any deadlines the one-time agenda jobs might have missed (server restart, etc.):

```js
async function runTournamentSweeper(agenda) {
  const now     = new Date();
  const horizon = new Date(now.getTime() + WINDOW_MS); // 15 min ahead

  // Sweep open phase deadlines
  const openExpiring = await Tournament.find({
    status: 'open',
    openDeadline: { $lte: horizon },
  }).select('_id openDeadline').lean();

  for (const t of openExpiring) {
    if (t.openDeadline <= now) {
      // Fire immediately
      const { tournamentOpenExpiry } = require('./tournamentJobs');
      await tournamentOpenExpiry(t._id);
    } else {
      const existing = await agenda.jobs({
        name: 'tournament_open_expiry',
        'data.tournamentId': t._id.toString(),
        nextRunAt: { $ne: null },
      });
      if (existing.length === 0) {
        await agenda.schedule(t.openDeadline, 'tournament_open_expiry', { tournamentId: t._id.toString() });
      }
    }
  }

  // Sweep cooldown deadlines (same pattern)
  // Sweep jury vote expiry (same pattern, checking TournamentMatch where tieStatus: 'jury_pending')
  // Sweep organizer vote expiry (same pattern, checking TournamentMatch where tieStatus: 'organizer_pending')
}
```

Add `runTournamentSweeper(agenda)` call inside the existing `startSweeper` function:
```js
agenda.define('contest_sweeper', async () => {
  await Promise.all([
    runVoidSweeper(agenda),
    runCloseSweeper(agenda),
    runTournamentSweeper(agenda),
  ]);
});
```

---

### Phase 8 exit criteria

- `closeTournament` fires after Final and 3rd place match both close
- 1st/2nd/3rd prize amounts are credited to winners' `earnedCHL`
- `WalletTransaction` records exist for each payout
- All participants receive `tournament_closed` notification
- Winners receive `tournament_prize_awarded` notification with their place and amount
- Tournament `status` is `'closed'`
- Jury members with missed votes are permanently flagged

---

## Phase 9 — Frontend, Admin & Notifications

### 9A. New view files to create

```
views/tournaments/index.ejs        — Browse tournaments (open, active, recently closed)
views/tournaments/detail.ejs       — Tournament detail (status-aware rendering)
views/tournaments/create.ejs       — Multi-step creation form (step 1–4)
views/tournaments/review.ejs       — Organizer candidate review queue
views/tournaments/jury-vote.ejs    — Anonymous jury voting interface
```

### 9B. `views/tournaments/index.ejs` — **done** (Open/Active/Closed tabs built; card content is simpler than specced, plus a Draft tab was added)

Tabs, as built: Open, Active, Closed, **Draft** (not in original spec — see below).

- Cards (shared markup across all three status tabs) show: thumbnail (uploaded image, or a trophy icon placeholder if none), name, `@organizer`, `N entries`, prize pool total, chevron → `/tournament/:id`. The size/progress/winner-specific details in the original per-tab spec (spots filled, days remaining, group/knockout progress, winner username+avatar) are **not yet built** — cards are currently uniform across tabs.
- **Draft tab (new):** if `req.session.tournamentDraft` exists, shows one row (thumbnail, name or "Untitled tournament", "Step N of 5 — tap to resume") linking to `/tournaments/create`, which redirects to the correct step. Empty state otherwise. (Updated 2026-07-03: was "Step N of 4" before the Review step was added — see "Phase 2 Extensions".)

No participation action on this page — all actions happen on the detail page.

---

### 9C. `views/tournaments/detail.ejs` — status-aware rendering — **partially done**

**Built so far (applies across statuses):** thumbnail hero banner (`aspect-3/1`, only rendered if `thumbnailUrl` is set), summary block, `entries.length/size` + prize pool stat tiles ("Entries" label, not "Players" — the platform-wide `Entry` terminology from `CLAUDE.md` was applied here), approved-entries list section (header now reads "Entries" too). This is fed by the read-only `GET /tournament/:id` route (fetches Tournament + approved TournamentEntries + matches with populated contestId, plus `declinedJuryCount` and `isFollowing` as of 2026-07-03).

**Organizer/social actions wired 2026-07-03 (ahead of the status-aware content below):** status badge inline with title; Share button (Web Share API with clipboard fallback); for the organizer while `open`/`cooldown` — "Cancel Tournament" (confirmation modal → `POST /tournament/:id/cancel`) and "Edit" (→ `/tournament/:id/edit`); a "Manage jury" card always visible to the organizer with an "N declined" badge (→ `/tournament/:id/jury/manage`); a follow/unfollow button for non-organizer viewers. Flash messages now support `flashType` (success/error styling).

**Social layer wired 2026-07-04 (also ahead of the status-aware content below) — see "Phase 9 Extensions" immediately after this section for full detail:** watch/subscribe bell icon, a view counter (currently not incremented — flagged gap), a tournament-level Report button, a full comments panel (post/edit/delete/like/dislike/report, one level of replies), and — for `status === 'closed'` — a podium fed by `loadTournamentPlacements` (present in code today but always empty until Phase 4–8 land).

**Not yet built — everything below is still the Phase 9C target, unimplemented:**

**When `status === 'open'`:**
- Tournament name, description, eligibility criteria list
- Prize pool display: 1st / 2nd / 3rd amounts
- Approved entries grid (entry card thumbnails, username)
- Pending count ("X entries awaiting review")
- Open phase countdown
- "Submit Your Entry" button (if user is eligible and hasn't submitted)
  - On click: opens entry picker modal (fetch user's entries, pick one, POST to /api/tournaments/:id/submit)
- If user already submitted: show submission status badge (pending / approved / rejected)

**When `status === 'cooldown'`:**
- Confirmed participant list (approved entries)
- "Tournament starts in Xh Ym" countdown to launch
- Prize pool display

**When `status === 'active'`:**

Two sub-sections toggle via tab:

*Groups tab:*
- One standings table per group
- Columns: Rank, Entry (thumbnail + username), W, L, Pts
- Highlight top 2 (will advance)
- Each row links to the entry page
- Active matches listed below each group table as H2H contest cards (same entryCard partial, with vote buttons)

*Bracket tab (only shown once knockout begins):*
- Visual bracket showing knockout rounds
- Each matchup shows entry thumbnails, vote counts (live)
- Advancing players highlighted
- Eliminated players greyed out

**When `status === 'closed'`:**
- Podium: 1st / 2nd / 3rd with entry thumbnail, username, prize amount — **done 2026-07-04** via `loadTournamentPlacements(tournamentId)`, see below
- Full bracket results
- Total matches played, total votes cast across tournament

---

## Phase 9 Extensions — built 2026-07-04, beyond original spec

None of this was in the original plan (it has no `views/tournaments/detail.ejs` comments/watch/report section at all). It grew out of Phase 9C's detail page and is documented here rather than renumbered into 9A–9J above.

### New models: `TournamentComment`, `TournamentCommentReport`, `TournamentReport`, `TournamentWatch` (renamed `TournamentLoop` 2026-07-05, see note below)

- **`models/TournamentComment.js`** — `tournamentId`, `userId`, `parentId` (self-ref, null for top-level — one level of nesting only, same rule as the platform `Comment` model), `body` (max 1000 chars), `hidden` (Boolean, set `true` the moment any report lands — no moderation queue wired yet, so a single report currently hides a comment for everyone), `editedAt`, `likes`/`dislikes` (arrays of `User` refs). Indexes on `tournamentId` and `parentId`.
- **`models/TournamentCommentReport.js`** — `tournamentCommentId`, `reportedBy`, `status` (`pending | approved | rejected`, default `pending`). Unique on `{ tournamentCommentId, reportedBy }`.
- **`models/TournamentReport.js`** — `tournamentId`, `reportedBy`, `status` (`pending | approved | rejected`, default `pending`). Unique on `{ tournamentId, reportedBy }`. Reports the tournament itself (distinct from reporting a comment on it).
- **`models/TournamentWatch.js`** — renamed **`models/TournamentLoop.js`** 2026-07-05 (later), same shape: `tournamentId`, `userId`, unique on `{ tournamentId, userId }`. A simple subscribe/loop-in-to-this-tournament toggle, independent of following the organizer. The corresponding route also moved from `POST /tournament/:id/watch` to `POST /tournament/:id/loop-in` (see below). A companion model, **`models/TournamentEntryLoop.js`** (new, not a rename — `tournamentEntryId`, `tournamentId`, `userId`, unique on `{ tournamentEntryId, userId }`), lets a viewer loop in on one specific candidate's `TournamentEntry` rather than the whole tournament, via `POST /tournament/:id/entry/:teId/loop-in`. Both notify through `utils/tournamentEntryLoop.js`'s `notifyEntryLoopedIn(entries, excludeUserIds)`, called from `utils/tournamentScheduler.js` and `jobs/tournamentJobs.js` (match-live) and `jobs/contestJobs.js` (match-closed). The platform-wide standalone-contest equivalent, `utils/notifyWatchers.js`, was renamed `utils/notifyLoopedIn.js` in the same pass, and `models/ContestWatch.js` → `models/ContestLoop.js`.

None of `TournamentComment`/`TournamentCommentReport`/`TournamentReport`/`TournamentLoop`/`TournamentEntryLoop` are mounted anywhere beyond being required directly in `routes/tournaments.js` or `routes/api.js` (no admin moderation queue reads `TournamentCommentReport`/`TournamentReport` yet — reports land in the DB but nothing surfaces them to a moderator today).

### New routes (`routes/tournaments.js`)

```
POST   /tournament/:id/loop-in                   — (was /tournament/:id/watch) toggle TournamentLoop; blocks the organizer looping on their own tournament
POST   /tournament/:id/entry/:teId/loop-in        — toggle TournamentEntryLoop on one candidate's entry; blocks looping on your own entry
POST   /tournament/:id/report                     — create TournamentReport; blocks the organizer reporting their own; 409 on duplicate
POST   /tournament/:id/comments                   — create top-level or reply comment (280-char cap, spaces not counted); replying to a reply
                                                      re-parents to the original top-level comment (`effectiveParentId`), keeping nesting at one level
PATCH  /tournament/:id/comments/:cid              — edit own comment, sets editedAt
DELETE /tournament/:id/comments/:cid              — owner or moderator+ (role in moderator/supervisor/superadmin/founder); cascades to
                                                      delete replies and TournamentCommentReport docs for the deleted comment
POST   /tournament/:id/comments/:cid/report       — reports a comment; auto-hides it (`hidden: true`) immediately, no threshold; re-reportable
                                                      after a prior report was marked 'rejected'
POST   /tournament/:id/comments/:cid/react        — like/dislike toggle, mutually exclusive (liking removes an existing dislike and vice versa)
```

All comment/report/watch routes require only `requireAuth` (already applied at the router level) — no additional tournament-status gating, so these work in every lifecycle state including `closed`.

### `loadTournamentComments(tournamentId)` — in `routes/tournaments.js`

Fetches non-hidden top-level comments + their non-hidden replies, populates `userId` (username/displayName/avatar), and sorts by a recency-weighted net-reaction score: `ownNet + replyBoost * 0.25 + recency`, where `recency = 1 / (hoursOld + 2)^1.5` and `replyBoost` sums each reply's own net-reaction-weighted-by-recency. Called from `GET /tournament/:id` for every status, not just `closed`.

### `loadTournamentPlacements(tournamentId)` — in `routes/tournaments.js`

Only called when `tournament.status === 'closed'`. Finds the `Final` and `3rd`-place `TournamentMatch` docs (`knockoutRound` enum values) and derives 1st (Final winner), 2nd (Final loser), 3rd (3rd-place match winner) as populated `TournamentEntry` docs — no separate "placement" field is persisted anywhere. Returns `{}` if no Final match exists, which is always true today since Phase 4–8 (bracket generation) isn't built — this is forward-compatible plumbing, not evidence the bracket exists.

### `views/tournaments/detail.ejs` UI additions

- Watch bell icon (`boxicons:bell` / `boxicons:bell-ring-filled`) next to the title, toggling `POST /tournament/:id/watch`.
- View counter reading `tournament.viewCount` — **flagged gap:** the increment call (`Tournament.updateOne({ _id }, { $inc: { viewCount: 1 } })` in `GET /tournament/:id`) was written and then removed again in the same working session; the field and its display are live but nothing increments it right now. Needs the increment restored (fire-and-forget, same pattern as `Entry.viewCount`) or the counter should be pulled from the view until it does.
- Share button (Web Share API, falls back to clipboard copy).
- Report button (organizer's own tournament hides this; posts to `/tournament/:id/report`, button becomes "Reported" on success).
- Comments panel (toggled via a Comment tab): compose box (280-char cap), one level of reply threads, per-comment like/dislike counts with active-state styling, edit (own only) and delete (own + moderator+) actions, report button per comment/reply.
- Podium block for `status === 'closed'`, fed by `placements`.

### Files touched, not previously listed

`models/TournamentComment.js`, `models/TournamentCommentReport.js`, `models/TournamentReport.js`, `models/TournamentWatch.js` (new); `routes/tournaments.js` (+1131 lines in the 2026-07-04 commit — comments/watch/report routes plus the helpers above); `views/tournaments/detail.ejs` (+1184 lines — social layer UI); `views/tournaments/index.ejs`, `views/tournaments/create.ejs`, `views/tournaments/jury-invite.ejs`, `views/tournaments/jury-manage.ejs` (incremental updates, same day); `views/partials/avatarJsHelpers.ejs` (extended).

---

### 9D. `views/tournaments/create.ejs` — multi-step form — **done through step 5 (Review added 2026-07-03); step 1 built out well beyond spec; also now doubles as the edit wizard**

Single EJS file that renders differently based on `step` variable (1–5) and an `editing` flag. See "Phase 2 Extensions" above for the new Step 5 (Review), the edit-mode wizard (`/tournament/:id/edit/stepN`, "Save Changes" via `trySaveNow`), and the live "estimated participant pool" counter added to Step 3.

**Step 1 — Basics — built as:**
- Toggle: Private tournament (hidden from public browsing, reachable via direct link only — writes `visibility`)
- Thumbnail upload (required): drop zone + live preview + clear button, 5MB client-side check before upload
- Input: Tournament Name — capitalized display, live debounced (450ms) availability check against `/api/tournaments/check-name` with inline check/x icon + error text, letters/numbers/spaces only
- Input: Description (optional, 220 char cap)
- Participant cap: radio-card list (not a dropdown) — each card shows group count/size, total contest count, and estimated duration for that size
- Open phase duration: custom dropdown component (not native radio/select) — 1/2/3 days
- "Continue" button disabled until thumbnail + valid+available name are both present
- "Save as Draft" now posts via `fetch` (supports the multipart thumbnail) and toasts instead of redirecting

**Step 2 — Prizes:**
- Three number inputs: 1st (min 1,000), 2nd (min 400), 3rd (min 100)
- Live total display (JS computed as user types)
- SB balance display: "Your balance: X CHL"
- If balance sufficient: green checkmark, "Continue" button
- If balance insufficient: red shortfall message, inline payment section:
  - "You need X more CHL" 
  - Payment button: "Buy X CHL — $Y" → POST /tournaments/fund
  - If shortfall > 500: show multiple payment steps ("3 payments required")
- "Continue" button → POST /tournaments/create/step2

**Step 3 — Eligibility:**
- "Add Criterion" button → shows a row with [field dropdown] [operator dropdown] [value input]
- Max 5 criteria
- "No criteria" option clearly available (empty array is valid)
- "Skip / Continue" button → POST /tournaments/create/step3

**Step 4 — Jury:**
- Search box with typeahead (hits POST /api/tournaments/search-users, now with `excludeTournamentId` support in edit mode)
- As built: a checkbox-style multi-select results list (not pill tags) with a "Done" footer; avatars rendered via the shared `views/partials/avatarJsHelpers.ejs` script (`window.ataAvatarHtml`) instead of duplicated markup
- Count indicator: "X of 5–7 selected"
- Step 4 now advances to Step 5 (Review), not straight to finalize — see "Phase 2 Extensions"

---

### 9E. `views/tournaments/review.ejs`

- Lists pending entries with:
  - Entry thumbnail (video or image)
  - Entry title + caption
  - Submitter username + avatar
  - Entry rating avg + count
  - "Approve" button (green) + "Reject" button (red, opens note modal)
- Count: "X pending, Y approved, Z/N slots filled"
- If no pending entries and tournament is still open: "No entries awaiting review"
- Auto-refresh every 60s (or use SSE if preferred) so new submissions appear without reload

---

### 9F. `views/tournaments/jury-vote.ejs` — **done 2026-07-06, see the Phase 7 as-built note above for the shared-partial/anonymity divergence**

Critical: this page must reveal nothing about jury identity.

- Header: "A match in [Tournament Name] is tied. Your vote is needed."
- Side-by-side entry display: Entry A and Entry B — thumbnail, rating avg only. No usernames. No entry titles. Just the media.
- Vote button under each entry: "Vote for this entry"
- Submit → POST /api/tournaments/:id/jury-vote/:matchId with { votedForEntryId }
- After submit: "Your vote has been cast." — no result shown.
- No navigation to the main tournament page from this screen (to avoid jury members knowing who they're judging)

---

### 9G. Update `views/partials/rightPanel.ejs` — **done (2026-07-03)**

Built essentially as specced below, with `limit(5)` instead of `limit(3)` and `thumbnailUrl` included in the `.select()`. Cards show thumbnail-or-trophy-icon fallback, name, and prize pool formatted as USD (`× 0.20`), not a raw "$X pool" span. Shipped ahead of Phases 3–8 since it only depends on `Tournament.status === 'active'` existing as a reachable state, not on anything those phases build.

Original spec, for reference (replace the existing tournament skeleton, currently commented-out or empty):

```html
<% if (locals.activeTournaments && activeTournaments.length > 0) { %>
  <div class="right-panel-section">
    <h3>Ongoing Tournaments</h3>
    <% activeTournaments.forEach(t => { %>
      <a href="/tournament/<%= t._id %>" class="tournament-card-mini">
        <span class="tournament-name"><%= t.name %></span>
        <span class="tournament-prize">$<%= ((t.prizes.first + t.prizes.second + t.prizes.third) * 0.20).toFixed(0) %> pool</span>
        <span class="tournament-status"><%= t.status %></span>
      </a>
    <% }) %>
  </div>
<% } %>
```

Update `middleware/injectRightPanelData.js` to add:
```js
const Tournament = require('../models/Tournament');
const activeTournaments = await Tournament.find({ status: 'active' })
  .sort({ activeAt: -1 })
  .limit(5)
  .select('name prizes status activeAt')
  .lean();
res.locals.activeTournaments = activeTournaments;
```

---

### 9H. Update `views/partials/sidebar.ejs`

Add "Tournaments" link in the main nav, below Contests:
```html
<a href="/tournaments" class="sidebar-link <% if (currentPath === '/tournaments') { %>active<% } %>">
  Tournaments
</a>
```

---

### 9I. Admin pages

**Update `views/admin/tournaments/index.ejs`** (skeleton exists):
- Table: Tournament Name | Organizer | Size | Status | Prize Pool | Created At | Actions
- Filter by status (open / cooldown / active / closed / canceled)
- Each row links to detail view
- No review/approve/reject actions (admin review step was removed)

**Update `views/admin/tournaments/review.ejs`** (skeleton exists):
- Repurpose as a read-only admin detail view
- Shows full tournament state: groups, matches, standings, jury member count (not identities), prize pool
- "Force Cancel" button for founder/superadmin only (in extreme cases)

Add admin routes in `routes/admin.js`:
```
GET /admin/tournaments          → middleware: requireDomain('tournaments'), render index
GET /admin/tournaments/:id      → middleware: requireDomain('tournaments'), render detail
POST /admin/tournaments/:id/cancel  → middleware: requireDomain(null) [founder only], call cancelTournament
```

---

### 9J. Notification types to add to `models/Notification.js`

**Already added and live — 5 of the 13 below, plus 3 not originally planned:** `tournament_cooldown_started`, `tournament_canceled` (2026-07-03, from the list below); `tournament_entry_submitted`, `tournament_entry_approved`, `tournament_entry_rejected` (2026-07-04, from the Phase 3 candidate-submission/review routes — see "Phase 3 Extensions"); `tournament_jury_invite`, `tournament_jury_declined`, `tournament_entry_removed` (net-new, from the jury invite/manage + edit-wizard criteria-tightening work — see "Phase 2 Extensions"). All 8 render in `views/notifications.ejs` already (medal / error-circle / time / x-circle icons as appropriate; `tournament_canceled` text branches on `payload.reason`, including the new `insufficient_jury`, `cooldown_incomplete`, and `organizer_canceled` reasons).

**Still to add** — the remaining 8, which depend on Phases 4–8 existing to ever fire:
```
'tournament_live'
'tournament_group_advance'
'tournament_eliminated'
'tournament_tie_jury'
'tournament_tie_organizer'
'tournament_jury_vote_received'
'tournament_closed'
'tournament_prize_awarded'
```
(`tournament_cooldown_started`, `tournament_canceled`, `tournament_entry_submitted`, `tournament_entry_approved`, `tournament_entry_rejected` already exist per above — 8 + 5 = the original 13.)

In `views/notifications.ejs`, add rendering cases for each new type. Pattern:
- `tournament_prize_awarded` → "You won [place] place in [tournament name] — [amount] CHL awarded"
- `tournament_eliminated` → "Your entry was eliminated in the [round] round of [tournament name]"
- `tournament_live` → "The tournament [name] is now live — your first match starts soon"
- etc.

---

### 9K. Mount `routes/tournaments.js` in `server.js`

```js
app.use('/tournaments', require('./routes/tournaments'));
```

Add after the existing route mounts (after `app.use('/wallet', ...)`, before the 404 handler).

Also add `registerTournamentJobs` call:
```js
const { registerTournamentJobs } = require('./jobs/tournamentJobs');
registerTournamentJobs(agenda);
```

---

### Phase 9 exit criteria

- Full tournament lifecycle is navigable via browser from creation to close
- All 5 view files render correctly at each lifecycle state
- Jury vote page reveals no user identity information
- Right panel shows active tournaments for all logged-in users
- Admin can browse all tournaments and view full detail (read-only)
- All 13 new notification types render correctly in `/notifications`
- Sidebar shows Tournaments link

---

## Build Order Summary

| Phase | Files Created | Files Modified |
|---|---|---|
| 1 | `models/TournamentGroup.js`, `models/TournamentMatch.js`, `models/TournamentJury.js`, `models/TournamentJuryVote.js` | `models/Tournament.js`, `models/TournamentEntry.js`, `models/User.js`, `server.js` |
| 2 | `middleware/requireOrganizerEligibility.js`, `routes/tournaments.js`, `utils/tournamentCriteria.js`, `utils/estimateParticipantPool.js`, `utils/wallet.js`, `views/tournaments/jury-invite.ejs`, `views/tournaments/jury-manage.ejs`, `views/partials/avatarJsHelpers.ejs` | `server.js`, `routes/api.js`, `models/Tournament.js`, `models/TournamentJury.js` |
| 3 | — | `routes/api.js` (+eligibility/submit/approve/reject), `jobs/tournamentJobs.js` (`activateTournament` extracted), `utils/estimateParticipantPool.js` (+`evaluateTournamentCriteria`), `models/Notification.js` (+3 enum values), `views/tournaments/detail.ejs` (+Participate flow), `routes/tournaments.js` (+`isJuror`) — no `utils/tournamentEligibility.js` file was created, see "Phase 3 Extensions" |
| 4 | `utils/tournamentScheduler.js` ✅ done 2026-07-05 | `jobs/tournamentJobs.js` ✅ |
| 5 | — (not started) | `jobs/contestJobs.js`, `jobs/tournamentJobs.js` |
| 6 | — (not started) | `jobs/tournamentJobs.js`, `utils/tournamentScheduler.js` |
| 7 | — (not started) | `jobs/tournamentJobs.js`, `routes/api.js` |
| 8 | — (not started) | `jobs/tournamentJobs.js`, `jobs/sweeper.js` |
| 9 | `views/tournaments/index.ejs`, `views/tournaments/detail.ejs`, `views/tournaments/create.ejs`, `views/tournaments/review.ejs`, `views/tournaments/jury-vote.ejs`, `views/tournaments/jury-invite.ejs`, `views/tournaments/jury-manage.ejs`, `views/partials/avatarJsHelpers.ejs`, `models/TournamentComment.js`, `models/TournamentCommentReport.js`, `models/TournamentReport.js`, `models/TournamentLoop.js` (renamed from `TournamentWatch.js`), `models/TournamentEntryLoop.js` (new), `utils/tournamentEntryLoop.js`, `utils/notifyLoopedIn.js` (renamed from `notifyWatchers.js`) | `views/partials/rightPanel.ejs`, `views/partials/sidebar.ejs`, `views/admin/tournaments/index.ejs`, `views/admin/tournaments/review.ejs`, `views/notifications.ejs`, `middleware/injectRightPanelData.js`, `routes/admin.js`, `models/Notification.js`, `routes/tournaments.js`, `models/Tournament.js` |

---

## What changes vs. old Phase 7/8

| Old spec | New spec | Impact |
|---|---|---|
| Round-robin, 66% win threshold | Group stage + knockout | `TournamentMatch` replaces simple win tracking; group scheduler new |
| Winner = highest totalVotes | Winner = grand final winner | `closeTournament` logic changed |
| 30-min per-review clock per entry | 3-day open window, batch review | No `missedReviews` counter; no 30-min agenda jobs |
| Replay chain (72h→36h→18h→9h) | Jury → organizer → coin flip | `TournamentJury`, `TournamentJuryVote` models new; tie jobs new |
| Admin review (`pending_review`) | No admin review | Remove `pending_review` status, `reviewStatus`, `fundsHeld` |
| Fixed prizes $1k/$400/$100 | Flexible prizes with minimums | `prizes` schema changed to plain Numbers |
| Single top-up max $200 | Tournament-gated $500 top-up | New `/tournaments/fund` route |
| No jury | 5–7 member anonymous jury | Two new models, new jobs, new view |
| `pending_funds` lifecycle state | Prizes funded inline at creation | `fundsHeld` removed; `prizes.funded` replaces it |

---

## Follow-up Tasks (not yet scheduled to a phase)

- Let organizers toggle whether they receive a notification when someone requests to join their tournament (extend `User.notificationSettings` with a tournament join-request in-app/email toggle, alongside the existing comments/nominations/contests/payouts toggles; gate the `tournament_entry_submitted` notification on it).
