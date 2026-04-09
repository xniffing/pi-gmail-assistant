import { fetchAttachmentContent } from "./attachment-client.ts";
import { loadOAuthTokens } from "./token-store.ts";
import { listMessageAttachments, parseGmailMessageDetail, summarizeGmailMessage } from "./message-parser.ts";
import type {
	GmailApiListMessagesResponse,
	GmailApiMessage,
	GmailAttachmentContent,
	GmailListMessagesOptions,
	GmailMessageAttachment,
	GmailMessageDetail,
	GmailMessageSummary,
	GmailSearchMessagesOptions,
	GmailTokenStorePaths,
} from "./types.ts";

const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_LIMIT = 25;
const SUMMARY_HEADERS = ["From", "Subject", "Date"];

function clampMaxResults(value: number | undefined): number {
	if (value === undefined || Number.isNaN(value)) {
		return DEFAULT_MAX_RESULTS;
	}

	return Math.min(Math.max(Math.trunc(value), 1), MAX_RESULTS_LIMIT);
}

function buildQuery(options: GmailListMessagesOptions | GmailSearchMessagesOptions): string | undefined {
	const queryParts = [options.query?.trim()].filter((part): part is string => Boolean(part));
	return queryParts.length > 0 ? queryParts.join(" ") : undefined;
}

export async function readAccessToken(paths?: GmailTokenStorePaths): Promise<string> {
	const tokens = await loadOAuthTokens(paths);
	if (!tokens?.accessToken) {
		throw new Error("Gmail is not connected yet. Run /gmail-auth status and complete /gmail-auth exchange before using Gmail tools.");
	}

	return tokens.accessToken;
}

export async function fetchGmailJson<T>(path: string, init: RequestInit = {}, paths?: GmailTokenStorePaths): Promise<T> {
	const accessToken = await readAccessToken(paths);
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${accessToken}`);
	headers.set("Accept", "application/json");
	if (init.body !== undefined && !headers.has("Content-Type")) {
		headers.set("Content-Type", "application/json");
	}

	const response = await fetch(`${GMAIL_API_BASE_URL}${path}`, {
		...init,
		headers,
	});

	let payload: Record<string, unknown> | undefined;
	try {
		payload = (await response.json()) as Record<string, unknown>;
	} catch {
		payload = undefined;
	}

	if (!response.ok) {
		const apiError = typeof payload?.error === "object" && payload.error !== null ? payload.error as Record<string, unknown> : undefined;
		const apiMessage = typeof apiError?.message === "string" ? apiError.message : undefined;

		if (response.status === 401) {
			throw new Error("Gmail access expired or was revoked. Re-run /gmail-auth exchange to refresh your local Gmail tokens.");
		}

		if (response.status === 403) {
			throw new Error(apiMessage ?? "Gmail rejected the request. Confirm the Gmail API is enabled and your account granted the requested scopes.");
		}

		if (response.status === 404) {
			throw new Error("That Gmail message or attachment was not found. List or search messages first to get a valid message id, then list attachments before downloading one.");
		}

		throw new Error(apiMessage ?? `Gmail request failed with status ${response.status}.`);
	}

	return payload as T;
}

async function fetchMessageSummary(messageId: string, paths?: GmailTokenStorePaths): Promise<GmailMessageSummary> {
	const params = new URLSearchParams({ format: "metadata" });
	for (const header of SUMMARY_HEADERS) {
		params.append("metadataHeaders", header);
	}

	const message = await fetchGmailJson<GmailApiMessage>(`/messages/${encodeURIComponent(messageId)}?${params.toString()}`, {}, paths);
	return summarizeGmailMessage(message);
}

async function fetchMessageIds(options: GmailListMessagesOptions | GmailSearchMessagesOptions, paths?: GmailTokenStorePaths): Promise<string[]> {
	const params = new URLSearchParams({ maxResults: String(clampMaxResults(options.maxResults)) });
	const query = buildQuery(options);
	if (query) {
		params.set("q", query);
	}

	const response = await fetchGmailJson<GmailApiListMessagesResponse>(`/messages?${params.toString()}`, {}, paths);
	return (response.messages ?? []).map((message) => message.id);
}

export async function listInboxMessages(options: GmailListMessagesOptions = {}, paths?: GmailTokenStorePaths): Promise<GmailMessageSummary[]> {
	const messageIds = await fetchMessageIds({ ...options, query: ["in:inbox", options.query?.trim()].filter(Boolean).join(" ") }, paths);
	return Promise.all(messageIds.map((messageId) => fetchMessageSummary(messageId, paths)));
}

export async function searchMessages(options: GmailSearchMessagesOptions, paths?: GmailTokenStorePaths): Promise<GmailMessageSummary[]> {
	const trimmedQuery = options.query?.trim();
	if (!trimmedQuery) {
		throw new Error("Search query required. Provide words like from:boss has:attachment newer_than:7d.");
	}

	const messageIds = await fetchMessageIds({ ...options, query: trimmedQuery }, paths);
	return Promise.all(messageIds.map((messageId) => fetchMessageSummary(messageId, paths)));
}

async function fetchFullMessage(messageId: string, paths?: GmailTokenStorePaths): Promise<GmailApiMessage> {
	const trimmedMessageId = messageId.trim();
	if (!trimmedMessageId) {
		throw new Error("Message id required. List or search Gmail first, then read a specific message id.");
	}

	return fetchGmailJson<GmailApiMessage>(`/messages/${encodeURIComponent(trimmedMessageId)}?format=full`, {}, paths);
}

export async function getMessageDetail(messageId: string, paths?: GmailTokenStorePaths): Promise<GmailMessageDetail> {
	const message = await fetchFullMessage(messageId, paths);
	return parseGmailMessageDetail(message);
}

export async function listMessageAttachmentsForMessage(messageId: string, paths?: GmailTokenStorePaths): Promise<GmailMessageAttachment[]> {
	const message = await fetchFullMessage(messageId, paths);
	return listMessageAttachments(message);
}

export async function getMessageAttachmentContent(messageId: string, attachmentId: string, paths?: GmailTokenStorePaths): Promise<GmailAttachmentContent> {
	return fetchAttachmentContent(messageId, attachmentId, paths);
}

export const internals = {
	clampMaxResults,
	buildQuery,
	readAccessToken,
};
