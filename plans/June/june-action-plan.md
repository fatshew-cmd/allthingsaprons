# June Action Plan

## Current State (June 2)

Phase 1 (schema alignment) and the bulk of Phase 2 (auth + user foundation) are complete — both finished ahead of the original schedule. Entry upload and ratings are also done. What remains is primarily content display (feed, leaderboard, comments) and the contest system.

### What is done
| Asset | Status |
|---|---|
| All models | Complete and aligned with `platform-core-concepts.md` |
| Auth routes | Signup (OTP via Resend), login, logout — fully working |
| Onboarding flow | ID verification → submit entry → pending approval → approved/rejected — fully working |
| ID verification | Selfie + government ID upload, code generation, attempt limiting, 2hr block after 3 failures — fully working |
| Admin entry review | Approve/reject tournament entries, sets `onboardingStatus` — fully working |
| `requireAuth` middleware | Unauthenticated users redirected to signup |
| `requireApproved` middleware | Non-approved users confined to onboarding domain |
| Entry upload | Photo + video, tags, caption — fully working |
| Entry display page | Media, owner info, rating avg/count — fully working |
| Rating flow | 1–10, no self-rate, no duplicate, denormalized onto entry — fully working |
| Profile page | Entries, follow counts, stats, contest/tournament history — fully working |
| Settings page | Edit username, bio, avatar, banner — fully working |

### What is not done yet
- Feed content (tabs exist, all three are empty)
- Leaderboard (route is broken — passes no data to the template)
- Right panel trending/contests data (shows skeleton permanently)
- Follow / Unfollow action (model + counts exist, no POST routes)
- Comments, replies, moderation, reporting
- Notifications (no model, no routes)
- Messages (stub only)
- Standalone contests (full lifecycle)

---

## June Phases

### Phase 1 — Schema Alignment (June 1–7)

The foundation. Nothing else gets built until the data models match the design.

**Tasks:**
- [x] Rename `Item` → `Entry`. Update all references across routes, views, and other models.
- [x] Update `Entry` schema: remove `title`, `price`, `isListed`, `contest` (link managed separately). Keep `mediaUrl`, `mediaType`, `caption`, `creator`, `ratingCount`, `ratingAvg`.
- [x] Update `User` schema: replace `isAdmin: Boolean` with `role: enum('user', 'admin')`. Add `onboardingStatus` (initial value: `pending_id_verification`), `emailConfirmed`, `idVerified`, `idVerificationStatus`, `idSelfieUrl`, `idDocUrl`, `idVerificationCode`, `idVerifyFailedAttempts`, `idVerifyBlockedUntil`, `accountStatus`. Add embedded `wallet`.
- [x] Rebuild `Rating` schema: reference `Entry` (not `Item`). Remove `mode` field. Add unique compound index on `{ entryId, userId }`.
- [x] Delete old `Contest` model. Create new `Contest` schema per design (entries embedded, designatedVoters embedded, status lifecycle, windowHours, deadlines, etc.).
- [x] Create `Nomination` schema.
- [x] Create `ContestVote` schema.
- [x] Create `Tournament` schema (with embedded prizes).
- [x] Create `TournamentEntry` schema — include `approvalStatus: enum('pending', 'approved', 'rejected', 'timed_out')` and `reviewedAt`.
- [x] Create `RatingsChallenge` schema (with embedded entries).
- [x] Create `RatingsChallengeVote` schema.
- [x] Update `isAdmin` middleware to use `role === 'admin'` instead of `isAdmin` boolean.
- [x] Run `seedAdmin.js` to verify the updated User schema works end to end.

**Exit criteria:** All models exist, are consistent with `platform-core-concepts.md`, and the app still boots without errors.

---

### Phase 2 — Auth + User Foundation ✅ (completed early)

