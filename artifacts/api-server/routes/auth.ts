import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { createPublicClient, getAddress, http, isAddress } from 'viem';
import { base } from 'viem/chains';
import { db, users } from '@mioagent/db';
import { BASE_CHAIN_ID, type TenantUser } from '../middleware/tenantAuth';
import { invalidatePreparedTransactionsForUser } from '../lib/preparedTransactionStore.js';

export const authRouter = Router();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

type SignatureVerifier = (input: { address: `0x${string}`; message: string; signature: `0x${string}` }) => Promise<boolean>;

const baseClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL),
});

let verifyWalletSignature: SignatureVerifier = (input) => baseClient.verifyMessage(input);

export const authRouteRuntime = {
  ensureUser: async (userId: string) => {
    await db.insert(users).values({ id: userId }).onConflictDoNothing();
  },
  invalidatePreparedTransactions: invalidatePreparedTransactionsForUser,
};

export function setWalletSignatureVerifierForTests(verifier?: SignatureVerifier): void {
  verifyWalletSignature = verifier || ((input) => baseClient.verifyMessage(input));
}

function requestOrigin(req: Request): { domain: string; uri: string } {
  const configuredUri = process.env.WALLET_AUTH_URI?.trim();
  if (configuredUri) {
    const parsed = new URL(configuredUri);
    return { domain: process.env.WALLET_AUTH_DOMAIN?.trim() || parsed.host, uri: parsed.origin };
  }
  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProto === 'https' ? 'https' : req.protocol;
  const domain = process.env.WALLET_AUTH_DOMAIN?.trim() || req.get('host');
  if (!domain) throw new Error('wallet_auth_origin_unavailable');
  return { domain, uri: `${protocol}://${domain}` };
}

export function buildSiweMessage(input: {
  domain: string;
  uri: string;
  address: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}): string {
  return `${input.domain} wants you to sign in with your Ethereum account:\n${input.address}\n\nSign in to Miorail.\n\nURI: ${input.uri}\nVersion: 1\nChain ID: ${BASE_CHAIN_ID}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt}\nExpiration Time: ${input.expiresAt}`;
}

authRouter.post('/challenge', (req, res) => {
  const rawAddress = typeof req.body?.address === 'string' ? req.body.address : '';
  if (!isAddress(rawAddress)) {
    res.status(400).json({ error: 'invalid_wallet_address', code: 'invalid_wallet_address' });
    return;
  }
  const address = getAddress(rawAddress);
  const { domain, uri } = requestOrigin(req);
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = buildSiweMessage({ domain, uri, address, nonce, issuedAt, expiresAt });
  req.session.walletAuthChallenge = {
    address: address.toLowerCase() as `0x${string}`,
    nonce,
    domain,
    uri,
    message,
    expiresAt,
  };
  res.json({ nonce, message, expiresAt, chainId: BASE_CHAIN_ID });
});

authRouter.post('/verify', async (req, res) => {
  const challenge = req.session.walletAuthChallenge;
  // One attempt per challenge, including failed attempts, prevents replay and guessing.
  delete req.session.walletAuthChallenge;
  const message = typeof req.body?.message === 'string' ? req.body.message : '';
  const signature = typeof req.body?.signature === 'string' ? req.body.signature : '';
  if (!challenge || message !== challenge.message) {
    res.status(401).json({ error: 'challenge_invalid', code: 'challenge_invalid' });
    return;
  }
  if (Date.parse(challenge.expiresAt) <= Date.now()) {
    res.status(401).json({ error: 'challenge_expired', code: 'challenge_expired' });
    return;
  }
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    res.status(400).json({ error: 'invalid_signature', code: 'invalid_signature' });
    return;
  }

  let verified: boolean;
  try {
    verified = await verifyWalletSignature({
      address: challenge.address,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    verified = false;
  }
  if (!verified) {
    res.status(401).json({ error: 'signature_verification_failed', code: 'signature_verification_failed' });
    return;
  }

  const user: TenantUser = {
    id: `eip155:${BASE_CHAIN_ID}:${challenge.address}`,
    address: challenge.address,
    chainId: BASE_CHAIN_ID,
  };
  await authRouteRuntime.ensureUser(user.id);
  req.session.regenerate((error) => {
    if (error) {
      res.status(500).json({ error: 'session_creation_failed', code: 'session_creation_failed' });
      return;
    }
    req.session.user = user;
    req.session.save((saveError) => {
      if (saveError) {
        res.status(500).json({ error: 'session_creation_failed', code: 'session_creation_failed' });
        return;
      }
      res.json({ user });
    });
  });
});

authRouter.get('/session', (req, res) => {
  res.json({ user: req.session.user || null });
});

authRouter.post('/logout', async (req, res) => {
  const userId = req.session.user?.id;
  if (userId) {
    try {
      await authRouteRuntime.invalidatePreparedTransactions(userId);
    } catch {
      res.status(503).json({
        error: 'wallet_session_invalidation_failed',
        code: 'wallet_session_invalidation_failed',
      });
      return;
    }
  }
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});
