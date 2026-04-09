import { createHash } from "node:crypto";

import type {
	GmailApiHeader,
	GmailApiMessage,
	GmailApiMessagePart,
	GmailMessageAttachment,
	GmailMessageBody,
	GmailMessageDetail,
	GmailMessageSummary,
} from "./types.ts";

const SUMMARY_SNIPPET_LIMIT = 160;
const BODY_PREVIEW_LIMIT = 4000;

function getHeader(headers: GmailApiHeader[] | undefined, name: string): string | undefined {
	return headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;
}

function decodeBase64Url(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
	return Buffer.from(padded, "base64").toString("utf8");
}

function stripHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/\r/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

function normalizeText(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	const normalized = value
		.replace(/\r/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return normalized || undefined;
}

function getHeaderValues(headers: GmailApiHeader[] | undefined, name: string): string[] {
	return headers?.filter((header) => header.name.toLowerCase() === name.toLowerCase()).map((header) => header.value) ?? [];
}

function getPartDisposition(part: GmailApiMessagePart): string | undefined {
	return getHeaderValues(part.headers, "Content-Disposition")[0]?.trim();
}

function getPartContentId(part: GmailApiMessagePart): string | undefined {
	return getHeaderValues(part.headers, "Content-Id")[0]?.trim();
}

function isAttachmentPart(part: GmailApiMessagePart): boolean {
	return Boolean(part.body?.attachmentId || part.filename?.trim());
}

function buildStableAttachmentId(part: GmailApiMessagePart, filename: string): string {
	const partId = part.partId?.trim();
	if (partId) {
		return `part:${partId}`;
	}

	const fingerprint = createHash("sha1")
		.update(filename)
		.update("\0")
		.update(part.mimeType?.trim() || "application/octet-stream")
		.update("\0")
		.update(String(part.body?.size ?? 0))
		.update("\0")
		.update(getPartDisposition(part) ?? "")
		.update("\0")
		.update(getPartContentId(part) ?? "")
		.digest("hex")
		.slice(0, 12);
	return `file:${fingerprint}`;
}

function normalizeAttachment(part: GmailApiMessagePart): GmailMessageAttachment | undefined {
	const apiAttachmentId = part.body?.attachmentId?.trim();
	const filename = part.filename?.trim();
	if (!apiAttachmentId || !filename) {
		return undefined;
	}

	const disposition = getPartDisposition(part);
	const normalizedDisposition = disposition?.toLowerCase();
	const isInline = normalizedDisposition?.startsWith("inline") ?? false;

	return {
		attachmentId: buildStableAttachmentId(part, filename),
		apiAttachmentId,
		partId: part.partId,
		filename,
		mimeType: part.mimeType?.trim() || "application/octet-stream",
		size: part.body?.size ?? 0,
		isInline,
		isDownloadable: !isInline,
		contentId: getPartContentId(part),
		contentDisposition: disposition,
	};
}

function collectBodyCandidates(part: GmailApiMessagePart | undefined): { plainText?: string; htmlText?: string; attachments: GmailMessageAttachment[] } {
	if (!part) {
		return { attachments: [] };
	}

	const mimeType = part.mimeType?.toLowerCase();
	const bodyText = decodeBase64Url(part.body?.data);
	let plainText = mimeType === "text/plain" && !isAttachmentPart(part) ? normalizeText(bodyText) : undefined;
	let htmlText = mimeType === "text/html" && !isAttachmentPart(part) ? normalizeText(bodyText) : undefined;
	const attachments: GmailMessageAttachment[] = [];
	const attachment = normalizeAttachment(part);
	if (attachment) {
		attachments.push(attachment);
	}

	for (const child of part.parts ?? []) {
		const candidate = collectBodyCandidates(child);
		plainText ??= candidate.plainText;
		htmlText ??= candidate.htmlText;
		attachments.push(...candidate.attachments);
	}

	return { plainText, htmlText, attachments };
}

function buildBody(bodyText: string | undefined, snippet: string | undefined): GmailMessageBody {
	const raw = normalizeText(bodyText) ?? normalizeText(snippet) ?? "Body unavailable.";
	const preview = raw.length > BODY_PREVIEW_LIMIT ? `${raw.slice(0, BODY_PREVIEW_LIMIT - 1)}…` : raw;

	return {
		text: preview,
		isTruncated: raw.length > BODY_PREVIEW_LIMIT,
		fullLength: raw.length,
	};
}

export function normalizeSnippet(snippet: string | undefined, limit = SUMMARY_SNIPPET_LIMIT): string | undefined {
	const normalized = normalizeText(snippet);
	if (!normalized) {
		return undefined;
	}

	return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

export function summarizeGmailMessage(message: GmailApiMessage): GmailMessageSummary {
	const headers = message.payload?.headers;
	return {
		id: message.id,
		threadId: message.threadId,
		from: getHeader(headers, "From") ?? "Unknown sender",
		subject: getHeader(headers, "Subject") ?? "(no subject)",
		date: getHeader(headers, "Date") ?? "Unknown date",
		snippet: normalizeSnippet(message.snippet) ?? "No preview available.",
	};
}

export function parseGmailMessageDetail(message: GmailApiMessage): GmailMessageDetail {
	const headers = message.payload?.headers;
	const candidates = collectBodyCandidates(message.payload);
	const bodyText = candidates.plainText ?? (candidates.htmlText ? stripHtml(candidates.htmlText) : undefined);

	return {
		id: message.id,
		threadId: message.threadId,
		labelIds: message.labelIds ?? [],
		from: getHeader(headers, "From") ?? "Unknown sender",
		to: getHeader(headers, "To"),
		cc: getHeader(headers, "Cc"),
		subject: getHeader(headers, "Subject") ?? "(no subject)",
		date: getHeader(headers, "Date") ?? "Unknown date",
		snippet: normalizeSnippet(message.snippet) ?? "No preview available.",
		body: buildBody(bodyText, message.snippet),
		attachments: candidates.attachments,
	};
}

export function listMessageAttachments(message: GmailApiMessage): GmailMessageAttachment[] {
	return collectBodyCandidates(message.payload).attachments;
}
