# Release Notes — 0.1.3

## Summary
Version 0.1.3 makes Gmail OAuth more durable by automatically refreshing expired access tokens when a stored refresh token is available.

## Added
- automatic access-token refresh using the saved Google refresh token
- token persistence after refresh so later Gmail requests reuse the new access token
- regression test coverage for the refresh flow
- README documentation for long-lived local Gmail OAuth setup

## Changed
- Gmail inbox, read, search, send-adjacent auth paths, and attachment downloads now attempt refresh automatically
- users are prompted to rerun `/gmail-auth exchange` only when the extension cannot refresh tokens locally

## Upgrade notes
- If your existing token set already includes a valid refresh token, no manual change should be required.
- If your older token set was issued without a refresh token, rerun `/gmail-auth exchange` once after upgrading.
- In Google Cloud, prefer an OAuth consent screen in **Production** for a more stable long-lived setup.
