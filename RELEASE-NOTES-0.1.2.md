# Release Notes — 0.1.2

## Summary
Version 0.1.2 adds HTML email sending and local file attachments to `gmail_send_email`.

## New capabilities
- send plain-text emails
- send HTML emails with `htmlBody`
- send multipart emails with both `body` and `htmlBody`
- attach local files with `attachments`
- review format and attachments in the confirmation dialog before sending

## API changes
`gmail_send_email` now accepts:
- `body` — optional plain-text body
- `htmlBody` — optional HTML body
- `attachments` — optional array of local file attachments

At least one of `body` or `htmlBody` must be provided.

## Notes
- attachments must come from local file paths
- no remote URL fetch for attachments
- no thread/reply support yet
- interactive confirmation is still required before every send

## Validation
This release was validated with:
- `npm test`
- `npm run build`
