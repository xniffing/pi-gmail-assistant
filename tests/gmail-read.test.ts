import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import gmailExtension from "../index.ts";
import { saveOAuthTokensForAccount } from "../token-store.ts";

interface RegisteredTool {
	name: string;
	execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>;
}

function createMockPi() {
	const tools: RegisteredTool[] = [];
	return {
		tools,
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		registerCommand() {},
		on() {},
	};
}

const TEST_STATE_ROOT = join(homedir(), ".config", "automation", "gmail");
const TEST_ACCOUNT_DIR = join(TEST_STATE_ROOT, "accounts", "test-example-com");
const TEST_ACTIVE_ACCOUNT_PATH = join(TEST_STATE_ROOT, "active-account.json");

async function cleanupTestAuthState(): Promise<void> {
	await rm(TEST_ACCOUNT_DIR, { recursive: true, force: true });
	await rm(TEST_ACTIVE_ACCOUNT_PATH, { force: true });
}

async function withTempProject(run: (projectRoot: string) => Promise<void>): Promise<void> {
	const projectRoot = await mkdtemp(join(tmpdir(), "gmail-ext-"));
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

function findTool(tools: RegisteredTool[], name: string): RegisteredTool {
	const tool = tools.find((entry) => entry.name === name);
	assert.ok(tool, `Expected tool ${name} to be registered`);
	return tool;
}

test("registers inbox list/read/search tools with normalized output", async () => {
	await withTempProject(async (projectRoot) => {
		await writeTokens(projectRoot);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (url: string | URL | Request) => {
			const href = String(url);
			if (href.includes("/messages?") && href.includes("q=in%3Ainbox")) {
				return new Response(JSON.stringify({ messages: [{ id: "m1" }] }), { status: 200, headers: { "content-type": "application/json" } });
			}
			if (href.includes("/messages?") && href.includes("q=from%3Aboss")) {
				return new Response(JSON.stringify({ messages: [{ id: "m2" }] }), { status: 200, headers: { "content-type": "application/json" } });
			}
			if (href.includes("m1?format=metadata")) {
				return new Response(JSON.stringify({ id: "m1", snippet: "Inbox preview", payload: { headers: [{ name: "From", value: "Boss <boss@example.com>" }, { name: "Subject", value: "Weekly sync" }, { name: "Date", value: "Thu, 09 Apr 2026 09:00:00 +0000" }] } }), { status: 200, headers: { "content-type": "application/json" } });
			}
			if (href.includes("m2?format=metadata")) {
				return new Response(JSON.stringify({ id: "m2", snippet: "Search preview", payload: { headers: [{ name: "From", value: "Boss <boss@example.com>" }, { name: "Subject", value: "Need update" }, { name: "Date", value: "Thu, 09 Apr 2026 08:00:00 +0000" }] } }), { status: 200, headers: { "content-type": "application/json" } });
			}
			if (href.includes("m1?format=full")) {
				return new Response(JSON.stringify({ id: "m1", labelIds: ["INBOX", "IMPORTANT"], snippet: "Inbox preview", payload: { headers: [{ name: "From", value: "Boss <boss@example.com>" }, { name: "To", value: "me@example.com" }, { name: "Subject", value: "Weekly sync" }, { name: "Date", value: "Thu, 09 Apr 2026 09:00:00 +0000" }], parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Agenda line 1\nAgenda line 2").toString("base64url") } }] } }), { status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error(`Unexpected fetch URL: ${href}`);
		};

		try {
			const pi = createMockPi();
			gmailExtension(pi as never);

			const listResult = await findTool(pi.tools, "gmail_list_inbox_messages").execute("call-1", { maxResults: 1 });
			assert.match(listResult.content[0]?.text ?? "", /Recent inbox messages/);
			assert.match(listResult.content[0]?.text ?? "", /id: m1/);
			assert.match(listResult.content[0]?.text ?? "", /snippet: Inbox preview/);

			const readResult = await findTool(pi.tools, "gmail_read_message").execute("call-2", { messageId: "m1" });
			assert.match(readResult.content[0]?.text ?? "", /Message: Weekly sync/);
			assert.match(readResult.content[0]?.text ?? "", /labels: INBOX, IMPORTANT/);
			assert.match(readResult.content[0]?.text ?? "", /Agenda line 1/);

			const searchResult = await findTool(pi.tools, "gmail_search_messages").execute("call-3", { query: "from:boss", maxResults: 1 });
			assert.match(searchResult.content[0]?.text ?? "", /Search results for: from:boss/);
			assert.match(searchResult.content[0]?.text ?? "", /Need update/);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

test("surfaces missing-token and auth-expired failures clearly", async () => {
	await withTempProject(async (projectRoot) => {
		const pi = createMockPi();
		gmailExtension(pi as never);

		await assert.rejects(
			() => findTool(pi.tools, "gmail_list_inbox_messages").execute("call-1", { maxResults: 1 }),
			/Gmail is not connected yet/,
		);

		await writeTokens(projectRoot);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "bad auth" } }), { status: 401, headers: { "content-type": "application/json" } });

		try {
			await assert.rejects(
				() => findTool(pi.tools, "gmail_read_message").execute("call-2", { messageId: "m1" }),
				/Re-run \/gmail-auth exchange/,
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
