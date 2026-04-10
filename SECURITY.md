# Security notes

## Credential storage decision

This extension currently stores Google OAuth client credentials and Gmail token sets as private JSON files under the local user profile:

- `~/.config/automation/gmail/google-oauth-client.json`
- `~/.config/automation/gmail/active-account.json`
- `~/.config/automation/gmail/accounts/<email-slug>/gmail-tokens.json`

Files are written with restrictive permissions where possible:
- directories: `0700`
- files: `0600`

### Current decision

**OS keychain-backed storage is deferred for now.**

Rationale:
- the extension is intended to stay lightweight and dependency-minimal
- secure keychain integration differs significantly across Linux, macOS, and Windows
- the current file-permission model is acceptable for a local developer tool when combined with strong host-user security
- adding a storage abstraction remains a valid future enhancement, but is not required to safely ship the current feature set

### Current risk

Refresh tokens are still sensitive secrets. If the local user account is compromised, an attacker may be able to read the stored Gmail token file and reuse the refresh token to obtain new Gmail access tokens.

### Recommended operator practices

- do not share the OS account used to run Pi
- use full-disk encryption and a locked screen on the host machine
- keep the home directory backed by normal OS permissions
- never paste token JSON or OAuth client JSON into repository files or chat
- revoke and reissue credentials immediately if the machine or user account may have been exposed

## Rotation and revocation

If you need to rotate or revoke Gmail access:

1. Revoke the existing app/session in your Google account security settings or rotate the OAuth client in Google Cloud.
2. Delete the local Gmail auth files:
   - `~/.config/automation/gmail/active-account.json`
   - `~/.config/automation/gmail/accounts/<email-slug>/gmail-tokens.json`
   - optionally `~/.config/automation/gmail/google-oauth-client.json` if the client credentials were rotated
3. Run the auth flow again:
   - `/gmail-auth init`
   - `/gmail-auth start`
   - `/gmail-auth exchange`
   - `/gmail-auth status`

## Future hardening direction

A future version may add a pluggable secret-storage backend so supported platforms can prefer Secret Service, Keychain, or Credential Manager while retaining the current file-based fallback.
