import {
  DIVIDEND_ISSUERS_V1,
  readDividendReleaseV1,
  releaseTextV1,
  type DividendIssuerV1,
  type DividendSourceKindV1,
} from '@mioagent/rwa-market-reality/dividend-sources';
import {
  DIVIDEND_DECLARATIONS_V1,
  newYorkDateV1,
  shiftDateV1,
  type DividendDeclarationV1,
} from '@mioagent/rwa-market-reality/dividends';
import type {
  DividendDeclarationRepositoryV1,
  RwaSignalRepositoryV1,
  RwaSignalV1,
} from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// New dividend declarations, read from the companies' own releases.
//
// EDGAR for the three that file the declaration in an 8-K exhibit (Apple,
// Alphabet, NVIDIA), Microsoft's newsroom and PR Newswire for the two that
// announce it in a standalone release (Microsoft, Meta). Only a release from
// the last three days is read, so a pass is a few requests: the submissions
// list per company and one feed each, then only what is new.
//
// A declaration the registry already names is left to the registry. A new one
// is stored (migration 0076) and becomes a signal per Coinbase token of that
// company, except on the pass that opens the watch: what was declared before
// Miorail watched is history, not news.
//
// SEC asks automated clients to name themselves; the name here is the
// product's, never a person's address.
// ---------------------------------------------------------------------------

export const SEC_USER_AGENT_V1 = 'Miorail dividend calendar research (https://miorail.xyz)';
const FEED_USER_AGENT_V1 = 'Mozilla/5.0 (compatible; MiorailDividendCalendar/1.0; +https://miorail.xyz)';
const LOOKBACK_MS_V1 = 3 * 86_400_000;
/** A clock a little ahead of ours is a clock; a day ahead is a wrong date. */
const SKEW_MS_V1 = 86_400_000;

/** Within the lookback, and not from the future: a few minutes of skew is
 * read as now, because nothing can be observed before it was published. */
function recentV1(published: Date, now: Date): Date | null {
  const age = now.getTime() - published.getTime();
  if (!Number.isFinite(age) || age > LOOKBACK_MS_V1 || age < -SKEW_MS_V1) return null;
  return age < 0 ? now : published;
}
/** Documents per filing: the 8-K itself, its exhibits, rarely more. */
const DOCUMENTS_PER_FILING_V1 = 6;

export type DividendFetchV1 = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface DividendReleaseV1 {
  issuer: DividendIssuerV1;
  kind: DividendSourceKindV1;
  url: string;
  publisher: string;
  publishedAt: Date;
  html: string;
}

