/**
 * Production user builds keep vendor and transport diagnostics out of the UI.
 * Operators can opt into the dedicated diagnostics surface at build time.
 */
export const DIAGNOSTICS_ENABLED = import.meta.env?.VITE_ENABLE_DIAGNOSTICS === 'true';
