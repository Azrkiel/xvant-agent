import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PromotionLedger, type LedgerEntry } from './ledger.ts';
import { evaluatePromotion, type BenchmarkReport } from './report.ts';

const name = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const kind = z.enum(['codex', 'claude', 'opencode']);
/** What a routing version decides: which model each role runs on. */
const settingsSchema = z.strictObject({
  /** Model per runtime; a runtime not named uses its own default. */
  models: z.partialRecord(kind, name),
  /** One worker plans and reviews on this model and implements nothing. */
  plannerModel: name.optional(),
});
export type RoutingSettings = z.infer<typeof settingsSchema>;
const profileSchema = z.strictObject({
  version: name,
  settings: settingsSchema,
  /** Absent only for a profile written by hand, such as the initial default. */
  provenance: z
    .strictObject({
      reportHash: z.string().regex(/^[0-9a-f]{64}$/),
      suiteId: z.string(),
      frozenHash: z.string(),
      configuration: z.string(),
      /** Tuning-split results only: held-out results decide promotion, not candidacy. */
      tuning: z.strictObject({
        scheduled: z.number().int(),
        accepted: z.number().int(),
      }),
      generatedAt: z.string(),
    })
    .optional(),
});
export type RoutingProfile = z.infer<typeof profileSchema>;

