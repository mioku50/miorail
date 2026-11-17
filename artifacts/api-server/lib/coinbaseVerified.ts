import { decodeAbiParameters, parseAbi, type Address, type Hex } from 'viem';

// ---------------------------------------------------------------------------
// Whether a wallet holds Coinbase's "Verified Account" attestation on Base:
// Coinbase attests, through EAS, that the address belongs to a Coinbase
// account that passed its identity checks. It is read, never written: the
// indexer names the wallet's attestation, EAS holds it, and it counts only
// from Coinbase's attester, of the right schema, for this wallet, not revoked,
// not expired, and saying true. Checked against Base on 2026-11-17.
// ---------------------------------------------------------------------------

export const COINBASE_VERIFIED_V1 = {
  indexer: '0x2c7eE1E5f416dfF40054c27A62f7B357C4E8619C' as Address,
  eas: '0x4200000000000000000000000000000000000021' as Address,
  schema: '0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9' as Hex,
  attester: '0x357458739F90461b99789350868CD7CF330Dd7EE' as Address,
  /** Where a person gets one. */
  url: 'https://www.coinbase.com/onchain-verify',
} as const;

const INDEXER_ABI_V1 = parseAbi(['function getAttestationUid(address recipient, bytes32 schemaUid) view returns (bytes32)']);
const EAS_ABI_V1 = parseAbi([
  'struct Attestation { bytes32 uid; bytes32 schema; uint64 time; uint64 expirationTime; uint64 revocationTime; bytes32 refUID; address recipient; address attester; bool revocable; bytes data; }',
  'function getAttestation(bytes32 uid) view returns (Attestation)',
]);

/** The one read this needs: viem's PublicClient fits. */
export interface CoinbaseVerifiedReaderV1 {
  readContract(args: { address: Address; abi: unknown; functionName: string; args: readonly unknown[] }): Promise<unknown>;
}

const ZERO_V1 = `0x${'0'.repeat(64)}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** True when the wallet holds a live Verified Account attestation from Coinbase; throws when Base could not be read. */
export async function coinbaseVerifiedAccountV1(wallet: string, reader: CoinbaseVerifiedReaderV1, now: Date): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return false;
  const uid = await reader.readContract({
    address: COINBASE_VERIFIED_V1.indexer, abi: INDEXER_ABI_V1, functionName: 'getAttestationUid', args: [wallet as Address, COINBASE_VERIFIED_V1.schema],
  }) as Hex;
  if (typeof uid !== 'string' || uid.toLowerCase() === ZERO_V1) return false;
  const attestation = await reader.readContract({ address: COINBASE_VERIFIED_V1.eas, abi: EAS_ABI_V1, functionName: 'getAttestation', args: [uid] }) as {
    uid: Hex; schema: Hex; expirationTime: bigint; revocationTime: bigint; recipient: Address; attester: Address; data: Hex;
  };
  if (!attestation || !same(attestation.uid, uid) || !same(attestation.schema, COINBASE_VERIFIED_V1.schema) || !same(attestation.recipient, wallet)
    || !same(attestation.attester, COINBASE_VERIFIED_V1.attester) || attestation.revocationTime !== 0n) return false;
  if (attestation.expirationTime !== 0n && attestation.expirationTime <= BigInt(Math.floor(now.getTime() / 1000))) return false;
  try {
    const [verified] = decodeAbiParameters([{ type: 'bool' }], attestation.data);
    return verified === true;
  } catch {
    return false;
  }
}