**Tasks:**
- [x] Complete signup flow: form validates, hashes password, creates user + wallet. Set `onboardingStatus: 'pending_id_verification'` on creation.
- [x] Redirect middleware: any request from an unauthenticated user goes to signup — no exceptions, no read-only browsing.
- [x] Onboarding middleware: any authenticated user with `onboardingStatus !== 'approved'` is confined to the onboarding domain. They cannot access the main platform.
- [x] Install and configure **Resend** for transactional email.
- [x] OTP email verification step within the signup form: user submits their email → Resend sends a 6-digit OTP → user enters it on the next signup step → verified before account is created. No async flow, no expiry timers. `emailConfirmed` is always `true` on any account that exists.
- [x] Onboarding flow (multi-step, replaces normal post-login redirect):
  - **Step 1 — ID verification:** user generates an 8-character code, uploads a selfie with the code visible, and uploads a government-issued ID. Submission sets `idVerificationStatus: 'pending'`. Admin reviews manually; approval sets `idVerified: true` and advances user to `pending_submission`. Failed attempts are tracked; 3 failures trigger a 2-hour block.
  - **Step 2 — Submit entry:** query tournaments with `status: 'open'`. If found, show them. User picks one and submits an entry. `onboardingStatus` → `pending_approval`. If none found → holding screen ("No tournament is accepting entries right now. Come back later.").
  - **Step 3 — Waiting for approval:** user sees a waiting screen. Organizer reviews the submission in their dashboard. On approval → `onboardingStatus: 'approved'`, user gains full platform access. On rejection or `timed_out` → `onboardingStatus: 'rejected'`, user is notified and sent back to Step 2.
- [x] Organizer entry review dashboard: list of `pending` tournament entries for each tournament they created. Approve or reject with one action. Rejected entries trigger a notification to the submitting user.
- [x] Complete login flow: session + `requireAuth` middleware, protect routes.
- [x] Profile page: display user's entries, average rating, username, avatar, bio, follow counts, contest/tournament history.
- [x] Settings page: edit username, bio, avatar upload, banner upload, account deletion.
- [ ] Follow / Unfollow: `Follow` model and `isFollowing` flag exist on profiles, but there are no POST routes to actually follow or unfollow. Add `POST /follow/:username` and `POST /unfollow/:username`, wire up the button in the profile view.

---

### Phase 3 — Entries + Ratings (June 8–14)

The default engagement layer. Every user on the platform interacts with this.

**Tasks:**
- [x] Entry upload: photo and video via existing `upload` middleware. Store `mediaUrl`, `mediaType`, link to user.
- [x] Entry display: entry page showing media, owner info, current rating average and count.
- [x] Rating flow: authenticated user submits 1–10 score. Enforce no self-rating, no duplicate rating. Update `ratingCount` and `ratingAvg` on the entry document.
- [x] Tags: entry owner can add, edit, or remove up to 6 free-form tags on their entry at any time.
- [ ] **Fix leaderboard route (broken):** `leaderboard.ejs` iterates an `items` variable that the route never passes — the page will throw on load. Wire up the route to query top entries by `ratingAvg` (minimum 3 ratings) and pass them as `items`.
- [ ] **Wire up right panel data:** `rightPanel.ejs` references `trendingItems` and `contests` that no route ever populates — the panel shows skeleton placeholders permanently. Feed and leaderboard routes should query and pass this data.
- [ ] Feed page: build out the Ratings tab — show recent entries from all users as cards with rating UI. The tab structure and layout exist; the content does not.
- [ ] Comment flow: any registered user can comment on an entry. Users can delete their own comments. Entry owner can hide any comment (hidden comments move to a private "hidden comments" section, visible only to the owner). Any user can report a comment.
- [ ] Reply flow: any registered user can reply to a top-level comment (one level only). Reply body is automatically prefixed with @username of the parent commenter.
- [ ] Comment notifications: notify entry owner when someone comments on their entry. Notify parent commenter when someone replies to their comment.

**Exit criteria:** A user can upload an entry, other users can rate it 1–10, and the feed and leaderboard reflect live data. Comments work end to end. Right panel shows real trending data.

---

### Phase 4 — Standalone Contests (June 15–22)

The core competitive mechanic. Build the HTH contest flow end to end.

**Tasks:**
- [ ] Contest creation: creator self-nominates (they are contestant A), nominates a specific opponent (contestant B).
- [ ] Nomination delivery: opponent receives a notification/message. 24hr acceptance window starts.
- [ ] Acceptance flow: opponent submits an entry → contest moves to `active`. Voting deadline set to `submittedAt + 72h`.
- [ ] Void logic: background job checks `voidDeadline`. If no second entry → status set to `void`. Creator notified.
- [ ] Contest voting page: show both entries side by side. Authenticated user picks one. Enforce no self-vote, no duplicate vote. Store `valueCents` on each vote (use $0.001 for now, tournament organizer logic comes later).
- [ ] Contest close logic: background job checks `votingDeadline`. Count votes per entry. Set `winnerEntryId`. Status → `closed`.
- [ ] Contest page: show result, vote counts, winner after close.
- [ ] Private contest flow: creator designates minimum 5 voters. Only designated voters can vote.

