// Stands in for '@reown/appkit/core' (vite.config.ts): WalletConnect's provider
// imports it only to open its QR modal, and the app never asks for one.
export function createAppKit(): never {
  throw new Error('walletconnect_modal_not_used');
}
