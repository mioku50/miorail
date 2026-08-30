/*
 * Phase 15.1 — manual launch check, run by a human.
 *
 * WHAT IT IS
 *   The one part of the Stocks smoke that cannot be automated from a shell: it
 *   needs a real signed wallet session, and Miorail never holds a key. So a
 *   person opens the product, pastes this in, and pastes the result back.
 *
 * HOW TO RUN
 *   1. Sign in at https://miorail.xyz/market with your wallet.
 *   2. Open DevTools (F12) -> Console.
 *   3. Paste this whole file and press Enter.
 *   4. The result prints and is copied to the clipboard. Paste it into the
 *      Phase 15.1 report.
 *
 * WHAT IT DOES
 *   - asks Ask Miorail three questions: a suggested one, a valid custom one,
 *     and one deliberately out of scope;
 *   - reads Radar, adds ONE exact watch, reads it back, and removes it again.
 *
 * WHAT IT WILL NEVER DO
 *   It never signs, never submits and never asks a wallet for anything. No
 *   transaction, no approval, no route payload, no signature request, no
 *   execution endpoint. Every call below is a read, an Ask, or the Radar watch
 *   it also deletes. Nothing here spends anything.
 *
 * The question is fixed to NVIDIA at $1,000 SELL into USDC because that is the
 * only underlying in the reviewed corpus with three representations, which is
 * what makes the comparison worth reading. Edit KEY/Q for another one.
 */
(async () => {
  const BASE = '/api/route-intelligence/rwa';
  const KEY = 'security:isin:US67066G1040'; // NVIDIA
  const Q = 'direction=sell&requestedCashAtomic=1000000000&destination=USDC';

  const post = (url, body) =>
    fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (url) => fetch(url, { credentials: 'same-origin' });

  const out = { ranAt: new Date().toISOString(), question: { KEY, Q }, ask: [], radar: {} };

  // ---- Ask Miorail -------------------------------------------------------
  const questions = [
    ['suggested', 'What did Miorail establish here, and what did it not?'],
    ['custom', 'Which representation returned cash at this size, and when was it measured?'],
    ['out_of_scope', 'Should I buy NVIDIA stock and what will the price be next week?'],
  ];
  for (const [kind, question] of questions) {
    const started = performance.now();
    const response = await post(
      `${BASE}/market-reality/${encodeURIComponent(KEY)}/ask?${Q}`,
      { question },
    );
    const body = await response.json().catch(() => ({}));
    out.ask.push({
      kind,
      asked: question,
      http: response.status,
      ms: Math.round(performance.now() - started),
      answerSource: body.answerSource,
      refused: body.refused,
      quoteOnly: body.quoteOnly,
      executionEvidenceIncluded: body.executionEvidenceIncluded,
      // The echo proves the answer is about the question on screen.
      echo: body.question,
      subjects: body.answer?.subjects,
      established: body.answer?.established,
      notEstablished: body.answer?.notEstablished,
      explanation: body.answer?.explanation,
      // Every citation must resolve to one of these ids.
      evidence: body.evidence,
      error: body.error,
      detail: body.detail,
    });
  }

  // ---- Radar: read, add one exact watch, read back, remove ---------------
  out.radar.before = await (await get(`${BASE}/radar`)).json().catch(() => ({}));

  const reality = await (
    await get(`${BASE}/market-reality/${encodeURIComponent(KEY)}?${Q}`)
  ).json().catch(() => ({}));
  const representation = (reality.representations || []).find(
    (row) => row.supply?.state === 'positive_supply' && row.routePolicyKey,
  );

  if (!representation) {
    out.radar.note =
      'no positive-supply representation with a route policy on this question, so no watch was attempted';
  } else {
    const added = await post(`${BASE}/radar/watches`, {
      underlyingKey: KEY,
      tokenAddress: representation.tokenAddress,
      direction: 'sell',
      requestedCashAtomic: '1000000000',
      destination: 'USDC',
      routePolicyKey: representation.routePolicyKey,
      approvedSources: [...new Set(representation.sources.map((s) => s.source))].sort(),
    });
    out.radar.addHttp = added.status;
    out.radar.afterAdd = await added.json().catch(() => ({}));
    const watch = (out.radar.afterAdd.watches || []).find(
      (row) => row.tokenAddress === representation.tokenAddress,
    );
    // The exact question identity, as Radar stored it.
    out.radar.watch = watch;
    if (watch) {
      const removed = await fetch(`${BASE}/radar/watches/${encodeURIComponent(watch.watchId)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      out.radar.removeHttp = removed.status;
      out.radar.afterRemove = await removed.json().catch(() => ({}));
      out.radar.removedCleanly =
        !(out.radar.afterRemove.watches || []).some((row) => row.watchId === watch.watchId);
    }
  }

  const text = JSON.stringify(out, null, 2);
  console.log(text);
  try {
    copy(JSON.stringify(out));
    console.log('--- result copied to clipboard ---');
  } catch {
    console.log('--- copy() unavailable; copy the JSON above by hand ---');
  }
})();
