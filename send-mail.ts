import { fetchGmailJson } from "./gmail-client.ts";
import type {
	GmailApiSendMessageResponse,
	GmailAddressInput,
	GmailPreparedSendMessage,
	GmailSendMessageRequest,
	GmailSendMessageResult,
	GmailTokenStorePaths,
} from "./types.ts";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BODY_PREVIEW_LIMIT = 240;

function normalizeWhitespace(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function createBodyPreview(body: string): string {
	const normalized = normalizeWhitespace(body).replace(/\n{3,}/g, "\n\n").trim();
	if (!normalized) {
		return "(empty body)";
	}

	const singleLine = normalized.replace(/\n/g, " ");
	return singleLine.length <= BODY_PREVIEW_LIMIT ? singleLine : `${singleLine.slice(0, BODY_PREVIEW_LIMIT - 1)}…`;
}

function assertSingleHeaderLine(value: string, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`${field} is required.`);
	}
	if (/[\r\n]/.test(trimmed)) {
		throw new Error(`${field} must be a single line.`);
	}
	return trimmed;
}

function normalizeAddressList(input: GmailAddressInput | undefined, field: string, options: { required?: boolean } = {}): string[] {
	if (input === undefined) {
		if (options.required) {
			throw new Error(`${field} is required. Provide at least one email address.`);
		}
		return [];
	}

	const values = Array.isArray(input) ? [...input] : input.split(",");
	const normalized = values.map((value) => value.trim()).filter(Boolean);

	if (normalized.length === 0) {
		if (options.required) {
			throw new Error(`${field} is required. Provide at least one email address.`);
		}
		return [];
	}

	const invalid = normalized.find((value) => /[\r\n]/.test(value) || !EMAIL_PATTERN.test(value));
	if (invalid) {
		throw new Error(`Invalid ${field} recipient: ${invalid}. Use plain email addresses like person@example.com.`);
	}

	return normalized;
}

export function preparePlainTextMessage(request: GmailSendMessageRequest): GmailPreparedSendMessage {
	const to = normalizeAddressList(request.to, "to", { required: true });
	const cc = normalizeAddressList(request.cc, "cc");
	const bcc = normalizeAddressList(request.bcc, "bcc");
	const subject = assertSingleHeaderLine(request.subject, "subject");
	const body = normalizeWhitespace(request.body ?? "").trim();
	if (!body) {
		throw new Error("body is required. Provide the plain-text email content to send.");
	}
	const replyTo = request.replyTo ? assertSingleHeaderLine(request.replyTo, "replyTo") : undefined;
	if (replyTo && !EMAIL_PATTERN.test(replyTo)) {
		throw new Error(`Invalid replyTo recipient: ${replyTo}. Use a plain email address like person@example.com.`);
	}

	const normalizedBody = normalizeWhitespace(request.body ?? "").replace(/\n/g, "\r\n");
	const lines = [
		`To: ${to.join(", ")}`,
		cc.length > 0 ? `Cc: ${cc.join(", ")}` : undefined,
		bcc.length > 0 ? `Bcc: ${bcc.join(", ")}` : undefined,
		replyTo ? `Reply-To: ${replyTo}` : undefined,
		`Subject: ${subject}`,
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: 8bit",
		"MIME-Version: 1.0",
		"",
		normalizedBody,
	].filter((line): line is string => line !== undefined);

	const raw = Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");

	return {
		raw,
		to,
		cc,
		bcc,
		replyTo,
		subject,
		body,
		bodyPreview: createBodyPreview(body),
	};
}

export async function sendPlainTextMessage(request: GmailSendMessageRequest, paths?: GmailTokenStorePaths): Promise<GmailSendMessageResult> {
	const prepared = preparePlainTextMessage(request);
	let response: GmailApiSendMessageResponse;

	try {
		response = await fetchGmailJson<GmailApiSendMessageResponse>(
			"/messages/send",
			{
				method: "POST",
				body: JSON.stringify({ raw: prepared.raw }),
			},
			paths,
		);
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
	};
}

export const internals = {
	createBodyPreview,
	normalizeAddressList,
	assertSingleHeaderLine,
};
