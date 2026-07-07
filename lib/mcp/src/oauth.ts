import crypto from "node:crypto";
import { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
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
  state?: string | (() => string | Promise<string>);
  loadClientInformation?: () => OAuthClientInformationMixed | undefined | Promise<OAuthClientInformationMixed | undefined>;
  saveClientInformation?: (info: OAuthClientInformationMixed) => void | Promise<void>;
  loadTokens?: () => OAuthTokens | undefined | Promise<OAuthTokens | undefined>;
  saveTokens?: (tokens: OAuthTokens) => void | Promise<void>;
  loadCodeVerifier?: () => string | undefined | Promise<string | undefined>;
  saveCodeVerifier?: (codeVerifier: string) => void | Promise<void>;
  loadDiscoveryState?: () => OAuthDiscoveryState | undefined | Promise<OAuthDiscoveryState | undefined>;
  saveDiscoveryState?: (state: OAuthDiscoveryState) => void | Promise<void>;
  invalidateCredentials?: (scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') => void | Promise<void>;
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
      client_name: this._options.clientName || "Miorail",
      redirect_uris: this._options.redirectUrl ? [this._options.redirectUrl.toString()] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async state(): Promise<string> {
    if (typeof this._options.state === 'function') {
      const value = await this._options.state();
      if (!value) throw new Error('OAuth state is not configured');
      return value;
    }
    if (!this._options.state) throw new Error('OAuth state is not configured');
    return this._options.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined | Promise<OAuthClientInformationMixed | undefined> {
    if (this._options.loadClientInformation) {
      return this._options.loadClientInformation();
    }
    return this._clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this._clientInformation = info;
    await this._options.saveClientInformation?.(info);
  }

  tokens(): OAuthTokens | undefined | Promise<OAuthTokens | undefined> {
    if (this._options.loadTokens) {
      return this._options.loadTokens();
    }
    return this._tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this._tokens = tokens;
    await this._options.saveTokens?.(tokens);
  }

  redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    if (this._options.onRedirectToAuthorization) {
      return this._options.onRedirectToAuthorization(authorizationUrl);
    }
    // Default behavior if callback is not provided
    throw new Error(`Authorization required. Please visit: ${authorizationUrl.toString()}`);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this._codeVerifier = codeVerifier;
    await this._options.saveCodeVerifier?.(codeVerifier);
  }

  async codeVerifier(): Promise<string> {
    const loaded = this._options.loadCodeVerifier ? await this._options.loadCodeVerifier() : undefined;
    const verifier = loaded || this._codeVerifier;
    if (!verifier) {
      throw new Error("No code verifier found");
    }
    return verifier;
  }

  discoveryState(): OAuthDiscoveryState | undefined | Promise<OAuthDiscoveryState | undefined> {
    return this._options.loadDiscoveryState?.();
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this._options.saveDiscoveryState?.(state);
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'tokens') {
      this._tokens = undefined;
    }
    if (scope === 'all' || scope === 'client') {
      this._clientInformation = undefined;
    }
    if (scope === 'all' || scope === 'verifier') {
      this._codeVerifier = undefined;
    }
    await this._options.invalidateCredentials?.(scope);
  }
}
