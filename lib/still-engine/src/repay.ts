// ---------------------------------------------------------------------------
// The bound for "Repay all", in one place (audit LEND-2, 2026-11-10).
//
// A debt grows every second, and a repayment lands some time after it was
// read. Aave takes the smaller of the debt and the bound when it lands: a
// bound with no room above the debt read repays the bound and leaves the
// interest since owing. So Repay all is asked with room, the page's Max
// offers this bound, and the server refuses an Aave Repay all below it.
//
// The room is one cent, or 0.1% of the debt when that is more, above the debt
// rounded up to the cent. 0.1% is about three and a half days of interest at
// 10% a year. What is not needed stays in the wallet.
//
// No BigInt literals here: the page's bundle carries this file too.
// ---------------------------------------------------------------------------

const CENT = BigInt(10_000);
const upToCent = (value: bigint): bigint => ((value + CENT - BigInt(1)) / CENT) * CENT;

/** USDC base units: the least bound a Repay all of this debt is asked with. */
export function repayAllBoundAtomicV1(debtAtomic: bigint | string): bigint {
  const debt = BigInt(debtAtomic);
  const perMille = upToCent((debt + BigInt(999)) / BigInt(1_000));
  return upToCent(debt) + (perMille > CENT ? perMille : CENT);
}
