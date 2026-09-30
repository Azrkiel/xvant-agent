// Synthetic stand-in for headless `claude -p --output-format stream-json`
// 2.1.285, shaped after traffic observed on 2026-09-30. Edits only its own
// working directory and never calls a model.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { followInstruction } from './fake-edit.mjs';

const [scenario, ...args] = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('2.1.285 (Claude Code)\n');
  process.exit(0);
}
const flag = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const session =
  scenario === 'wrong-session'
    ? '00000000-0000-4000-8000-000000000000'
    : (flag('--session-id') ?? flag('--resume'));
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  if (!prompt.trim()) process.exit(1);
  send({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: session,
    tools: ['Read', 'Edit'],
    mcp_servers: [],
    model: 'fixture-model',
    permissionMode: flag('--permission-mode'),
    apiKeySource: scenario === 'api-key' ? 'ANTHROPIC_API_KEY' : 'none',
    claude_code_version: '2.1.285',
    uuid: 'init-1',
  });
  const followed = followInstruction(prompt);
  if (scenario === 'hang' || followed === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }
  send({ type: 'rate_limit_event', rate_limit_info: {} });
  if (scenario === 'fail') {
    send({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'limit' }] },
      error: 'rate_limit',
      session_id: session,
    });
    send({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: session,
      uuid: 'result-1',
      num_turns: 0,
      total_cost_usd: 0,
    });
    process.exit(1);
  }
  send({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'Write', id: 't1', input: {} }],
    },
    session_id: session,
  });
  if (followed === 'unmatched')
    writeFileSync(join(process.cwd(), 'hello.txt'), 'hi from claude\n');
  send({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'DONE' }] },
    session_id: session,
  });
  send({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: session,
    uuid: 'result-1',
    result: 'DONE',
    num_turns: 2,
    usage: { input_tokens: 100, output_tokens: 20 },
    total_cost_usd: 0.17,
  });
  process.exit(0);
});
