import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { baseMcpConnectHref } from '../lib/format';

interface BaseMcpConnectButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  returnTo: string;
  children: ReactNode;
}

/**
 * Opens OAuth synchronously from the user's click. This preserves
 * `window.opener`, which Base Account requires, and prevents an embedded Base
 * App from navigating its own frame to keys.coinbase.com.
 */
export function BaseMcpConnectButton({ returnTo, children, ...props }: BaseMcpConnectButtonProps) {
  return (
    <button
      type="button"
      {...props}
      onClick={() => {
        const popup = window.open(
          baseMcpConnectHref(returnTo),
          'miorail-base-mcp-oauth',
          'popup=yes,width=520,height=760,resizable=yes,scrollbars=yes',
        );
        if (!popup) {
          window.dispatchEvent(new CustomEvent('miorail:base-mcp-popup-blocked'));
          return;
        }
        popup.focus();
      }}
    >
      {children}
    </button>
  );
}
