import {
  chainBlockNumberV1,
  chainGasLabelV1,
  chainLabelV1,
  providerUnavailableCopyV1,
  type ConsoleServerStatusV1,
} from './consoleFlow';
import type { SettingsProviderRowV1 } from './SettingsScreen';

// ---------------------------------------------------------------------------
// The rows of Settings that come straight from the server's own report:
// providers, network and the technical facts a bug report needs.
//
// One reading for the web's Settings page and the Base App's, so the two pages
// cannot disagree about what the same `/api/status` says.
// ---------------------------------------------------------------------------

/** The provider slots the status endpoint reports, and the word each one is
 * about. Named here so a server that stops reporting one drops it from the
 * list rather than showing a permanent failure for something it no longer has. */
export const SETTINGS_PROVIDER_SLOTS_V1 = [
  { key: 'prices', name: 'Prices', what: 'price' },
  { key: 'tokenBalances', name: 'Balances', what: 'balance' },
  { key: 'risk', name: 'Risk', what: 'risk' },
  { key: 'approvals', name: 'Approvals', what: 'approval' },
] as const;

/** What these rows read of `/api/status`, structurally. */
export type SettingsServerStatusV1 = ConsoleServerStatusV1 & {
  chainId?: number;
  chainEnv?: string;
  approvals?: { status: string; provider: string };
  productMigration: ConsoleServerStatusV1['productMigration'] & { b20ControlV1?: boolean };
};

export interface SettingsStatusRowsV1 {
  providers: SettingsProviderRowV1[];
  /** Set exactly when the report was not read: "none listed" must not read
   * as "none configured". */
  providersUnavailableReason: string | null;
  /** Set exactly when the report was not read. The adapter rows are built
   * from the server's flags, and an unread report reads every flag as off:
   * thirteen adapters drawn as `disabled` on a server where they are on. */
  adaptersUnavailableReason: string | null;
  network: { label: string; value: string; tone?: 'ok' | 'off' }[];
  technical: { label: string; value: string }[];
}

export function settingsStatusRowsV1(status: SettingsServerStatusV1 | null): SettingsStatusRowsV1 {
  return {
    providersUnavailableReason: status
      ? null
      : 'This server’s providers were not read, so none are listed. Nothing here is a statement about them.',
    adaptersUnavailableReason: status
      ? null
      : 'The server did not report its adapters, so none are listed. Nothing here is a statement about them.',
    // Read straight from the server's own report. A provider this server
    // never mentions is absent from the list rather than listed as broken.
    providers: SETTINGS_PROVIDER_SLOTS_V1.flatMap(({ key, name, what }) => {
      const provider = status?.[key];
      if (!provider) return [];
      return [
        {
          name,
          label:
            provider.status === 'connected'
              ? `${provider.provider} · connected`
              : providerUnavailableCopyV1(provider, what),
          tone: provider.status === 'connected' ? ('ok' as const) : ('off' as const),
        },
      ];
    }),
    network: [
      { label: 'Network', value: chainLabelV1(status?.chainId) },
      {
        label: 'RPC',
        value: status?.rpc?.status ?? 'unknown',
        tone: status?.rpc?.status === 'connected' ? 'ok' : 'off',
      },
      { label: 'Block', value: chainBlockNumberV1(status) ?? '—' },
      { label: 'Gas', value: chainGasLabelV1(status) ?? '—' },
    ],
    technical: [
      { label: 'Chain env', value: status?.chainEnv ?? 'not reported' },
      { label: 'Chain id', value: status?.chainId ? String(status.chainId) : 'not reported' },
      { label: 'Paid intelligence', value: status?.productMigration?.paidIntelligence === true ? 'on' : 'off' },
      { label: 'B20 Discover', value: status?.productMigration?.b20ControlV1 === true ? 'on' : 'off' },
    ],
  };
}
