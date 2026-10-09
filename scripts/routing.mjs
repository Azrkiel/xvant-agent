// The routing default: which model each role runs on, and how it changes.
// Usage: node scripts/routing.mjs status
//        node scripts/routing.mjs init [--version NAME] [--model KIND=MODEL]... [--planner-model MODEL]
//        node scripts/routing.mjs candidates --report FILE
//        node scripts/routing.mjs promote --candidate VERSION --report FILE
//        node scripts/routing.mjs rollback
// `xvant run` and the app apply the default; candidates are files they never
// read. A candidate becomes the default only if the report's held-out
// results beat the configuration that ran with the current default, on the
// current orchestration behaviour, with a passing offline gate on this source.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  RoutingProfiles,
  generateCandidates,
} from '../packages/evaluation/src/profile.ts';
import { routingDir } from '../apps/controller/src/routing-default.ts';
import { spawnSync } from 'node:child_process';
import { ORCHESTRATION_VERSION } from '../apps/controller/src/orchestrator.ts';

const home = resolve(process.env.XVANT_HOME ?? join(homedir(), '.xvant'));
const [command, ...rest] = process.argv.slice(2);
const values = (name) =>
  rest.flatMap((arg, i) => (arg === name ? [rest[i + 1]] : [])).filter(Boolean);
const value = (name) => values(name)[0];
const profiles = new RoutingProfiles(routingDir(home));
const describe = (settings) =>
  [
    ...Object.entries(settings.models).map(([k, m]) => k + '=' + m),
    ...(settings.plannerModel ? ['planner=' + settings.plannerModel] : []),
  ].join(' ') || "each runtime's own model";
const readReport = () => {
  const file = value('--report');
  if (!file || !existsSync(file)) {
    console.error('--report FILE is required and must exist');
    process.exit(2);
  }
  const bytes = readFileSync(file);
  return {
    report: JSON.parse(bytes.toString('utf8')),
    reportHash: createHash('sha256').update(bytes).digest('hex'),
  };
};
// The mandatory safety and recovery fixtures are the cumulative offline gate.
// The release check decides whether it passed on this source, bundle included.
const gatePassed = () => {
  const check = spawnSync(
    process.execPath,
    ['scripts/release-check.mjs', '--profile', 'local-v1', '--json'],
    { encoding: 'utf8', windowsHide: true },
  );
  try {
    return (
      JSON.parse(check.stdout).requirements.find((r) => r.id === 'G10 offline')
        ?.state === 'met'
    );
  } catch {
    return false;
  }
};

try {
  if (command === 'status') {
    const current = profiles.active();
    console.log(
      current
        ? 'default    ' + current.version + '  ' + describe(current.settings)
        : 'default    none recorded (each runtime uses its own model)',
    );
    for (const entry of profiles.ledger.history())
      console.log('previous   ' + entry.version);
    for (const c of profiles.candidates())
      console.log(
        'candidate  ' +
          c.version +
          '  ' +
          describe(c.settings) +
          (c.provenance
            ? '  tuning ' +
              c.provenance.tuning.accepted +
              '/' +
              c.provenance.tuning.scheduled
            : ''),
      );
  } else if (command === 'init') {
    const models = Object.fromEntries(
      values('--model').map((pair) => {
        const [kind, model, more] = pair.split('=');
        if (!kind || !model || more !== undefined)
          throw new Error('--model needs KIND=MODEL, e.g. claude=haiku');
        return [kind, model];
      }),
    );
    const plannerModel = value('--planner-model');
    const profile = {
      version: value('--version') ?? 'default',
      settings: { models, ...(plannerModel ? { plannerModel } : {}) },
    };
    profiles.initialize(profile);
    console.log(
      'default    ' + profile.version + '  ' + describe(profile.settings),
    );
  } else if (command === 'candidates') {
    const { report, reportHash } = readReport();
    const current = profiles.active();
    if (!current) throw new Error('LEDGER_NOT_INITIALIZED');
    const candidates = generateCandidates(report, reportHash, current.settings);
    for (const c of candidates) {
      profiles.addCandidate(c);
      console.log(
        'candidate  ' +
          c.version +
          '  ' +
          describe(c.settings) +
          '  tuning ' +
          c.provenance.tuning.accepted +
          '/' +
          c.provenance.tuning.scheduled,
      );
    }
    if (!candidates.length)
      console.log(
        'No candidate: the report has no finished orchestrated configuration that differs from the default.',
      );
  } else if (command === 'promote') {
    const { report, reportHash } = readReport();
    const entry = profiles.promote(
      value('--candidate') ?? '',
      report,
      reportHash,
      {
        safetyFixturesPassed: gatePassed(),
        orchestration: ORCHESTRATION_VERSION,
      },
    );
    console.log(
      'default    ' +
        entry.version +
        '  (' +
        entry.evidence.benefits.join('; ') +
        ')',
    );
  } else if (command === 'rollback') {
    console.log('default    ' + profiles.rollback().version);
  } else {
    console.error(
      'Usage: node scripts/routing.mjs status | init | candidates --report FILE | promote --candidate VERSION --report FILE | rollback',
    );
    process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
