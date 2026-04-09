import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import { parseOAuthClientCredentials } from "./oauth.ts";
import type {
	GmailAuthStatus,
	GmailTokenStorePaths,
	GoogleOAuthClientCredentials,
	GoogleOAuthTokenSet,
} from "./types.ts";

const LOCAL_STATE_ROOT = join(homedir(), ".config", "automation", "gmail");

function getProjectStoreName(projectRoot: string): string {
	const projectName = basename(projectRoot) || "project";
	const hash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
	return `${projectName}-${hash}`;
}

export function getDefaultTokenStorePaths(projectRoot = process.cwd()): GmailTokenStorePaths {
	const baseDir = join(LOCAL_STATE_ROOT, getProjectStoreName(projectRoot));
	return {
		baseDir,
		credentialsPath: join(baseDir, "google-oauth-client.json"),
		tokenPath: join(baseDir, "gmail-tokens.json"),
	};
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await chmod(path, 0o600);
}

export async function saveOAuthClientCredentials(rawJson: string, paths = getDefaultTokenStorePaths()): Promise<GoogleOAuthClientCredentials> {
	const parsedCredentials = parseOAuthClientCredentials(rawJson);
	await ensurePrivateDirectory(paths.baseDir);
	await writePrivateJson(paths.credentialsPath, JSON.parse(rawJson) as unknown);
	return parsedCredentials;
}

export async function loadOAuthClientCredentials(paths = getDefaultTokenStorePaths()): Promise<GoogleOAuthClientCredentials> {
	if (!(await pathExists(paths.credentialsPath))) {
		throw new Error(
			`Google OAuth credentials not found. Save the client JSON at ${paths.credentialsPath} with /gmail-auth init first.`,
		);
	}

	const rawJson = await readFile(paths.credentialsPath, "utf8");
	return parseOAuthClientCredentials(rawJson);
}

export async function saveOAuthTokens(tokens: GoogleOAuthTokenSet, paths = getDefaultTokenStorePaths()): Promise<void> {
	await ensurePrivateDirectory(paths.baseDir);
	await writePrivateJson(paths.tokenPath, tokens);
}

export async function loadOAuthTokens(paths = getDefaultTokenStorePaths()): Promise<GoogleOAuthTokenSet | undefined> {
	if (!(await pathExists(paths.tokenPath))) {
		return undefined;
	}

	const rawJson = await readFile(paths.tokenPath, "utf8");
	return JSON.parse(rawJson) as GoogleOAuthTokenSet;
}

export async function getGmailAuthStatus(paths = getDefaultTokenStorePaths()): Promise<GmailAuthStatus> {
	const tokenSet = await loadOAuthTokens(paths);
	return {
		paths,
		hasCredentials: await pathExists(paths.credentialsPath),
		hasTokens: tokenSet !== undefined,
		tokenExpiryIso: tokenSet?.expiryDate ? new Date(tokenSet.expiryDate).toISOString() : undefined,
	};
}
