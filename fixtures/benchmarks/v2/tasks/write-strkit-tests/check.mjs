import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sha = (data) => createHash('sha256').update(data).digest('hex');
function treeHash(root) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, prefix + name + '/');
      else files.push(prefix + name + '\0' + sha(readFileSync(path)));
    }
  };
  walk(root, '');
  return sha(files.join('\n'));
}
assert.equal(treeHash('src'), '3d96f006c3a16de03f2b887604330592a9e55c06bcd9d2d49080f48dde0588a4', 'the source under src/ must stay unchanged');

const runTest = (file, cwd) =>
  spawnSync(process.execPath, [file], { cwd, encoding: 'utf8', timeout: 30_000 });

// Every test file exists and passes against the unchanged source.
const files = { slug: 'test/slug.test.mjs', wrap: 'test/wrap.test.mjs', semver: 'test/semver.test.mjs', csv: 'test/csv.test.mjs' };
for (const file of Object.values(files)) {
  assert.ok(existsSync(file), file + ' exists');
  const run = runTest(file, process.cwd());
  assert.equal(run.status, 0, file + ' passes on the current source:\n' + run.stderr);
}

// Each test file must fail when the behaviour of its module is broken in one of these ways.
const mutants = {
  slug: [
    ['src/text/slug.js', '\n    .toLowerCase()', '', 'letters are no longer lowercased'],
    ['src/text/slug.js', '/[^a-z0-9]+/g', '/[^a-z0-9]/g', 'runs of separators are no longer collapsed'],
    ['src/text/slug.js', "\n    .replace(/^-+|-+$/g, '')", '', 'leading and trailing hyphens are kept'],
    ['src/text/slug.js', "\n    .replace(/\\p{M}/gu, '')", '', 'accents are no longer stripped'],
    ['src/text/slug.js', "base.slice(0, maxLength).replace(/-+$/, '')", 'base.slice(0, maxLength)', 'a hyphen is left at the cut'],
    ['src/text/slug.js', 'base.slice(0, maxLength)', 'base.slice(0, maxLength + 1)', 'the cut is one character too long'],
  ],
  wrap: [
    ['src/text/wrap.js', 'line.length + 1 + word.length <= width', 'line.length + 1 + word.length < width', 'a line can no longer be exactly width long'],
    ['src/text/wrap.js', 'line.length + 1 + word.length <= width', 'line.length + word.length <= width', 'the space is not counted'],
    ['src/text/wrap.js', 'width < 1', 'width < 0', 'width 0 is accepted'],
    ['src/text/wrap.js', '!Number.isInteger(width) || ', '', 'a fractional width is accepted'],
    ['src/text/wrap.js', "split('\\n')", "split('\\n\\n')", 'single line breaks no longer start a paragraph'],
    ['src/util/strings.js', '.filter(Boolean)', '', 'empty words from extra whitespace are kept'],
  ],
  semver: [
    ['src/version/parse.js', '/^(\\d+)', '/(\\d+)', 'a prefix before the version is accepted'],
    ['src/version/parse.js', ')?$/;', ')?/;', 'text after the version is accepted'],
    ['src/version/parse.js', "throw new SyntaxError('invalid version: ' + text);", 'return null;', 'invalid versions no longer throw'],
    ['src/version/parse.js', 'Number(match[2])', 'Number(match[3])', 'minor is read from the patch part'],
    ['src/version/compare.js', "['major', 'minor', 'patch']", "['major', 'patch']", 'minor is ignored'],
    ['src/version/compare.js', 'return x[part] < y[part] ? -1 : 1;', 'return x[part] < y[part] ? 1 : -1;', 'number parts compare in reverse'],
    ['src/version/compare.js', 'return a.length === 0 ? 1 : -1;', 'return a.length === 0 ? -1 : 1;', 'a prerelease ranks above its release'],
    ['src/version/compare.js', 'Number(a[i]) < Number(b[i])', 'a[i] < b[i]', 'numeric identifiers compare as text'],
    ['src/version/compare.js', 'return an ? -1 : 1;', 'return an ? 1 : -1;', 'numeric identifiers rank above text'],
    ['src/version/compare.js', 'if (a[i] === undefined) return -1;', 'if (a[i] === undefined) return 1;', 'fewer identifiers rank higher'],
    ['src/version/compare.js', 'return a[i] < b[i] ? -1 : 1;', 'return a[i] < b[i] ? 1 : -1;', 'text identifiers compare in reverse'],
    ['src/version/range.js', 'compareVersions(version, base) < 0', 'compareVersions(version, base) <= 0', 'the base version itself is rejected'],
    ['src/version/range.js', 'b.major > 0', 'b.major >= 0', 'zero-major bases get the major rule'],
    ['src/version/range.js', 'b.minor > 0', 'b.minor >= 0', '^0.0.x accepts other patch levels'],
    ['src/version/range.js', 'v.major === 0 && v.minor === b.minor', 'v.minor === b.minor', '^0.x accepts other majors'],
  ],
  csv: [
    ['src/data/csv.js', "ch === '\"' && text[i + 1] === '\"'", 'false', 'doubled quotes are not unescaped'],
    ['src/data/csv.js', "if (field !== '' || row.length > 0)", 'if (true)', 'a final line break adds an empty row'],
    ['src/data/csv.js', "    } else if (ch === '\\r' && text[i + 1] === '\\n') continue;\n", '    }\n', 'CRLF line ends keep the carriage return'],
    ['src/data/csv.js', "if (quoted) throw new SyntaxError('unterminated quoted field');", '', 'an unterminated quote is accepted'],
    ['src/data/csv.js', 'ch === delimiter', "ch === ','", 'the delimiter option is ignored'],
    ['src/data/csv.js', "else if (ch === '\"' && field === '') quoted = true;", 'else if (false) quoted = true;', 'quoted fields are not recognised'],
    ['src/data/tsv.js', "'\\t'", "','", 'tab-separated input is split on commas'],
  ],
};

const copy = mkdtempSync(join(tmpdir(), 'xvant-mutant-'));
// Runs a test file in the background; resolves to its exit status.
const runAsync = (file, cwd) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [file], { cwd, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      done(status);
    });
  });
const jobs = Object.entries(mutants).flatMap(([module, list]) =>
  list.map(([source, find, replace, what]) => ({ module, source, find, replace, what })),
);
try {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      const { module, source, find, replace, what } = jobs[index];
      const dir = join(copy, String(index));
      cpSync('src', join(dir, 'src'), { recursive: true });
      cpSync('test', join(dir, 'test'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      const original = readFileSync(join(dir, source), 'utf8');
      assert.ok(original.includes(find), 'mutant is applicable: ' + find);
      writeFileSync(join(dir, source), original.replace(find, () => replace));
      const status = await runAsync(files[module], dir);
      assert.notEqual(status, 0, files[module] + ' must fail when ' + what);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
} finally {
  rmSync(copy, { recursive: true, force: true });
}
