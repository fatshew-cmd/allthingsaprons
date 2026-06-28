# June Action Plan

## Current State (June 27)

Phase 1 (schema alignment), Phase 2 (auth + user foundation), and Phase 3 (entries + ratings) are complete. Phase 6 admin infrastructure — role system, staff hiring flow, audit log, support chat, and admin profile — was pulled forward and is also done. Follow/unfollow and direct messaging are now complete. The leaderboard is also fully wired. The contest system — creation, nomination, acceptance, voting, result display, contest comments, private contests, and withdrawal/forfeit — is now substantially complete. Void deadline state is normalized at read time via Mongoose post-hooks (bridge until Phase 5 background jobs land); UI correctly shows "Timed out" / "No response" states across entryCard, edit-entry, and the contest page. Entry comments and replies are fully implemented. The notification system is live. The right panel is fully built. Nomination notification redirect is fixed.

**entryCard script extracted to partial.** The large inline `<script>` block that was previously embedded in `views/partials/entryCard.ejs` (guarded by `locals.__ecScript`) has been extracted to its own partial `views/partials/ecScript.ejs`. It is now included once per page via `views/partials/appEnd.ejs`. This removes the guard hack and ensures the script loads exactly once regardless of how many cards are on the page. Minor fix: the rating label element uses `h-5 leading-5 overflow-hidden` instead of `min-h-4` to prevent layout shifts.

A **contest eligibility gate** is now wired: before a user can create a contest or accept a nomination, `utils/contestEligibility.js` checks their entries against configurable thresholds (`minEntries`, `minRatingCount`, `minWeightedAvg`) stored in the `PlatformSettings` collection. The admin **Platform Settings page** (`/admin/settings`) lets the founder adjust these thresholds live. The **announcement detail/stats page** is implemented — shows dismissal count, placeholder rows for impressions/clicks (tracking not yet wired), a right-panel card preview, and activate/expire/delete actions.

The **entryCard HTH contest badges** now have full visual differentiation across all contest states: pending (amber), accepted/waiting-to-go-live (charm), active/live (green), won (yellow), lost (muted/dimmed), void (greyed with reason label). Won/lost dim vote count values accordingly. The old `contestInfo` overlay badge on card media was removed — state is conveyed entirely through the badges section below the media.

The **`/contests` page** is now fully wired. The route queries active public contests (and contests the current user is a participant in), builds contestant rows with per-viewer follow state, and passes live data to the view. The view was redesigned: card layout with picture-in-picture media thumbnails, contestant rows with inline follow/following toggle buttons, live countdown timers, and "vs" dividers. Pending nominations panel remains functional as before.

Two **correctness bugs fixed**: (1) the feed and entry page contest badge data was broken when the current user was the *nominee* rather than the nominator — the query filtered to `nominatorId: ownerId` and skipped the case where the user received the nomination. Both pages now populate both `nominatorId` and `nomineeId` and derive the opponent dynamically. (2) Profile page `receivedNominations` query now includes `void` status so forfeited/voided contests still appear in contest history.

The **Take On feature** is now fully implemented. Initiator clicks Take On on any entry card → redirected to `/submit?takeOnTargetId=<entryId>` → submits their entry → contest created pending + `take_on_received` notification sent to the targeted entry's owner → owner accepts or declines from `/take-on/:id`. Accept moves the contest to `active`; decline voids. `allowTakeOns` toggle is on the entry edit page (default on). `takeOnCount` is denormalized on Entry. The `Nomination` model was extended with `type`, `nomineeEntryId`, and `challengerEntryId` fields to support this flow alongside standard nominations. Notification types `take_on_received` and `take_on_accepted` are wired throughout.

**Phase 5 background jobs are done.** `agenda` is installed and wired. The void deadline sweeper + `void_expired_contest` one-time jobs replace the old Mongoose post-hook bridge (post-hooks removed). The voting deadline sweeper + `close_contest` one-time jobs count votes, set `winnerEntryId`, status → `closed`, and fire `contest_closed` notifications to both participants. Both sweepers run on startup to catch any deadlines missed while the server was down.

**Phase 4.7 (Chilli Wallet + Economic Flow) is substantially complete.** All models are built (`WalletTransaction`, `ContestContribution`, `ContestPayout`, `MonthlySnapshot`). The wallet uses two separate pools — `purchasedCHL` (SB, from top-ups) and `earnedCHL` (AAC, from contest payouts) — replacing the old single `balanceCHL` field. The full top-up flow is live (`/wallet/topup` → `/wallet/checkout` → `POST /wallet/checkout` → wallet credit + `WalletTransaction` audit record). Contribution routes are fully wired on active contests: `POST /api/contests/:id/contribute`, `PATCH` (adjust), and `DELETE` (withdraw), each debiting/crediting the wallet and writing the appropriate transaction record. The contest-close job (`close_contest`) now locks all active contributions, credits 75% net to each contestant's `earnedCHL` immediately, creates `ContestPayout` audit docs, and fires `contest_payout_available` notifications. The settings wallet section is live: SB + AAC balance display, auto-payout notice with "Hold until the 15th" button (visible 25th–29th), and transaction history with links to a dedicated `/wallet/transaction/:id` detail page. Profile stats row shows spendable balance (owner view only). All four monthly payout background jobs are running via agenda: `snapshot_monthly_balances` (1st), `payout_reminder` (25th, in-app + email), `auto_payout_30` (30th), and `makeup_payout_15` (15th). `POST /wallet/hold-payout` endpoint is live. All three new notification types (`payout_reminder`, `payout_processed`, `contest_payout_available`) render correctly in `/notifications`.

**Privacy & notification settings are now live.** `privacySettings` (`whoCanDm`, `showMatureContent`, `showAiContent`, `defaultAllowTakeOns`) and `notificationSettings` (in-app + email toggles for comments, nominations, contests, payouts) are embedded on User. Both are wired to new settings tabs (Privacy, Notifications) with `POST /settings/privacy` and `POST /settings/notifications` routes.

**Wallet schema migration complete.** `User.wallet.balanceCHL` → `purchasedCHL` + `earnedCHL` two-pool model is fully live. Migration scripts ran (`scripts/migrateWalletPools.js`, `scripts/correctWalletBalance.js`). All routes, jobs, and views updated. The `withTxnOrFallback` helper in `routes/wallet.js` handles replica-set-less dev environments gracefully.

**Full transaction history page** (`GET /wallet/transactions`) is live with month + type filters and Excel download (`GET /wallet/transactions/download`). The `transaction/:id` detail page links to a billing dispute flow: `GET /contact/new?topic=billing&txId=<id>` auto-creates a support thread and pre-populates a dispute message with the transaction details.

**Top-up package names updated:** Starter → "Chill Vibes", Medium → "After Hours", Hot → "Milky Way", Inferno stays.

**Content Moderation (Phase 6) is now fully implemented.** The admin moderation queue at `/admin/moderation` is live with two tabbed views — Comments and Entries — both with real data and actions. Comment reports: pulls all `CommentReport` + `ContestCommentReport` docs with `status: 'pending'`, groups by comment, shows reporter list and context; Approve deletes the comment and fires `comment_removed` (author) + `report_reviewed` (reporters) notifications; Reject reinstates the comment (`hidden: false`) and fires `report_reviewed`. Entry reports: `POST /api/entries/:eid/report` is wired with threshold logic (configurable via admin settings) — when a threshold is crossed, `Entry.hidden → true` and any active contests containing that entry are stalled (`Contest.stalled: true`, `Contest.stalledAt: now`); entry owner receives `entry_reported` notification, contestants + watchers receive `contest_stalled`. Admin Approve (clear) reinstates the entry, extends the voting deadline by the stall duration (capped at 24h), and fires `contest_resumed`. Admin Approve (violating) deletes the entry, voids any active contest with `voidReason: 'entry_removed'`, and fires `entry_removed` to entry owner.

**Schema additions shipped:** `EntryReport` model (new), `Entry.hidden: Boolean`, `Contest.stalled: Boolean`, `Contest.stalledAt: Date`, `Contest.voidReason` enum extended with `'entry_removed'`, `PlatformSettings.entryReportThresholds` array (default: 3/60min, 5/360min, 10/1440min), `CommentReport.status` + `reasons` fields, `ContestCommentReport.status` field, `Comment.likes`, `Comment.dislikes`, `Comment.pinnedAt`, `ContestComment.likes`, `ContestComment.dislikes`.

**All 6 new notification types render in `/notifications`:** `comment_removed`, `report_reviewed`, `contest_stalled`, `contest_resumed`, `entry_reported`, `entry_removed`. Removal notifications (`comment_removed`, `entry_removed`) use a two-row layout with "Community guidelines" link and "Dispute this decision" button → `/contact/new?topic=moderation&contentType=<entry|comment>`.

**`/guidelines` page is live** — community guidelines view at `views/guidelines.ejs` + `GET /guidelines` route.

**Comment enhancements:** Like/dislike reactions wired on entry comments and replies via `POST /entries/:eid/comments/:cid/react` and `POST /contests/:id/comments/:cid/react`. Comment pinning for entry owners via `POST /entries/:eid/comments/:cid/pin`. Comments on both entry and contest pages are now sorted by score (net likes − dislikes + recency decay), with pinned comments always first. Entry card comment section renders like/dislike buttons and pin button (owner only). Report button on entry card is now wired to the real `POST /api/entries/:eid/report` route (was a fake toast).

**Entry page — raters list:** Entry page now shows the list of users who rated the entry, with follow state for the viewer, pulled via `GET /entry/:id`.

**Profile page UI refactor:** Message button moved into a "More" dropdown (`···` icon button). Nominate button condensed to a compact icon (`boxicons:git-compare`). More menu includes: Direct Message, Share Profile (stub), Block (stub), Report user (stub).

