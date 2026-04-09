import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";

import { loadOAuthClientCredentials, loadOAuthTokens, saveResolvedOAuthTokens } from "./token-store.ts";
import { refreshAccessToken } from "./oauth.ts";
import type { GmailApiAttachmentResponse, GmailAttachmentContent, GmailMessageAttachment, GmailSavedAttachment, GmailTokenStorePaths } from "./types.ts";

const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;
export const DEFAULT_ATTACHMENT_DOWNLOAD_DIRNAME = ".gmail-attachments";

function decodeAttachmentData(data: string | undefined): Buffer {
	if (!data) {
		return Buffer.alloc(0);
	}

	const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
	return Buffer.from(padded, "base64");
}

async function getStoredTokensOrThrow(paths?: GmailTokenStorePaths) {
	const tokens = await loadOAuthTokens(paths);
	if (!tokens?.accessToken) {
		throw new Error("Gmail is not connected yet. Run /gmail-auth status and complete /gmail-auth exchange before using Gmail tools.");
	}
	return tokens;
}

async function refreshStoredAccessToken(paths?: GmailTokenStorePaths) {
	const existingTokens = await getStoredTokensOrThrow(paths);
	if (!existingTokens.refreshToken) {
		throw new Error("Gmail access expired or was revoked, and no refresh token is stored locally. Re-run /gmail-auth exchange to reconnect Gmail.");
	}

	const credentials = await loadOAuthClientCredentials(paths);
	const refreshedTokens = await refreshAccessToken(credentials, existingTokens.refreshToken);
	const mergedTokens = {
		...existingTokens,
		...refreshedTokens,
		refreshToken: refreshedTokens.refreshToken ?? existingTokens.refreshToken,
	};
	await saveResolvedOAuthTokens(mergedTokens, paths);
	return mergedTokens;
}

async function readAccessToken(paths?: GmailTokenStorePaths): Promise<string> {
	const tokens = await getStoredTokensOrThrow(paths);
	const expiresSoon = typeof tokens.expiryDate === "number" && tokens.expiryDate <= Date.now() + ACCESS_TOKEN_REFRESH_SKEW_MS;
	if (expiresSoon && tokens.refreshToken) {
		return (await refreshStoredAccessToken(paths)).accessToken;
	}
	return tokens.accessToken;
}

export async function fetchAttachmentContent(messageId: string, attachmentId: string, paths?: GmailTokenStorePaths, hasRetried = false): Promise<GmailAttachmentContent> {
	const trimmedMessageId = messageId.trim();
	if (!trimmedMessageId) {
		throw new Error("Message id required. List or search Gmail first, then choose a message attachment.");
	}

	const trimmedAttachmentId = attachmentId.trim();
	if (!trimmedAttachmentId) {
		throw new Error("Attachment id required. List the message attachments first, then choose one attachment id.");
	}

	const accessToken = await readAccessToken(paths);
	const response = await fetch(
		`${GMAIL_API_BASE_URL}/messages/${encodeURIComponent(trimmedMessageId)}/attachments/${encodeURIComponent(trimmedAttachmentId)}`,
		{
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
			},
		},
	);

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
			if (!hasRetried) {
				try {
					await refreshStoredAccessToken(paths);
					return fetchAttachmentContent(trimmedMessageId, trimmedAttachmentId, paths, true);
				} catch (refreshError) {
					if (refreshError instanceof Error) {
						throw refreshError;
					}
				}
			}
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

	const attachmentResponse = payload as GmailApiAttachmentResponse;
	const data = decodeAttachmentData(attachmentResponse.data);
	return {
		attachmentId: trimmedAttachmentId,
		messageId: trimmedMessageId,
		data,
		size: attachmentResponse.size ?? data.byteLength,
	};
}

function sanitizeFilename(filename: string): string {
	const trimmed = filename.trim();
	const safeName = trimmed.replace(/[\\/:*?"<>|\u0000-\u001F]+/g, "-").replace(/\s+/g, " ").trim();
	return safeName || "attachment.bin";
}

export function getDefaultAttachmentDownloadDir(projectRoot = process.cwd()): string {
	return resolve(projectRoot, DEFAULT_ATTACHMENT_DOWNLOAD_DIRNAME);
}

export function resolveAttachmentSavePath(filename: string, savePath?: string, projectRoot = process.cwd()): string {
	const safeFilename = sanitizeFilename(filename);
	if (!savePath?.trim()) {
		return resolve(getDefaultAttachmentDownloadDir(projectRoot), safeFilename);
	}

	const trimmedSavePath = savePath.trim();
	if (trimmedSavePath.endsWith(sep)) {
		throw new Error("Attachment savePath must include the destination filename, not just a directory.");
	}

	const resolvedPath = resolve(projectRoot, trimmedSavePath);
	const relativePath = resolvedPath.slice(projectRoot.length).replace(/^[\\/]+/, "");
	if (!resolvedPath.startsWith(resolve(projectRoot) + sep) && resolvedPath !== resolve(projectRoot)) {
		throw new Error(
			`Attachment savePath must stay inside the current project. Use a relative path under ${projectRoot} or omit savePath to use ${getDefaultAttachmentDownloadDir(projectRoot)}.`,
		);
	}

	if (!basename(relativePath || resolvedPath)) {
		throw new Error("Attachment savePath must include a filename. Provide something like downloads/report.pdf.");
	}

	return resolvedPath;
}

export async function saveAttachmentContent(params: {
	messageId: string;
	attachment: GmailMessageAttachment;
	savePath?: string;
	overwrite?: boolean;
	paths?: GmailTokenStorePaths;
	projectRoot?: string;
}): Promise<GmailSavedAttachment> {
	const projectRoot = params.projectRoot ?? process.cwd();
	const resolvedPath = resolveAttachmentSavePath(params.attachment.filename, params.savePath, projectRoot);
	const content = await fetchAttachmentContent(
		params.messageId,
		params.attachment.apiAttachmentId ?? params.attachment.attachmentId,
		params.paths,
	);
	await mkdir(dirname(resolvedPath), { recursive: true });
	await writeFile(resolvedPath, content.data, { flag: params.overwrite ? "w" : "wx" });
	return {
		attachmentId: params.attachment.attachmentId,
		messageId: params.messageId,
		filename: params.attachment.filename,
		mimeType: params.attachment.mimeType,
		size: content.size,
		isInline: params.attachment.isInline,
		savedPath: resolvedPath,
		overwritten: Boolean(params.overwrite),
	};
}

export const internals = {
	decodeAttachmentData,
	sanitizeFilename,
};
