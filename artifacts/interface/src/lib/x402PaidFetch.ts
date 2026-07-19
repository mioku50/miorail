// T59 decision 10: the real implementation now lives in
// @mioagent/x402-actions/paidFetch (shared verbatim between web and
// miniapp — the miniapp previously had no x402 client at all). This file is
// kept as a thin re-export shim so every EXISTING import from
// '../../lib/x402PaidFetch' (PaidActionButton, Fuel actions, tests) keeps
// working unchanged.
export * from '@mioagent/x402-actions/paidFetch';
