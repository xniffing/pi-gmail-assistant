import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { getDefaultAttachmentDownloadDir, saveAttachmentContent } from "./attachment-client.ts";
import { getMessageAttachmentContent, getMessageDetail, listInboxMessages, listMessageAttachmentsForMessage, searchMessages } from "./gmail-client.ts";
import { buildGoogleConsentUrl, exchangeAuthorizationCode, fetchConnectedGmailAccountEmail } from "./oauth.ts";
import { prepareMessage, sendMessage } from "./send-mail.ts";
import { getGmailAuthStatus, getDefaultTokenStorePaths, loadOAuthClientCredentials, saveOAuthClientCredentials, saveOAuthTokensForAccount } from "./token-store.ts";
import type {
	GmailMessageAttachment,
	GmailMessageDetail,
	GmailMessageSummary,
	GmailPreparedSendMessage,
	GmailSavedAttachment,
	GmailSendMessageResult,
} from "./types.ts";

const EXTENSION_STATUS_KEY = "gmail-ext";
const GMAIL_AUTH_COMMAND = "gmail-auth";
const TOOL_MAX_RESULTS_LIMIT = 25;

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getHelpText(paths = getDefaultTokenStorePaths()): string {
	return [
		"Gmail auth commands:",
		`- /${GMAIL_AUTH_COMMAND} init     Paste Google OAuth client JSON and store it outside the repo`,
		`- /${GMAIL_AUTH_COMMAND} start    Generate a Gmail consent URL and optionally exchange the returned code`,
		`- /${GMAIL_AUTH_COMMAND} exchange Paste an authorization code or full redirect URL and store tokens locally`,
		`- /${GMAIL_AUTH_COMMAND} status   Show whether local credentials and tokens are configured`,
		"",
		"Available Gmail tools after auth:",
		"- gmail_list_inbox_messages   List recent inbox items with compact previews",
		"- gmail_read_message          Read one message by Gmail message id",
		"- gmail_search_messages       Search Gmail with standard Gmail query syntax",
		"- gmail_list_message_attachments List attachment metadata for a specific Gmail message",
		"- gmail_download_attachment   Save one Gmail attachment into a safe project-local path",
		"- gmail_send_email            Send a plain-text Gmail message after explicit confirmation",
		"",
		`Local credential path: ${paths.credentialsPath}`,
		`Local token path: ${paths.tokenPath}`,
	].join("\n");
}

function formatSummary(summary: GmailMessageSummary, index: number): string {
	return [
		`${index + 1}. ${summary.subject}`,
		`   id: ${summary.id}`,
		`   from: ${summary.from}`,
		`   date: ${summary.date}`,
		`   snippet: ${summary.snippet}`,
	].join("\n");
}

function formatSummaryList(title: string, messages: GmailMessageSummary[]): string {
	if (messages.length === 0) {
		return `${title}\nNo messages found.`;
	}

	return [title, ...messages.map((message, index) => formatSummary(message, index))].join("\n\n");
}

function formatMessageDetail(detail: GmailMessageDetail): string {
	const lines = [
		`Message: ${detail.subject}`,
		`id: ${detail.id}`,
		`from: ${detail.from}`,
		detail.to ? `to: ${detail.to}` : undefined,
		detail.cc ? `cc: ${detail.cc}` : undefined,
		`date: ${detail.date}`,
		detail.labelIds.length > 0 ? `labels: ${detail.labelIds.join(", ")}` : undefined,
		`snippet: ${detail.snippet}`,
		"",
		"body:",
		detail.body.text,
		detail.body.isTruncated ? "" : undefined,
		detail.body.isTruncated ? `[body truncated to ${detail.body.text.length} of ${detail.body.fullLength} characters]` : undefined,
	].filter((line): line is string => line !== undefined);

	return lines.join("\n");
}

function formatRecipientLine(label: string, recipients: string[]): string | undefined {
	return recipients.length > 0 ? `${label}: ${recipients.join(", ")}` : undefined;
}

