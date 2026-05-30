# June Action Plan

## Current State (end of May)

The project has meaningful scaffolding already in place. Before building new features, some existing models need to be aligned with the finalized design from `platform-core-concepts.md`.

### What exists
| Asset | Status |
|---|---|
| `User` model | Exists — needs `idVerified`, `wallet`, role alignment |
| `Item` model | Exists — is functionally our `Entry`, needs rename + field cleanup |
| `Rating` model | Exists — references `Item`, has `mode` field that no longer applies. Needs rebuild. |
| `Contest` model | Exists — completely different concept. Needs full replacement. |
| Auth routes | Exists (`routes/auth.js`) |
| Admin middleware | Exists (`middleware/isAdmin.js`) |
| Upload middleware | Exists (`middleware/upload.js`) |
| Views | Stubs exist for: feed, profile, contests, notifications, messages, leaderboard, search, settings, signup |
| Admin dashboard | Stub exists |

### What does not exist yet
- `Entry` model (replacing `Item`)
- `Contest` model (replacing the old one entirely)
- `Nomination` model
- `ContestVote` model
- `Tournament` model
- `TournamentEntry` model
- `RatingsChallenge` model
- `RatingsChallengeVote` model
- Background job scheduler (for deadline enforcement)
- Notification system (logic and delivery)

---

## June Phases

### Phase 1 — Schema Alignment (June 1–7)

The foundation. Nothing else gets built until the data models match the design.

**Tasks:**
- [x] Rename `Item` → `Entry`. Update all references across routes, views, and other models.
- [x] Update `Entry` schema: remove `title`, `price`, `isListed`, `contest` (link managed separately). Keep `mediaUrl`, `mediaType`, `caption`, `creator`, `ratingCount`, `ratingAvg`.
- [x] Update `User` schema: replace `isAdmin: Boolean` with `role: enum('user', 'admin')`. Add `onboardingStatus`, `emailConfirmed`, `emailConfirmSentAt`, `idVerified`. Add embedded `wallet`.
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

### Phase 2 — Auth + User Foundation (June 8–14)

Build the user layer that everything else depends on.

**Tasks:**
- [ ] Complete signup flow: form validates, hashes password, creates user + wallet. Set `onboardingStatus: 'pending_submission'` on creation.
- [ ] Redirect middleware: any request from an unauthenticated user goes to signup — no exceptions, no read-only browsing.
- [ ] Onboarding middleware: any authenticated user with `onboardingStatus !== 'approved'` is confined to the onboarding domain. They cannot access the main platform.
- [ ] Install and configure **Resend** for transactional email.
- [ ] OTP email verification step within the signup form: user submits their email → Resend sends a 6-digit OTP → user enters it on the next signup step → verified before account is created. No async flow, no expiry timers. `emailConfirmed` is always `true` on any account that exists.
- [ ] Onboarding flow (multi-step, replaces normal post-login redirect):
  - **Step 1 — Submit entry:** query tournaments with `status: 'open'`. If found, show them. User picks one and submits an entry. `onboardingStatus` → `pending_approval`. If none found → holding screen ("No tournament is accepting entries right now. Come back later.").
  - **Step 2 — Waiting for approval:** user sees a waiting screen. Organizer reviews the submission in their dashboard. On approval → `onboardingStatus: 'approved'`, user gains full platform access. On rejection or `timed_out` → `onboardingStatus: 'rejected'`, user is notified and sent back to Step 1.
- [ ] Organizer entry review dashboard: list of `pending` tournament entries for each tournament they created. Approve or reject with one action. Rejected entries trigger a notification to the submitting user.
- [ ] Complete login flow: session or JWT, protect routes with auth middleware.
- [ ] Profile page: display user's entries, average rating, username, avatar, bio.
- [ ] Settings page: edit username, bio, avatar upload.

**Exit criteria:** A new user completes signup, submits an entry, waits for approval, and upon approval lands on the main platform. Rejection loops them back cleanly. Anonymous users never reach any platform page.

**Exit criteria:** A user can register, log in, view and edit their profile, and be redirected to signup when trying to access protected routes without a session.

---

### Phase 3 — Entries + Ratings (June 8–14, parallel with Phase 2)

The default engagement layer. Every user on the platform interacts with this.

**Tasks:**
- [ ] Entry upload: photo and video via existing `upload` middleware. Store `mediaUrl`, `mediaType`, link to user.
- [ ] Entry display: entry page showing media, owner info, current rating average and count.
- [ ] Rating flow: authenticated user submits 1–10 score. Enforce no self-rating, no duplicate rating. Update `ratingCount` and `ratingAvg` on the entry document.
- [ ] Tags: entry owner can add, edit, or remove up to 6 free-form tags on their entry at any time.
- [ ] Comment flow: any registered user can comment on an entry. Users can delete their own comments. Entry owner can hide any comment (hidden comments move to a private "hidden comments" section, visible only to the owner). Any user can report a comment.
- [ ] Reply flow: any registered user can reply to a top-level comment (one level only). Reply body is automatically prefixed with @username of the parent commenter.
- [ ] Comment notifications: notify entry owner when someone comments on their entry. Notify parent commenter when someone replies to their comment.
- [ ] Feed page: show recent entries from all users, sortable by rating.
- [ ] Leaderboard page: top entries by `ratingAvg` (minimum rating count threshold TBD).

**Exit criteria:** A user can upload an entry, other users can rate it 1–10, and the feed and leaderboard reflect live data.

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
- [ ] Gate tournament creation behind `idVerified: true` check — prompt ID verification if user tries to create a tournament without it.
- [ ] Notification model or in-document array: store unread notifications per user.
- [ ] Notifications page: show nominations received, contest results, contest voided.
- [ ] Messages page: show nomination messages from viewers (viewer HTH suggestions with message).
- [ ] Viewer nomination flow: any registered user can nominate two other users for a HTH, with an optional message. Both nominees receive a notification.

**Exit criteria:** Time-based contest state transitions happen automatically without manual intervention. Users receive in-app notifications for all nomination and contest events.

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
| ID verification | No user-organized tournaments yet |

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
