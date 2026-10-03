/** What the release check knows about one receipt file under docs/evidence. */
export interface ReceiptFacts {
  status: string;
  /** Source tree hash the run recorded, when it recorded one. */
  sourceHash: string | null;
  /** Whether an intact evidence bundle holds exactly this receipt. */
  bundle: 'intact' | 'partial' | 'missing' | 'tampered';
  /** Benchmark reports only. */
  complete?: boolean;
  suiteShapeProblems?: string[];
  /** The `runtime` each benchmarked configuration recorded. */
  runtimes?: string[];
}
export interface Requirement {
  id: string;
  state: 'met' | 'unmet' | 'deferred';
  detail: string;
}
export const PROFILES = ['local-beta', 'local-v1'] as const;
export type Profile = (typeof PROFILES)[number];

/** Offline gates are cumulative: a pass at a later phase reruns every earlier suite. */
const CUMULATIVE = [
  'G01',
  'G02',
  'G03',
  'G04',
  'G05',
  'G06',
  'G07',
  'G08',
  'G09',
  'G10',
];
/** local-beta leaves out the native loop (G08) and evaluation (G09). */
const OFFLINE: Record<Profile, string[]> = {
  'local-beta': CUMULATIVE.filter((id) => id !== 'G08' && id !== 'G09'),
  'local-v1': CUMULATIVE,
};
const LIVE: Record<Profile, string[]> = {
  'local-beta': [
    'G03-live-roster',
    'G04-live-handoff',
    'G05-live-mcp',
    'G06-live-parallel-feature',
  ],
  'local-v1': [
    'G03-live-roster',
    'G04-live-handoff',
    'G05-live-mcp',
    'G06-live-parallel-feature',
    'G08-live-native',
  ],
};

/**
 * Decides whether a release profile has complete evidence. A requirement is
 * met only by a receipt that passed and sits in an intact bundle; offline
 * gates must also have run on the current source tree. Nothing is inferred
 * from a missing, failed, skipped or stale receipt.
 */
export function evaluateRelease(
  profile: Profile,
  input: {
    receipts: Record<string, ReceiptFacts | undefined>;
    currentSourceHash: string;
    /** Operator decisions that defer a requirement instead of failing it. */
    deferred?: Record<string, string>;
  },
): { ready: boolean; requirements: Requirement[] } {
  const requirements: Requirement[] = [];
  const passed = (id: string): string | null => {
    const receipt = input.receipts[id];
    if (!receipt) return 'no receipt';
    if (receipt.status !== 'passed') return 'receipt is ' + receipt.status;
    if (receipt.bundle !== 'intact')
      return 'evidence bundle is ' + receipt.bundle;
    return null;
  };
  const fresh = (id: string) =>
    passed(id) ??
    (input.receipts[id]!.sourceHash === input.currentSourceHash
      ? null
      : 'receipt was produced on a different source tree; rerun the gate');
  const add = (id: string, problem: string | null, ok: string) =>
    requirements.push(
      problem === null
        ? { id, state: 'met', detail: ok }
        : { id, state: 'unmet', detail: problem },
    );

  add('G00', passed('G00'), 'compatibility and billing scope recorded');
  // The latest cumulative gate that is fresh covers the gates before it.
  const covering = CUMULATIVE.findLast((id) => fresh(id) === null);
  for (const id of OFFLINE[profile])
    add(
      id + ' offline',
      covering && CUMULATIVE.indexOf(id) <= CUMULATIVE.indexOf(covering)
        ? null
        : fresh(id),
      id === covering
        ? 'passed on the current source'
        : 'covered by ' + covering,
    );
  for (const id of LIVE[profile]) add(id, passed(id), 'passed live');
  add('G07 real-repository UI run', passed('G07-live-ui'), 'passed live');
  if (profile === 'local-v1') {
    const benchmark = input.receipts['benchmark-v1'];
    add(
      'benchmark-v1',
      !benchmark
        ? 'no report'
        : benchmark.complete !== true
          ? 'campaign is incomplete'
          : benchmark.suiteShapeProblems?.length
            ? 'suite is not the v1 benchmark: ' +
              benchmark.suiteShapeProblems.join('; ')
            : // A comparison needs XVANT itself and something to compare it with.
              !benchmark.runtimes?.includes('xvant-orchestrated')
              ? 'no XVANT-orchestrated configuration was benchmarked'
              : !benchmark.runtimes.some(
                    (r) =>
                      !['xvant-orchestrated', 'noop'].includes(r) &&
                      !r.startsWith('reference'),
                  )
                ? 'no single-runtime baseline was benchmarked'
                : null,
      'complete campaign on the frozen v1 suite with XVANT and a baseline',
    );
  }
  for (const [id, reason] of Object.entries(input.deferred ?? {}))
    requirements.push({ id, state: 'deferred', detail: reason });
  return {
    ready: requirements.every((r) => r.state !== 'unmet'),
    requirements,
  };
}