function formatSendConfirmation(prepared: GmailPreparedSendMessage): string {
	return [
		"Pi is about to send a Gmail message from your connected account.",
		"Review the details carefully before approving:",
		"",
		formatRecipientLine("To", prepared.to),
		formatRecipientLine("Cc", prepared.cc),
		formatRecipientLine("Bcc", prepared.bcc),
		prepared.replyTo ? `Reply-To: ${prepared.replyTo}` : undefined,
		`Subject: ${prepared.subject}`,
		prepared.htmlBody ? "Format: HTML email" : "Format: plain text email",
		`Preview: ${prepared.bodyPreview}`,
		prepared.attachments.length > 0 ? `Attachments: ${prepared.attachments.map((attachment) => `${attachment.filename} (${formatBytes(attachment.size)})`).join(", ")}` : "Attachments: none",
		"",
		"This tool sends immediately after confirmation. Cancel if anything looks wrong.",
	].filter((line): line is string => line !== undefined).join("\n");
}

function formatSendResult(result: GmailSendMessageResult): string {
	return [
		`Sent Gmail message: ${result.subject}`,
		`id: ${result.id}`,
		formatRecipientLine("to", result.to),
		formatRecipientLine("cc", result.cc),
		formatRecipientLine("bcc", result.bcc),
		result.replyTo ? `reply-to: ${result.replyTo}` : undefined,
		`format: ${result.hasHtmlBody ? "html" : "plain-text"}`,
		`attachments: ${result.attachments.length}`,
		`preview: ${result.bodyPreview}`,
	].filter((line): line is string => line !== undefined).join("\n");
}

function formatAttachmentLine(attachment: GmailMessageAttachment, index: number): string {
	return [
		`${index + 1}. ${attachment.filename}`,
		`   attachmentId: ${attachment.attachmentId}`,
		`   type: ${attachment.mimeType}`,
		`   size: ${formatBytes(attachment.size)}`,
		`   disposition: ${attachment.isInline ? "inline" : "downloadable"}`,
	].join("\n");
}

function formatAttachmentList(messageId: string, attachments: GmailMessageAttachment[]): string {
	if (attachments.length === 0) {
		return [`Attachments for message ${messageId}`, "No attachments found."].join("\n");
	}

	return [
		`Attachments for message ${messageId}`,
		...attachments.map((attachment, index) => formatAttachmentLine(attachment, index)),
	].join("\n\n");
}

function formatAttachmentDownloadResult(result: GmailSavedAttachment): string {
	return [
		`Saved Gmail attachment: ${result.filename}`,
		`attachmentId: ${result.attachmentId}`,
		`mimeType: ${result.mimeType}`,
		`size: ${formatBytes(result.size)}`,
		`inline: ${result.isInline ? "yes" : "no"}`,
		`path: ${result.savedPath}`,
		`overwritten: ${result.overwritten ? "yes" : "no"}`,
	].join("\n");
}

async function handleInit(ctx: ExtensionCommandContext): Promise<void> {
	const paths = getDefaultTokenStorePaths();
	const rawJson = await ctx.ui.editor(
		"Paste Google OAuth client JSON",
		'{\n  "installed": {\n    "client_id": "",\n    "client_secret": "",\n    "redirect_uris": ["http://127.0.0.1"]\n  }\n}',
	);

	if (rawJson === undefined) {
		ctx.ui.notify("Gmail OAuth credential import cancelled.", "info");
		return;
	}

	await saveOAuthClientCredentials(rawJson, paths);
	ctx.ui.notify(`Saved Gmail OAuth credentials to ${paths.credentialsPath}`, "success");
}

async function runStartFlow(ctx: ExtensionCommandContext): Promise<void> {
	const paths = getDefaultTokenStorePaths();
	const credentials = await loadOAuthClientCredentials(paths);
	const bootstrap = buildGoogleConsentUrl(credentials);

	await ctx.ui.editor(
		"Open this Gmail consent URL in your browser, then copy back the code or redirect URL",
		[
			`Consent URL: ${bootstrap.consentUrl}`,
			"",
			`Redirect URI configured in Google Cloud: ${bootstrap.redirectUri}`,
			"After approval, copy either the authorization code or the full redirect URL and use /gmail-auth exchange.",
		].join("\n"),
	);

	const authorizationInput = await ctx.ui.input(
		"Paste the Gmail authorization code or full redirect URL",
		"code=... or https://127.0.0.1/?code=...",
	);

	if (!authorizationInput?.trim()) {
		ctx.ui.notify("Consent URL generated. Run /gmail-auth exchange when you have the code.", "info");
		return;
	}

	const tokens = await exchangeAuthorizationCode(credentials, authorizationInput);
	const accountEmail = await fetchConnectedGmailAccountEmail(tokens.accessToken);
	const savedPaths = await saveOAuthTokensForAccount(accountEmail, tokens);
	ctx.ui.notify(`Gmail OAuth tokens saved locally for ${accountEmail} at ${savedPaths.tokenPath}`, "success");
}

