import { baseAppNotifyConfigV1 } from './baseAppNotify.js';
import { baseAppNotifyStatusV1 } from './baseAppNotifyStatus.js';
import { loadRootEnvFileV1 } from './loadEnvFile.js';

// The deploy's informational check only lists opt-ins. It never runs the
// sender, changes cursors or prints a provider body, URL or credential.
loadRootEnvFileV1();
baseAppNotifyStatusV1({ config: baseAppNotifyConfigV1(process.env) }).then((status) => {
  console.log(`${status.state}${status.reason ? ` ${status.reason}` : ''}`);
}).catch(() => {
  console.log('unavailable status_check_failed');
  process.exitCode = 1;
});
