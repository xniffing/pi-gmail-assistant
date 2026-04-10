import assert from "node:assert/strict";
import test from "node:test";

import { buildGoogleConsentUrl, exchangeAuthorizationCode, internals, toPendingBootstrapState } from "../oauth.ts";

const TEST_CREDENTIALS = {
	clientId: "test-client-id",
	clientSecret: "test-client-secret",
	redirectUri: "http://127.0.0.1",
};

test("buildGoogleConsentUrl includes state and PKCE parameters", () => {
	const bootstrap = buildGoogleConsentUrl(TEST_CREDENTIALS);
	const url = new URL(bootstrap.consentUrl);

	assert.equal(url.searchParams.get("state"), bootstrap.state);
	assert.equal(url.searchParams.get("code_challenge"), bootstrap.codeChallenge);
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(bootstrap.codeChallenge, internals.createPkceCodeChallenge(bootstrap.codeVerifier));
});

test("exchangeAuthorizationCode verifies state and submits code_verifier", async () => {
	const bootstrap = buildGoogleConsentUrl(TEST_CREDENTIALS);
	const pendingBootstrap = toPendingBootstrapState(bootstrap);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		assert.equal(String(url), "https://oauth2.googleapis.com/token");
		const params = new URLSearchParams(String(init?.body ?? ""));
		assert.equal(params.get("grant_type"), "authorization_code");
		assert.equal(params.get("code_verifier"), bootstrap.codeVerifier);
		assert.equal(params.get("code"), "sample-code");
		return new Response(JSON.stringify({
			access_token: "fresh-token",
			expires_in: 3600,
			token_type: "Bearer",
		}), { status: 200, headers: { "content-type": "application/json" } });
	};

	try {
		const tokens = await exchangeAuthorizationCode(
			TEST_CREDENTIALS,
			`${TEST_CREDENTIALS.redirectUri}/?code=sample-code&state=${bootstrap.state}`,
			pendingBootstrap,
		);
		assert.equal(tokens.accessToken, "fresh-token");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("exchangeAuthorizationCode rejects missing or mismatched state when bootstrap is pending", async () => {
	const bootstrap = buildGoogleConsentUrl(TEST_CREDENTIALS);
	const pendingBootstrap = toPendingBootstrapState(bootstrap);

	await assert.rejects(
		() => exchangeAuthorizationCode(TEST_CREDENTIALS, `${TEST_CREDENTIALS.redirectUri}/?code=sample-code`, pendingBootstrap),
		/state query parameter/,
	);

	await assert.rejects(
		() => exchangeAuthorizationCode(TEST_CREDENTIALS, `${TEST_CREDENTIALS.redirectUri}/?code=sample-code&state=wrong-state`, pendingBootstrap),
		/OAuth state mismatch/,
	);

	await assert.rejects(
		() => exchangeAuthorizationCode(TEST_CREDENTIALS, "sample-code", pendingBootstrap),
		/full redirect URL/,
	);
});
