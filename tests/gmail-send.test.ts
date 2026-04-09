import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import gmailExtension from "../index.ts";
import { saveOAuthTokensForAccount } from "../token-store.ts";

interface RegisteredTool {
	name: string;
	execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>;
}

interface ToolContext {
	hasUI: boolean;
	ui: {
		confirm: (title: string, message: string) => Promise<boolean>;
		notify: (...args: any[]) => void;
		setStatus: (...args: any[]) => void;
		editor: (...args: any[]) => Promise<string | undefined>;
		input: (...args: any[]) => Promise<string | undefined>;
	};
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

function createToolContext(confirmImpl: ToolContext["ui"]["confirm"], hasUI = true): ToolContext {
	return {
		hasUI,
		ui: {
			confirm: confirmImpl,
			notify() {},
			setStatus() {},
			async editor() { return undefined; },
			async input() { return undefined; },
		},
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
	const projectRoot = await mkdtemp(join(tmpdir(), "gmail-send-tool-"));
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

test("gmail_send_email shows confirmation details and only sends after approval", async () => {
	await withTempProject(async (projectRoot) => {
		await writeTokens(projectRoot);
		const originalFetch = globalThis.fetch;
		const confirmMessages: string[] = [];
		let fetchCalls = 0;

		globalThis.fetch = async (_url, init) => {
			fetchCalls += 1;
			assert.equal(init?.method, "POST");
			return new Response(JSON.stringify({ id: "sent-1", labelIds: ["SENT"] }), { status: 200, headers: { "content-type": "application/json" } });
		};

		try {
			const pi = createMockPi();
			gmailExtension(pi as never);
			const sendTool = findTool(pi.tools, "gmail_send_email");
			const ctx = createToolContext(async (_title, message) => {
				confirmMessages.push(message);
				return true;
			});

			const result = await sendTool.execute("call-1", {
				to: ["person@example.com"],
				subject: "Quarterly update",
				body: "Line 1\nLine 2",
				cc: ["leader@example.com"],
			}, undefined, undefined, ctx);

			assert.equal(fetchCalls, 1);
			assert.match(confirmMessages[0] ?? "", /To: person@example.com/);
			assert.match(confirmMessages[0] ?? "", /Cc: leader@example.com/);
			assert.match(confirmMessages[0] ?? "", /Subject: Quarterly update/);
			assert.match(confirmMessages[0] ?? "", /Format: plain text email/);
			assert.match(confirmMessages[0] ?? "", /Attachments: none/);
			assert.match(confirmMessages[0] ?? "", /Preview: Line 1 Line 2/);
			assert.match(result.content[0]?.text ?? "", /Sent Gmail message: Quarterly update/);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

test("gmail_send_email cancels safely when confirmation is rejected", async () => {
	await withTempProject(async (projectRoot) => {
		await writeTokens(projectRoot);
		const originalFetch = globalThis.fetch;
		let fetchCalled = false;
		globalThis.fetch = async () => {
			fetchCalled = true;
			throw new Error("fetch should not be called when confirmation is rejected");
		};

		try {
			const pi = createMockPi();
			gmailExtension(pi as never);
			const sendTool = findTool(pi.tools, "gmail_send_email");
			const ctx = createToolContext(async () => false);

			const result = await sendTool.execute("call-2", {
				to: "person@example.com",
				subject: "Hold",
				body: "Do not send",
			}, undefined, undefined, ctx);

			assert.equal(fetchCalled, false);
			assert.match(result.content[0]?.text ?? "", /cancelled before contacting Gmail/);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

test("gmail_send_email supports htmlBody and attachments in confirmation", async () => {
	await withTempProject(async (projectRoot) => {
		await writeTokens(projectRoot);
		const attachmentPath = join(projectRoot, "brief.html");
		await writeFile(attachmentPath, "<p>Attachment</p>");
		const originalFetch = globalThis.fetch;
		const confirmMessages: string[] = [];
		globalThis.fetch = async () => new Response(JSON.stringify({ id: "sent-html-1", labelIds: ["SENT"] }), { status: 200, headers: { "content-type": "application/json" } });
		try {
			const pi = createMockPi();
			gmailExtension(pi as never);
			const sendTool = findTool(pi.tools, "gmail_send_email");
			const ctx = createToolContext(async (_title, message) => {
				confirmMessages.push(message);
				return true;
			});
			const result = await sendTool.execute("call-html", {
				to: "person@example.com",
				subject: "HTML message",
				htmlBody: "<p>Hello <strong>world</strong></p>",
				attachments: [{ path: attachmentPath }],
			}, undefined, undefined, ctx);
			assert.match(confirmMessages[0] ?? "", /Format: HTML email/);
			assert.match(confirmMessages[0] ?? "", /Attachments: brief.html/);
			assert.match(result.content[0]?.text ?? "", /format: html/);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

test("gmail_send_email rejects invalid inputs and blocks non-interactive sends", async () => {
		const pi = createMockPi();
		gmailExtension(pi as never);
		const sendTool = findTool(pi.tools, "gmail_send_email");

		await assert.rejects(
			() => sendTool.execute("call-3", { to: "bad-address", subject: "Hello", body: "Body" }, undefined, undefined, createToolContext(async () => true)),
			/Invalid to recipient: bad-address/,
		);

		await assert.rejects(
			() => sendTool.execute("call-4", { to: "person@example.com", subject: "Hello", body: "Body" }, undefined, undefined, createToolContext(async () => true, false)),
			/requires interactive confirmation/,
		);
});
