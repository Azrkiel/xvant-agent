import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const entrySchema = z.strictObject({
  /** Names a routing or skill version, e.g. `skills-2026-10-03`. */
  version: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  contentHash: hash,
  promotedAt: z.string(),
  /** Absent only for the initial known-good version. */
  evidence: z
    .strictObject({
      reportHash: hash,
      baseline: z.string(),
      benefits: z.array(z.string()),
    })
    .optional(),
});
const ledgerSchema = z.strictObject({
  current: entrySchema,
  /** Earlier versions, oldest first; rollback restores the last one. */
  previous: z.array(entrySchema),
});
export type LedgerEntry = z.infer<typeof entrySchema>;
export interface PromotionVerdict {
  promote: boolean;
  benefits: string[];
  blockers: string[];
}

/**
 * Which routing/skill version is the production default. A candidate
 * becomes current only with a passing promotion verdict, and the version
 * it replaces is kept so one step restores it.
 */
export class PromotionLedger {
  readonly #path: string;
  constructor(path: string) {
    this.#path = path;
  }
  #read() {
    return existsSync(this.#path)
      ? ledgerSchema.parse(JSON.parse(readFileSync(this.#path, 'utf8')))
      : null;
  }
  #write(ledger: z.infer<typeof ledgerSchema>) {
    const temp = this.#path + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx' });
    renameSync(temp, this.#path);
  }
  current(): LedgerEntry | null {
    return this.#read()?.current ?? null;
  }
  history(): LedgerEntry[] {
    return this.#read()?.previous ?? [];
  }
  /** Records the first known-good version. */
  initialize(version: string, contentHash: string, now = new Date()): void {
    if (this.#read()) throw new Error('LEDGER_EXISTS');
    this.#write({
      current: { version, contentHash, promotedAt: now.toISOString() },
      previous: [],
    });
  }
  promote(
    candidate: { version: string; contentHash: string },
    verdict: PromotionVerdict,
    evidence: { reportHash: string; baseline: string },
    now = new Date(),
  ): LedgerEntry {
    const ledger = this.#read();
    if (!ledger) throw new Error('LEDGER_NOT_INITIALIZED');
    if (!verdict.promote || verdict.blockers.length)
      throw new Error('PROMOTION_BLOCKED: ' + verdict.blockers.join('; '));
    if (evidence.baseline !== ledger.current.version)
      throw new Error('BASELINE_IS_NOT_CURRENT');
    const entry: LedgerEntry = {
      ...candidate,
      promotedAt: now.toISOString(),
      evidence: { ...evidence, benefits: verdict.benefits },
    };
    this.#write({
      current: entry,
      previous: [...ledger.previous, ledger.current],
    });
    return entry;
  }
  /** Restores the previous known-good version. */
  rollback(): LedgerEntry {
    const ledger = this.#read();
    const restored = ledger?.previous.at(-1);
    if (!ledger || !restored) throw new Error('NO_PREVIOUS_VERSION');
    this.#write({ current: restored, previous: ledger.previous.slice(0, -1) });
    return restored;
  }
}