const sha = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex');
/** Hashes the settings alone, so two versions that route alike hash alike. */
export function settingsHash(settings: RoutingSettings): string {
  const models = Object.fromEntries(
    Object.entries(settings.models).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return sha(
    JSON.stringify([models, settings.plannerModel ?? null] satisfies unknown[]),
  );
}

/** The routing settings an orchestrated benchmark configuration ran with, or null if it was not orchestrated. */
export function settingsOf(
  versions: Record<string, string>,
): RoutingSettings | null {
  const runtime = kind.safeParse(versions.workerRuntime);
  if (versions.runtime !== 'xvant-orchestrated' || !runtime.success)
    return null;
  // `default` is how a record says the runtime chose its own model. It is
  // kept only beside a planner model, which needs to know its runtime.
  const named =
    versions.model && (versions.model !== 'default' || versions.plannerModel);
  return settingsSchema.parse({
    models: named ? { [runtime.data]: versions.model } : {},
    ...(versions.plannerModel ? { plannerModel: versions.plannerModel } : {}),
  });
}

/**
 * Candidate routing versions from a benchmark report. Every orchestrated
 * configuration that completed its tuning tasks and whose settings differ
 * from the current default becomes one; ranking uses tuning tasks only.
 * Nothing here changes the default: a candidate is a file until promoted.
 */
export function generateCandidates(
  report: BenchmarkReport,
  reportHash: string,
  current: RoutingSettings,
  now = new Date(),
): RoutingProfile[] {
  const tuning = report.bySplit.tuning ?? {};
  return Object.entries(report.configurations)
    .flatMap(([configuration, summary]) => {
      const settings = settingsOf(summary.versions);
      const split = tuning[configuration];
      if (!settings || !split || !split.scheduled) return [];
      if (summary.incomplete || summary.missing) return [];
      if (settingsHash(settings) === settingsHash(current)) return [];
      return [
        {
          version: (configuration + '-' + reportHash.slice(0, 8)).slice(-64),
          settings,
          provenance: {
            reportHash,
            suiteId: report.suiteId,
            frozenHash: report.frozenHash,
            configuration,
            tuning: { scheduled: split.scheduled, accepted: split.accepted },
            generatedAt: now.toISOString(),
          },
        },
      ];
    })
    .sort(
      (a, b) =>
        b.provenance.tuning.accepted / b.provenance.tuning.scheduled -
        a.provenance.tuning.accepted / a.provenance.tuning.scheduled,
    );
}

/**
 * Routing versions on disk: `profiles/` holds versions that are or were the
 * default, `candidates/` holds proposals, and the ledger names the default.
 * Only `active()` is read by a run, and it never looks at `candidates/`.
 */
export class RoutingProfiles {
  readonly #dir: string;
  readonly ledger: PromotionLedger;
  constructor(dir: string) {
    this.#dir = dir;
    this.ledger = new PromotionLedger(join(dir, 'ledger.json'));
  }
  #file(folder: 'profiles' | 'candidates', version: string) {
    return join(this.#dir, folder, name.parse(version) + '.json');
  }
  #load(folder: 'profiles' | 'candidates', version: string): RoutingProfile {
    const path = this.#file(folder, version);
    if (!existsSync(path)) throw new Error('PROFILE_NOT_FOUND: ' + version);
    return profileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  }
  #save(folder: 'profiles' | 'candidates', profile: RoutingProfile) {
    mkdirSync(join(this.#dir, folder), { recursive: true });
    writeFileSync(
      this.#file(folder, profile.version),
      JSON.stringify(profileSchema.parse(profile), null, 2) + '\n',
    );
  }
  /** The default a run uses, or null before `initialize`. A profile that no longer matches the ledger is refused. */
  active(): RoutingProfile | null {
    const entry = this.ledger.current();
    if (!entry) return null;
    const profile = this.#load('profiles', entry.version);
    if (settingsHash(profile.settings) !== entry.contentHash)
      throw new Error('PROFILE_HASH_MISMATCH: ' + entry.version);
    return profile;
  }
  /** Records the first known-good default. */
  initialize(profile: RoutingProfile, now = new Date()): void {
    if (this.ledger.current()) throw new Error('LEDGER_EXISTS');
    this.#save('profiles', profile);
    this.ledger.initialize(
      profile.version,
      settingsHash(profile.settings),
      now,
    );
  }
  addCandidate(profile: RoutingProfile): void {
    this.#save('candidates', profile);
  }
  candidates(): RoutingProfile[] {
    const dir = join(this.#dir, 'candidates');
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .sort()
          .map((f) => this.#load('candidates', f.slice(0, -5)))
      : [];
  }
  /**
   * Makes a candidate the default if the report's held-out results allow
   * it. The baseline is the configuration in the same report that ran with
   * the current default's settings; without one there is nothing to
   * compare against and the promotion is refused.
   */
  promote(
    version: string,
    report: BenchmarkReport,
    reportHash: string,
    options: {
      safetyFixturesPassed: boolean;
      /** The orchestration behaviour of the running code, as benchmark records name it. */
      orchestration: string;
    },
    now = new Date(),
  ): LedgerEntry {
    const current = this.active();
    if (!current) throw new Error('LEDGER_NOT_INITIALIZED');
    const candidate = this.#load('candidates', version);
    const configured = (settings: RoutingSettings) =>
      Object.entries(report.configurations)
        .filter(([, summary]) => {
          const ran = settingsOf(summary.versions);
          return ran && settingsHash(ran) === settingsHash(settings);
        })
        .map(([id]) => id);
    const [baseline] = configured(current.settings);
    const [evidence] = configured(candidate.settings);
    const blockers: string[] = [];
    if (!baseline)
      blockers.push('the current default was not benchmarked in this report');
    if (!evidence)
      blockers.push('the candidate was not benchmarked in this report');
    for (const id of [baseline, evidence])
      if (
        id &&
        (report.configurations[id]!.versions.orchestration ?? '1') !==
          options.orchestration
      )
        blockers.push(
          id + ' was benchmarked on an older orchestration behaviour',
        );
    const verdict =
      baseline && evidence
        ? evaluatePromotion(report, {
            baseline,
            candidate: evidence,
            safetyFixturesPassed: options.safetyFixturesPassed,
          })
        : { promote: false, benefits: [], blockers: [] };
    verdict.blockers.unshift(...blockers);
    verdict.promote = verdict.promote && !blockers.length;
    if (!verdict.promote)
      throw new Error('PROMOTION_BLOCKED: ' + verdict.blockers.join('; '));
    // Written first: a default the ledger names must always be loadable.
    this.#save('profiles', candidate);
    return this.ledger.promote(
      {
        version: candidate.version,
        contentHash: settingsHash(candidate.settings),
      },
      verdict,
      { reportHash, baseline: current.version },
      now,
    );
  }
  /** Restores the previous default. */
  rollback(): LedgerEntry {
    return this.ledger.rollback();
  }
}
