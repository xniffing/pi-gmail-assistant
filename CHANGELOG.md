# Changelog

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
