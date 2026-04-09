import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { preparePlainTextMessage, sendPlainTextMessage } from "../send-mail.ts";
import { saveOAuthTokensForAccount } from "../token-store.ts";

const TEST_STATE_ROOT = join(homedir(), ".config", "automation", "gmail");
const TEST_ACCOUNT_DIR = join(TEST_STATE_ROOT, "accounts", "test-example-com");
const TEST_ACTIVE_ACCOUNT_PATH = join(TEST_STATE_ROOT, "active-account.json");

async function cleanupTestAuthState(): Promise<void> {
	await rm(TEST_ACCOUNT_DIR, { recursive: true, force: true });
	await rm(TEST_ACTIVE_ACCOUNT_PATH, { force: true });
}

async function withTempProject(run: (projectRoot: string) => Promise<void>): Promise<void> {
	const projectRoot = await mkdtemp(join(tmpdir(), "gmail-send-helper-"));
	const previousCwd = process.cwd();
	await cleanupTestAuthState();
	process.chdir(projectRoot);
	try {
		await run(projectRoot);
	} finally {
		process.chdir(previousCwd);
		await rm(projectRoot, { recursive: true, force: true });
		await cleanupTestAuthState();
	}
}

async function writeTokens(_projectRoot: string): Promise<void> {
	await saveOAuthTokensForAccount("test@example.com", { accessToken: "test-token" });
}

test("preparePlainTextMessage normalizes addresses and builds a plain-text RFC822 payload", () => {
	const prepared = preparePlainTextMessage({
		to: ["alpha@example.com", "beta@example.com"],
		cc: "copy@example.com",
		bcc: ["hidden@example.com"],
		replyTo: "reply@example.com",
		subject: "Launch update",
		body: "Line one\n\nLine two",
	});

	assert.deepEqual(prepared.to, ["alpha@example.com", "beta@example.com"]);
	assert.equal(prepared.bodyPreview, "Line one  Line two");

	const decoded = Buffer.from(prepared.raw, "base64url").toString("utf8");
	assert.match(decoded, /^To: alpha@example.com, beta@example.com/m);
	assert.match(decoded, /^Cc: copy@example.com/m);
	assert.match(decoded, /^Bcc: hidden@example.com/m);
	assert.match(decoded, /^Reply-To: reply@example.com/m);
	assert.match(decoded, /^Subject: Launch update/m);
	assert.match(decoded, /Content-Type: text\/plain; charset=utf-8/);
	assert.match(decoded, /\r\n\r\nLine one\r\n\r\nLine two$/);
});

test("sendPlainTextMessage posts the encoded raw message and returns normalized metadata", async () => {
	await withTempProject(async (projectRoot) => {
		await writeTokens(projectRoot);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (url, init) => {
			assert.match(String(url), /\/messages\/send$/);
			assert.equal(init?.method, "POST");
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
			const payload = JSON.parse(String(init?.body)) as { raw: string };
			const decoded = Buffer.from(payload.raw, "base64url").toString("utf8");
			assert.match(decoded, /^To: person@example.com/m);
			assert.match(decoded, /^Subject: Hello there/m);
			assert.match(decoded, /\r\n\r\nBody text$/);
			return new Response(JSON.stringify({ id: "sent-1", threadId: "thread-1", labelIds: ["SENT"] }), { status: 200, headers: { "content-type": "application/json" } });
		};

		try {
			const result = await sendPlainTextMessage({
				to: "person@example.com",
				subject: "Hello there",
				body: "Body text",
			});

			assert.equal(result.id, "sent-1");
			assert.deepEqual(result.to, ["person@example.com"]);
			assert.equal(result.bodyPreview, "Body text");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

test("sendPlainTextMessage surfaces validation and scope failures clearly", async () => {
	assert.throws(
		() => preparePlainTextMessage({ to: "not-an-email", subject: "Hello", body: "Body" }),
		/Invalid to recipient: not-an-email/,
	);

	await withTempProject(async (projectRoot) => {
		await writeTokens(projectRoot);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "Request had insufficient authentication scopes." } }), { status: 403, headers: { "content-type": "application/json" } });

		try {
			await assert.rejects(
				() => sendPlainTextMessage({ to: "person@example.com", subject: "Hello", body: "Body" }),
				/Re-run \/gmail-auth exchange after approving the Gmail send scope/,
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
