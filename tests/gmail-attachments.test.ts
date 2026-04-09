import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import gmailExtension from "../index.ts";
import { getMessageAttachmentContent, getMessageDetail, listMessageAttachmentsForMessage } from "../gmail-client.ts";
import { getDefaultTokenStorePaths } from "../token-store.ts";

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

function findTool(tools: RegisteredTool[], name: string): RegisteredTool {
	const tool = tools.find((entry) => entry.name === name);
	assert.ok(tool, `Expected tool ${name} to be registered`);
	return tool;
}

async function withTempProject(run: (projectRoot: string) => Promise<void>): Promise<void> {
	const projectRoot = await mkdtemp(join(tmpdir(), "gmail-attachments-"));
	const previousCwd = process.cwd();
	process.chdir(projectRoot);
	try {
		await run(projectRoot);
	} finally {
		process.chdir(previousCwd);
		await rm(projectRoot, { recursive: true, force: true });
	}
}

async function writeTokens(projectRoot: string): Promise<void> {
	const paths = getDefaultTokenStorePaths(projectRoot);
	await mkdir(paths.baseDir, { recursive: true });
	await writeFile(paths.tokenPath, JSON.stringify({ accessToken: "test-token" }));
}

test("nested MIME messages expose attachment metadata and readable body text", async () => {
	await withTempProject(async (projectRoot) => {
		await writeTokens(projectRoot);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (url: string | URL | Request) => {
			const href = String(url);
			if (href.includes("nested-1?format=full")) {
				return new Response(JSON.stringify({
					id: "nested-1",
					snippet: "Quarterly report attached",
					payload: {
						headers: [
							{ name: "From", value: "Finance <finance@example.com>" },
							{ name: "Subject", value: "Quarterly report" },
							{ name: "Date", value: "Thu, 09 Apr 2026 10:00:00 +0000" },
						],
						parts: [
							{
								mimeType: "multipart/alternative",
								parts: [
									{ mimeType: "text/plain", body: { data: Buffer.from("See attached report.").toString("base64url") } },
									{ mimeType: "text/html", body: { data: Buffer.from("<p>See attached <b>report</b>.</p>").toString("base64url") } },
								],
							},
							{
								mimeType: "multipart/related",
								parts: [
									{
										partId: "2.1",
										mimeType: "application/pdf",
										filename: "report.pdf",
										headers: [{ name: "Content-Disposition", value: "attachment; filename=report.pdf" }],
										body: { size: 5120, attachmentId: "att-pdf" },
									},
									{
										partId: "2.2",
										mimeType: "image/png",
										filename: "chart.png",
										headers: [
											{ name: "Content-Disposition", value: "inline; filename=chart.png" },
											{ name: "Content-Id", value: "<chart-1>" },
										],
										body: { size: 2048, attachmentId: "att-inline" },
									},
								],
							},
						],
					},
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error(`Unexpected fetch URL: ${href}`);
		};

		try {
			const detail = await getMessageDetail("nested-1");
			assert.equal(detail.body.text, "See attached report.");
			assert.equal(detail.attachments.length, 2);
			assert.deepEqual(detail.attachments.map((attachment) => ({
				id: attachment.attachmentId,
				apiId: attachment.apiAttachmentId,
				name: attachment.filename,
				inline: attachment.isInline,
				downloadable: attachment.isDownloadable,
				mimeType: attachment.mimeType,
				size: attachment.size,
			})), [
				{ id: "part:2.1", apiId: "att-pdf", name: "report.pdf", inline: false, downloadable: true, mimeType: "application/pdf", size: 5120 },
				{ id: "part:2.2", apiId: "att-inline", name: "chart.png", inline: true, downloadable: false, mimeType: "image/png", size: 2048 },
			]);

			const attachments = await listMessageAttachmentsForMessage("nested-1");
			assert.equal(attachments[1]?.contentId, "<chart-1>");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

test("attachment content helper decodes Gmail attachment payloads", async () => {
	await withTempProject(async (projectRoot) => {
		await writeTokens(projectRoot);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (url: string | URL | Request) => {
			const href = String(url);
			if (href.includes("/messages/msg-1/attachments/att-1")) {
				return new Response(JSON.stringify({ size: 7, data: Buffer.from("PDFDATA").toString("base64url") }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(`Unexpected fetch URL: ${href}`);
		};

		try {
			const attachment = await getMessageAttachmentContent("msg-1", "att-1");
			assert.equal(attachment.size, 7);
			assert.equal(attachment.data.toString("utf8"), "PDFDATA");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

test("attachment tools list metadata and download into safe project-local paths", async () => {
	await withTempProject(async (projectRoot) => {
		await writeTokens(projectRoot);
		const originalFetch = globalThis.fetch;
		let fullFetchCount = 0;
		globalThis.fetch = async (url: string | URL | Request) => {
			const href = String(url);
			if (href.includes("tool-msg?format=full")) {
				fullFetchCount += 1;
				const attachmentId = fullFetchCount === 1 ? "tool-att-a" : "tool-att-b";
				return new Response(JSON.stringify({
					id: "tool-msg",
					payload: {
						parts: [
							{
								partId: "1",
								mimeType: "application/pdf",
								filename: "status-report.pdf",
								headers: [{ name: "Content-Disposition", value: "attachment; filename=status-report.pdf" }],
								body: { size: 4096, attachmentId },
							},
						],
					},
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			if (href.includes("/messages/tool-msg/attachments/tool-att-b")) {
				return new Response(JSON.stringify({ size: 9, data: Buffer.from("PDF-BYTES").toString("base64url") }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(`Unexpected fetch URL: ${href}`);
		};

		try {
			const pi = createMockPi();
			gmailExtension(pi as never);

			const listResult = await findTool(pi.tools, "gmail_list_message_attachments").execute("call-1", { messageId: "tool-msg" });
			assert.match(listResult.content[0]?.text ?? "", /Attachments for message tool-msg/);
			assert.match(listResult.content[0]?.text ?? "", /status-report.pdf/);
			assert.match(listResult.content[0]?.text ?? "", /attachmentId: part:1/);

			const downloadResult = await findTool(pi.tools, "gmail_download_attachment").execute("call-2", {
				messageId: "tool-msg",
				attachmentId: "part:1",
			});
			assert.match(downloadResult.content[0]?.text ?? "", /Saved Gmail attachment: status-report.pdf/);
			const savedPath = String((downloadResult.details?.attachment as { savedPath: string }).savedPath);
			assert.ok(savedPath.includes(join(projectRoot, ".gmail-attachments")));
			assert.equal(await readFile(savedPath, "utf8"), "PDF-BYTES");

			await assert.rejects(
				() => findTool(pi.tools, "gmail_download_attachment").execute("call-3", {
					messageId: "tool-msg",
					attachmentId: "part:1",
					savePath: "../escape/status-report.pdf",
				}),
				/stay inside the current project/,
			);

			await assert.rejects(
				() => findTool(pi.tools, "gmail_download_attachment").execute("call-4", {
					messageId: "tool-msg",
					attachmentId: "part:1",
				}),
				/already exists/,
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
