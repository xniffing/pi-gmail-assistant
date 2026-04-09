# Gmail Pi extension

A Pi extension for Gmail OAuth setup plus safe Gmail workflows for listing inbox mail, searching Gmail, reading a selected message, inspecting a message's attachments, downloading a selected attachment to disk, and sending outbound email with plain-text or HTML bodies plus optional file attachments with explicit user confirmation.

## Install as a Pi package

After publishing to npm, add it to Pi through `settings.json`:

```json
{
  "packages": [
    "npm:@xniffing/pi-gmail-assistant@0.1.2"
  ]
}
```

Then reload Pi:

```text
/reload
```

You can also test the package locally before publishing:

```bash
cd ~/Projects/pi-gmail-assistant
npm install
npm test
npm run build
npm pack --dry-run
```

## What this extension does

- registers a `/gmail-auth` command for first-time setup
- generates a Google OAuth consent URL for Gmail scopes
- exchanges an authorization code for Google tokens
- stores OAuth credentials and tokens outside git-tracked files
- lets Pi list recent inbox mail with compact previews
- lets Pi search Gmail with normal Gmail query syntax
- lets Pi read one message by id without dumping raw Gmail API payloads
- lets Pi list a message's attachments with concise metadata instead of raw MIME structure
- lets Pi download a selected attachment into a safe project-local path by default
- lets Pi send Gmail messages with plain-text or HTML bodies and optional file attachments only after the operator explicitly confirms the recipient, subject, body preview, and attachments
- avoids printing client secrets or refresh tokens into normal chat output

## Required Google Cloud setup

1. Create or select a Google Cloud project.
2. Enable the **Gmail API** for that project.
3. Create an **OAuth client ID** in **APIs & Services → Credentials**.
4. Add at least one redirect URI. The simplest option is a loopback URI such as `http://127.0.0.1`.
5. Download the OAuth client JSON.

## Required Gmail scopes

The extension currently requests:

- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/gmail.send`

Minimum scope for outbound send is `gmail.send`. The extension also keeps `gmail.modify` because the inbox-reading workflows from AU-002 already rely on broader mailbox access.

HTML email and file attachments are sent through the same Gmail send scope; no additional Gmail OAuth scope is required.

If you added credentials before send support existed, rerun `/gmail-auth exchange` so the stored local tokens include the Gmail send scope.

## Local credential and token storage

Secrets are stored outside the repository under your home directory:

- shared OAuth client credentials: `~/.config/automation/gmail/google-oauth-client.json`
- active account marker: `~/.config/automation/gmail/active-account.json`
- per-account tokens: `~/.config/automation/gmail/accounts/<email-slug>/gmail-tokens.json`

Tokens are now scoped to the connected Gmail account instead of the current project path. That means changing projects, folders, or worktrees should no longer make the extension look unauthenticated once an account has been connected.

Files are written with private permissions where possible. Do **not** paste OAuth client JSON or token JSON into repository files.

## Auth prerequisite

Before Pi can read or send Gmail, complete the local auth flow introduced in AU-001:

```text
/reload
/gmail-auth init
/gmail-auth start
/gmail-auth exchange
/gmail-auth status
```

If tokens are missing, expired, revoked, or missing the send scope, Gmail tools will tell you to rerun `/gmail-auth exchange`.

If you previously authenticated with an older project-scoped version of the extension, rerun `/gmail-auth exchange` once so the active account can be detected and saved into the new account-scoped token layout.

## Inbox workflows

### 1. List recent inbox messages

Ask Pi to use `gmail_list_inbox_messages` when you want recent inbox items.

Example prompts:

```text
List my latest Gmail inbox messages.
Show the 5 newest inbox emails.
List inbox mail from the last week about invoices.
```

The tool combines `in:inbox` with an optional extra Gmail query, then returns compact previews with:

- Gmail message id
- sender
- subject
- date
- short snippet

### 2. Search Gmail

Ask Pi to use `gmail_search_messages` when you want Gmail query syntax.

Example prompts:

```text
Search Gmail for from:bob newer_than:7d
Find unread Gmail messages with has:attachment label:important
Search for receipts from March in Gmail
```

The tool accepts standard Gmail query fragments such as `from:`, `subject:`, `has:attachment`, `label:`, `is:unread`, and date filters.

### 3. Read one message

After listing or searching, ask Pi to read a specific Gmail message id with `gmail_read_message`.

Example prompts:

```text
Read Gmail message id 18c123abc456def
Open the message with id 18c123abc456def
Show me the body of the email about quarterly planning
```

The read tool returns normalized fields instead of the raw Gmail API response:

- subject
- message id
- from / to / cc
- date
- labels
- snippet
- extracted body text

## Attachment workflows

### 1. Check what is attached to a message

After listing, searching, or reading a message, ask Pi to use `gmail_list_message_attachments` with the Gmail message id.

Example prompts:

```text
Show me the attachments for Gmail message id 18c123abc456def
What files are attached to that finance email?
List the attachments on the message I just opened before downloading anything
```

The attachment list stays concise and returns one entry per attachment with:

- attachment id
- filename
- mime type
- size
- whether Gmail marked it as inline or downloadable

Recommended workflow:

1. Use `gmail_list_inbox_messages`, `gmail_search_messages`, or `gmail_read_message` to identify the message.
2. Use `gmail_list_message_attachments` to confirm the available attachment ids and filenames.
3. Download only the exact attachment id you want.

### 2. Download one attachment safely

Use `gmail_download_attachment` with a Gmail `messageId` plus the returned `attachmentId`.

Example prompts:

```text
Download attachment att_123 from Gmail message 18c123abc456def
Save the PDF attachment from that finance email
Download attachment att_123 to downloads/april-report.pdf
```

When the download succeeds, Pi returns:

- saved path
- filename
- mime type
- byte size
- inline status
- whether an existing file was overwritten

### Default download directory

If you omit `savePath`, the extension writes the file under a project-local directory:

- default directory: `<current-project>/.gmail-attachments/`

This keeps attachment downloads inside the active project checkout instead of writing into arbitrary filesystem locations by default.

### Save path and overwrite behavior

Version 1 keeps writes intentionally narrow:

- `savePath` is optional
- when provided, it must be a relative path that stays inside the current project
- paths that escape the project, such as `../outside/file.pdf`, are rejected
- directory-only paths are rejected; include the destination filename
- existing files are **not** overwritten unless `overwrite: true` is passed explicitly

### Current attachment limitations

Attachment support is intentionally scoped for safe v1 behavior:

- no inline preview rendering
- no PDF text extraction
- no OCR or image analysis during download
- no automatic attachment selection; Pi should list attachments first
- downloads are single-attachment operations by `messageId` plus `attachmentId`
- Gmail body reads still focus on readable message text, not raw MIME dumps

## Outbound send workflow

### Tool name and schema

Pi sends outbound mail through `gmail_send_email`.

Required fields:

- `to` — one email address, a comma-separated string, or an array of email addresses
- `subject` — a single-line subject
- one of `body`, `htmlBody`, or both

Optional fields:

- `cc` — one or more CC recipients
- `bcc` — one or more BCC recipients
- `replyTo` — a single reply-to address
- `attachments` — local file attachments with `path`, plus optional `filename` and `contentType`

Example structured tool shape:

```json
{
  "to": ["alex@example.com"],
  "cc": ["manager@example.com"],
  "subject": "Weekly update",
  "body": "Finished the release checklist and sent the build to QA.",
  "htmlBody": "<p>Finished the <strong>release checklist</strong> and sent the build to QA.</p>",
  "attachments": [
    { "path": "docs/release-notes.md", "filename": "release-notes.md" }
  ],
  "replyTo": "me@example.com"
}
```

### Confirmation behavior

`gmail_send_email` does **not** call the Gmail API immediately. It first opens an explicit confirmation dialog that shows:

- primary recipients (`To`)
- optional `Cc`, `Bcc`, and `Reply-To`
- subject
- whether the email is plain-text or HTML
- concise body preview
- attachment names and sizes

The operator must approve that dialog before the Gmail API call is made. If the operator cancels, the tool returns a cancellation result and nothing is sent.

### Current send limitations

Version 1 still keeps outbound mail relatively narrow and safe:

- supports plain-text and HTML bodies
- supports local file attachments
- no explicit thread/reply support
- no background or bootstrap sends outside the tool flow
- interactive confirmation required before every send
- attachment content must come from local files, not remote URLs

### Safe usage examples

Use direct prompts when you want Pi to send a message:

```text
Send an email to alex@example.com with subject "Weekly update" and body "Finished the release checklist and sent the build to QA."
Send a plain-text Gmail email to finance@example.com and cc manager@example.com about the April invoice.
Draft the email content first, then send it only after I confirm the final wording.
```

Recommended operator workflow:

1. Ask Pi to draft or refine the email text in chat.
2. Ask Pi to call `gmail_send_email` with the final recipients and subject.
3. Review the confirmation dialog carefully.
4. Approve only if the recipient list, subject, and preview all match your intent.

## Normalization and truncation behavior

The extension intentionally keeps output concise for conversation use:

- list and search results show compact summaries, not full API payloads
- snippets are normalized to single readable preview lines
- message bodies prefer `text/plain` parts when available
- HTML-only bodies are stripped to readable text when possible
- if no body text can be extracted, the snippet is used as a fallback
- long message bodies are truncated to a preview instead of dumping the full raw content
- send confirmation uses a concise body preview instead of the entire draft
- truncated body output is labeled with the displayed and original character counts

## Example end-to-end workflow

```text
/reload
/gmail-auth status
List my 5 newest inbox emails.
Read Gmail message id 18c123abc456def
Search Gmail for from:finance newer_than:30d
Draft a reply for Alex about tomorrow's meeting.
Send an email to alex@example.com with subject "Tomorrow's meeting" and body "Looking forward to it. Agenda attached separately."
```

## Publishing checklist

Before `npm publish`, make sure you have:

- reviewed `package.json` name/version/license fields
- confirmed no credentials or token files are inside the package directory
- run `npm test`
- run `npm run build`
- run `npm pack --dry-run`
- logged into npm with `npm login`

Publish with:

```bash
cd ~/Projects/pi-gmail-assistant
npm publish --access public
```

## Security expectations

- Never commit Google OAuth client JSON or Gmail token files.
- Never paste refresh tokens into normal chat messages.
- Keep credentials in the external config path shown by `/gmail-auth status`.
- Review every send confirmation dialog before approving it.
- If you rotate or revoke credentials in Google Cloud, rerun `/gmail-auth init` and `/gmail-auth exchange`.

## Current capabilities

This extension now covers:

- OAuth setup and token storage
- inbox listing
- Gmail search
- normalized message reads
- attachment listing
- safe attachment downloads into project-local paths
- safe plain-text outbound email sending with explicit confirmation