async function textOfV1(fetch: DividendFetchV1, url: string, sec: boolean): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': sec ? SEC_USER_AGENT_V1 : FEED_USER_AGENT_V1, Accept: '*/*' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`dividend_source_http_${response.status}`);
  return response.text();
}

interface SubmissionsV1 {
  filings?: { recent?: Record<string, unknown[]> };
}

/** Recent 8-K filings of one company, as EDGAR lists them. */
async function secReleasesV1(fetch: DividendFetchV1, issuer: DividendIssuerV1, now: Date): Promise<DividendReleaseV1[]> {
  const cik = issuer.cik!;
  const list = JSON.parse(await textOfV1(fetch, `https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`, true)) as SubmissionsV1;
  const recent = list.filings?.recent ?? {};
  const column = (name: string) => (Array.isArray(recent[name]) ? recent[name] : []);
  const forms = column('form');
  const releases: DividendReleaseV1[] = [];
  for (let index = 0; index < forms.length; index += 1) {
    if (forms[index] !== '8-K') continue;
    const accepted = recentV1(new Date(String(column('acceptanceDateTime')[index] ?? '')), now);
    if (!accepted) continue;
    const accession = String(column('accessionNumber')[index] ?? '');
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const folder = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replaceAll('-', '')}`;
    const index_ = JSON.parse(await textOfV1(fetch, `${folder}/index.json`, true)) as {
      directory?: { item?: Array<{ name?: unknown }> };
    };
    const documents = (index_.directory?.item ?? [])
      .map((item) => String(item.name ?? ''))
      .filter((name) => /^[\w.-]+\.html?$/i.test(name) && !/-index(-headers)?\.html?$/i.test(name) && !/^R\d+\.htm$/i.test(name))
      .slice(0, DOCUMENTS_PER_FILING_V1);
    for (const name of documents) {
      releases.push({
        issuer,
        kind: 'sec_8k',
        url: `${folder}/${name}`,
        publisher: issuer.filer ?? issuer.company,
        publishedAt: accepted,
        html: await textOfV1(fetch, `${folder}/${name}`, true),
      });
    }
  }
  return releases;
}

function tagV1(item: string, name: string): string | null {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(item);
  if (!match) return null;
  return match[1]!.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim();
}

/** The company's own release, found by its title in a feed. */
async function feedReleasesV1(fetch: DividendFetchV1, issuer: DividendIssuerV1, now: Date): Promise<DividendReleaseV1[]> {
  const feed = issuer.feed!;
  const xml = await textOfV1(fetch, feed.url, false);
  const releases: DividendReleaseV1[] = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const title = releaseTextV1(tagV1(item!, 'title') ?? '');
    const link = tagV1(item!, 'link') ?? '';
    const published = recentV1(new Date(tagV1(item!, 'pubDate') ?? ''), now);
    if (!feed.title.test(title) || !/^https:\/\//.test(link) || !published) continue;
    releases.push({
      issuer,
      kind: feed.kind,
      url: link,
      publisher: feed.publisher,
      publishedAt: published,
      html: await textOfV1(fetch, link, false),
    });
  }
  return releases;
}

export interface DividendWatchPassV1 {
  releasesRead: number;
  found: number;
  recorded: number;
  known: number;
  /** Same company and payment date, different words: left for review. */
  conflicts: string[];
  signalled: number;
  /** A release that reads like a declaration and matched no pattern. */
  unmatched: string[];
  refused: string[];
  failed: string[];
  openedWatch: boolean;
}

export async function runDividendDeclarationWatchV1(deps: {
  fetch: DividendFetchV1;
  now: Date;
  declarations: DividendDeclarationRepositoryV1;
  signals: Pick<RwaSignalRepositoryV1, 'openSignalWatch' | 'recordSignals'>;
  /** Coinbase's tokens for an underlying: each converts the dividend. */
  tokensOf: (underlyingKey: string) => Promise<string[]>;
  issuers?: readonly DividendIssuerV1[];
  registry?: readonly DividendDeclarationV1[];
}): Promise<DividendWatchPassV1> {
  const issuers = deps.issuers ?? DIVIDEND_ISSUERS_V1;
  const registry = deps.registry ?? DIVIDEND_DECLARATIONS_V1;
  const pass: DividendWatchPassV1 = {
    releasesRead: 0,
    found: 0,
    recorded: 0,
    known: 0,
    conflicts: [],
    signalled: 0,
    unmatched: [],
    refused: [],
    failed: [],
    openedWatch: false,
  };
  const nowIso = deps.now.toISOString();
  const [watch] = await deps.signals.openSignalWatch({ chainId: 8453, kinds: ['official_asset_dividend_declared'], at: nowIso });
  pass.openedWatch = watch?.openedNow ?? false;
  const watchingSince = Date.parse(watch?.watchingSince ?? nowIso);

  const releases: DividendReleaseV1[] = [];
  for (const issuer of issuers) {
    for (const [source, read] of [
      ['sec', issuer.cik ? () => secReleasesV1(deps.fetch, issuer, deps.now) : null],
      ['feed', issuer.feed ? () => feedReleasesV1(deps.fetch, issuer, deps.now) : null],
    ] as const) {
      if (!read) continue;
      try {
        releases.push(...(await read()));
      } catch (cause) {
        pass.failed.push(`${issuer.symbol}:${source}:${cause instanceof Error && /^dividend_source_http_\d+$/.test(cause.message) ? cause.message : 'error'}`);
      }
    }
  }
  pass.releasesRead = releases.length;

  const today = newYorkDateV1(deps.now);
  const oldest = shiftDateV1(today, -30);
  const signals: RwaSignalV1[] = [];
  for (const release of releases) {
    const text = releaseTextV1(release.html);
    const reading = readDividendReleaseV1({
      issuer: release.issuer,
      text,
      publishedAt: release.publishedAt,
      url: release.url,
      publisher: release.publisher,
    });
    pass.refused.push(...reading.refused);
    if (reading.declarations.length === 0 && reading.refused.length === 0 && /declared[^.]{0,120}dividend of \$\d/i.test(text)) {
      pass.unmatched.push(`${release.issuer.symbol}:${release.url}`);
    }
    for (const declaration of reading.declarations) {
      pass.found += 1;
      if (declaration.payDate < oldest) continue;
      if (registry.some((row) => row.underlyingKey === declaration.underlyingKey && row.payDate === declaration.payDate)) {
        pass.known += 1;
        continue;
      }
      const outcome = await deps.declarations.record({
        ...declaration,
        sourceKind: release.kind,
        publishedAt: release.publishedAt.toISOString(),
        observedAt: nowIso,
      });
      if (outcome === 'already_recorded') {
        pass.known += 1;
        continue;
      }
      if (outcome === 'conflict') {
        pass.conflicts.push(`${declaration.symbol}:${declaration.payDate}`);
        continue;
      }
      pass.recorded += 1;
      // Declared before Miorail watched, or already paid: stored, not news.
      if (pass.openedWatch || release.publishedAt.getTime() < watchingSince || declaration.payDate < today) continue;
      for (const token of await deps.tokensOf(declaration.underlyingKey)) {
        signals.push({
          kind: 'official_asset_dividend_declared',
          chainId: 8453,
          subjectAddress: token,
          officialAddress: null,
          occurredAt: release.publishedAt.toISOString(),
          dedupeKey: `dividend_declared:${token}:${declaration.payDate}`,
          facts: {
            underlyingKey: declaration.underlyingKey,
            symbol: declaration.symbol,
            company: declaration.company,
            amountPerShare: declaration.amountPerShare,
            declaredOn: declaration.declaredOn,
            exDate: declaration.exDate,
            recordDate: declaration.recordDate,
            payDate: declaration.payDate,
            sourceUrl: declaration.source.url,
          },
        });
      }
    }
  }
  if (signals.length > 0) {
    const outcome = await deps.signals.recordSignals({ chainId: 8453, recordedAt: nowIso, signals });
    pass.signalled = outcome.recorded.length;
  }
  return pass;
}
