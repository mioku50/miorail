/**
 * How the Base Account connector is created.
 *
 * `telemetry: false`. Left on, the library adds an inline `<script>` to every page as it loads:
 * Coinbase's ClientAnalytics, with a session and a device identifier of its own, before anyone has
 * chosen a wallet. Found on 2026-11-12 as the one thing in our own bundle that breaks the page's
 * script rule (audit AUTH-7): an inline script is exactly what that rule exists to stop, and a page
 * that signs loans has no reason to carry a third party's analytics. The switch is the library's own
 * ("Whether to enable functional telemetry", default true); signing does not depend on it.
 */
export const BASE_ACCOUNT_PREFERENCE_V1 = { telemetry: false } as const;
