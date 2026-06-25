import crypto from "node:crypto";
import { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface OAuthConfig {
  clientId: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export function generateAuthorizationUrl(config: OAuthConfig) {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return {
    url: url.toString(),
    codeVerifier,
  };
}

export async function exchangeCodeForToken(config: OAuthConfig, code: string, codeVerifier: string): Promise<OAuthTokens> {
  const body = new URLSearchParams();
  body.set('client_id', config.clientId);
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', config.redirectUri);
  body.set('code_verifier', codeVerifier);

  const response = await fetch(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  if (!response.ok) {
    throw new Error(`Failed to exchange code for token: ${response.statusText}`);
  }

  const data = await response.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    token_type: data.token_type || "Bearer"
  };
}

export interface BaseMcpOAuthProviderOptions {
  redirectUrl?: string | URL;
  clientName?: string;
  clientInformation?: OAuthClientInformationMixed;
  onRedirectToAuthorization?: (authorizationUrl: URL) => void | Promise<void>;
  tokens?: OAuthTokens;
}

export class BaseMcpOAuthProvider implements OAuthClientProvider {
  private _tokens?: OAuthTokens;
  private _codeVerifier?: string;
  private _clientInformation?: OAuthClientInformationMixed;
  private _options: BaseMcpOAuthProviderOptions;

  constructor(options: BaseMcpOAuthProviderOptions = {}) {
    this._options = options;
    this._clientInformation = options.clientInformation;
    this._tokens = options.tokens;
  }

  get redirectUrl(): string | URL | undefined {
    return this._options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this._options.clientName || "MioAgent", redirect_uris: this._options.redirectUrl ? [this._options.redirectUrl.toString()] : []
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this._clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this._clientInformation = info;
  }

  tokens(): OAuthTokens | undefined {
    return this._tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    if (this._options.onRedirectToAuthorization) {
      return this._options.onRedirectToAuthorization(authorizationUrl);
    }
    // Default behavior if callback is not provided
    throw new Error(`Authorization required. Please visit: ${authorizationUrl.toString()}`);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this._codeVerifier) {
      throw new Error("No code verifier found");
    }
    return this._codeVerifier;
  }
}
