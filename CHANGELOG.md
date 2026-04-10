# Changelog

## 0.1.4 - 2026-04-10

### Added
- OAuth hardening with `state` validation and PKCE (`S256`) for the Gmail auth flow
- pending OAuth bootstrap-state persistence so `/gmail-auth exchange` can validate the redirect response
- outbound-attachment safety checks that block sensitive local paths such as `~/.ssh` and the Gmail token store
- `SECURITY.md` with token-storage rationale plus credential rotation/revocation guidance
- regression tests for OAuth `state`/PKCE and safe attachment restrictions

### Changed
- `/gmail-auth exchange` now expects the full Google redirect URL so Pi can verify `state`
- Gmail send attachments are now limited to project-local files, and send confirmation shows absolute attachment paths
- Gmail read access now uses `gmail.readonly` instead of `gmail.modify`
- README installation example updated to `@xniffing/pi-gmail-assistant@0.1.4`

### Upgrade notes
- Rerun `/gmail-auth start` and `/gmail-auth exchange` after upgrading so stored tokens reflect the hardened OAuth flow and reduced scope set.
- If you previously attached files from outside the current project, move them into the project first or the send flow will reject them.

## 0.1.3 - 2026-04-09

### Added
- automatic Gmail access-token refresh using stored refresh tokens
- test coverage for successful token refresh before Gmail API requests
- README guidance for long-lived local OAuth setup and Production consent-screen usage

### Changed
- Gmail read, list, search, send-adjacent auth paths, and attachment downloads now reuse refreshed tokens automatically
- Gmail auth errors now only require `/gmail-auth exchange` when tokens are missing, revoked, unrefreshable, or missing required scope

## 0.1.2 - 2026-04-09

### Added
- HTML email sending through `gmail_send_email` via `htmlBody`
- optional local file attachments through `gmail_send_email.attachments`
- multipart MIME generation for HTML + attachment emails
- send confirmation now includes email format and attachment list
- test coverage for HTML email and attachment sending

### Changed
- `gmail_send_email` now accepts `body`, `htmlBody`, or both
- outbound send helper now supports generic Gmail MIME messages, not just plain-text payloads
- README updated to document HTML and attachment workflows

## 0.1.1 - 2026-04-09

### Added
- account-scoped Gmail token storage keyed by connected Gmail address
- active account tracking in `~/.config/automation/gmail/active-account.json`
- Gmail profile lookup after OAuth exchange to detect the connected account
- `/gmail-auth status` output for the active Gmail account
- backward-compatible fallback reads for older project-scoped credentials and tokens
- release notes for the account-scoped auth migration

### Changed
- shared OAuth client credentials now live at `~/.config/automation/gmail/google-oauth-client.json`
- per-account Gmail tokens now live at `~/.config/automation/gmail/accounts/<email-slug>/gmail-tokens.json`
- test suite now runs serially because token storage uses a shared home-directory path in tests
- README installation example updated to `@xniffing/pi-gmail-assistant@0.1.1`

### Migration note
- If you authenticated with an older project-scoped version, run `/gmail-auth exchange` once after upgrading so the extension can detect the Gmail account and save tokens into the new account-scoped layout.
