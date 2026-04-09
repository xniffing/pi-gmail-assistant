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
const ACTIVE_ACCOUNT_PATH = join(LOCAL_STATE_ROOT, "active-account.json");
const SHARED_CREDENTIALS_PATH = join(LOCAL_STATE_ROOT, "google-oauth-client.json");
const TOKEN_FILE_NAME = "gmail-tokens.json";

function getProjectStoreName(projectRoot: string): string {
	const projectName = basename(projectRoot) || "project";
	const hash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
	return `${projectName}-${hash}`;
}

function getLegacyProjectStorePaths(projectRoot = process.cwd()): GmailTokenStorePaths {
	const baseDir = join(LOCAL_STATE_ROOT, getProjectStoreName(projectRoot));
	return {
		baseDir,
		credentialsPath: join(baseDir, "google-oauth-client.json"),
		tokenPath: join(baseDir, TOKEN_FILE_NAME),
	};
}

function slugifyAccountEmail(email: string): string {
	return email.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "account";
}

function getAccountBaseDir(email: string): string {
	return join(LOCAL_STATE_ROOT, "accounts", slugifyAccountEmail(email));
}

function getAccountTokenStorePaths(email: string): GmailTokenStorePaths {
	const baseDir = getAccountBaseDir(email);
	return {
		baseDir,
		credentialsPath: SHARED_CREDENTIALS_PATH,
		tokenPath: join(baseDir, TOKEN_FILE_NAME),
	};
}

export function getDefaultTokenStorePaths(_projectRoot = process.cwd()): GmailTokenStorePaths {
	return {
		baseDir: LOCAL_STATE_ROOT,
		credentialsPath: SHARED_CREDENTIALS_PATH,
		tokenPath: join(LOCAL_STATE_ROOT, "accounts", "<active-account>", TOKEN_FILE_NAME),
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
	if (await pathExists(paths.credentialsPath)) {
		const rawJson = await readFile(paths.credentialsPath, "utf8");
		return parseOAuthClientCredentials(rawJson);
	}

	const legacyPaths = getLegacyProjectStorePaths();
	if (await pathExists(legacyPaths.credentialsPath)) {
		const rawJson = await readFile(legacyPaths.credentialsPath, "utf8");
		return parseOAuthClientCredentials(rawJson);
	}

	throw new Error(
		`Google OAuth credentials not found. Save the client JSON at ${paths.credentialsPath} with /gmail-auth init first.`,
	);
}

async function saveActiveAccountEmail(email: string): Promise<void> {
	await ensurePrivateDirectory(LOCAL_STATE_ROOT);
	await writePrivateJson(ACTIVE_ACCOUNT_PATH, { email: email.trim().toLowerCase() });
}

async function loadActiveAccountEmail(): Promise<string | undefined> {
	if (!(await pathExists(ACTIVE_ACCOUNT_PATH))) {
		return undefined;
	}

	const rawJson = await readFile(ACTIVE_ACCOUNT_PATH, "utf8");
	const payload = JSON.parse(rawJson) as Record<string, unknown>;
	return typeof payload.email === "string" && payload.email.trim() ? payload.email.trim().toLowerCase() : undefined;
}

export async function saveOAuthTokens(tokens: GoogleOAuthTokenSet, paths = getDefaultTokenStorePaths()): Promise<void> {
	await ensurePrivateDirectory(paths.baseDir);
	await writePrivateJson(paths.tokenPath, tokens);
}

export async function saveOAuthTokensForAccount(email: string, tokens: GoogleOAuthTokenSet): Promise<GmailTokenStorePaths> {
	const paths = getAccountTokenStorePaths(email);
	await ensurePrivateDirectory(paths.baseDir);
	await writePrivateJson(paths.tokenPath, tokens);
	await saveActiveAccountEmail(email);
	return paths;
}

export async function loadOAuthTokens(paths = getDefaultTokenStorePaths()): Promise<GoogleOAuthTokenSet | undefined> {
	const activeAccountEmail = await loadActiveAccountEmail();
	if (activeAccountEmail) {
		const accountPaths = getAccountTokenStorePaths(activeAccountEmail);
		if (await pathExists(accountPaths.tokenPath)) {
			const rawJson = await readFile(accountPaths.tokenPath, "utf8");
			return JSON.parse(rawJson) as GoogleOAuthTokenSet;
		}
	}

	if (await pathExists(paths.tokenPath)) {
		const rawJson = await readFile(paths.tokenPath, "utf8");
		return JSON.parse(rawJson) as GoogleOAuthTokenSet;
	}

	const legacyPaths = getLegacyProjectStorePaths();
	if (await pathExists(legacyPaths.tokenPath)) {
		const rawJson = await readFile(legacyPaths.tokenPath, "utf8");
		return JSON.parse(rawJson) as GoogleOAuthTokenSet;
	}

	return undefined;
}

export async function getGmailAuthStatus(paths = getDefaultTokenStorePaths()): Promise<GmailAuthStatus> {
	const activeAccountEmail = await loadActiveAccountEmail();
	const resolvedPaths = activeAccountEmail ? getAccountTokenStorePaths(activeAccountEmail) : paths;
	const tokenSet = await loadOAuthTokens(paths);
	const hasSharedCredentials = await pathExists(paths.credentialsPath);
	const hasLegacyCredentials = await pathExists(getLegacyProjectStorePaths().credentialsPath);
	return {
		paths: resolvedPaths,
		hasCredentials: hasSharedCredentials || hasLegacyCredentials,
		hasTokens: tokenSet !== undefined,
		activeAccountEmail,
		tokenExpiryIso: tokenSet?.expiryDate ? new Date(tokenSet.expiryDate).toISOString() : undefined,
	};
}
