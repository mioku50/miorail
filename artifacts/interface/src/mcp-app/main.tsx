import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';
import '@mioagent/ui/still.css';
import './card.css';
import { StillCard } from './StillCard';
import { createStillCardStoreV1, stillCardProjectIdV1, type StillCardHostV1 } from './stillCardStore';

// Still's review card in an assistant's chat (MCP Apps). The host renders this
// one file in a sandbox beside the result of a miorail_prepare_still_* tool;
// everything it shows comes from that result and from
// miorail_get_still_review_status, called through the host. It holds no key
// and signs nothing: the person's own wallet signs, on stills.lat or paired
// here by WalletConnect (StillCardSign).
const app = new App({ name: 'Still review', version: '1.0.0' }, {}, { autoResize: true });
const host = app as unknown as StillCardHostV1;
const store = createStillCardStoreV1(host);
// The server writes its WalletConnect project id into this file; without one the card offers stills.lat only.
const projectId = stillCardProjectIdV1(document);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StillCard store={store} host={host} projectId={projectId} />
  </StrictMode>,
);
