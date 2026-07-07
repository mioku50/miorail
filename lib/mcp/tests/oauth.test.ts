import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert";
import { generateAuthorizationUrl, exchangeCodeForToken, OAuthConfig, BaseMcpOAuthProvider } from "../src/oauth.js";

const mockConfig: OAuthConfig = {
  clientId: "test-client",
  redirectUri: "http://localhost/callback",
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token"
};

describe("OAuth utilities", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("generateAuthorizationUrl should return a URL with correct parameters", () => {
    const { url, codeVerifier } = generateAuthorizationUrl(mockConfig);
    const parsedUrl = new URL(url);

    assert.strictEqual(parsedUrl.origin + parsedUrl.pathname, mockConfig.authorizationEndpoint);
    assert.strictEqual(parsedUrl.searchParams.get("client_id"), mockConfig.clientId);
    assert.strictEqual(parsedUrl.searchParams.get("redirect_uri"), mockConfig.redirectUri);
    assert.strictEqual(parsedUrl.searchParams.get("response_type"), "code");
    assert.strictEqual(parsedUrl.searchParams.get("code_challenge_method"), "S256");
    assert.ok(parsedUrl.searchParams.get("code_challenge"));
    assert.ok(codeVerifier);
    assert.strictEqual(codeVerifier.length, 43); // 32 bytes base64url encoded
  });

  it("exchangeCodeForToken should call the token endpoint correctly and return tokens", async () => {
    const mockResponse = {
      access_token: "mock-access-token",
      refresh_token: "mock-refresh-token",
      expires_in: 3600
    };

    mock.method(global, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.strictEqual(input, mockConfig.tokenEndpoint);
      assert.strictEqual(init?.method, "POST");
      assert.strictEqual((init?.headers as Record<string, string>)["Content-Type"], "application/x-www-form-urlencoded");

      const bodyParams = new URLSearchParams(init?.body as string);
      assert.strictEqual(bodyParams.get("client_id"), mockConfig.clientId);
      assert.strictEqual(bodyParams.get("grant_type"), "authorization_code");
      assert.strictEqual(bodyParams.get("code"), "mock-code");
      assert.strictEqual(bodyParams.get("redirect_uri"), mockConfig.redirectUri);
      assert.strictEqual(bodyParams.get("code_verifier"), "mock-verifier");

      return {
        ok: true,
        json: async () => mockResponse
      } as Response;
    });

    const tokens = await exchangeCodeForToken(mockConfig, "mock-code", "mock-verifier");

    assert.strictEqual(tokens.access_token, "mock-access-token");
    assert.strictEqual(tokens.refresh_token, "mock-refresh-token");
    assert.strictEqual(tokens.expires_in, 3600);
  });

  it("exchangeCodeForToken should throw an error if the response is not ok", async () => {
    mock.method(global, 'fetch', async () => {
      return {
        ok: false,
        statusText: "Bad Request"
      } as Response;
    });

    await assert.rejects(
      exchangeCodeForToken(mockConfig, "mock-code", "mock-verifier"),
      (err: Error) => err.message === "Failed to exchange code for token: Bad Request"
    );
  });
});

describe("BaseMcpOAuthProvider", () => {
  it("should initialize and return correctly", async () => {
    const provider = new BaseMcpOAuthProvider({
      redirectUrl: "http://localhost/callback"
    });

    assert.strictEqual(provider.redirectUrl, "http://localhost/callback");
    assert.deepStrictEqual(provider.clientMetadata, {
      client_name: "Miorail",
      redirect_uris: ["http://localhost/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });

    await provider.saveTokens({ access_token: "token123", token_type: "Bearer" });
    assert.deepStrictEqual(await provider.tokens(), { access_token: "token123", token_type: "Bearer" });

    await provider.saveCodeVerifier("verifier123");
    assert.strictEqual(await provider.codeVerifier(), "verifier123");
  });

  it("should throw on redirect if no callback provided", () => {
    const provider = new BaseMcpOAuthProvider();
    assert.throws(() => provider.redirectToAuthorization(new URL("http://example.com")));
  });

  it("should call callback on redirect", () => {
    let called = false;
    const provider = new BaseMcpOAuthProvider({
      onRedirectToAuthorization: (url) => {
        called = true;
        assert.strictEqual(url.toString(), "http://example.com/");
      }
    });
    provider.redirectToAuthorization(new URL("http://example.com"));
    assert.ok(called);
  });
});