async function handleExchange(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const paths = getDefaultTokenStorePaths();
	const credentials = await loadOAuthClientCredentials(paths);
	const initialCode = args.trim();
	const authorizationInput = initialCode || (await ctx.ui.input(
		"Paste the Gmail authorization code or full redirect URL",
		"code=... or https://127.0.0.1/?code=...",
	));

	if (!authorizationInput?.trim()) {
		ctx.ui.notify("Gmail OAuth token exchange cancelled.", "info");
		return;
	}

	const tokens = await exchangeAuthorizationCode(credentials, authorizationInput);
	const accountEmail = await fetchConnectedGmailAccountEmail(tokens.accessToken);
	const savedPaths = await saveOAuthTokensForAccount(accountEmail, tokens);
	ctx.ui.notify(`Gmail OAuth tokens saved locally for ${accountEmail} at ${savedPaths.tokenPath}`, "success");
}

async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
	const status = await getGmailAuthStatus(getDefaultTokenStorePaths());
	await ctx.ui.editor(
		"Gmail OAuth status",
		[
			`Credentials stored: ${status.hasCredentials ? "yes" : "no"}`,
			`Tokens stored: ${status.hasTokens ? "yes" : "no"}`,
			status.activeAccountEmail ? `Active account: ${status.activeAccountEmail}` : "Active account: not set",
			`Credential file: ${status.paths.credentialsPath}`,
			`Token file: ${status.paths.tokenPath}`,
			status.tokenExpiryIso ? `Access token expiry: ${status.tokenExpiryIso}` : "Access token expiry: not available",
		].join("\n"),
	);
}

