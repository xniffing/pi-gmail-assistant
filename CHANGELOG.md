# Changelog

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