**Exit criteria:** Two users can complete a full contest cycle — nomination → acceptance → voting → result — with both public and private variants working.

---

### Phase 5 — Notifications + Background Jobs (June 22–30)

The system that makes everything time-sensitive work reliably.

**Tasks:**
- [ ] Choose and install a job scheduler (`node-cron` or `agenda`).
- [ ] Implement void deadline job: runs every 15 minutes, voids pending contests past their `voidDeadline`.
- [ ] Implement voting deadline job: runs every 15 minutes, closes active contests past their `votingDeadline`.
- [ ] Implement entry review timeout job: runs every 5 minutes. Finds `tournament_entries` with `approvalStatus: 'pending'` and `submittedAt < now - 30min`. For each: set `approvalStatus: 'timed_out'`, increment `tournament.missedReviews`, notify the submitting user (`onboardingStatus` → `rejected`). If `tournament.missedReviews >= 3`: cancel the tournament, notify all `pending_approval` users to resubmit elsewhere.
- [ ] Gate tournament creation behind `idVerified: true` check — server-side safeguard only. Since all approved users complete ID verification during onboarding, the "prompt ID verification" path is unreachable under normal flow; this is a hard server-side guard against bypasses.
- [ ] Notification model or in-document array: store unread notifications per user.
- [ ] Notifications page: show nominations received, contest results, contest voided.
- [ ] Messages page: show nomination messages from viewers (viewer HTH suggestions with message).
- [ ] Viewer nomination flow: any registered user can nominate two other users for a HTH, with an optional message. Both nominees receive a notification.

**Exit criteria:** Time-based contest state transitions happen automatically without manual intervention. Users receive in-app notifications for all nomination and contest events.

---

### Phase 6 — Admin UI

A dedicated admin area covering platform oversight, user management, content moderation, and tournament administration.

**Pages and tasks:**

- [ ] **Admin dashboard:** platform health metrics (total users, active contests, active tournaments, open ID verification queue count, pending tournament review count) + recent activity feed (new signups, new reports, tournament status transitions)
- [ ] **User management — list:** paginated user list with filters for role, onboarding status, account status, and `idVerified`
- [ ] **User management — detail:** profile info, uploaded entries, contest/tournament history, onboarding status, ID verification documents, wallet balance; admin actions (role change, account suspension)
- [ ] **ID verification queue:** list of users with `idVerificationStatus: 'pending'`; review view showing selfie and government ID side by side; approve / reject action (approval sets `idVerified: true` and advances user to `pending_submission`)
- [ ] **Tournament management — list:** all tournaments with status filter; entry point for creating a platform-funded tournament
- [ ] **Tournament management — create:** form to create a platform-funded tournament (name, description, participant cap, time config, prize amounts); starts directly at `open` status
- [ ] **Tournament management — detail:** participant list, matchup grid, missed reviews counter, prize config; admin override actions
- [ ] **Tournament review queue:** user-organized tournaments with `reviewStatus: 'pending_review'`; review view showing tournament config and organizer profile; approve / reject action
- [ ] **Content moderation — reported comments:** queue from `comment_reports`; each item shows the comment in context, who reported it, and when; dismiss / remove actions
- [ ] **Entries moderation:** browse all entries with search and filter; entry detail with moderation actions (hide, remove)

**Exit criteria:** Admin can manage users, process ID verification queue, create and review tournaments, and action reported comments — all from a dedicated admin-only UI.

---

## What is NOT in June

These are defined but deliberately deferred:

| Feature | Reason |
|---|---|
| Tournaments | Needs contest system solid and battle-tested first |
| Vote wallet + earnings | Needs contest system working; adds complexity |
| CCBill integration | No payments until tournament prize flow is ready |
| Ratings Challenge (tie-breaker) | Part of tournament system |
| Open challenges (post-MVP) | Explicitly post-MVP |

---

## End-of-June Target

By June 30, the platform should support the complete standalone contest lifecycle:
- Users register, upload entries, get rated
- Users challenge each other to HTHs
- Viewers can nominate two users for a HTH with a message
- Contests run on a timer, void or close automatically
- Winners are determined by vote count
- Users receive notifications throughout

This is the MVP core. Tournaments and vote economics are the July scope.
