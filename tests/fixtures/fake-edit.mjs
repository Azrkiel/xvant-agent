// Deterministic stand-in for a model following the live roster's
// instructions. Used by synthetic peers only.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** @returns 'edited' | 'hang' | 'unmatched' */
export function followInstruction(prompt, cwd = process.cwd()) {
  const create =
    /Create a file named (\S+?\.txt) .*single line: (.+?)\. Do not/.exec(
      prompt,
    );
  if (create) {
    writeFileSync(join(cwd, create[1]), create[2] + '\n');
    return 'edited';
  }
  const append =
    /In (\S+?\.txt), keep the existing line and add a second line: (.+?)\. Do not/.exec(
      prompt,
    );
  if (append) {
    const file = join(cwd, append[1]);
    const current = readFileSync(file, 'utf8');
    appendFileSync(
      file,
      (current.endsWith('\n') ? '' : '\n') + append[2] + '\n',
    );
    return 'edited';
  }
  const insert =
    /In (\S+), add the line `(.+?)` directly below the (\w+) line/.exec(prompt);
  if (insert) {
    const file = join(cwd, ...insert[1].split('/'));
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const at = lines.findIndex((line) => line.includes(insert[3]));
    lines.splice(at + 1, 0, insert[2]);
    writeFileSync(file, lines.join('\n'));
    return 'edited';
  }
  const limit = /Set MAX_RETRIES to (\d+)/.exec(prompt);
  if (limit) {
    const file = join(cwd, 'src', 'fetch.mjs');
    const keep = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.startsWith('export const RETRY_ON'));
    writeFileSync(
      file,
      [
        'export const MAX_RETRIES = ' + limit[1] + ';',
        ...keep,
        '',
        'export async function fetchWithRetry(call) {',
        '  let last;',
        '  for (let i = 0; i < MAX_RETRIES; i++) {',
        '    try {',
        '      return await call();',
        '    } catch (error) {',
        '      last = error;',
        '    }',
        '  }',
        '  throw last;',
        '}',
        '',
      ].join('\n'),
    );
    return 'edited';
  }
  if (/Create 40 files/.test(prompt)) return 'hang';
  return 'unmatched';
}

/** Follow the live MCP fixture's instruction by calling XVANT's bridge. */
export async function followMcpInstruction(
  prompt,
  endpoint,
  cwd = process.cwd(),
) {
  if (
    !/file_read tool from the MCP server named xvant/.test(prompt) ||
    !endpoint
  )
    return false;
  let session = '';
  let id = 0;
  const rpc = async (method, params) => {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + endpoint.token,
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    session ||= response.headers.get('mcp-session-id') ?? '';
    return response.json();
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const listed = await rpc('tools/list', {});
  if (!listed.result.tools.some((tool) => tool.name === 'file_read'))
    return false;
  const read = await rpc('tools/call', {
    name: 'file_read',
    arguments: { path: 'plan.txt' },
  });
  writeFileSync(
    join(cwd, 'answer.txt'),
    read.result.structuredContent.content.trim() + '\n',
  );
  return true;
}