**Admin user detail — password reset:** `POST /admin/users/:id/password` allows moderators/supervisors to reset a regular user's password. Enforces strict password rules (12+ chars, 3+ each of upper/lower/digit/special). Admin-only; rejects non-`user` role targets.

What remains in Phase 6: tournament management pages (deferred to July).

### What is done
| Asset | Status |
|---|---|
| All models | Complete and aligned with `platform-core-concepts.md` |
| Auth routes | Signup (OTP via Resend), login, logout — fully working |
| Access model | No onboarding gate — registered users get full platform access immediately after signup. ID verification is scoped: only triggered when a user attempts to submit an entry or create a tournament without `idVerified: true` |
| ID verification | Own route file (`routes/verify-identity.js`). Selfie + government ID upload, code generation, attempt limiting, 2hr block after 3 failures. Triggered on-demand from `/submit`, not as a signup step — fully working |
| Admin entry review | Approve/reject ID verification submissions, sets `idVerified` — fully working |
| `requireAuth` middleware | Unauthenticated users redirected to signup |
| `requireApproved` middleware | Loads `req.currentUser`; blocks only `banned` accounts — does not confine users by onboarding state (there is none) |
| Entry upload | Photo + video, tags, caption — fully working |
| Entry display page | Media, owner info, rating avg/count — fully working |
| Entry edit page | Title, caption, tags, visibility, mature/AI flags; locked during active contests — fully working |
| Rating flow | 1–10, no self-rate, no duplicate, denormalized onto entry — fully working |
| Profile page | Entries, follow counts, stats, contest/tournament history, banner pan/zoom — fully working |
| Settings page | Edit username, bio, avatar, banner with drag pan/zoom positioning — fully working |
| Banner positioning | `posX`, `posY`, `zoom` stored on User; drag-to-reposition UI in settings and profile edit; rendered correctly on profile display with gap-clamping fix |
| Follow / Unfollow | `routes/follow.js` — `POST /follow/:username` + `POST /unfollow/:username`. Profile action row has Follow + Message buttons. "People you might like" section appears after following, sourced from the profile's followers + following |
| Direct messages | `Conversation` + `DirectMessage` models, `routes/messages.js`. Two-panel `/messages` view — conversation list + thread. Message button on profile opens or creates the conversation. Polled every 5s |
| Support chat | User-facing `/contact` thread + admin `/admin/support` two-panel messenger — fully working |
| Admin role system | 5-tier hierarchy (`user → moderator → supervisor → superadmin → founder`), domain permissions (`content / chat / comments / financial / support`), `requireDomain` middleware, domain-aware sidebar, scoped badge counts, admin accounts page — fully working |
| Admin hiring flow | Public careers page, applications queue, invite-based account creation with 72h token, invite acceptance + password setup, temporary account support — fully working |
| Admin audit log | Append-only `admin_audit_logs` collection, `ATA-YYYYMMDD-XXXXXXXX` ticket refs, full metadata, filterable at `/admin/audit-log` — fully working |
| Admin profile | Dedicated admin profile page at `/admin/profile` — fully working |
| BannedEmail / BannedDocHash models | Schema-level infrastructure for ban enforcement — done |
| Feed — Ratings tab | Fully wired: entry query, `UserAffinity` model, `utils/feedScorer.js` (affinity + velocity + follow weighting, decay scoring), `buildFeedPage`, `entryCard` rendered with pre-locked ratings — fully working |
| Contest creation | Creator challenges a user via `POST /api/contests/challenge` or during entry submission; Nomination created with 24hr expiry — fully working |
| Nomination flow | Pending nominations shown on entry edit and submit pages; accept via existing entry or new submission; decline available — fully working |
| Contest voting | Side-by-side entry display, vote counts + percentages, winner badge, vote toggle; no self-vote enforced — fully working |
| Contest page | Full page at `/contest/:id` — both entries, owner info, vote state, related contests, status label — fully working |
| Contest comments | Full CRUD (post, edit, delete, report) for contest-level comments and one-level replies; private contest access guard — fully working |
| Private contests | Creator designates ≥5 voters; `designatedVoters` array enforced on creation — fully working |
| Void deadline — read-time normalization | Mongoose post-hooks on `Contest.find` / `findOne` flip `status` to `void` at read time when `voidDeadline` has passed; UI shows "Timed out" / "No response" across entryCard, edit-entry, and contest page — fully working (background job promotion deferred to Phase 5) |
| Entry comments + replies | Full CRUD on entry-level comments: post, edit, delete (own or entry owner), hide/unhide (entry owner only, moves to private section), report. One level of replies. `commentCount` denormalized on Entry and kept in sync. Comments panel in `entryCard` auto-opens on the entry page; feed cards keep the empty stub. — fully working |
| Notification system | Dedicated `Notification` collection with compound index `{userId, read, createdAt}` and 90-day TTL. `injectNotificationCount` middleware on all main platform routes. `GET /notifications` paginated list, `POST /notifications/:id/read`, `POST /notifications/read-all`. Sidebar badge (count label on expanded, dot on collapsed). Triggers: comment on entry → entry owner notified; reply → parent commenter notified; nomination created → nominee notified. `contest_closed` / `contest_voided` triggers deferred to Phase 5 background jobs. |
| Contest eligibility gate | `utils/contestEligibility.js` — checks minEntries (5), minRatingCount (250), minWeightedAvg (7.4) before a user can create a contest or accept a nomination. Thresholds read from `PlatformSettings` collection. `TEST_BYPASS_USERNAMES` bypasses check for local dev accounts — remove before launch. |
| Admin Platform Settings page | `GET /admin/settings` + `views/admin/settings.ejs` — founder-only page to configure contest eligibility thresholds live. Backed by `PlatformSettings` MongoDB collection. |
| Announcement detail/stats page | `GET /admin/announcements/:id` + `views/admin/announcements/detail.ejs` — dismissal count (live), impressions/clicks/dismiss-rate placeholders (tracking not yet wired), right-panel card preview, activate/expire/delete actions. |
| Contest withdrawal & forfeit | Nominee decline (pending): `POST /nominations/:id/decline`. Nominator cancel (pending only): `DELETE /contests/:id` (`voidReason: 'canceled'`). Active forfeit by either party: `POST /contests/:id/forfeit` (`voidReason: 'nominee_forfeit'` or `'nominator_forfeit'`, sets `winnerEntryId`). Contest page shows "wins by forfeit" banner and forfeit modal. Nominator cannot delete a forfeited (void) contest record — that scrub path remains open. |
| Contest vote window options | `windowHours` on contest creation now accepts 24 / 48 / 72 / 168 hours (was hardcoded 72). |
| entryCard HTH contest badges | Full visual state differentiation: pending (amber), accepted/waiting (charm), active/live (green), won (yellow highlight + dimmed opponent), lost (muted/dimmed), void (greyed with reason label). Username and vote/attribution scores dim on lost contests. |
| `/contests` page | `GET /contests` + `views/contests.ejs` — fully wired. Route queries active public contests (+ contests the user is in), builds contestant rows with per-viewer follow state, and passes live data. View: card layout with picture-in-picture media thumbnails, contestant rows with inline follow toggle buttons, live countdown timers, "vs" dividers. Pending nominations panel functional. |
| Take On | `allowTakeOns: Boolean` (default `true`) + `takeOnCount: Number` on Entry. `Nomination` extended with `type` (`standard` / `take_on`), `nomineeEntryId`, `challengerEntryId`. Notification types `take_on_received` / `take_on_accepted`. Take On button on entryCard → `/submit?takeOnTargetId=<entryId>`. Submit page flow creates pending contest + nomination, fires `take_on_received`. Dedicated accept/decline page at `/take-on/:id` (`views/take-on.ejs`). `POST /nominations/:id/take-on-accept` moves contest to active. `PATCH /entries/:id/allow-take-ons` endpoint. "Allow Take Ons" toggle on edit-entry page. |
| Contest Watch + Follower Notifications | `ContestWatch` model (`contestId`, `userId`, unique index on both). `utils/notifyWatchers.js` inserts `Notification` docs for all watchers, with an `excludeUserIds` set. Bell toggle ("Stay in the loop") on contest page with `POST /api/contests/:id/watch` (toggle on/off, returns `{ watching: bool }`). `isWatching` injected by the contest page route. Watched contests shown in the `/contests` page. Watcher notifications fire on: nominee accepted, nominee declined, contest forfeited (via route), contest voided and contest closed (both via background jobs). Follower notification type `contest_started` fires to all of the nominator's followers on new contest creation. All new notification types render in `views/notifications.ejs`: `contest_started`, `nominee_accepted`, `nominee_declined`, `contest_forfeited`. |
| Viewer Nomination | Any authenticated user can nominate two other users for a HTH via a modal on the profile page. Viewer selects opponent from a user search, optionally selects a specific entry for each nominee and adds a message. `POST /api/contests/viewer-nominate` validates that both nominees accept viewer nominations (per `nominationSettings` — allow on/off, with `everyone` / `followers_only` / `followees_only` / `mutual_follow` controls). Creates one shared `Contest` doc + two `Nomination` docs (type: `viewer_nomination`) with `preSelectedEntryId` when a specific entry was chosen. Both nominees receive a `viewer_nomination` notification. Submit page + nomination acceptance flow handle `viewer_nomination` type: locked-entry path (when entry was pre-selected) and free-choice path. Settings page has "Allow viewer nominations" toggle + "Who can nominate me" dropdown. `nominationSettings` embedded on User. |
| Wallet schema migration | `User.wallet.balanceCHL` replaced by two-pool `purchasedCHL` (SB) + `earnedCHL` (AAC). Migration scripts at `scripts/migrateWalletPools.js` and `scripts/correctWalletBalance.js`. `withTxnOrFallback` helper in `routes/wallet.js` handles replica-set-less dev environments. All routes, background jobs, and views updated. |
| Full transaction history page | `GET /wallet/transactions` + `views/wallet/transactions.ejs` — filterable by month and transaction type, with Excel download via `GET /wallet/transactions/download`. Links from the "See all" button in Settings wallet section. |
| Transaction detail page | `GET /wallet/transaction/:id` + `views/wallet/transaction.ejs` — shows full transaction metadata; "Dispute this transaction" link opens `GET /contact/new?topic=billing&txId=<id>` which auto-creates a support thread and pre-populates a dispute message with the transaction details. |
| Privacy settings | `privacySettings` embedded on User: `whoCanDm` (`everyone` / `followers_only` / `mutual_follow`), `showMatureContent`, `showAiContent`, `defaultAllowTakeOns`. Settings page Privacy tab wired to `POST /settings/privacy`. |
| Notification settings | `notificationSettings` embedded on User: in-app + email toggles for Comments, Contest Invitations, Contest Updates, Payouts. Settings page Notifications tab wired to `POST /settings/notifications`. |
| Top-up package names | Packages renamed: Starter → "Chill Vibes", Medium → "After Hours", Hot → "Milky Way", Inferno unchanged. |
| entryCard script partial | Inline `<script>` block extracted from `entryCard.ejs` to `views/partials/ecScript.ejs`, included once per page from `appEnd.ejs`. Removes the `locals.__ecScript` guard hack; rating label div uses stable fixed height (`h-5 leading-5 overflow-hidden`). |
| Content moderation — comment reports | Admin queue at `GET /admin/moderation` (Comments tab). Groups `CommentReport` + `ContestCommentReport` by comment, sorted by report count. Approve: deletes comment, fires `comment_removed` + `report_reviewed` notifications. Reject: reinstates (`hidden: false`), fires `report_reviewed`. `CommentReport.status` + `reasons` and `ContestCommentReport.status` fields added. |
| Content moderation — entry reports | `POST /api/entries/:eid/report` with configurable threshold logic. Crossing a threshold: `Entry.hidden → true`, stalls active contests (`Contest.stalled: true`, `stalledAt`), fires `entry_reported` + `contest_stalled` notifications. Admin Entries tab: Clear (reinstates entry, extends deadline, fires `contest_resumed`) and Remove (deletes entry, voids contest `entry_removed`, fires `entry_removed` notification). |
| Entry report schema | `EntryReport` model. `Entry.hidden`, `Contest.stalled`, `Contest.stalledAt`, `Contest.voidReason: 'entry_removed'`. `PlatformSettings.entryReportThresholds` (default: 3/60min, 5/360min, 10/1440min). |
| Moderation notification types | 6 new types render in `/notifications`: `comment_removed`, `report_reviewed`, `contest_stalled`, `contest_resumed`, `entry_reported`, `entry_removed`. Removal types use two-row layout with "Community guidelines" link + "Dispute this decision" CTA. |
| `/guidelines` page | `views/guidelines.ejs` + `GET /guidelines` route — community guidelines content live. |
| Comment reactions + pinning | `Comment.likes`, `Comment.dislikes`, `Comment.pinnedAt` added. `ContestComment.likes`, `ContestComment.dislikes` added. Like/dislike via `POST /entries/:eid/comments/:cid/react` and `POST /contests/:id/comments/:cid/react`. Pin/unpin via `POST /entries/:eid/comments/:cid/pin` (entry owner only). Comments sorted by score (net likes + recency), pinned first. entryCard renders reactions + pin button. |
| Entry card report wired | Report button on entry card now calls real `POST /api/entries/:eid/report` (was fake toast). |
| Entry page — raters list | Entry page shows users who rated the entry, with per-viewer follow state. |
| Profile page — More menu | "More" dropdown added: Direct Message (functional), Share Profile (stub), Block (stub), Report user (stub). Message button moved into menu. Nominate button condensed to compact icon. |
| Admin user detail — password reset | `POST /admin/users/:id/password` — moderator/supervisor can reset a regular user's password with strict complexity rules. Audit-logged. |

