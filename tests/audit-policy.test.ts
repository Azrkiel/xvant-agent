import { describe, expect, it } from 'vitest';
import {
  licenseProblems,
  listenProblems,
  lockfileProblems,
  secretFindings,
} from '../scripts/audit-policy.ts';

const pkg = (extra: object = {}) => ({
  version: '1.0.0',
  resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
  integrity: 'sha512-abc',
  license: 'MIT',
  ...extra,
});
const lock = (packages: Record<string, object>) => ({
  lockfileVersion: 3,
  packages: { '': {}, 'packages/core': {}, ...packages },
});

describe('release audit policy', () => {
  it('accepts registry packages with integrity hashes and allowed licences', () => {
    const good = lock({
      'node_modules/a': pkg(),
      'node_modules/b/node_modules/c': pkg({ license: '(MIT OR GPL-3.0)' }),
      'node_modules/@xvant/core': { resolved: 'packages/core', link: true },
    });
    expect(lockfileProblems(good)).toEqual([]);
    expect(licenseProblems(good)).toEqual([]);
  });
  it('rejects packages that could install unreviewed bytes', () => {
    expect(
      lockfileProblems(
        lock({
          'node_modules/a': pkg({ integrity: undefined }),
          'node_modules/b': pkg({ integrity: 'sha1-abc' }),
          'node_modules/c': pkg({ resolved: 'git+https://example.com/c.git' }),
          'node_modules/d': pkg({
            resolved: 'http://registry.npmjs.org/d.tgz',
          }),
        }),
      ),
    ).toEqual([
      'node_modules/a: no sha512 integrity hash',
      'node_modules/b: no sha512 integrity hash',
      'node_modules/c: not resolved from the npm registry',
      'node_modules/d: not resolved from the npm registry',
    ]);
    expect(lockfileProblems({ lockfileVersion: 1, packages: {} })).toEqual([
      'lockfileVersion must be 3 or later',
      'lockfile lists no installed packages',
    ]);
  });
  it('rejects missing, copyleft and partly disallowed licences', () => {
    expect(
      licenseProblems(
        lock({
          'node_modules/a': pkg({ license: undefined }),
          'node_modules/b': pkg({ license: 'GPL-3.0' }),
          'node_modules/c': pkg({ license: 'MIT AND GPL-3.0' }),
        }),
      ),
    ).toEqual([
      'node_modules/a: no licence recorded',
      'node_modules/b: licence GPL-3.0 is not on the allow list',
      'node_modules/c: licence MIT AND GPL-3.0 is not on the allow list',
    ]);
  });
  it('allows file-level copyleft only for development-only tools', () => {
    expect(
      licenseProblems(
        lock({
          'node_modules/tool': pkg({ license: 'MPL-2.0', dev: true }),
          'node_modules/shipped': pkg({ license: 'MPL-2.0' }),
          'node_modules/strong': pkg({ license: 'GPL-3.0', dev: true }),
        }),
      ),
    ).toEqual([
      'node_modules/shipped: licence MPL-2.0 is not on the allow list',
      'node_modules/strong: licence GPL-3.0 is not on the allow list',
    ]);
  });
  it('finds tracked secrets except where fakes are expected', () => {
    const key = 'ghp_' + 'a'.repeat(36);
    const files = [
      { path: 'src/config.ts', text: 'const token = "' + key + '";' },
      { path: 'deploy/.env', text: 'X=1' },
      { path: 'tests/secrets.test.ts', text: key },
      { path: 'README.md', text: 'no secrets here' },
      { path: 'big.bin', text: null },
    ];
    expect(secretFindings(files, (path) => path.startsWith('tests/'))).toEqual([
      'src/config.ts: contains a credential-shaped string',
      'deploy/.env: secret-bearing file name is tracked',
    ]);
  });
  it('requires every server to bind loopback explicitly', () => {
    expect(
      listenProblems([
        {
          path: 'apps/a.ts',
          text: "server.listen(0, '127.0.0.1', done);\nserver.listen(8080);\nserver.listen(0, '0.0.0.0');",
        },
      ]),
    ).toEqual([
      'apps/a.ts:2: listen() without the loopback address',
      'apps/a.ts:3: listen() without the loopback address',
    ]);
  });
});
