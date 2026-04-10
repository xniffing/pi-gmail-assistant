import { createHash, randomBytes } from "node:crypto";

import type {
	GmailOAuthBootstrapState,
	GmailOAuthPendingBootstrap,
	GoogleOAuthClientCredentials,
	GoogleOAuthCredentialsFile,
	GoogleOAuthTokenSet,
} from "./types.ts";
import { GMAIL_OAUTH_SCOPES } from "./types.ts";

const GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

export function parseOAuthClientCredentials(input: string | GoogleOAuthCredentialsFile): GoogleOAuthClientCredentials {
	const parsed = typeof input === "string" ? (JSON.parse(input) as GoogleOAuthCredentialsFile) : input;
	const candidate = parsed.installed ?? parsed.web;

	if (!candidate?.client_id) {
		throw new Error("OAuth client JSON must include installed.client_id or web.client_id.");
	}

	const redirectUri = candidate.redirect_uris?.[0];
	if (!redirectUri) {
		throw new Error("OAuth client JSON must include at least one redirect URI.");
	}

	return {
		clientId: candidate.client_id,
		clientSecret: candidate.client_secret,
		redirectUri,
	};
}

function toBase64Url(value: Buffer): string {
	return value.toString("base64url");
}

function createPkceCodeVerifier(): string {
	return toBase64Url(randomBytes(32));
}

function createPkceCodeChallenge(codeVerifier: string): string {
	return createHash("sha256").update(codeVerifier).digest("base64url");
}

function createOAuthState(): string {
	return toBase64Url(randomBytes(24));
}

export function buildGoogleConsentUrl(credentials: GoogleOAuthClientCredentials): GmailOAuthBootstrapState {
	const codeVerifier = createPkceCodeVerifier();
	const codeChallenge = createPkceCodeChallenge(codeVerifier);
	const state = createOAuthState();
	const params = new URLSearchParams({
		client_id: credentials.clientId,
		redirect_uri: credentials.redirectUri,
		response_type: "code",
		scope: GMAIL_OAUTH_SCOPES.join(" "),
		access_type: "offline",
		prompt: "consent",
		include_granted_scopes: "true",
		state,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
	});

	return {
		consentUrl: `${GOOGLE_OAUTH_AUTHORIZE_URL}?${params.toString()}`,
		scopes: GMAIL_OAUTH_SCOPES,
		redirectUri: credentials.redirectUri,
		state,
		codeVerifier,
		codeChallenge,
	};
}

export function toPendingBootstrapState(bootstrap: GmailOAuthBootstrapState): GmailOAuthPendingBootstrap {
	return {
		state: bootstrap.state,
		codeVerifier: bootstrap.codeVerifier,
		redirectUri: bootstrap.redirectUri,
		createdAt: Date.now(),
	};
}

export function extractAuthorizationResponse(input: string, pendingBootstrap?: GmailOAuthPendingBootstrap): { code: string; state?: string } {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Authorization code cannot be empty.");
	}

	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		const url = new URL(trimmed);
		const code = url.searchParams.get("code");
		if (!code) {
			throw new Error("Redirect URL did not contain a code query parameter.");
		}

		const state = url.searchParams.get("state") ?? undefined;
		if (pendingBootstrap) {
			if (!state) {
				throw new Error("Redirect URL did not contain a state query parameter. Restart with /gmail-auth start and paste the full redirect URL after approval.");
			}
			if (state !== pendingBootstrap.state) {
				throw new Error("OAuth state mismatch. Restart with /gmail-auth start and complete the consent flow again.");
			}
		}

		return { code, state };
	}

	if (pendingBootstrap) {
		throw new Error("Paste the full redirect URL returned by Google so Pi can verify OAuth state before exchanging the code.");
	}

	return { code: trimmed };
}

async function exchangeTokenRequest(params: URLSearchParams, errorPrefix: string): Promise<GoogleOAuthTokenSet> {
	const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
		},
		body: params,
	});

	const payload = (await response.json()) as Record<string, unknown>;
	if (!response.ok) {
		const message = typeof payload.error_description === "string"
			? payload.error_description
			: typeof payload.error === "string"
				? payload.error
				: `Token exchange failed with status ${response.status}`;
		throw new Error(`${errorPrefix}: ${message}`);
	}

	if (typeof payload.access_token !== "string") {
		throw new Error(`${errorPrefix}: response did not include access_token.`);
	}

	return {
		accessToken: payload.access_token,
		refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
		expiryDate:
			typeof payload.expires_in === "number"
				? Date.now() + payload.expires_in * 1000
				: undefined,
		scope: typeof payload.scope === "string" ? payload.scope : undefined,
		tokenType: typeof payload.token_type === "string" ? payload.token_type : undefined,
	};
}

export async function exchangeAuthorizationCode(
	credentials: GoogleOAuthClientCredentials,
	authorizationInput: string,
	pendingBootstrap?: GmailOAuthPendingBootstrap,
): Promise<GoogleOAuthTokenSet> {
	const authorizationResponse = extractAuthorizationResponse(authorizationInput, pendingBootstrap);
	const params = new URLSearchParams({
		code: authorizationResponse.code,
		client_id: credentials.clientId,
		redirect_uri: pendingBootstrap?.redirectUri ?? credentials.redirectUri,
		grant_type: "authorization_code",
	});

	if (pendingBootstrap?.codeVerifier) {
		params.set("code_verifier", pendingBootstrap.codeVerifier);
	}

	if (credentials.clientSecret) {
		params.set("client_secret", credentials.clientSecret);
	}

	return exchangeTokenRequest(params, "Google OAuth token exchange failed");
}

export async function refreshAccessToken(
	credentials: GoogleOAuthClientCredentials,
	refreshToken: string,
): Promise<GoogleOAuthTokenSet> {
	const trimmedRefreshToken = refreshToken.trim();
	if (!trimmedRefreshToken) {
		throw new Error("Cannot refresh Gmail access without a refresh token. Re-run /gmail-auth exchange.");
	}

	const params = new URLSearchParams({
		client_id: credentials.clientId,
		grant_type: "refresh_token",
		refresh_token: trimmedRefreshToken,
	});

	if (credentials.clientSecret) {
		params.set("client_secret", credentials.clientSecret);
	}

	const refreshedTokens = await exchangeTokenRequest(params, "Google OAuth token refresh failed");
	return {
		...refreshedTokens,
		refreshToken: refreshedTokens.refreshToken ?? trimmedRefreshToken,
	};
}

export async function fetchConnectedGmailAccountEmail(accessToken: string): Promise<string> {
	const response = await fetch(GMAIL_PROFILE_URL, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		},
	});

	const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) {
		const message = typeof payload.error === "object" && payload.error !== null && typeof (payload.error as Record<string, unknown>).message === "string"
			? (payload.error as Record<string, unknown>).message as string
			: `Failed to fetch Gmail profile with status ${response.status}`;
		throw new Error(`Google OAuth succeeded, but Gmail profile lookup failed: ${message}`);
	}

	if (typeof payload.emailAddress !== "string" || payload.emailAddress.trim() === "") {
		throw new Error("Google OAuth succeeded, but Gmail profile lookup did not return an email address.");
	}

	return payload.emailAddress.trim().toLowerCase();
}

export const internals = {
	createPkceCodeVerifier,
	createPkceCodeChallenge,
	createOAuthState,
	extractAuthorizationResponse,
};
