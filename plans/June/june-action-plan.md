# June Action Plan

## Current State (June 15)

Phase 1 (schema alignment), Phase 2 (auth + user foundation), and Phase 3 (entries + ratings) are complete. Phase 6 admin infrastructure — role system, staff hiring flow, audit log, support chat, and admin profile — was pulled forward and is also done. Follow/unfollow and direct messaging are now complete. The leaderboard is also fully wired. The contest system — creation, nomination, acceptance, voting, result display, contest comments, and private contests — is substantially done. Void deadline state is now normalized at read time via Mongoose post-hooks (a bridge until Phase 5 background jobs land); UI correctly shows "Timed out" / "No response" states across entryCard, edit-entry, and the contest page. Entry comments and replies are now fully implemented — post, edit, delete, hide (owner), report, denormalized `commentCount`, and the hidden comments section visible to the entry owner only. The notification system is now live: dedicated `Notification` collection (Option A), `injectNotificationCount` middleware injecting unread badge counts into all main platform views, per-notification click-to-mark-read, mark-all-as-read, sidebar badge (count label + collapsed dot), and triggers wired for new comments, replies, and nominations. What remains is right panel data, viewer nominations, background jobs (including contest_closed / contest_voided notification triggers), and the remaining Phase 6 admin UI pages.

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

### What is not done yet
- Feed — Head To Head and Tournaments tabs (empty; Ratings tab is done)
- Right panel trending/contests data (shows skeleton permanently)
- Background jobs: void deadline enforcement, voting deadline + close logic, contest_closed / contest_voided notification triggers (Phase 5 scope)
- Viewer nomination flow (any user nominates two others for a HTH with a message)
- Phase 6 admin UI pages: tournament management, content moderation, and entries moderation are placeholder stubs only; admin dashboard, user list/detail, ID verification queue, and audit log are done

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
- [x] Create `RatingsChallenge` schema (with embedded entries).
- [x] Create `RatingsChallengeVote` schema.
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
- [ ] **Wire up right panel data:** `rightPanel.ejs` references `trendingItems` and `contests` that no route ever populates — the panel shows skeleton placeholders permanently. Feed and leaderboard routes should query and pass this data.
- [x] Feed page: Ratings tab fully wired — `UserAffinity` model + `utils/feedScorer.js` affinity/velocity/follow scoring, entries rendered as `entryCard` with pre-locked ratings for already-rated entries.
- [x] Comment flow: any registered user can comment on an entry. Users can delete their own comments. Entry owner can hide any comment (hidden comments move to a private "hidden comments" section, visible only to the owner). Any user can report a comment.
- [x] Reply flow: any registered user can reply to a top-level comment (one level only).
- [x] Comment notifications: notify entry owner when someone comments on their entry. Notify parent commenter when someone replies to their comment.

**Exit criteria:** A user can upload an entry, other users can rate it 1–10, and the feed and leaderboard reflect live data. Comments work end to end. Right panel shows real trending data.

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
- [ ] Nominee withdrawal action while `pending`: no-fault decline, contest/nomination deleted on nominator's follow-up "remove nominee" action.
- [ ] Nominee forfeit action while `active`: closes contest, sets opponent as `winnerEntryId`, marks nominee's side with a `withdrew: true` (or similar) flag for the "Withdrew" badge.
- [ ] "Remove nominee" route (nominator-only): deletes the Contest + Nomination doc, covering both the no-fault pending case and the scrub-the-forfeit-record live case.

---

#### Contest Watch / Follower Notifications (added June 16)

**Design:**
- When a nominator starts a new contest (nominates someone), their followers (existing `Follow` model) are auto-notified via a new `Notification` type.
- Any user landing on a contest page — follower or not — gets a "stay in the loop" button to subscribe specifically to that contest's updates. Requires a new per-contest watch model (e.g. `ContestWatch`: `contestId`, `userId`) since `Follow` is user-to-user only.
- Watchers get notified on: nominee responds (accept/decline), forfeit, timeout/void, contest closed.

**Tasks:**
- [ ] New `Notification` types for: contest started (sent to nominator's followers), nominee responded, nominee forfeited, contest timed out/voided, contest closed (sent to watchers).
- [ ] `ContestWatch` model + "stay in the loop" toggle on the contest page.
- [ ] Wire notification triggers for all events above to the watcher list (nominator's followers are auto-watchers from creation; anyone else opts in via the button).

> Note: the "voting closes in" countdown format (days/hours/minutes/seconds, zero-padded, fewer units as time runs out) was reviewed and confirmed correct as-is — no change needed.

---

### Phase 5 — Notifications + Background Jobs (June 22–30)

The system that makes everything time-sensitive work reliably.

**Tasks:**
- [ ] Choose and install a job scheduler (`node-cron` or `agenda`).
- [ ] Implement void deadline job: runs every 15 minutes, voids pending contests past their `voidDeadline`.
- [ ] Implement voting deadline job: runs every 15 minutes, closes active contests past their `votingDeadline`.
- [ ] Implement entry review timeout job (July/tournament scope): runs every 5 minutes. Finds `tournament_entries` with `approvalStatus: 'pending'` and `submittedAt < now - 30min`. For each: set `approvalStatus: 'timed_out'`, increment `tournament.missedReviews`, notify the submitting user their entry timed out. If `tournament.missedReviews >= 3`: cancel the tournament, notify all `pending_approval` users to resubmit elsewhere.
- [ ] Gate tournament creation behind `idVerified: true` check. Since ID verification is now scoped and on-demand (not a mandatory onboarding step), a user can reach the "create tournament" action without ever having verified — this check is a real, reachable gate, not just a bypass safeguard.
- [x] Notification model: dedicated `Notification` collection (Option A) with compound index `{userId, read, createdAt}` and 90-day TTL index. `injectNotificationCount` middleware injects unread count into all main platform views. Sidebar badge (count label + collapsed dot). Per-notification click-to-mark-read + mark-all-as-read. Triggers: new comment → entry owner, reply → parent commenter, nomination created → nominee.
- [x] Notifications page: paginated list at `/notifications` — actor avatar, notification text, relative timestamp, unread highlight. `contest_closed` / `contest_voided` rows render correctly when triggers fire (wired in Phase 5 background jobs).
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
