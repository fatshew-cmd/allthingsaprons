# June Action Plan

## Current State (June 10)

Phase 1 (schema alignment), Phase 2 (auth + user foundation), and the core of Phase 3 (entries + ratings) are complete. Phase 6 admin infrastructure — role system, staff hiring flow, audit log, support chat, and admin profile — was pulled forward and is also done. Follow/unfollow and direct messaging are now complete. The leaderboard is also fully wired. What remains is content display (feed, comments), the contest system, and the remaining Phase 6 admin UI pages.

### What is done
| Asset | Status |
|---|---|
| All models | Complete and aligned with `platform-core-concepts.md` |
| Auth routes | Signup (OTP via Resend), login, logout — fully working |
| Onboarding flow | ID verification → submit entry → pending approval → approved/rejected — fully working |
| ID verification | Moved to own route file (`routes/verify-identity.js`). Selfie + government ID upload, code generation, attempt limiting, 2hr block after 3 failures — fully working |
| Admin entry review | Approve/reject tournament entries, sets `onboardingStatus` — fully working |
| `requireAuth` middleware | Unauthenticated users redirected to signup |
| `requireApproved` middleware | Non-approved users confined to onboarding domain |
| Entry upload | Photo + video, tags, caption — fully working |
| Entry display page | Media, owner info, rating avg/count — fully working |
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

### What is not done yet
- Feed content (tabs exist, all three are empty)
- Right panel trending/contests data (shows skeleton permanently)
- Comments, replies, moderation, reporting
- Notifications (no model, no routes)
- Standalone contests (full lifecycle)
- Phase 6 admin UI pages: tournament management, content moderation, and entries moderation are placeholder stubs only; admin dashboard, user list/detail, ID verification queue, and audit log are done

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
- [ ] **Wire up right panel data:** `rightPanel.ejs` references `trendingItems` and `contests` that no route ever populates — the panel shows skeleton placeholders permanently. Feed and leaderboard routes should query and pass this data.
- [ ] Feed page: build out the Ratings tab — show recent entries from all users as cards with rating UI. The tab structure and layout exist; the content does not. → [milestone breakdown](feed-ratings-tab-milestones.md)
- [ ] Comment flow: any registered user can comment on an entry. Users can delete their own comments. Entry owner can hide any comment (hidden comments move to a private "hidden comments" section, visible only to the owner). Any user can report a comment.
- [ ] Reply flow: any registered user can reply to a top-level comment (one level only). Reply body is automatically prefixed with @username of the parent commenter.
- [ ] Comment notifications: notify entry owner when someone comments on their entry. Notify parent commenter when someone replies to their comment.

**Exit criteria:** A user can upload an entry, other users can rate it 1–10, and the feed and leaderboard reflect live data. Comments work end to end. Right panel shows real trending data.

> **Dev note:** `@storiesbyshews` has `idVerified: true` set manually in the DB to allow free entry submission testing during Phase 3. Before Phase 3 closes, reset this user's `idVerified` to `false` and `idVerificationStatus` to `none` (or `null`) so the account goes through the real ID verification flow.

---

### Phase 4 — Standalone Contests (June 15–22)

The core competitive mechanic. Build the HTH contest flow end to end.

**Tasks:**
- [ ] Contest creation: creator self-nominates (they are contestant A), nominates a specific opponent (contestant B).
- [ ] Nomination delivery: opponent receives a notification/message. 24hr acceptance window starts.
- [ ] Acceptance flow: opponent submits an entry → contest moves to `active`. Voting deadline set to `submittedAt + 72h`.
- [ ] Void logic: background job checks `voidDeadline`. If no second entry → status set to `void`. Creator notified.
- [ ] Contest voting page: show both entries side by side. Authenticated user picks one. Enforce no self-vote, no duplicate vote. Store `valueCents` on each vote (use $0.001 for now, tournament organizer logic comes later).
- [ ] **REVERT BEFORE LAUNCH:** Re-enable participant vote guard and `status === 'active'` checks in `routes/api.js` (contest vote handler) and `routes/pages.js` (contest GET handler) — both are commented out with `// TEMP` for local testing.
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
- [x] Messages page: direct messaging between users — `Conversation` + `DirectMessage` models, `routes/messages.js`, two-panel view (`/messages` list + `/messages/:username` thread). Polled every 5s. Message button on profile opens or creates a conversation.
- [ ] Viewer nomination flow: any registered user can nominate two other users for a HTH, with an optional message. Both nominees receive a notification.

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
| Users | Onboarding Queue | Approve/reject new user entry submissions |
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
| Onboarding Queue | | ✓ | ✓ | | |
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

**Superadmin:** Active tournaments (status, entries pending review), user registration trend, onboarding queue depth, escalations pending, entry volume (submitted/approved/rejected this week).

**Supervisor:** Moderation queue depth (reported comments, pending reviews), moderator activity (who reviewed what, response times), escalations assigned to them, entry review throughput.

**Moderator:** Their personal queue — entries to review and reported comments to action. Their own stats (reviewed today, this week, avg response time). No platform-wide data.

**Support:** Unread message count, open vs resolved tickets, average response time, users who have contacted support multiple times.

---

**Pages and tasks:**

- [x] **Admin dashboard:** role-specific view — Founder sees financials and org health; Superadmin sees operational metrics; Supervisor sees moderation throughput; Moderator sees their personal queue and stats; Support sees inbox metrics. One route, one conditional render per role.
- [x] **User management — list:** paginated user list with filters for role, onboarding status, account status, and `idVerified`
- [x] **User management — detail:** profile info, uploaded entries, contest/tournament history, onboarding status, ID verification documents, wallet balance; admin actions (role assignment using 2-tier-ahead rule, account suspension)
- [x] **ID verification queue:** list of users with `idVerificationStatus: 'pending'`; review view showing selfie and government ID side by side; approve / reject action (approval sets `idVerified: true` and advances user to `pending_submission`)
- [x] **Admin audit log:** append-only `admin_audit_logs` collection, `ATA-YYYYMMDD-XXXXXXXX` ticket refs, actor ID + role, action slug, affected entity, target user, `remarks`, and `metadata` payload. Global log view at `/admin/audit-log` visible to supervisor+; filterable by action, target user, and ticket ref. `utils/auditLog.js` helper used throughout.
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
