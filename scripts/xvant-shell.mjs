// The interactive XVANT shell: `npm run xvant` with no command. Type an
// objective to run it; slash commands change settings and inspect results.
// Every action runs as an ordinary `xvant` or `git` command line, so the
// shell adds no second way of doing anything.
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describe,
  gitArgs,
  interpret,
  observe,
  restore,
} from '../apps/controller/src/shell.ts';
import { discoverRuntime } from '../packages/adapters/src/live/discover.ts';

const xvant = fileURLToPath(new URL('./xvant.mjs', import.meta.url));

export async function startShell({ home }) {
  const tty = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const paint = (code) => (text) =>
    tty && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
  const dim = paint('2'),
    bold = paint('1'),
    cyan = paint('36'),
    green = paint('32'),
    red = paint('31'),
    yellow = paint('33');

  // Settings are kept per repository: checks and criteria belong to one.
  const file = join(home, 'shell.json');
  const saved = () => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')).repos ?? {};
    } catch {
      return {};
    }
  };
  const save = (session) => {
    const { tandem, only, checks, criteria, review } = session;
    mkdirSync(home, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        {
          repos: {
            ...saved(),
            [session.repo]: { tandem, only, checks, criteria, review },
          },
        },
        null,
        2,
      ) + '\n',
    );
  };
  const topLevel = (path) => {
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: path,
      encoding: 'utf8',
      windowsHide: true,
    });
    return top.status === 0 ? realpathSync(top.stdout.trim()) : null;
  };
  const open = (repo) => restore(saved()[repo], repo);

  const start = topLevel(process.cwd());
  let session = open(start ?? process.cwd());
  let running = null;
  let sharing = null;
  // Lines are handled one at a time; any typed or piped meanwhile wait.
  const queue = [];
  let busy = false;
  let closed = false;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: tty,
    historySize: 200,
    prompt: bold(cyan('xvant> ')),
  });
  // Printed above the prompt, so output arriving while you type stays readable.
  const print = (text) => {
    if (tty && !running) process.stdout.write('\r\x1b[K');
    console.log(text);
    if (tty && !running && !busy) rl.prompt(true);
  };

  /** Runs one command, passing its output through `each` line by line. */
  const exec = (command, args, each) =>
    new Promise((done) => {
      const child = spawn(command, args, {
        cwd: session.repo,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, XVANT_HOME: home },
      });
      running = child;
      // Cooked mode while it runs: Ctrl+C then reaches the command itself,
      // which stops its workers cleanly, instead of being swallowed here.
      if (!closed) rl.pause();
      if (tty) process.stdin.setRawMode(false);
      let pending = '';
      const feed = (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) each(line);
      };
      child.stdout.setEncoding('utf8').on('data', feed);
      child.stderr.setEncoding('utf8').on('data', feed);
      const end = (code) => {
        if (running !== child) return;
        if (pending) each(pending);
        running = null;
        if (tty) process.stdin.setRawMode(true);
        if (!closed) rl.resume();
        done(code ?? 1);
      };
      child.on('error', (error) => {
        console.log(red('Could not start ' + command + ': ' + error.message));
        end(1);
      });
      child.on('close', end);
    });

  const runLine = (line) => {
    session = observe(session, line);
    if (/^(plan|start) /.test(line)) return console.log(cyan(line));
    if (/^Result: ready/.test(line)) return console.log(green(bold(line)));
    if (/^Result: /.test(line)) return console.log(red(bold(line)));
    if (/^(Skipping|Routing)/.test(line)) return console.log(yellow(line));
    if (/^ {2}\S/.test(line) && !/^ {2}(check|review) /.test(line))
      return console.log(dim(line));
    console.log(line);
  };

  const stopSharing = () => {
    if (!sharing) return false;
    sharing.kill();
    sharing = null;
    return true;
  };
  process.on('exit', stopSharing);

  async function handle(input) {
    const action = interpret(input, session);
    if (action.kind === 'quit') return false;
    if (action.kind === 'say') {
      if (action.message) console.log(action.message);
    } else if (action.kind === 'set') {
      session = action.session;
      save(session);
      console.log(dim(action.message));
    } else if (action.kind === 'repo') {
      const top = topLevel(resolve(session.repo, action.path));
      if (!top) console.log(red('Not a Git repository: ' + action.path));
      else {
        session = open(top);
        console.log(describe(session));
      }
    } else if (action.kind === 'run') {
      if (!topLevel(session.repo)) {
        console.log(
          red('This folder is not a Git repository. Pick one with /repo PATH.'),
        );
        return true;
      }
      const code = await exec(
        process.execPath,
        [xvant, ...action.args],
        runLine,
      );
      if (code === 0 && session.lastBranch)
        console.log(
          dim('Next: /diff to read it, /accept to take it, then /merge.'),
        );
    } else if (action.kind === 'xvant') {
      await exec(process.execPath, [xvant, ...action.args], (line) =>
        console.log(line),
      );
    } else if (action.kind === 'git') {
      await exec('git', gitArgs(action.args, tty), (line) => console.log(line));
    } else if (action.kind === 'share') {
      const was = stopSharing();
      if (!action.branch)
        console.log(
          dim(was ? 'Stopped sharing.' : 'Nothing was being shared.'),
        );
      else {
        // Its own console, so Ctrl+C on a run does not stop the sharing.
        const child = spawn(
          process.execPath,
          [xvant, 'share', '--repo', session.repo, '--branch', action.branch],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            detached: process.platform === 'win32',
          },
        );
        sharing = child;
        const each = (chunk) => {
          for (const line of String(chunk).split(/\r?\n/).filter(Boolean))
            print(dim('share  ' + line));
        };
        child.stdout.on('data', each);
        child.stderr.on('data', each);
        child.on('close', () => {
          if (sharing === child) {
            sharing = null;
            print(dim('share  stopped'));
          }
        });
      }
    }
    return true;
  }

  const finished = new Promise((done) => {
    const leave = () => {
      stopSharing();
      rl.close();
      done();
    };
    const pump = async () => {
      if (busy) return;
      busy = true;
      while (queue.length) {
        let go = true;
        try {
          go = await handle(queue.shift());
        } catch (error) {
          console.log(red('Failed: ' + error.message));
        }
        if (!go) return leave();
      }
      busy = false;
      if (closed) leave();
      else rl.prompt();
    };
    rl.on('line', (line) => {
      queue.push(line);
      void pump();
    });
    rl.on('close', () => {
      closed = true;
      void pump();
    });
    // Ctrl+C at the prompt leaves; during a run the command handles it.
    rl.on('SIGINT', () => {
      if (running) return;
      console.log('');
      queue.length = 0;
      queue.push('/quit');
      void pump();
    });
    process.on('SIGINT', () => {});

    console.log(bold('XVANT') + dim('  interactive shell'));
    console.log(describe(session));
    console.log(
      'runtimes   ' +
        ['codex', 'claude', 'opencode']
          .map((kind) => {
            const found = discoverRuntime(kind);
            return found.status === 'qualified'
              ? green(kind + ' ' + found.version)
              : dim(kind + ' ' + found.status.replace('_', ' '));
          })
          .join('  '),
    );
    if (!start)
      console.log(
        yellow(
          'This folder is not a Git repository. Pick one with /repo PATH.',
        ),
      );
    console.log(dim('Type what you want done, or /help.'));
    rl.prompt();
  });
  await finished;
}
