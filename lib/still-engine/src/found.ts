// One bounded queue protects the shared RPC quota. Wallets live in RAM only; no disk or logs.
import type { Address } from 'viem';
import { createFoundReader, type FoundReadOptions } from './found-read.js';
import { emptyFoundReport, type FoundReport } from './found-report.js';

export interface FoundSource { current(address: Address): FoundReport | null }
export interface FoundSourceOptions extends FoundReadOptions {
  reader?: (address: Address, progress: (report: FoundReport) => void) => Promise<FoundReport>;
}

export function createFoundSource(options: FoundSourceOptions): FoundSource {
  const reader = options.reader ?? createFoundReader(options);
  const now = options.now ?? (() => new Date());
  const jobs = new Map<string, { report: FoundReport; at: number; active: boolean }>();
  const queue: Address[] = [];
  let running = false;

  async function drain() {
    if (running) return;
    running = true;
    try {
      let owner: Address | undefined;
      while ((owner = queue.shift())) {
        const job = jobs.get(owner.toLowerCase())!;
        job.report.state = 'reading';
        try { job.report = await reader(owner, (value) => { job.report = value; }); }
        catch {
          // No raw exception ever leaves this boundary: RPC messages may contain credentials.
          job.report.state = 'unavailable';
          job.report.valueCents = null;
          job.report.valueComplete = false;
          for (const v of job.report.venues) if (v.state !== 'complete') { v.state = 'partial'; v.issues.push('Our check could not finish.'); }
        }
        job.at = now().getTime();
        job.active = false;
      }
    } finally { running = false; }
  }

  return {
    current(owner) {
      const key = owner.toLowerCase();
      const hit = jobs.get(key);
      const ttl = hit?.report.state === 'complete' ? 120_000 : 30_000;
      if (hit && (hit.active || now().getTime() - hit.at < ttl)) return structuredClone(hit.report);
      if (queue.length >= 4) return null;
      for (const [key, job] of jobs) if (!job.active && now().getTime() - job.at > 120_000) jobs.delete(key);
      if (jobs.size >= 32) {
        const oldest = [...jobs].find(([, job]) => !job.active);
        if (oldest) jobs.delete(oldest[0]);
        else return null;
      }
      const job = { report: emptyFoundReport(owner), at: now().getTime(), active: true };
      jobs.set(key, job);
      queue.push(owner);
      void drain();
      return structuredClone(job.report);
    },
  };
}