### What is not done yet
- **Admin hidden user parameters** — superadmin+ can attach hidden labels/tags to any user profile. Not visible to the user or to viewers — admin-facing only. Functions like admin-added stains on a user (e.g. internal flags, behavioral notes, content categories). Stored as a separate field on User, rendered only in the admin user detail page. Settable and removable by superadmin and founder only.
- Feed — Head To Head and Tournaments tabs (empty; Ratings tab is done)
- ~~Fake credits admin action~~ — dropped; the fake `/wallet/topup` stub already lets any user acquire chillies without real payment, making a separate admin grant redundant
- `Retag` model is scaffolded (`models/Retag.js`) but not yet wired into any route or UI
- Forfeit scrub path: nominator cannot currently delete a `void` contest record (the `DELETE /contests/:id` route rejects non-pending contests) — the design's "scrub forfeit record" case is not yet implemented
- Announcement impressions + click tracking: `AnnouncementDismissal` count is live; impressions and clicks need dedicated log entries or counter fields before the stats page shows real data
- REVERT BEFORE LAUNCH: re-enable participant vote guard and `status === 'active'` checks in `routes/api.js` and `routes/pages.js`; remove `TEST_BYPASS_USERNAMES` from `utils/contestEligibility.js`
- Phase 6 admin UI: content moderation and entry moderation queues are now done; tournament management and tournament review queue deferred to July
- Profile More menu: Share Profile, Block, and Report user are UI stubs — no backend routes wired yet

---

## June Phases

### Phase 1 — Schema Alignment (June 1–7)

The foundation. Nothing else gets built until the data models match the design.

**Tasks:**
- [x] Rename `Item` → `Entry`. Update all references across routes, views, and other models.
- [x] Update `Entry` schema: remove `title`, `price`, `isListed`, `contest` (link managed separately). Keep `mediaUrl`, `mediaType`, `caption`, `creator`, `ratingCount`, `ratingAvg`.
- [x] Update `User` schema: replace `isAdmin: Boolean` with `role: enum('user', 'admin')`. Add `emailConfirmed`, `idVerified`, `idVerificationStatus`, `idSelfieUrl`, `idDocUrl`, `idVerificationCode`, `idVerifyFailedAttempts`, `idVerifyBlockedUntil`, `accountStatus` (`'active' | 'invited' | 'banned'`). Add embedded `wallet`. (No `onboardingStatus` field — there is no onboarding gate; see Phase 2.)
- [x] Rebuild `Rating` schema: reference `Entry` (not `Item`). Remove `mode` field. Add unique compound index on `{ entryId, userId }`.
- [x] Delete old `Contest` model. Create new `Contest` schema per design (entries embedded, designatedVoters embedded, status lifecycle, windowHours, deadlines, etc.).
- [x] Create `Nomination` schema.
- [x] Create `ContestVote` schema.
- [x] Create `Tournament` schema (with embedded prizes).
- [x] Create `TournamentEntry` schema — include `approvalStatus: enum('pending', 'approved', 'rejected', 'timed_out')` and `reviewedAt`.
- ~~Create `RatingsChallenge` schema~~ — removed, mechanic replaced by 3-replay tie-breaker chain
- ~~Create `RatingsChallengeVote` schema~~ — removed
- [x] Update `isAdmin` middleware to use `role === 'admin'` instead of `isAdmin` boolean.
- [x] Run `seedAdmin.js` to verify the updated User schema works end to end.

**Exit criteria:** All models exist, are consistent with `platform-core-concepts.md`, and the app still boots without errors.

---

### Phase 2 — Auth + User Foundation ✅ (completed early)

**Tasks:**
- [x] Complete signup flow: form validates, hashes password, creates user + wallet. Account is created with full platform access immediately — no onboarding status to set.
- [x] Redirect middleware: any request from an unauthenticated user goes to signup — no exceptions, no read-only browsing.
- [x] ~~Onboarding middleware~~ — dropped by design. Mandatory ID-verification-before-access was reconsidered: review work doesn't scale to every signup without dedicated staff, and it collects PII (selfie + government ID) from users who may never intend to submit anything. Scoped instead to the point of actual need (see ID verification below).
- [x] Install and configure **Resend** for transactional email.
- [x] OTP email verification step within the signup form: user submits their email → Resend sends a 6-digit OTP → user enters it on the next signup step → verified before account is created. No async flow, no expiry timers. `emailConfirmed` is always `true` on any account that exists.
- [x] ID verification, scoped to entry submission: visiting `/submit` without `idVerified: true` redirects to `/verify-identity`. User generates an 8-character code, uploads a selfie with the code visible, and uploads a government-issued ID. Submission sets `idVerificationStatus: 'pending'`. Admin reviews manually; approval sets `idVerified: true` and sends the user back to `/submit`. Failed attempts are tracked; 3 failures trigger a 2-hour block. The same gate applies to tournament creation.
- [x] Admin ID verification review queue: list of `pending` verification submissions. Approve or reject with one action.
- [x] Complete login flow: session + `requireAuth` middleware, protect routes.
- [x] Profile page: display user's entries, average rating, username, avatar, bio, follow counts, contest/tournament history.
- [x] Settings page: edit username, bio, avatar upload, banner upload, account deletion.
- [x] Follow / Unfollow: `POST /follow/:username` and `POST /unfollow/:username` in `routes/follow.js`. Follow/Unfollow + Message buttons wired on profile action row. After following, a "People you might like" section appears between the stats row and tab bar — pulls followers + following of the viewed profile, shows up to 3 suggestions with inline follow toggles.

---

### Phase 3 — Entries + Ratings (June 8–14)

The default engagement layer. Every user on the platform interacts with this.

