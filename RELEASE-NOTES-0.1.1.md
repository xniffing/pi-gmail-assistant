# Release Notes — 0.1.1

## Summary
Version 0.1.1 changes Gmail authentication storage from project-path-scoped tokens to account-scoped tokens.

## Why this release matters
Previously, Gmail auth could appear to be lost when Pi was opened from a different project folder, repo path, or worktree. That happened because tokens were stored under a path derived from the current project root.

This release fixes that by storing tokens by Gmail account instead of by project path.

## New auth storage layout
- shared OAuth client: `~/.config/automation/gmail/google-oauth-client.json`
- active account marker: `~/.config/automation/gmail/active-account.json`
- per-account tokens: `~/.config/automation/gmail/accounts/<email-slug>/gmail-tokens.json`

## Behavior changes
- changing project folder should no longer make Gmail look disconnected
- `/gmail-auth exchange` now detects the connected Gmail account automatically
- `/gmail-auth status` shows the active account email
- older project-scoped auth files are still checked as a fallback

## Upgrade step
After upgrading, run:

```text
/reload
/gmail-auth exchange
/gmail-auth status
```

This refreshes the stored tokens and records the active Gmail account in the new layout.

## Validation
This release was validated with:
- `npm test`
- `npm run build`
- `npm pack --dry-run`
