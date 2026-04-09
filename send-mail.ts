import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import { fetchGmailJson } from "./gmail-client.ts";
import type {
	GmailApiSendMessageResponse,
	GmailAddressInput,
	GmailPreparedAttachment,
	GmailPreparedSendMessage,
	GmailSendAttachmentInput,
	GmailSendMessageRequest,
	GmailSendMessageResult,
	GmailTokenStorePaths,
} from "./types.ts";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BODY_PREVIEW_LIMIT = 240;

type PreparedAttachmentWithData = GmailPreparedAttachment & { data: Buffer };

function normalizeWhitespace(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripHtml(html: string): string {
	return html
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");
}

function createBodyPreview(textBody: string | undefined, htmlBody: string | undefined): string {
	const source = textBody?.trim() ? textBody : htmlBody?.trim() ? stripHtml(htmlBody) : "";
	const normalized = normalizeWhitespace(source).replace(/\n{3,}/g, "\n\n").trim();
	if (!normalized) return "(empty body)";
	const singleLine = normalized.replace(/\n/g, " ");
	return singleLine.length <= BODY_PREVIEW_LIMIT ? singleLine : `${singleLine.slice(0, BODY_PREVIEW_LIMIT - 1)}…`;
}

function assertSingleHeaderLine(value: string, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${field} is required.`);
	if (/[\r\n]/.test(trimmed)) throw new Error(`${field} must be a single line.`);
	return trimmed;
}

function normalizeAddressList(input: GmailAddressInput | undefined, field: string, options: { required?: boolean } = {}): string[] {
	if (input === undefined) {
		if (options.required) throw new Error(`${field} is required. Provide at least one email address.`);
		return [];
	}
	const values = Array.isArray(input) ? [...input] : input.split(",");
	const normalized = values.map((value) => value.trim()).filter(Boolean);
	if (normalized.length === 0) {
		if (options.required) throw new Error(`${field} is required. Provide at least one email address.`);
		return [];
	}
	const invalid = normalized.find((value) => /[\r\n]/.test(value) || !EMAIL_PATTERN.test(value));
	if (invalid) throw new Error(`Invalid ${field} recipient: ${invalid}. Use plain email addresses like person@example.com.`);
	return normalized;
}

function assertMessageBodies(request: GmailSendMessageRequest): { textBody?: string; htmlBody?: string } {
	const textBody = request.body !== undefined ? normalizeWhitespace(request.body).trim() : undefined;
	const htmlBody = request.htmlBody !== undefined ? request.htmlBody.trim() : undefined;
	if (!textBody && !htmlBody) throw new Error("body or htmlBody is required. Provide plain-text content, HTML content, or both.");
	return { textBody, htmlBody };
}

function normalizeCommonFields(request: GmailSendMessageRequest) {
	const to = normalizeAddressList(request.to, "to", { required: true });
	const cc = normalizeAddressList(request.cc, "cc");
	const bcc = normalizeAddressList(request.bcc, "bcc");
	const subject = assertSingleHeaderLine(request.subject, "subject");
	const { textBody, htmlBody } = assertMessageBodies(request);
	const replyTo = request.replyTo ? assertSingleHeaderLine(request.replyTo, "replyTo") : undefined;
	if (replyTo && !EMAIL_PATTERN.test(replyTo)) {
		throw new Error(`Invalid replyTo recipient: ${replyTo}. Use a plain email address like person@example.com.`);
	}
	return { to, cc, bcc, subject, textBody, htmlBody, replyTo };
}

function base64Mime(data: Buffer): string {
	return data.toString("base64").replace(/(.{76})/g, "$1\r\n");
}

function generateBoundary(label: string): string {
	return `----pi-gmail-${label}-${Math.random().toString(16).slice(2)}-${Date.now()}`;
}

function guessContentType(filename: string): string {
	switch (extname(filename).toLowerCase()) {
		case ".html":
		case ".htm": return "text/html; charset=utf-8";
		case ".txt":
		case ".md": return "text/plain; charset=utf-8";
		case ".csv": return "text/csv; charset=utf-8";
		case ".json": return "application/json";
		case ".pdf": return "application/pdf";
		case ".png": return "image/png";
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".gif": return "image/gif";
		case ".webp": return "image/webp";
		case ".zip": return "application/zip";
		default: return "application/octet-stream";
	}
}

async function prepareAttachments(inputs: GmailSendAttachmentInput[] | undefined): Promise<PreparedAttachmentWithData[]> {
	if (!inputs?.length) return [];
	const attachments: PreparedAttachmentWithData[] = [];
	for (const input of inputs) {
		const resolvedPath = resolve(assertSingleHeaderLine(input.path, "attachment path"));
		const filename = input.filename ? assertSingleHeaderLine(input.filename, "attachment filename") : basename(resolvedPath);
		const contentType = input.contentType ? assertSingleHeaderLine(input.contentType, "attachment contentType") : guessContentType(filename);
		const data = await readFile(resolvedPath);
		attachments.push({ path: resolvedPath, filename, contentType, size: data.byteLength, data });
	}
	return attachments;
}

function buildMimeMessage(fields: {
	to: string[];
	cc: string[];
	bcc: string[];
	replyTo?: string;
	subject: string;
	textBody?: string;
	htmlBody?: string;
	attachments: PreparedAttachmentWithData[];
}): string {
	const headers = [
		`To: ${fields.to.join(", ")}`,
		fields.cc.length > 0 ? `Cc: ${fields.cc.join(", ")}` : undefined,
		fields.bcc.length > 0 ? `Bcc: ${fields.bcc.join(", ")}` : undefined,
		fields.replyTo ? `Reply-To: ${fields.replyTo}` : undefined,
		`Subject: ${fields.subject}`,
		"MIME-Version: 1.0",
	].filter((line): line is string => line !== undefined);

	if (fields.attachments.length === 0 && fields.textBody && !fields.htmlBody) {
		return [
			...headers,
			"Content-Type: text/plain; charset=utf-8",
			"Content-Transfer-Encoding: 8bit",
			"",
			normalizeWhitespace(fields.textBody).replace(/\n/g, "\r\n"),
		].join("\r\n");
	}

	const altBoundary = generateBoundary("alt");
	const altParts: string[] = [];
	if (fields.textBody) {
		altParts.push([
			`--${altBoundary}`,
			"Content-Type: text/plain; charset=utf-8",
			"Content-Transfer-Encoding: 8bit",
			"",
			normalizeWhitespace(fields.textBody).replace(/\n/g, "\r\n"),
		].join("\r\n"));
	}
	if (fields.htmlBody) {
		altParts.push([
			`--${altBoundary}`,
			"Content-Type: text/html; charset=utf-8",
			"Content-Transfer-Encoding: 8bit",
			"",
			fields.htmlBody.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n"),
		].join("\r\n"));
	}
	altParts.push(`--${altBoundary}--`);
	const altBody = altParts.join("\r\n");

	if (fields.attachments.length === 0) {
		return [
			...headers,
			`Content-Type: multipart/alternative; boundary="${altBoundary}"`,
			"",
			altBody,
		].join("\r\n");
	}

	const mixedBoundary = generateBoundary("mixed");
	const mixedParts: string[] = [[
		`--${mixedBoundary}`,
		`Content-Type: multipart/alternative; boundary="${altBoundary}"`,
		"",
		altBody,
	].join("\r\n")];

	for (const attachment of fields.attachments) {
		mixedParts.push([
			`--${mixedBoundary}`,
			`Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
			"Content-Transfer-Encoding: base64",
			`Content-Disposition: attachment; filename="${attachment.filename}"`,
			"",
			base64Mime(attachment.data),
		].join("\r\n"));
	}
	mixedParts.push(`--${mixedBoundary}--`);

	return [
		...headers,
		`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
		"",
		mixedParts.join("\r\n"),
	].join("\r\n");
}

export function preparePlainTextMessage(request: GmailSendMessageRequest): GmailPreparedSendMessage {
	if (request.htmlBody !== undefined || request.attachments?.length) {
		throw new Error("preparePlainTextMessage only supports plain-text messages without attachments. Use prepareMessage for HTML or attachments.");
	}
	const { to, cc, bcc, subject, textBody, replyTo } = normalizeCommonFields(request);
	if (!textBody) throw new Error("body is required. Provide the plain-text email content to send.");
	const mime = buildMimeMessage({ to, cc, bcc, replyTo, subject, textBody, attachments: [] });
	return {
		raw: Buffer.from(mime, "utf8").toString("base64url"),
		to,
		cc,
		bcc,
		replyTo,
		subject,
		body: textBody,
		bodyPreview: createBodyPreview(textBody, undefined),
		attachments: [],
	};
}

export async function prepareMessage(request: GmailSendMessageRequest): Promise<GmailPreparedSendMessage> {
	const { to, cc, bcc, subject, textBody, htmlBody, replyTo } = normalizeCommonFields(request);
	const attachmentsWithData = await prepareAttachments(request.attachments);
	const mime = buildMimeMessage({ to, cc, bcc, replyTo, subject, textBody, htmlBody, attachments: attachmentsWithData });
	return {
		raw: Buffer.from(mime, "utf8").toString("base64url"),
		to,
		cc,
		bcc,
		replyTo,
		subject,
		body: textBody,
		htmlBody,
		bodyPreview: createBodyPreview(textBody, htmlBody),
		attachments: attachmentsWithData.map(({ data: _data, ...attachment }) => attachment),
	};
}

export async function sendMessage(request: GmailSendMessageRequest, paths?: GmailTokenStorePaths): Promise<GmailSendMessageResult> {
	const prepared = await prepareMessage(request);
	let response: GmailApiSendMessageResponse;
	try {
		response = await fetchGmailJson<GmailApiSendMessageResponse>("/messages/send", {
			method: "POST",
			body: JSON.stringify({ raw: prepared.raw }),
		}, paths);
	} catch (error) {
		if (error instanceof Error && error.message.includes("insufficient authentication scopes")) {
			throw new Error("Gmail send failed because the saved tokens do not include send access. Re-run /gmail-auth exchange after approving the Gmail send scope.");
		}
		throw error;
	}
	return {
		id: response.id,
		threadId: response.threadId,
		labelIds: response.labelIds ?? [],
		to: prepared.to,
		cc: prepared.cc,
		bcc: prepared.bcc,
		replyTo: prepared.replyTo,
		subject: prepared.subject,
		bodyPreview: prepared.bodyPreview,
		attachments: prepared.attachments,
		hasHtmlBody: Boolean(prepared.htmlBody),
	};
}

export async function sendPlainTextMessage(request: GmailSendMessageRequest, paths?: GmailTokenStorePaths): Promise<GmailSendMessageResult> {
	if (request.htmlBody !== undefined || request.attachments?.length) {
		throw new Error("sendPlainTextMessage only supports plain-text messages without attachments. Use sendMessage for HTML or attachments.");
	}
	return sendMessage(request, paths);
}

export const internals = {
	createBodyPreview,
	normalizeAddressList,
	assertSingleHeaderLine,
	stripHtml,
	guessContentType,
};