**Tasks:**
- [x] Entry upload: photo and video via existing `upload` middleware. Store `mediaUrl`, `mediaType`, link to user.
- [x] Entry display: entry page showing media, owner info, current rating average and count.
- [x] Rating flow: authenticated user submits 1–10 score. Enforce no self-rating, no duplicate rating. Update `ratingCount` and `ratingAvg` on the entry document.
- [x] Tags: entry owner can add, edit, or remove up to 6 free-form tags on their entry at any time.
- [x] **Fix leaderboard route:** real query implemented — top entries by `ratingAvg` with minimum 3 ratings, populated owner info, passed as `items` to the view.
- [x] **Right panel redesign:** Rebuilt `rightPanel.ejs` with all three sections: (1) Ongoing Tournaments skeleton; (2) Announcements carousel — dismissable, user-filtered, auto-advances every 6s, dot navigation; (3) People to Follow — follower-count ranked suggestions with inline follow buttons. `injectRightPanelData` middleware handles all data fetching.
- [x] Feed page: Ratings tab fully wired — `UserAffinity` model + `utils/feedScorer.js` affinity/velocity/follow scoring, entries rendered as `entryCard` with pre-locked ratings for already-rated entries.
- [x] Comment flow: any registered user can comment on an entry. Users can delete their own comments. Entry owner can hide any comment (hidden comments move to a private "hidden comments" section, visible only to the owner). Any user can report a comment.
- [x] Reply flow: any registered user can reply to a top-level comment (one level only).
- [x] Comment notifications: notify entry owner when someone comments on their entry. Notify parent commenter when someone replies to their comment.

**Exit criteria:** A user can upload an entry, other users can rate it 1–10, and the feed and leaderboard reflect live data. Comments work end to end. Right panel renders with the defined section structure (tournaments skeleton, announcements matching the current user, people to follow suggestions).

> **Dev note:** `@storiesbyshews` has `idVerified: true` set manually in the DB to allow free entry submission testing during Phase 3. Before Phase 3 closes, reset this user's `idVerified` to `false` and `idVerificationStatus` to `none` (or `null`) so the account goes through the real ID verification flow.

---

### Phase 4 — Standalone Contests (June 15–22)

The core competitive mechanic. Build the HTH contest flow end to end.

**Tasks:**
- [x] Contest creation: creator self-nominates (they are contestant A), nominates a specific opponent (contestant B).
- [x] Nomination delivery: opponent receives a pending nomination visible on their entry edit and submit pages. 24hr acceptance window starts.
- [x] Acceptance flow: opponent accepts via an existing entry (`/api/nominations/:id/accept`) or by submitting a new entry with `?nomination=<id>` → contest moves to `active`. Voting deadline set to `submittedAt + 72h`.
- [~] Void logic: Mongoose post-hooks normalize expired-pending contests to `void` at read time (bridge until Phase 5). Background job promotion + creator notification still deferred to Phase 5.
- [x] Contest voting page: both entries displayed side by side with vote counts, percentages, and winner badge. Authenticated user picks one. Enforce no self-vote, no duplicate vote.
- [ ] **REVERT BEFORE LAUNCH:** Re-enable participant vote guard and `status === 'active'` checks in `routes/api.js` (contest vote handler) and `routes/pages.js` (contest GET handler) — both are commented out with `// TEMP` for local testing.
- [ ] Contest close logic: background job checks `votingDeadline`. Count votes per entry. Set `winnerEntryId`. Status → `closed`.
- [x] Contest page: result, vote counts, winner after close — `winnerEntryId` logic renders winner badge correctly.
- [x] Private contest flow: creator designates minimum 5 voters. `designatedVoters` array enforced on creation; access guard in comment routes.

**Exit criteria:** Two users can complete a full contest cycle — nomination → acceptance → voting → result — with both public and private variants working.

---

#### Contest Withdrawal & Forfeit (added June 16)

