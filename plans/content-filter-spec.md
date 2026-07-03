# Content Filter Spec — All Things Aprons

## Status
**Backlog — not scheduled to any phase.** No implementation yet. This doc exists so the idea isn't lost; pick it up when prioritized.

## Motivation
Every piece of moderation on this platform today is **reactive**: content goes live immediately and is only reviewed/removed after another user files a report through the moderation queue (comment reports, entry reports, user reports — Phase 6 admin infrastructure). There's no proactive filter anywhere that blocks obviously offensive text at the moment a user submits it.

The idea originated from a narrower question (should tournament names be checked for profanity?) and was deliberately expanded: **if we filter one free-text field, we should filter all of them**, consistently, via one shared mechanism — not a one-off check bolted onto a single form.

## Scope — every free-text field a non-admin user submits

Full inventory taken directly from the codebase (not guessed):

| Feature | Model | Field(s) | Route(s) |
|---|---|---|---|
| Signup | `User` | `username.value`, `displayName.value`, `bio.value`, `location.value`, `orientation.value` | `routes/auth.js POST /signup` |
| Profile / settings edit | `User` | `displayName.value`, `bio.value`, `location.value`, `url.value` | `routes/pages.js POST /settings/profile` |
| Entry submission | `Entry` | `title`, `caption`, `tags[]` | `routes/pages.js POST /submit`, `routes/api.js POST /entries`, `PATCH /entries/:id` |
| Comments (entry) | `Comment` | `body` | `routes/api.js POST/PATCH /entries/:eid/comments...` |
| Comments (contest) | `ContestComment` | `body` | `routes/api.js POST/PATCH /contests/:id/comments...` |
| Tournament creation | `Tournament` | `name` (already regex-restricted to letters/numbers/spaces), `description` | `routes/tournaments.js POST /tournaments/create/step1` |
| Direct messages | `DirectMessage` | `body` | `routes/messages.js POST /:username/send` |
| Nominations | `Nomination` | `message` (optional) | `routes/api.js POST /contests/viewer-nominate` |
| Support chat | `SupportMessage` | `body` | `routes/contact.js POST /thread/:threadId/messages` |
| Job applications (low priority, admin-only visibility) | `AdminApplication` | `name`, `linkedin`, `message` | `routes/careers.js POST /` |

**Not in scope:** `Contest` has no user-entered title/name — it's system-generated and inherits its display title from the linked `Entry`, so nothing to filter there directly. Report-reason fields (`UserReport`, `CommentReport`) are checkbox enums, not free text.

### Loose ends noticed while inventorying (not filter-related, worth a separate look)
- `routes/pages.js POST /submit` appears to create an `Entry` without requiring `title`, while `routes/api.js POST /entries` requires it — inconsistent, may be a pre-existing bug independent of this feature.
- The standard `/contests/challenge` nomination path has no `message` field, but `/contests/viewer-nominate` does — confirm this asymmetry is intentional before touching either.

## Open design questions (resolve before building)

1. **Library vs. custom wordlist.** No profanity-filter utility exists anywhere in this codebase today — this is a net-new dependency (or a hand-rolled wordlist) either way.
2. **Behavior on match:**
   - Hard block at submission (reject with an inline error, matching how tournament name validation already works), or
   - Flag for moderation queue review, consistent with the platform's existing reactive-first pattern, or
   - Auto-mask (e.g. asterisk out) and let it through.
3. **Match strictness** — exact wordlist match only, or fuzzy/leetspeak evasion detection (e.g. "sh1t").
4. **Per-field tolerance.** A DM between two consenting adults may reasonably allow language a public, platform-wide tournament name shouldn't. One shared utility, but possibly parameterized strictness per call site.
5. **False positives.** Need an appeal/override path, or at minimum a way to whitelist legitimate words caught by accident.
6. **Where it lives.** Recommend one shared utility (e.g. `utils/contentFilter.js`) exposing something like `containsProhibitedContent(text)`, called from each of the touchpoints above — mirroring how `utils/contestEligibility.js` already centralizes a similar cross-cutting rule rather than duplicating logic per route.

## Recommended approach (once prioritized)
Build the single shared utility first, wire it into the highest-visibility/highest-risk fields first (tournament name/description, entry title/caption, display name/bio — all public-facing), then extend to DMs/comments/support chat. Decide the match-strictness and block-vs-flag questions above before writing any code, since they change the utility's shape.
