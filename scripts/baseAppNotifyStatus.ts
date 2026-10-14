import {
  BaseAppNotifyErrorV1,
  createBaseAppNotifyClientV1,
  type BaseAppNotifyClientV1,
  type BaseAppNotifyConfigV1,
} from './baseAppNotify.js';

export type BaseAppNotifyStatusV1 =
  | { state: 'off'; reason: null; optedIn: null }
  | { state: 'ready'; reason: null; optedIn: number }
  | { state: 'unavailable'; reason: string; optedIn: null };

/** A GET-only provider check. No queues, counts, RPC or notifications are
 * written. Configuration and a running timer are not proof of delivery. */
export async function baseAppNotifyStatusV1(input: {
  config: BaseAppNotifyConfigV1 | null;
  client?: BaseAppNotifyClientV1;
}): Promise<BaseAppNotifyStatusV1> {
  if (!input.config) return { state: 'off', reason: null, optedIn: null };
  const client = input.client ?? createBaseAppNotifyClientV1({ config: input.config });
  try {
    const wallets = await client.enabledWallets();
    return { state: 'ready', reason: null, optedIn: wallets.size };
  } catch (error) {
    let reason = 'provider_error';
    if (error instanceof BaseAppNotifyErrorV1) {
      if (error.message === 'base_app_notifications_retired') reason = 'provider_retired';
      else if (error.message === 'base_app_unreadable_body') reason = 'unreadable_subscriber_list';
      else if (error.message === 'base_app_subscribers_incomplete') reason = 'incomplete_subscriber_list';
      else if (error.status === 401) reason = 'authentication_refused';
      else if (error.status === 403) reason = 'access_refused';
      else if (error.status === 404) reason = 'provider_404';
      else if (error.status === 429) reason = 'provider_rate_limited';
      else if (error.status === null || error.status >= 500) reason = 'provider_unavailable';
    }
    return { state: 'unavailable', reason, optedIn: null };
  }
}