**Design:**
- **Pending** (nominee hasn't submitted their entry yet): nominee can decline/withdraw freely, no fault recorded.
- **Active/live** (status flips to `active` the moment the nominee submits their entry): nominee dropping from this point on is a formal loss — contest closes immediately, opponent is declared winner, nominee gets a public "Withdrew" badge.
- **Remove nominee** (nominator-only action, usable in both phases): the single mechanism for "starting over." Deletes the Contest + Nomination doc entirely rather than resetting it for reuse — consistent with the existing rule that a new entry attempt means a new contest doc, not an edit. In the pending case this is a clean, traceless deletion. In the live/forfeit case, this is also how the public "Withdrew" loss record gets scrubbed — it stays visible until the nominator chooses to delete it.

**Tasks:**
- [x] Nominee withdrawal action while `pending`: `POST /nominations/:id/decline` voids nomination + contest (`voidReason: 'declined'`). Nominator cancels via `DELETE /contests/:id` (`voidReason: 'canceled'`, pending only).
- [x] Nominee forfeit action while `active`: `POST /contests/:id/forfeit` — both nominator and nominee can forfeit; sets `voidReason` and `winnerEntryId`. Contest page shows "wins by forfeit" banner and forfeit modal with consequence summary.
- [~] "Remove nominee" route (nominator-only): pending-case cancel is done via `DELETE /contests/:id`. The scrub-forfeit-record case (deleting a void contest from a forfeited live contest) is not yet implemented — `DELETE /contests/:id` rejects when status is not `pending`.

---

#### Contest Watch / Follower Notifications (added June 16)

**Design:**
- When a nominator starts a new contest (nominates someone), their followers (existing `Follow` model) are auto-notified via a new `Notification` type.
- Any user landing on a contest page — follower or not — gets a "stay in the loop" button to subscribe specifically to that contest's updates. Requires a new per-contest watch model (e.g. `ContestWatch`: `contestId`, `userId`) since `Follow` is user-to-user only.
- Watchers get notified on: nominee responds (accept/decline), forfeit, timeout/void, contest closed.

**Tasks:**
- [x] New `Notification` types for: contest started (sent to nominator's followers), nominee responded, nominee forfeited, contest timed out/voided, contest closed (sent to watchers).
- [x] `ContestWatch` model + "stay in the loop" toggle on the contest page.
- [x] Wire notification triggers for all events above to the watcher list (nominator's followers are auto-watchers from creation; anyone else opts in via the button).

> Note: the "voting closes in" countdown format (days/hours/minutes/seconds, zero-padded, fewer units as time runs out) was reviewed and confirmed correct as-is — no change needed.

---

#### Take On (designed June 21, implemented June 21)

**Design (as implemented — differs from original draft):**
- `allowTakeOns: Boolean` (default `true`) + `takeOnCount: Number` added to the `Entry` schema.
- The "Allow Take Ons" toggle appears on the entry edit page for all entries. Default is **on**. Owner can disable it at any time.
- Take On button shown on entry cards, positioned right of the rating button. Visible when `allowTakeOns: true` and viewer is eligible non-owner.
- `Nomination` model extended: `type` enum (`standard` | `take_on`), `nomineeEntryId` (the challenged entry), `challengerEntryId` (the initiator's entry).
- **Flow (initiator submits first):**
  1. User A clicks Take On on User B's entry → redirected to `/submit?takeOnTargetId=<entryId>`.
  2. User A submits their own entry → contest created `pending` with User A's entry pre-loaded + nomination created (type: `take_on`, nomineeEntryId: User B's entry, challengerEntryId: User A's new entry) → `take_on_received` notification sent to User B. 24h void deadline starts.
  3. User B clicks notification → `/take-on/:nomId` — sees the take-on request with their entry shown → accepts or declines.
     - Accept → `POST /nominations/:id/take-on-accept` → User B's entry pushed into contest, status → `active`. `take_on_accepted` notification fires to User A.
     - Decline → contest voids.
- Cannot Take On your own entry. `POST /api/entries/:id/take-on` API also available for initiating a take-on with an existing entry directly.

**Tasks:**
- [x] Add `allowTakeOns: Boolean` (default `true`) + `takeOnCount: Number` to `Entry` schema and model
- [x] Add `type`, `nomineeEntryId`, `challengerEntryId` to `Nomination` schema
- [x] Add "Allow Take Ons" toggle to entry edit page — on by default, owner can disable
- [x] `PATCH /api/entries/:id/allow-take-ons` endpoint — toggle on/off, owner only
- [x] Add `take_on_received` and `take_on_accepted` to `Notification` type enum
- [x] Replace placeholder retweet icon on entryCard with Take On button — positioned right of the rating button; shown when `allowTakeOns: true` and viewer is eligible non-owner
- [x] `POST /api/entries/:id/take-on` — creates pending contest with initiator's existing entry, fires `take_on_received` notification to entry owner
- [x] Wire `/submit?takeOnTargetId=<entryId>` — initiator submits new entry, creates pending contest + nomination, fires `take_on_received`
- [x] `GET /take-on/:id` + `views/take-on.ejs` — entry owner accept/decline page with countdown timer
- [x] `POST /nominations/:id/take-on-accept` — pushes target entry into contest, sets active, fires `take_on_accepted` to initiator

---

#### Nomination Notification Redirect Fix (added June 17)

**Issue:** When a nominee clicks their nomination notification, they are always sent to the entry submission page (`/submit?nomination=<id>`). But if they have already submitted their entry and the contest is now `active`, that redirect is wrong — the submission page is irrelevant and the contest is already live.

**Fix:** At the point the nomination notification is clicked (or the redirect is resolved), check the nomination's current status:
- `nomination.status === 'pending'` → redirect to `/submit?nomination=<id>` as normal
- `nomination.status === 'accepted'` → redirect to `/contest/:contestId` instead

**Tasks:**
- [x] Update the nomination notification click handler to check nomination status and redirect to the contest page when already accepted. Implemented as a `Notification.updateOne` patch fired at acceptance time on both acceptance paths (existing entry and new entry submission). Pre-existing stale notifications for already-accepted nominations will need a one-time DB fix before launch.

---

#### Fake Credits for Contribution Flow Testing (added June 17)

The full credit system (CCBill integration, credit packages) is July scope. However, contribution flow on contests needs to be testable before then. Rather than integrating CCBill early, a dev convenience will be used: an admin action to manually credit a user's balance directly in the DB.

**Tasks:**
- ~~Add an admin action (superadmin only) to manually set or top up a user's credit balance~~ — dropped; the fake `/wallet/topup` stub serves this need without a separate admin route.

---

### Phase 5 — Notifications + Background Jobs (June 22–30)

The system that makes everything time-sensitive work reliably.

**Job scheduler decision: `agenda`** — `node-cron` only supports fixed recurring schedules and cannot schedule one-time jobs at a specific datetime. `agenda` uses MongoDB (already in use) as its backing store and natively supports both recurring sweeper jobs and dynamically scheduled one-time jobs.

**Sweeper + scheduler pattern** — recurring sweeper jobs run every 15 minutes. When a sweeper finds a deadline within the next 15 minutes, it schedules a one-time targeted job to fire at exactly that deadline rather than waiting for the next sweep. This ensures no contest waits more than a few seconds past its actual deadline. If the deadline has already passed, the sweeper closes it immediately.

**Tasks:**
- [x] Install and configure `agenda` with MongoDB backing store (`jobs/agenda.js` — reuses existing mongoose connection).
- [x] Implement void deadline sweeper (every 15 min): finds pending contests where `voidDeadline <= now` → void immediately; `voidDeadline` within 15 min → schedule one-time `void_expired_contest` job at exact deadline. Replaces the Mongoose post-hook bridge (post-hooks removed from `Contest.js`).
- [x] Implement voting deadline sweeper (every 15 min): finds active contests where `votingDeadline <= now` → close immediately (count votes, set `winnerEntryId`, status → `closed`, fire `contest_closed` notifications); `votingDeadline` within 15 min → schedule one-time `close_contest` job at exact deadline. Both sweepers run on startup to catch missed deadlines.
- [ ] Implement entry review timeout job (July/tournament scope): runs every 5 minutes. Finds `tournament_entries` with `approvalStatus: 'pending'` and `submittedAt < now - 30min`. For each: set `approvalStatus: 'timed_out'`, increment `tournament.missedReviews`, notify the submitting user their entry timed out. If `tournament.missedReviews >= 3`: cancel the tournament, notify all `pending_approval` users to resubmit elsewhere.
- [ ] Gate tournament creation behind `idVerified: true` check. Since ID verification is now scoped and on-demand (not a mandatory onboarding step), a user can reach the "create tournament" action without ever having verified — this check is a real, reachable gate, not just a bypass safeguard.
- [x] Notification model: dedicated `Notification` collection (Option A) with compound index `{userId, read, createdAt}` and 90-day TTL index. `injectNotificationCount` middleware injects unread count into all main platform views. Sidebar badge (count label + collapsed dot). Per-notification click-to-mark-read + mark-all-as-read. Triggers: new comment → entry owner, reply → parent commenter, nomination created → nominee.
- [x] Notifications page: paginated list at `/notifications` — actor avatar, notification text, relative timestamp, unread highlight. `contest_closed` / `contest_voided` rows render correctly (triggers now live from background jobs).
- [x] Messages page: direct messaging between users — `Conversation` + `DirectMessage` models, `routes/messages.js`, two-panel view (`/messages` list + `/messages/:username` thread). Polled every 5s. Message button on profile opens or creates a conversation.
- [x] Viewer nomination flow: any registered user can nominate two other users for a HTH, with an optional message and optional entry pre-selection per nominee. Both nominees receive a `viewer_nomination` notification. Nomination settings (`allow`, `whoCanNominate`) on User control who can receive viewer nominations. Modal on profile page. Settings page UI wired.

**Exit criteria:** Time-based contest state transitions happen automatically without manual intervention. Users receive in-app notifications for all nomination and contest events.

---

### Phase 6 — Admin UI

A dedicated admin area covering platform oversight, user management, content moderation, and tournament administration.

#### Admin Role System (prerequisite — implement before any Phase 6 UI)

**Design:**

Role tiers (lowest → highest): `user → moderator → supervisor → superadmin → founder`

Permission domains (moderators and supervisors only): `content | chat | comments | financial | support`

| Domain | Scope |
|---|---|
| `content` | Entry review, media, tournament submissions |
| `chat` | User-to-user message moderation, reports |
| `comments` | Comment moderation, reports |
| `financial` | Prizes, payouts |
| `support` | Support inbox — replies to users contacting the platform |

**Rules:**
- `moderator` — exactly 1 domain (enforced at schema level)
- `supervisor` — 1 or more domains (can oversee multiple moderator types); escalation target when a moderator is unsure
- `superadmin` — full cross-domain access; permissions array ignored
- `founder` — same as superadmin, but immutable (cannot be demoted by anyone)

**Promotion rule — "2 tiers ahead":**
- `superadmin` can grant `moderator` only
- `founder` can grant `supervisor`, `superadmin`, and `moderator`
- `supervisor` has zero promotion power

**Migration:** existing `role: 'admin'` documents → `role: 'founder'`

**Implementation tasks:**
- [x] Update `User` schema: expand `role` enum to `['user', 'moderator', 'supervisor', 'superadmin', 'founder']`. Add `permissions` array with enum `['content', 'chat', 'comments', 'financial', 'support']`. Add schema-level validator: if `role === 'moderator'` then `permissions.length === 1`; if `role === 'supervisor'` then `permissions.length >= 1`.
- [x] Migration script: update all `{ role: 'admin' }` documents to `{ role: 'founder' }`.
- [x] New admin middleware (`requireDomain`): replace the blunt `requireAdmin` check with a factory function that accepts a required domain. `superadmin` and `founder` pass automatically. `moderator` and `supervisor` must have the domain in their `permissions` array.
- [x] Update all existing admin routes to use the new middleware with the appropriate domain.
- [x] Admin management routes: `POST /admin/users/:id/role` — promote/demote a user, enforcing the 2-tier-ahead rule server-side.
- [x] Admin sidebar respects permissions — sections and links hidden when the logged-in admin lacks the required domain.
- [x] Sidebar badge counts scoped to domain — queries only run for domains the admin has access to.
- [x] Admin accounts management page (`/admin/admins`) — lists all admin-tier accounts with tier badge and permissions; inline role assignment form for authorized granters.

---

#### Admin Hiring Flow

The process for bringing a new admin onto the platform — from public application to active account.

**Flow:**
1. Candidate finds the application link (e.g. from a LinkedIn post) and fills out a public form
2. Founder or superadmin reviews submitted applications in the admin panel
3. After selecting a candidate, they create an account: set role, permissions, and optionally an expiry date for temporary accounts
4. The system creates the user record and emails an invite link containing a secure token
5. Candidate clicks the link, sets their own password, and gains access to the admin panel
6. Temporary accounts automatically deny login once `temporaryUntil` has passed

**Who can hire:**
- `founder` — can create moderator, supervisor, and superadmin accounts
- `superadmin` — can create moderator accounts only
- Both governed by the existing 2-tier rule

**New components:**

| Component | Description |
|---|---|
| `AdminApplication` model | Stores job applications: `name`, `email`, `message`, `status` (`pending/reviewed/hired/rejected`), `submittedAt` |
| Public application page | `/careers` — publicly accessible form; no login required; confirmation email sent on submit |
| Applications queue | `/admin/applications` — list of submitted applications with status filters; mark reviewed / hired / rejected |
| Account creation form | On the application detail, a form to set role + permissions + optional expiry; fires invite email on submit |
| Invite token | Secure token stored on `User` (`adminInviteToken`, `adminInviteExpiry` — 72h TTL) |
| Invite acceptance page | `/admin/accept-invite?token=xxx` — candidate sets their password; token validated; account activates |
| Temporary accounts | `isTemporary: Boolean` + `temporaryUntil: Date` on `User`; login denied if expired |

**User schema additions:** `adminInviteToken`, `adminInviteExpiry`, `isTemporary`, `temporaryUntil`, `accountStatus` gains a new value: `'invited'`

**Implementation tasks:**
- [x] Add `AdminApplication` model
- [x] Add `adminInviteToken`, `adminInviteExpiry`, `isTemporary`, `temporaryUntil` to `User` schema; add `'invited'` to `accountStatus` enum
- [x] Public route + view: `GET /careers` — application form; `POST /careers` — stores application, sends confirmation email
- [x] Admin applications routes + view: `GET /admin/applications` — list; `GET /admin/applications/:id` — detail with hire action form
- [x] Account creation route: `POST /admin/applications/:id/hire` — creates User record with `accountStatus: 'invited'`, generates invite token, sends invite email via Resend
- [x] Invite acceptance route + view: `GET /admin/accept-invite` — validates token; `POST /admin/accept-invite` — sets password, activates account
- [x] Temporary account login guard: on admin login, check `isTemporary && temporaryUntil < now` — deny with clear message if expired
- [x] Add Applications link to admin sidebar (founder/superadmin only)

---

---

#### Admin Sidebar — Menu Design

Menus are **non-inclusive**. Higher roles do not inherit lower-role menus. Each role sees exactly what its job requires — nothing more.

**Exhaustive menu item list:**

| Section | Item | Description |
|---|---|---|
| Overview | Dashboard | Role-specific summary view |
| Users | User Management | Browse and edit user accounts |
| Users | ID Verification | Review identity documents |
| Content | Entry Review | Approve/reject pending entries |
| Content | All Entries | Browse the full entry catalog |
| Moderation | Reported Comments | Review flagged comments |
| Moderation | Escalations | Issues escalated by moderators needing senior review |
| Support | Messages | Customer support inbox |
| Tournaments | All Tournaments | Browse/manage platform tournaments |
| Tournaments | Review Queue | Review entries submitted to open tournaments |
| Team | Admin Accounts | View and manage the admin team |
| Team | Applications | Review admin job applications |
| Platform | Settings | Global platform configuration |
| Platform | Financials | Prize payouts and transaction history |
| Platform | Analytics | Usage and engagement stats |

**Role → menu assignment (non-cumulative):**

| Menu Item | Founder | Superadmin | Supervisor | Moderator | Support |
|---|:---:|:---:|:---:|:---:|:---:|
| Dashboard | ✓ | ✓ | ✓ | ✓ | ✓ |
| User Management | | ✓ | ✓ | | |
| ID Verification | | | | ✓ | |
| Entry Review | | | ✓ | ✓ | |
| All Entries | | ✓ | ✓ | | |
| Reported Comments | | | ✓ | ✓ | |
| Escalations | | ✓ | ✓ | | |
| Messages | | | | | ✓ |
| All Tournaments | ✓ | ✓ | | | |
| Review Queue | | ✓ | | | |
| Admin Accounts | ✓ | | | | |
| Applications | ✓ | | | | |
| Settings | ✓ | | | | |
| Financials | ✓ | | | | |
| Analytics | ✓ | ✓ | | | |

Key decisions:
- Founder sees nothing operational — no moderation, no entries, no user management. They own the org, not the day-to-day.
- Moderator is narrow — reports, entry review, ID verification only. No user management power.
- Supervisor bridges operational and senior review — can see what moderators produce and handle escalations.
- Support is fully siloed — only messages (and whatever user lookup they need to answer tickets).
- Escalations is a dedicated queue that moderators push items to when they need senior eyes.

---

#### Admin Dashboard — Role-Specific Views

The dashboard is served at `/admin` for all roles but renders entirely different content based on `adminRole`. It is a job briefing, not a data dump.

**Founder:** Revenue and prize payouts this month, platform growth (new users, entries submitted), admin team headcount and open applications, high-level tournament activity (running, completed, total prize pool). No queues, no flags.

**Superadmin:** Active tournaments (status, entries pending review), user registration trend, ID verification queue depth, escalations pending, entry volume (submitted/approved/rejected this week).

**Supervisor:** Moderation queue depth (reported comments, pending reviews), moderator activity (who reviewed what, response times), escalations assigned to them, entry review throughput.

**Moderator:** Their personal queue — entries to review and reported comments to action. Their own stats (reviewed today, this week, avg response time). No platform-wide data.

**Support:** Unread message count, open vs resolved tickets, average response time, users who have contacted support multiple times.

---

**Pages and tasks:**

- [x] **Admin dashboard:** role-specific view — Founder sees financials and org health; Superadmin sees operational metrics; Supervisor sees moderation throughput; Moderator sees their personal queue and stats; Support sees inbox metrics. One route, one conditional render per role.
- [x] **User management — list:** paginated user list with filters for role, `idVerificationStatus`, account status, and `idVerified`
- [x] **User management — detail:** profile info, uploaded entries, contest/tournament history, ID verification status and documents, wallet balance; admin actions (role assignment using 2-tier-ahead rule, account suspension)
- [x] **ID verification queue:** list of users with `idVerificationStatus: 'pending'`; review view showing selfie and government ID side by side; approve / reject action (approval sets `idVerified: true`, user can now submit an entry)
- [x] **Admin audit log:** append-only `admin_audit_logs` collection, `ATA-YYYYMMDD-XXXXXXXX` ticket refs, actor ID + role, action slug, affected entity, target user, `remarks`, and `metadata` payload. Global log view at `/admin/audit-log` visible to supervisor+; filterable by action, target user, and ticket ref. `utils/auditLog.js` helper used throughout.
- [x] **Platform Settings page:** `GET /admin/settings` + `POST /admin/settings/contest-eligibility` — founder-only. Configures contest eligibility thresholds (minEntries, minRatingCount, minWeightedAvg). Persisted in `PlatformSettings` collection (key: `'global'`).
- [x] **Announcement detail/stats page:** `GET /admin/announcements/:id` — dismissal count (live from `AnnouncementDismissal`), impressions/clicks/dismiss-rate placeholders (tracking not yet wired), right-panel card preview, activate/expire/delete actions.
- [x] **Content moderation — reported comments:** queue from `CommentReport` + `ContestCommentReport`; each row shows comment in context, report count, reporter, date; Approve (delete comment + warn author + confirm to reporter) / Reject (reinstate comment + confirm to reporter). `comment_removed` + `report_reviewed` notifications wired.
- [x] **Entries moderation — reported entries:** threshold-triggered auto-hide with contest stalling; admin Approve (clear) reinstates entry, extends voting deadline; admin Approve (violating) deletes entry + voids contest. `entry_reported`, `contest_stalled`, `contest_resumed`, `entry_removed` notifications wired.
- ~~**Tournament management — list/create/detail**~~ — deferred to July; no tournament data to manage until the full tournament system is built
- ~~**Tournament review queue**~~ — deferred to July for the same reason

**Exit criteria:** Admin can manage users, process ID verification queue, action reported comments and entries — all from a dedicated admin-only UI.

---

#### Content Moderation — Full Spec (designed June 25)

Covers both comment reports and entry reports. Two separate queues, same admin area.

---

##### Comment Reports

**Reporting**
- Any user can report any comment they didn't write — entry comments and contest comments both covered
- `POST /api/entries/:eid/comments/:cid/report` and `POST /api/contests/:id/comments/:cid/report` already exist and work
- On report: `Comment.hidden → true` immediately (first report, no threshold). Contest comments same behaviour.
- No notification to the comment author at this stage

**Admin queue** (`GET /admin/moderation`)
- Pulls all `CommentReport` + `ContestCommentReport` docs with `status: 'pending'`
- Each row: comment text in context (entry or contest it belongs to), who wrote it, reporter(s), date, total report count for that comment
- Two actions:

| Action | Effect |
|---|---|
| **Approve** | Comment deleted. Report `status → approved`. Warning notif to author (policy link + Dispute button). Confirmation notif to reporter. |
| **Reject** | `Comment.hidden → false` (reinstated). Report `status → rejected`. Confirmation notif to reporter. |

**Schema additions**
- `CommentReport` + `ContestCommentReport`: add `status: enum('pending', 'approved', 'rejected')`, default `'pending'`

**New notification types**
- `comment_removed` (to author on approve) — *"Your comment was removed for violating our community guidelines."* + link to `/guidelines` + Dispute button → `GET /contact/new?topic=moderation&reportId=<id>`
- `report_reviewed` (to reporter, both outcomes) — different copy: *"Action was taken"* vs *"Comment was not found to be in violation"*

**Prerequisites**
- ~~`/guidelines` page must exist~~ — done: `views/guidelines.ejs` + `GET /guidelines` live
- `/contact` route must handle `topic=moderation&contentType=<entry|comment>` to pre-populate a dispute thread — dispute link is wired in notifications; contact route auto-population not yet implemented

---

##### Entry Reports

**Reporting behaviour**
- Entry reporting is threshold-based — a single report does not hide an entry
- On every new report, all three threshold windows are evaluated. Any one crossing triggers auto-hide.
- Thresholds are configurable by supervisor+ in Platform Settings (stored in `PlatformSettings` alongside contest eligibility config)

**Default thresholds**

| Reports | Window |
|---|---|
| 3 | 30 min |
| 5 | 1 hour |
| 10 | 6 hours |

**When threshold is crossed**
- `Entry.hidden → true` — entry disappears from feed, profile, and search immediately
- If entry is in an active contest: `Contest.stalled → true`, `Contest.stalledAt → now` — voting frozen, countdown frozen
- Notifications:
  - All contestants + watchers → `contest_stalled`: *"This contest has been temporarily paused."* (no reason given)
  - Reported entry owner only → `entry_reported`: their entry is under review

**Admin queue** (entries tab within `/admin/moderation`)
- Lists all entries with `hidden: true` and at least one `EntryReport` with `status: 'pending'`
- Each row: entry media thumbnail, owner, report count, first reported at, whether it's stalling an active contest
- Two actions:

| Action | Effect |
|---|---|
| **Cleared** (not in violation) | `Entry.hidden → false`. If contest was stalled: `Contest.stalled → false`, `votingDeadline += min(now − stalledAt, 24h)`. Notification to contestants + watchers: contest resumed. All reports for this entry `status → rejected`. |
| **Violating** | Entry deleted. If in active contest: contest void (`voidReason: 'entry_removed'`). Notification to contestants + watchers: contest canceled. Warning notif to entry owner (policy link + Dispute button). All reports for this entry `status → approved`. |

**Deadline extension edge case:** if `votingDeadline` has already passed by the time the entry is cleared, set new deadline to `now + min(stalledDuration, 24h)` rather than adding to an already-elapsed deadline.

**Schema additions**
- New `EntryReport` model — `{ entryId, reportedBy, status: enum('pending','approved','rejected') }`, unique index on `{entryId, reportedBy}`, timestamps
- `Entry`: add `hidden: Boolean`, default `false`
- `Contest`: add `stalled: Boolean` default `false`, `stalledAt: Date`
- `PlatformSettings`: add `entryReportThresholds: [{ count: Number, windowMinutes: Number }]`, default `[{count:3,windowMinutes:30},{count:5,windowMinutes:60},{count:10,windowMinutes:360}]`

**New notification types**
- `contest_stalled` — sent to contestants + watchers when entry is hidden mid-contest
- `contest_resumed` — sent to contestants + watchers when entry is cleared and contest restarts
- `entry_reported` — sent to entry owner when their entry crosses the report threshold
- `entry_removed` (to entry owner on violating decision) — policy link + Dispute button

**Report button on entry card**
- ~~Currently wired to a fake toast only~~ — `POST /api/entries/:eid/report` is now live; entry card report button calls it directly

---

#### Announcements — Stats Page (added June 18, implemented June 20)

The detail/stats page at `GET /admin/announcements/:id` is now live. Dismissal count is real data. The remaining metrics are placeholders until tracking is wired.

**Still needed to show real stats:**
- **Impressions** — requires a server-side counter increment on each `injectRightPanelData` call or a separate log entry per unique user render
- **Clicks / Conversions** — requires routing announcement clicks through `/api/announcements/:id/click` before forwarding to the redirect URL
- **Dismiss rate** — derivable once impressions are tracked
- **Reach by filter segment** — breakdown of impressions by sex / orientation / age group if filters are set

The page shows "tracking not yet wired" placeholders for these metrics until they are implemented.

---

## Phase 4.7 — Chilli Wallet + Economic Flow (Fake CCBill Phase)

The full CCBill integration is July scope, but the economic flow needs to be testable before then. This phase builds the complete chilli economy end-to-end with a stubbed payment step that CCBill will simply replace later. Every model, route, and background job built here is production-ready — the only fake part is the payment confirmation screen.

**Currency:** chillies (🌶️). Never displayed as "CHL" to users — always "chilli" / "chillies" + the emoji.
**Exchange rate:** $1 = 5 🌶️ (1 🌶️ = $0.20). Stored on every transaction so disputes survive future rate changes.
**Cashout minimum:** 100 🌶️ ($20).

---

### Schema Changes

#### `User.wallet` — two-pool model
```
wallet: {
  purchasedCHL: { type: Number, default: 0 },  // SB — credits from top-ups
  earnedCHL:    { type: Number, default: 0 },  // AAC — credits from contest earnings
  updatedAt:    { type: Date },
}
```
- **SB (Spendable Balance)** = `purchasedCHL`. Credits bought via top-up. Spent on contributions (debited first before `earnedCHL`). Can be cashed out via optional toggle.
- **AAC (Amount Available for Cashout)** = `earnedCHL`. Credits earned from contest payouts. The default cashout pool. Also available to fund contributions if SB is insufficient.
- **Total spendable** = `purchasedCHL + earnedCHL`. Contribution spending order: debit `purchasedCHL` first; if insufficient, debit remainder from `earnedCHL`.

`balanceCHL` (the original single-field design) is superseded. Migration: rename existing `balanceCHL` to `purchasedCHL`, add `earnedCHL: 0`.

---

### New Models

#### `WalletTransaction`
Full audit trail. One document per credit movement, no exceptions.

| Field | Type | Notes |
|---|---|---|
| `userId` | ObjectId → User | |
| `type` | enum | `top_up \| contribution \| contribution_adjustment \| contribution_withdrawal \| contest_payout_settled \| platform_fee \| admin_grant \| auto_payout \| makeup_payout` |
| `direction` | enum | `credit \| debit` |
| `amountCHL` | Number | Always positive — direction field carries the sign |
| `amountUSD` | Number | Dollar equivalent at time of transaction |
| `exchangeRate` | Number | Rate used (default 0.20) — frozen at tx time in case platform adjusts it later |
| `balanceBefore` | Number | Total wallet balance (`purchasedCHL + earnedCHL`) before this tx |
| `balanceAfter` | Number | Total wallet balance (`purchasedCHL + earnedCHL`) after this tx |
| `status` | enum | `completed \| pending \| reversed` |
| `source` | enum | `package \| custom \| admin \| contest_close \| system \| manual_cashout \| auto_payout \| makeup_payout` |
| `packageName` | String | If a preset package was used (e.g. `"Starter"`) |
| `referenceId` | ObjectId | Links to contest, contribution, payout doc, etc. |
| `referenceType` | String | `Contest \| ContestContribution \| ContestPayout \| MonthlySnapshot` |
| `metadata` | Mixed | Catch-all: user agent stub, future CCBill txn ID, IP |
| `createdAt` | Date | Auto |

Indexes: `{ userId, createdAt }`, `{ referenceId, referenceType }`, `{ type, status }`.

---

#### `ContestContribution`
Tracks a viewer's live contribution to a specific entry in a contest. One doc per `{contestId, contributorId, entryId}` — updated in place as the user adjusts their contribution. The `WalletTransaction` log handles the delta audit trail.

| Field | Type | Notes |
|---|---|---|
| `contestId` | ObjectId → Contest | |
| `entryId` | ObjectId → Entry | Which contestant they're supporting |
| `beneficiaryId` | ObjectId → User | Entry owner (denormalized for payout queries) |
| `contributorId` | ObjectId → User | Who contributed |
| `amountCHL` | Number | Current contribution amount (gross) |
| `status` | enum | `active \| withdrawn \| locked` |
| `lockedAt` | Date | Set when contest closes |
| `createdAt` | Date | Auto |
| `updatedAt` | Date | Auto |

Unique index: `{ contestId, contributorId, entryId }`.
Index: `{ contestId, beneficiaryId }` — used by close job to sum contributions per contestant.
Index: `{ contributorId, status }` — used for contributor's own history.

A user **can** contribute to both entries in the same contest (attribution is independent of voting). They **cannot** contribute to their own entry.

---

#### `ContestPayout`
Audit record created by the contest-close job. One doc per contestant per contest. Earnings are credited to `wallet.earnedCHL` immediately at contest close — no pending/claim step.

| Field | Type | Notes |
|---|---|---|
| `contestId` | ObjectId → Contest | |
| `entryId` | ObjectId → Entry | |
| `userId` | ObjectId → User | The contestant |
| `grossContributionsCHL` | Number | Total contributed to this entry |
| `netPayoutCHL` | Number | 75% of gross — credited to wallet at contest close |
| `platformFeeCHL` | Number | 25% of gross — platform's cut |
| `status` | enum | `completed` only — settled immediately at contest close |
| `paidAt` | Date | Contest close time |
| `createdAt` | Date | Auto (contest close time) |

Index: `{ userId }` — transaction history queries.
Index: `{ contestId }` — contest page earnings display.

---

#### `MonthlySnapshot`
Created on the 1st of each month for every user with `balanceCHL > 0`. Drives the auto-payout cycle.

| Field | Type | Notes |
|---|---|---|
| `userId` | ObjectId → User | |
| `month` | String | `"YYYY-MM"` — e.g. `"2026-03"` |
| `snapshotDate` | Date | Exact datetime of snapshot (1st 00:00 UTC) |
| `earnedCHL` | Number | AAC (`wallet.earnedCHL`) at snapshot time — only earned credits are auto-paid out |
| `autoPayoutDate` | Date | 30th of same month 00:00 UTC |
| `makeupPayoutDate` | Date | 15th of next month 00:00 UTC |
| `status` | enum | `pending \| paid \| held \| makeup_paid` |
| `amountPaidCHL` | Number | Actual amount paid — `min(snapshotBalance, balanceAtPayoutTime)` |
| `heldAt` | Date | When user requested hold |
| `paidAt` | Date | When payout was executed |

Unique index: `{ userId, month }`.
Index: `{ status, autoPayoutDate }` — 30th sweeper.
Index: `{ status, makeupPayoutDate }` — 15th makeup sweeper.

---

### Routes

#### Top-up flow
| Method | Path | Description |
|---|---|---|
| `GET` | `/wallet/topup` | Packages page — 4 preset cards + custom input + USD↔🌶️ toggle |
| `GET` | `/wallet/checkout` | Order summary — shows package, amount in CHL + USD, fake "Complete Purchase" btn |
| `POST` | `/wallet/checkout` | Processes fake payment — credits `purchasedCHL`, writes `WalletTransaction` (type: `top_up`), redirects to `/settings?section=wallet&success=topup` |

Query params on checkout: `?amount=100&package=Starter` (or `?amount=X&custom=true`).

#### Contribution
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/contests/:id/contribute` | Body: `{ entryId, amountCHL }`. Validates total balance (`purchasedCHL + earnedCHL`), creates/updates `ContestContribution`, debits wallet (SB first, then AAC for any remainder), writes `WalletTransaction` (type: `contribution`). Cannot contribute to own entry. |
| `PATCH` | `/api/contests/:id/contribute/:entryId` | Body: `{ amountCHL }`. Adjusts existing contribution up or down. Debits or credits the delta. Writes `WalletTransaction` (type: `contribution_adjustment`). |
| `DELETE` | `/api/contests/:id/contribute/:entryId` | Full withdrawal — refunds full contribution to wallet. Sets `ContestContribution.status: withdrawn`. Writes `WalletTransaction` (type: `contribution_withdrawal`). |

All three blocked if contest is not `active` or contribution is `locked`.

#### Settings wallet section data
Served as part of `GET /settings` — the wallet section queries:
- `User.wallet.purchasedCHL` — SB (spendable balance from top-ups)
- `User.wallet.earnedCHL` — AAC (amount available for cashout from contest earnings)
- `MonthlySnapshot.findOne({ userId, month: currentMonth })` — upcoming auto-payout info
- `WalletTransaction.find({ userId }).sort({ createdAt: -1 }).limit(50)` — transaction history

---

### Views

#### `/wallet/topup`
- 4 preset package cards: **Starter** $20 / 100 🌶️, **Medium** $50 / 250 🌶️, **Hot** $100 / 500 🌶️, **Inferno** $200 / 1,000 🌶️
- Custom amount input ($20–$500, live-computes CHL equivalent)
- Currency toggle: switches all displayed amounts between USD and 🌶️ in real time (no page reload)
- Selecting a package → redirects to `/wallet/checkout?amount=X&package=Name`

#### `/wallet/checkout`
- Order summary: package name (or "Custom"), CHL amount, USD amount
- "Complete Purchase" button (the CCBill stub — later this page becomes the CCBill redirect)
- Back link to `/wallet/topup`

#### Settings → Wallet section
- **Spendable Balance (SB):** `purchasedCHL` 🌶️ with top-up anchor — credits from top-ups only
- **Available to Cash Out (AAC):** `earnedCHL` 🌶️ — credits earned from contest payouts; default cashout pool
- **Auto-payout notice** — if a `MonthlySnapshot` exists for the current month with `status: pending`, show: *"X 🌶️ is scheduled for auto-payout on the 30th"* + "Hold until the 15th" button (visible 25th–29th only). Auto-payout draws from `earnedCHL` only.
- **Transaction history** — paginated table: date, type label, amount (coloured credit/debit), balance after

#### Contest page additions
- Per contestant: gross contribution total shown below their entry (visible to all viewers)
- Contribution UI: slider or +/− input, shows your current contribution to that contestant, "Contribute" and "Withdraw" buttons. Hidden for the contestant's own entry. Blocked if contest is not `active`.
- Your total contribution shown inline: *"You've contributed 50 🌶️ to this contestant"*

#### Profile (owner view only)
- SB (`purchasedCHL`) and AAC (`earnedCHL`) displayed in the stats row — hidden from all other viewers

---

### Background Jobs (agenda pattern — same as existing sweepers)

#### 1st of month — `snapshot_monthly_balances`
Recurring on the 1st. Finds all users with `wallet.earnedCHL > 0` where no snapshot exists for the current month. Creates one `MonthlySnapshot` per user, capturing `earnedCHL` at snapshot time. Sets `autoPayoutDate` (30th of current month) and `makeupPayoutDate` (15th of next month).

#### 25th of month — `payout_reminder`
Recurring on the 25th. Finds all `MonthlySnapshot` docs with `status: pending` and `balanceCHL > 0`. For each: send in-app `Notification` (type: `payout_reminder`) and email via Resend — *"Your X 🌶️ auto-payout fires on the 30th. Tap here to hold it until the 15th."*

#### 30th of month — `auto_payout_30`
Recurring on the 30th. Finds all `MonthlySnapshot` docs with `status: pending` and `autoPayoutDate <= now`. For each:
- Calculate `amountPaid = min(snapshot.earnedCHL, user.wallet.earnedCHL)` — draws from AAC only
- If `amountPaid > 0`: debit `wallet.earnedCHL`, write `WalletTransaction` (type: `auto_payout`), set snapshot `status: paid`, `amountPaidCHL`, `paidAt`
- Send in-app notification (type: `payout_processed`) confirming amount

#### 15th of month — `makeup_payout_15`
Recurring on the 15th. Finds all `MonthlySnapshot` docs with `status: held` and `makeupPayoutDate <= now`. Same logic as auto-payout — draws from `earnedCHL` only, no further opt-out available.

#### Contest-close job extension (existing `close_contest` job)
After setting `winnerEntryId` and `status: closed`, the job now also:
1. Aggregates `ContestContribution` totals per entry (only `status: active` contributions)
2. Sets all contributions for this contest to `status: locked`
3. For each entry with contributions > 0: credits `wallet.earnedCHL` with `netPayoutCHL` (75% of gross), writes a `WalletTransaction` (type: `contest_payout_settled`, direction: `credit`), creates a `ContestPayout` audit doc with `status: completed`
4. Sends `contest_payout_available` notification to each contestant who received earnings

---

### New Notification Types

| Type | When | Copy |
|---|---|---|
| `payout_reminder` | 25th of month | *"Your X 🌶️ auto-payout fires in 5 days. Tap to hold until the 15th."* |
| `payout_processed` | 30th or 15th after auto-payout | *"X 🌶️ has been paid out from your account."* |
| `contest_payout_available` | Contest closes with contributions > 0 | *"Your contest earned X 🌶️ — added to your balance."* |

---

### Task List

**Schema**
- [x] Migrate `User.wallet.balanceCents → balanceCHL` (default 0, no data to preserve)
- [x] Refactor `User.wallet.balanceCHL → purchasedCHL + earnedCHL` — rename field, add earnedCHL, update all routes/jobs/views
- [x] Create `WalletTransaction` model
- [x] Create `ContestContribution` model
- [x] Create `ContestPayout` model
- [x] Create `MonthlySnapshot` model
- [x] Add new notification types to `Notification` schema enum

**Top-up flow**
- [x] `GET /wallet/topup` route + `views/wallet/topup.ejs` — package cards, custom input, USD↔🌶️ toggle
- [x] `GET /wallet/checkout` route + `views/wallet/checkout.ejs` — order summary
- [x] `POST /wallet/checkout` — credit wallet, write `WalletTransaction`, redirect with success flash

**Contribution**
- [x] `POST /api/contests/:id/contribute` — create/update `ContestContribution`, debit wallet, write tx
- [x] `PATCH /api/contests/:id/contribute/:entryId` — adjust contribution, write delta tx
- [x] `DELETE /api/contests/:id/contribute/:entryId` — withdraw, refund wallet, write tx
- [x] Contest page contribution UI — slider/input per contestant, gross total display, your-contribution line

**Contest close earnings**
- [x] Extend `close_contest` background job — lock contributions, credit wallet immediately, create `ContestPayout` audit docs, fire `contest_payout_available` notifications
- [x] `POST /wallet/hold-payout` — hold current month's auto-payout

**Settings wallet section**
- [x] Add Wallet section to `views/settings.ejs` — balance, auto-payout notice, transaction history
- [x] Wire wallet data into `GET /settings` route

**Profile**
- [x] Show SB (`purchasedCHL`) and AAC (`earnedCHL`) in stats row — owner view only (update from single `balanceCHL`)

**Background jobs**
- [x] `snapshot_monthly_balances` — 1st of month
- [x] `payout_reminder` — 25th of month (in-app + email)
- [x] `auto_payout_30` — 30th of month
- [x] `makeup_payout_15` — 15th of month

**Notifications**
- [x] Add `payout_reminder`, `payout_processed`, `contest_payout_available` render cases to `views/notifications.ejs`

---

## Financial System — Design Reference (June 17)

The full financial system is documented in `plans/platform-core-concepts.md`. Key decisions locked:

### Credits
- **Exchange rate:** 1 credit = $0.20 ($1 = 5 credits). Adjustable at platform discretion.
- **Credit packages:** $20 (100cr) / $50 (250cr) / $100 (500cr) / custom $20–$500 (100–2,500cr). Minimum purchase $20.
- **Payment processor:** CCBill (pending ToS verification).

### Voting & Attribution
- **Free vote:** 1 per 12 hours per user. Resets, does not accumulate.
- **Paid vote:** costs credits (user-determined amount). Vote switching allowed while contest is live — free vote returned, credits refunded.
- **One vote per contest per user** (one entry only). Cannot vote for own entry.
- **Attribution:** separate from voting. User-determined credit spend via slider. Can contribute to both entries in a contest. Mutable while contest is live (increase, decrease, or full withdrawal). Locks at contest close.
- **Attribution in tie-breaker chains:** attribution window is original contest only. If the original ties, attribution locks — replays are vote-only. Pays out at final chain resolution (replay win or sudden death).
- **Attribution cash-out minimum:** 100 credits ($20).
- **Split:** 75% to contestant, 25% to platform at contest close.
- **All votes equal** — no special weighting for organizers or any other role.

### Contestant Aprons (contest trophy system)
Aprons are awarded at contest close based on margin of victory. Separate from tournament placement prizes (Golden/Silver/Red).

**Eligibility:** winner must reach 5,000 votes. Gap % = `(winner − loser) / loser`.

| Apron | Gap required | Example (loser = 5,000) | Value each | Min. to cash out | Min. payout |
|-------|:-----------:|:-----------------------:|:----------:|:----------------:|:-----------:|
| Flannel | ≥ 49% | 7,450 votes | $10 (50cr) | 5 | $50 |
| Denim | ≥ 68% | 8,400 votes | $20 (100cr) | 10 | $200 |
| Velvet | ≥ 110% | 10,500 votes | $50 (250cr) | 20 | $1,000 |

Special case: winner ≥ 5,000, loser < 5,000 → automatic Flannel.

- Aprons are **permanent on profile** (lifetime total always visible). Eligible balance = total won − paid out.
- **Forced monthly auto-payout:** platform settles all eligible balances at month end. If below minimum, carries over.
- Funded from general platform resources (primarily the 25% vote attribution cut).

### Tie-breaker chain update
Ratings Challenge removed. New chain (tournament contests only):

| Round | Window |
|-------|:------:|
| Original | 72h |
| Replay 1 | 36h |
| Replay 2 | 18h |
| Replay 3 | 9h |
| Sudden Death | Organizer decides — final |

---

## What is NOT in June

These are defined but deliberately deferred:

| Feature | Reason |
|---|---|
| Tournaments (player-facing system) | Needs contest system solid and battle-tested first |
| Admin tournament management pages | No tournament data to manage until the full tournament system is built — deferred to July alongside it |
| CCBill real payment integration | July — fake checkout stub built in Phase 4.7 is the drop-in replacement point |
| Apron payout system | July — needs real vote volumes to be meaningful |
| Ratings Challenge (tie-breaker) | Removed from design — replaced by 3-replay chain |
| Open challenges (post-MVP) | Explicitly post-MVP |

---

## End-of-June Target

By June 30, the platform should support the complete standalone contest lifecycle plus a testable economic layer:
- Users register, upload entries, get rated
- Users challenge each other to HTHs
- Viewers can nominate two users for a HTH with a message
- Contests run on a timer, void or close automatically
- Winners are determined by vote count
- Users receive notifications throughout
- Users can top up chillies via the fake checkout flow
- Viewers can contribute chillies to contestants on active contests
- Contest earnings (75% net) are credited to a contestant's spendable balance immediately when the contest closes
- Monthly auto-payout cycle with hold-to-15th opt-out runs via background jobs

CCBill real payment integration and Apron payouts are July scope. Everything else is done.
