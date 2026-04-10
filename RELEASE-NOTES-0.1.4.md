# Release Notes — 0.1.4

## Summary
Version 0.1.4 focuses on security hardening for Gmail authentication, outbound attachments, OAuth scopes, and operator guidance.

## Added
- OAuth `state` validation for the Gmail local auth flow
- PKCE with `code_challenge_method=S256` during Google OAuth authorization
- persisted pending bootstrap state so `/gmail-auth exchange` can validate the redirect response
- outbound attachment safety checks that block sensitive local paths such as `~/.ssh` and the Gmail token store
- `SECURITY.md` with token-storage rationale and rotation/revocation guidance
- regression tests for OAuth hardening and safe attachment restrictions

## Changed
- `/gmail-auth exchange` now expects the full Google redirect URL, not just the raw code
- Gmail send attachments are restricted to project-local files
- send confirmation now includes absolute attachment paths
- Gmail read permissions now use `gmail.readonly` instead of `gmail.modify`

## Upgrade notes
- Rerun `/gmail-auth start` and `/gmail-auth exchange` after upgrading so stored tokens use the hardened OAuth flow and reduced scope set.
- If you previously attached files from outside the current project, move those files into the project before sending.
- Review `SECURITY.md` for current token-storage behavior and local credential rotation steps.

## Included pull requests
- #6 harden Gmail OAuth with state and PKCE
- #7 restrict Gmail send attachments to safe paths
- #8 reduce Gmail OAuth scopes to least privilege
- #9 record token storage security decision