export default function gmailExtension(pi: ExtensionAPI) {
	pi.registerCommand(GMAIL_AUTH_COMMAND, {
		description: "Manage local Gmail OAuth setup without printing secrets to chat",
		handler: async (args, ctx) => {
			try {
				const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
				const payload = rest.join(" ");

				switch (subcommand ?? "help") {
					case "help":
						await ctx.ui.editor("Gmail auth help", getHelpText());
						return;
					case "init":
						await handleInit(ctx);
						return;
					case "start":
						await runStartFlow(ctx);
						return;
					case "exchange":
						await handleExchange(payload, ctx);
						return;
					case "status":
						await handleStatus(ctx);
						return;
					default:
						ctx.ui.notify(`Unknown /${GMAIL_AUTH_COMMAND} subcommand: ${subcommand}`, "warning");
						await ctx.ui.editor("Gmail auth help", getHelpText());
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Gmail OAuth setup failed.", "error");
			}
		},
	});

	pi.registerTool({
		name: "gmail_list_inbox_messages",
		label: "Gmail Inbox",
		description: "List recent inbox emails with compact previews and message ids.",
		promptSnippet: "List recent Gmail inbox emails and return compact previews with ids.",
		promptGuidelines: ["Use gmail_list_inbox_messages before gmail_read_message when the user has not provided a message id."],
		parameters: {
			type: "object",
			properties: {
				maxResults: { type: "integer", minimum: 1, maximum: TOOL_MAX_RESULTS_LIMIT, description: "How many inbox messages to list (1-25)." },
				query: { type: "string", description: "Optional extra Gmail query filter to combine with in:inbox." },
			},
			additionalProperties: false,
		},
		async execute(_toolCallId, params) {
			const messages = await listInboxMessages(params);
			return {
				content: [{ type: "text", text: formatSummaryList("Recent inbox messages", messages) }],
				details: { messages },
			};
		},
	});

	pi.registerTool({
		name: "gmail_read_message",
		label: "Read Gmail",
		description: "Read one Gmail message by id and return normalized sender, subject, snippet, and body text.",
		promptSnippet: "Read a Gmail message by id and return a normalized summary plus body preview.",
		promptGuidelines: ["Use gmail_read_message only after you have a Gmail message id from list/search results or the user provides one."],
		parameters: {
			type: "object",
			properties: {
				messageId: { type: "string", description: "The Gmail message id to read." },
			},
			required: ["messageId"],
			additionalProperties: false,
		},
		async execute(_toolCallId, params) {
			const message = await getMessageDetail(params.messageId);
			return {
				content: [{ type: "text", text: formatMessageDetail(message) }],
				details: { message },
			};
		},
	});

	pi.registerTool({
		name: "gmail_search_messages",
		label: "Search Gmail",
		description: "Search Gmail using standard Gmail query syntax and return compact message previews.",
		promptSnippet: "Search Gmail with Gmail query syntax like from:, subject:, has:attachment, newer_than:.",
		promptGuidelines: ["Use gmail_search_messages when the user asks for Gmail search or provides Gmail-style filters."],
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "A Gmail search query such as from:bob newer_than:7d." },
				maxResults: { type: "integer", minimum: 1, maximum: TOOL_MAX_RESULTS_LIMIT, description: "How many matching messages to return (1-25)." },
			},
			required: ["query"],
			additionalProperties: false,
		},
		async execute(_toolCallId, params) {
			const messages = await searchMessages(params);
			return {
				content: [{ type: "text", text: formatSummaryList(`Search results for: ${params.query}`, messages) }],
				details: { messages, query: params.query },
			};
		},
	});

	pi.registerTool({
		name: "gmail_list_message_attachments",
		label: "Gmail Attachments",
		description: "List attachment metadata for one Gmail message without exposing raw Gmail MIME payloads.",
		promptSnippet: "List concise attachment metadata for a Gmail message by id before downloading anything.",
		promptGuidelines: [
			"Use gmail_list_message_attachments after gmail_read_message, gmail_list_inbox_messages, or gmail_search_messages when the user asks what is attached.",
			"Prefer listing attachments before gmail_download_attachment so the operator can confirm the correct attachment id.",
		],
		parameters: {
			type: "object",
			properties: {
				messageId: { type: "string", description: "The Gmail message id whose attachments you want to inspect." },
			},
			required: ["messageId"],
			additionalProperties: false,
		},
		async execute(_toolCallId, params) {
			const attachments = await listMessageAttachmentsForMessage(params.messageId);
			return {
				content: [{ type: "text", text: formatAttachmentList(params.messageId, attachments) }],
				details: { messageId: params.messageId, attachments },
			};
		},
	});

	pi.registerTool({
		name: "gmail_download_attachment",
		label: "Download Gmail Attachment",
		description: "Download one Gmail attachment into a safe project-local path, using .gmail-attachments by default.",
		promptSnippet: "Download a Gmail attachment by message id and attachment id into a safe local path.",
		promptGuidelines: [
			"Use gmail_download_attachment only after the operator has identified the right attachment id, ideally via gmail_list_message_attachments.",
			"Omit savePath unless the operator clearly wants a specific file path under the current project.",
		],
		parameters: {
			type: "object",
			properties: {
				messageId: { type: "string", description: "The Gmail message id that owns the attachment." },
				attachmentId: { type: "string", description: "The Gmail attachment id to download." },
				savePath: { type: "string", description: "Optional relative file path inside the current project. Omit to save into the default .gmail-attachments directory." },
				overwrite: { type: "boolean", description: "Set true to overwrite an existing file at savePath. Defaults to false for safety." },
			},
			required: ["messageId", "attachmentId"],
			additionalProperties: false,
		},
		async execute(_toolCallId, params) {
			const attachments = await listMessageAttachmentsForMessage(params.messageId);
			const requestedAttachmentId = params.attachmentId.trim();
			const attachment = attachments.find((entry) =>
				entry.attachmentId === requestedAttachmentId || entry.apiAttachmentId === requestedAttachmentId,
			);
			if (!attachment) {
				const availableIds = attachments.map((entry) => entry.attachmentId).join(", ");
				throw new Error(
					availableIds
						? `Attachment id not found on that message. Run gmail_list_message_attachments first and use one of these stable ids: ${availableIds}`
						: "Attachment id not found on that message. Run gmail_list_message_attachments first and pick one of the returned attachment ids.",
				);
			}

			try {
				const result = await saveAttachmentContent({
					messageId: params.messageId,
					attachment,
					savePath: params.savePath,
					overwrite: params.overwrite,
				});
				return {
					content: [{ type: "text", text: formatAttachmentDownloadResult(result) }],
					details: { attachment: result, defaultDownloadDir: getDefaultAttachmentDownloadDir() },
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
					throw new Error("That attachment file already exists. Choose a different savePath or rerun with overwrite: true if replacing it is intentional.");
				}
				throw error;
			}
		},
	});

	pi.registerTool({
		name: "gmail_send_email",
		label: "Send Gmail",
		description: "Send a Gmail message with plain text or HTML body, with optional file attachments, only after the operator explicitly confirms the recipient, subject, preview, and attachments.",
		promptSnippet: "Send a Gmail email with plain text or HTML content, optionally with attachments, only after collecting explicit confirmation from the operator.",
		promptGuidelines: [
			"Use gmail_send_email only when the user clearly wants to send an email, not merely draft or summarize one.",
			"Always rely on the built-in confirmation step before sending. If the user sounds unsure, ask clarifying questions first.",
		],
		parameters: {
			type: "object",
			properties: {
				to: {
					oneOf: [
						{ type: "string", description: "Primary recipient email address, or a comma-separated list of email addresses." },
						{ type: "array", items: { type: "string" }, minItems: 1, description: "Primary recipient email addresses." },
					],
					description: "Primary recipient email address or addresses.",
				},
				subject: { type: "string", description: "Subject line for the outgoing email." },
				body: { type: "string", description: "Optional plain-text body. Provide this, htmlBody, or both." },
				htmlBody: { type: "string", description: "Optional HTML body. Use email-compatible HTML." },
				cc: {
					oneOf: [
						{ type: "string", description: "Optional CC recipient or comma-separated recipient list." },
						{ type: "array", items: { type: "string" }, minItems: 1, description: "Optional CC recipients." },
					],
					description: "Optional CC recipients.",
				},
				bcc: {
					oneOf: [
						{ type: "string", description: "Optional BCC recipient or comma-separated recipient list." },
						{ type: "array", items: { type: "string" }, minItems: 1, description: "Optional BCC recipients." },
					],
					description: "Optional BCC recipients.",
				},
				replyTo: { type: "string", description: "Optional Reply-To email address." },
				attachments: {
					type: "array",
					description: "Optional local file attachments to include.",
					items: {
						type: "object",
						properties: {
							path: { type: "string", description: "Path to a local file to attach." },
							filename: { type: "string", description: "Optional override filename shown in the email." },
							contentType: { type: "string", description: "Optional MIME type override, e.g. text/html or application/pdf." },
						},
						required: ["path"],
						additionalProperties: false,
					},
				},
			},
			required: ["to", "subject"],
			additionalProperties: false,
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const prepared = await prepareMessage(params);
			if (!ctx.hasUI) {
				throw new Error("gmail_send_email requires interactive confirmation so the operator can review recipients, subject, and body preview before sending.");
			}

			const confirmed = await ctx.ui.confirm("Send Gmail email?", formatSendConfirmation(prepared));
			if (!confirmed) {
				return {
					content: [{ type: "text", text: "Email send cancelled before contacting Gmail." }],
					details: { cancelled: true, prepared },
				};
			}

			const message = await sendMessage(params);
			return {
				content: [{ type: "text", text: formatSendResult(message) }],
				details: { message },
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus(EXTENSION_STATUS_KEY, `Gmail extension loaded — use /${GMAIL_AUTH_COMMAND} help to connect or ask Pi to read or send Gmail`);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(EXTENSION_STATUS_KEY, undefined);
	});
}

export const internals = {
	formatSummary,
	formatSummaryList,
	formatMessageDetail,
	formatSendConfirmation,
	formatSendResult,
};
