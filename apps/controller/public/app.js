// XVANT browser client. All data from runs, workers and repositories is
// rendered as text (never as HTML), so worker output cannot inject markup.

const $ = (id) => document.getElementById(id);
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat())
    if (child !== undefined && child !== null && child !== false)
      el.append(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
  return el;
}
const LABELS = {
  planning: 'Planning',
  running: 'Running',
  verifying: 'Checking',
  reviewing: 'Reviewing',
  ready: 'Ready for you',
  accepted: 'Accepted',
  failed: 'Failed',
  needs_attention: 'Needs attention',
  cancelled: 'Stopped',
  pending: 'Waiting',
  integrated: 'Integrated',
  passed: 'Passed',
  qualified: 'Ready',
  version_mismatch: 'Unsupported version',
  unavailable: 'Not installed',
  idle: 'Idle',
  blocked: 'Account blocked',
};
const badge = (status) =>
  h('span', { class: 'badge s-' + status }, LABELS[status] ?? status);
const announce = (text) => {
  $('status').textContent = '';
  requestAnimationFrame(() => ($('status').textContent = text));
};

let csrf = sessionStorage.getItem('xvant-csrf') ?? '';
async function api(path, options = {}) {
  const response = await fetch('/api/v1' + path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.method && options.method !== 'GET'
        ? { 'x-csrf-token': csrf }
        : {}),
      ...(options.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error ?? 'HTTP_' + response.status);
    error.status = response.status;
    throw error;
  }
  return data;
}
async function connect() {
  const match = /bootstrap=([a-f0-9]{64})/.exec(location.hash);
  if (match) {
    history.replaceState(null, '', location.pathname);
    const data = await api('/session', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + match[1] },
    });
    csrf = data.csrfToken;
  } else {
    // A reload keeps the session cookie; ask for the CSRF token again.
    csrf = (await api('/csrf')).csrfToken;
  }
  sessionStorage.setItem('xvant-csrf', csrf);
}

const view = { root: null, rowVersion: 0, state: null, overview: null };
const ERRORS = {
  CONFLICT:
    'This run changed since you looked at it. The view has been refreshed; review it again.',
  UNAUTHORIZED: 'Your session ended. Start XVANT again from the terminal.',
  INVALID_REPOSITORY: 'That folder is not a Git repository.',
  NO_RUNTIME: 'No supported runtime is installed and signed in.',
  UNKNOWN_REPOSITORY: 'XVANT has not worked in that repository.',
};
const explain = (error) =>
  ERRORS[error.message] ?? 'Request failed: ' + error.message;

async function refreshOverview() {
  const overview = await api('/overview');
  view.overview = overview;
  $('runtimes').replaceChildren(
    ...overview.runtimes.map((r) =>
      h(
        'li',
        { class: 'chip', title: r.executable ?? '' },
        r.runtimeKind + ' ',
        r.version ? r.version + ' ' : '',
        badge(r.status),
      ),
    ),
  );
  $('runs').replaceChildren(
    ...(overview.roots.length
      ? overview.roots.map((root) =>
          h(
            'li',
            {},
            h(
              'button',
              {
                type: 'button',
                'aria-current': view.root === root.id ? 'true' : 'false',
                onclick: () => openRun(root.id),
              },
              h('span', { class: 'objective' }, root.objective),
              badge(root.phase),
            ),
          ),
        )
      : [h('li', { class: 'empty' }, 'No runs yet.')]),
  );
  $('workers').replaceChildren(
    ...overview.workers.map((w) =>
      h(
        'li',
        {},
        h('span', {}, '@' + w.alias),
        h(
          'span',
          {},
          w.state === 'running' ? badge('running') : badge(w.state),
        ),
      ),
    ),
  );
}

function composer() {
  const commandId = 'ui-' + crypto.randomUUID();
  const qualified = (view.overview?.runtimes ?? []).filter(
    (r) => r.status === 'qualified',
  );
  const form = h(
    'form',
    { 'aria-labelledby': 'compose-title', novalidate: true },
    h('h2', { class: 'title', id: 'compose-title', tabindex: '-1' }, 'New run'),
    qualified.length
      ? null
      : h('p', { class: 'notice error' }, ERRORS.NO_RUNTIME),
    h('label', { for: 'repo' }, 'Repository folder'),
    h('input', {
      id: 'repo',
      name: 'repository',
      type: 'text',
      required: true,
      autocomplete: 'off',
      value: localStorage.getItem('xvant-repo') ?? '',
      placeholder: 'C:\\path\\to\\your\\repo',
    }),
    h('label', { for: 'objective' }, 'What should be done'),
    h('textarea', {
      id: 'objective',
      name: 'objective',
      required: true,
      placeholder:
        'Describe the outcome. Mention @codex-1 or @claude-2 to ask for a specific worker.',
    }),
    h(
      'label',
      { for: 'criteria' },
      'Acceptance criteria ',
      h('span', { class: 'hint' }, 'one per line'),
    ),
    h('textarea', { id: 'criteria', name: 'criteria' }),
    h(
      'label',
      { for: 'checks' },
      'Check commands ',
      h(
        'span',
        { class: 'hint' },
        'one per line, run on the combined result, e.g. npm test',
      ),
    ),
    h('textarea', { id: 'checks', name: 'checks', class: 'short' }),
    h(
      'div',
      { class: 'row' },
      h(
        'div',
        {},
        h('label', { for: 'max-active' }, 'Workers at once'),
        h('input', {
          id: 'max-active',
          name: 'maxActive',
          type: 'number',
          min: 1,
          max: 10,
          value: 3,
        }),
      ),
      h(
        'label',
        { class: 'hint' },
        h('input', { type: 'checkbox', name: 'review', checked: true }),
        ' Independent review of the combined change',
      ),
    ),
    h(
      'p',
      { class: 'hint' },
      'Workers use their own tools inside XVANT worktrees (trusted-local). Your checkout and branches are not changed; results land on an xvant/… branch for you to review.',
    ),
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'submit', class: 'primary' }, 'Start run'),
    ),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const repository = String(data.get('repository') ?? '').trim();
    const objective = String(data.get('objective') ?? '').trim();
    if (!repository || !objective) {
      announce('Repository folder and what should be done are required.');
      (repository ? form.objective : form.repository).focus();
      return;
    }
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    button.textContent = 'Starting…';
    try {
      const lines = (name) =>
        String(data.get(name) ?? '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
      const started = await api('/roots', {
        method: 'POST',
        body: JSON.stringify({
          commandId,
          repository,
          objective,
          criteria: lines('criteria'),
          checks: lines('checks'),
          maxActive: Number(data.get('maxActive') ?? 3),
          review: data.get('review') === 'on',
        }),
      });
      localStorage.setItem('xvant-repo', repository);
      announce('Run started.');
      await refreshOverview();
      await openRun(started.id);
    } catch (error) {
      announce(explain(error));
      form.prepend(
        h('p', { class: 'notice error', role: 'alert' }, explain(error)),
      );
      button.disabled = false;
      button.textContent = 'Start run';
    }
  });
  return form;
}
function showComposer() {
  view.root = null;
  $('main').replaceChildren(composer());
  $('compose-title').focus();
  void refreshOverview();
}

function diffView(text, label = 'Combined diff') {
  return h(
    'pre',
    { class: 'diff', tabindex: '0', 'aria-label': label },
    ...text.split('\n').map((line) =>
      h(
        'span',
        {
          class:
            line.startsWith('+') && !line.startsWith('+++')
              ? 'add'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'del'
                : line.startsWith('@@')
                  ? 'hunk'
                  : '',
        },
        line + '\n',
      ),
    ),
  );
}
async function confirm(title, body, ok) {
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-ok').textContent = ok;
  const dialog = $('confirm');
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener(
      'close',
      () => resolve(dialog.returnValue === 'ok'),
      { once: true },
    ),
  );
}
function runDetail(root) {
  const s = root.state;
  const nodes = Object.values(s.nodes ?? {});
  const active = ['planning', 'running', 'verifying', 'reviewing'].includes(
    s.phase,
  );
  return h(
    'article',
    { 'aria-labelledby': 'run-title' },
    h('h2', { class: 'title', id: 'run-title', tabindex: '-1' }, s.objective),
    h('p', {}, badge(s.phase), ' ', s.reason ? h('span', {}, s.reason) : ''),
    s.integration
      ? h(
          'p',
          { class: 'hint' },
          'Branch ',
          h('code', {}, s.integration.branch),
          ' at ',
          h('code', {}, s.integration.head.slice(0, 12)),
          ' in ',
          h('code', {}, root.repository ?? ''),
        )
      : null,
    h(
      'div',
      { class: 'actions' },
      active
        ? h(
            'button',
            {
              type: 'button',
              class: 'danger',
              onclick: async () => {
                if (
                  !(await confirm(
                    'Stop this run?',
                    'Running workers are interrupted. Work already integrated stays on the branch.',
                    'Stop run',
                  ))
                )
                  return;
                await api('/roots/' + root.id + '/cancel', {
                  method: 'POST',
                  body: '{}',
                });
                announce('Stopping the run.');
              },
            },
            'Stop run',
          )
        : null,
      s.phase === 'ready'
        ? h(
            'button',
            {
              type: 'button',
              class: 'primary',
              onclick: async () => {
                const head = s.integration.head;
                if (
                  !(await confirm(
                    'Accept this result?',
                    'You are accepting branch ' +
                      s.integration.branch +
                      ' at ' +
                      head.slice(0, 12) +
                      '. XVANT will not merge it; you merge when ready.',
                    'Accept',
                  ))
                )
                  return;
                try {
                  await api('/roots/' + root.id + '/accept', {
                    method: 'POST',
                    body: JSON.stringify({
                      expectedVersion: root.rowVersion,
                      head,
                    }),
                  });
                  announce(
                    'Accepted. Merge with: git merge ' + s.integration.branch,
                  );
                  await openRun(root.id);
                } catch (error) {
                  announce(explain(error));
                  await openRun(root.id);
                }
              },
            },
            'Accept result',
          )
        : null,
      s.phase === 'accepted'
        ? h(
            'p',
            {},
            'Merge when ready: ',
            h('code', {}, 'git merge ' + s.integration.branch),
          )
        : null,
    ),
    h(
      'section',
      { 'aria-labelledby': 'plan-h' },
      h('h3', { id: 'plan-h' }, 'Plan'),
      nodes.length
        ? h(
            'table',
            {},
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                h('th', {}, 'Task'),
                h('th', {}, 'Status'),
                h('th', {}, 'Worker'),
                h('th', {}, 'After'),
                h('th', {}, 'Why this worker'),
              ),
            ),
            h(
              'tbody',
              {},
              ...nodes.map((n) =>
                h(
                  'tr',
                  {},
                  h(
                    'td',
                    {},
                    h('strong', {}, n.node.title),
                    h('div', { class: 'hint' }, n.node.objective),
                  ),
                  h(
                    'td',
                    {},
                    badge(n.status),
                    n.repairs
                      ? h('div', { class: 'hint' }, n.repairs + ' repair(s)')
                      : null,
                    n.lastFailure
                      ? h('div', { class: 'hint' }, n.lastFailure)
                      : null,
                  ),
                  h(
                    'td',
                    {},
                    n.attempts.map((a) => '@' + a.alias).join(', ') || '—',
                  ),
                  h('td', {}, n.node.dependsOn.join(', ') || '—'),
                  h(
                    'td',
                    { class: 'hint' },
                    n.route
                      ? [
                          ...n.route.reasons,
                          ...n.route.excluded.map(
                            (e) => e.alias + ': ' + e.reason,
                          ),
                        ].join('; ')
                      : '—',
                  ),
                ),
              ),
            ),
          )
        : h(
            'p',
            { class: 'empty' },
            s.phase === 'planning' ? 'The planner is working…' : 'No plan.',
          ),
    ),
    h(
      'section',
      { 'aria-labelledby': 'checks-h' },
      h('h3', { id: 'checks-h' }, 'Checks on the combined result'),
      s.checks?.length
        ? h(
            'ul',
            {},
            ...s.checks.map((c) => h('li', {}, c.id + ' ', badge(c.status))),
          )
        : h('p', { class: 'empty' }, 'Not run yet.'),
    ),
    h(
      'section',
      { 'aria-labelledby': 'review-h' },
      h('h3', { id: 'review-h' }, 'Review'),
      s.review
        ? h(
            'div',
            {},
            h(
              'p',
              {},
              '@' + s.review.alias + ': ',
              s.review.approve ? 'approved' : 'changes requested',
              s.review.independent
                ? s.review.sameRuntime
                  ? ' (independent reviewer, same runtime as some of the work)'
                  : ' (independent reviewer)'
                : ' (the reviewer also implemented part of this)',
            ),
            s.review.findings.length
              ? h('ul', {}, ...s.review.findings.map((f) => h('li', {}, f)))
              : null,
          )
        : h('p', { class: 'empty' }, 'Not reviewed yet.'),
    ),
    s.integration
      ? h(
          'section',
          { 'aria-labelledby': 'diff-h' },
          h('h3', { id: 'diff-h' }, 'Combined change'),
          h(
            'button',
            {
              type: 'button',
              onclick: async (event) => {
                const button = event.currentTarget;
                button.disabled = true;
                const diff = await api('/roots/' + root.id + '/diff');
                button.replaceWith(
                  diff.diff
                    ? diffView(diff.diff)
                    : h('p', { class: 'empty' }, 'No changes yet.'),
                  diff.truncated
                    ? h(
                        'p',
                        { class: 'hint' },
                        'Diff truncated; see the branch for everything.',
                      )
                    : '',
                );
              },
            },
            'Show diff',
          ),
        )
      : null,
    h(
      'section',
      { 'aria-labelledby': 'events-h' },
      h('h3', { id: 'events-h' }, 'Timeline'),
      h(
        'ol',
        { class: 'timeline', tabindex: '0', 'aria-label': 'Run events' },
        ...root.events.map((e) =>
          h(
            'li',
            {},
            String(e.sequence).padStart(4) +
              '  ' +
              e.kind +
              (e.payload?.alias ? '  @' + e.payload.alias : '') +
              (e.payload?.id ? '  ' + e.payload.id : ''),
          ),
        ),
      ),
    ),
  );
}
async function openRun(id, focus = true) {
  const root = await api('/roots/' + encodeURIComponent(id));
  const phaseChanged =
    view.root === id && view.state && view.state.phase !== root.state.phase;
  view.root = id;
  view.rowVersion = root.rowVersion;
  view.state = root.state;
  const opened = $('main').querySelector('pre.diff');
  $('main').replaceChildren(runDetail(root));
  if (opened) $('main').querySelector('#diff-h')?.after(opened);
  if (focus) $('run-title').focus();
  if (phaseChanged)
    announce('Run is now: ' + (LABELS[root.state.phase] ?? root.state.phase));
  void refreshOverview();
}

// Lessons: the challenge/solution graph of one repository. Every string in it
// comes from worker or tool output, so it is only ever set as text.
const lessonsState = {
  repository: localStorage.getItem('xvant-lessons-repo') ?? '',
};
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
async function forgetLesson(repository, id, reason, what) {
  const body =
    'It is hidden here and never suggested again. It stays in the store for audit.';
  if (!(await confirm('Forget this ' + what + '?', body, 'Forget'))) return;
  try {
    await api('/lessons/forget', {
      method: 'POST',
      body: JSON.stringify({ repository, id, reason }),
    });
    announce('Forgotten.');
  } catch (error) {
    announce(explain(error));
  }
  await openLessons(false);
}
function forgetRow(repository, id, what) {
  const reason = h('input', {
    type: 'text',
    'aria-label': 'Reason for forgetting this ' + what,
    placeholder: 'Why forget this ' + what + '?',
    maxlength: 500,
    autocomplete: 'off',
  });
  return h(
    'div',
    { class: 'row forget' },
    reason,
    h(
      'button',
      {
        type: 'button',
        class: 'danger',
        onclick: () => {
          const why = reason.value.trim();
          if (why) return forgetLesson(repository, id, why, what);
          announce('Say why before forgetting.');
          reason.focus();
        },
      },
      'Forget ' + what,
    ),
  );
}
function solutionItem(repository, s) {
  const fix = s.relation === 'solved_by';
  const what = fix ? 'fix' : 'dead end';
  return h(
    'li',
    { class: 'solution' },
    h(
      'p',
      {},
      h(
        'span',
        { class: 'badge ' + (fix ? 's-passed' : 's-failed') },
        fix ? 'Fix' : 'Dead end',
      ),
      ' ',
      h(
        'span',
        { class: 'badge ' + (s.verified ? 's-passed' : 's-cancelled') },
        s.verified ? 'Verified' : 'Unverified',
      ),
      ' ',
      h(
        'span',
        { class: 'hint' },
        'linked ' +
          s.count +
          '×, suggested ' +
          s.usage.suggested +
          ', worked ' +
          s.usage.succeeded +
          ', failed ' +
          s.usage.failed,
      ),
    ),
    h('p', { class: 'wrap' }, s.summary || '(no summary)'),
    s.files.length
      ? h('p', { class: 'hint wrap' }, 'Files: ' + s.files.join(', '))
      : null,
    s.checks.length
      ? h('p', { class: 'hint wrap' }, 'Checks: ' + s.checks.join(', '))
      : null,
    s.diff
      ? h(
          'details',
          {},
          h('summary', {}, 'Diff excerpt'),
          diffView(s.diff, 'Diff excerpt'),
        )
      : h('p', { class: 'hint' }, 'No diff recorded.'),
    forgetRow(repository, s.id, what),
  );
}
function challengeItem(repository, c) {
  return h(
    'li',
    {},
    h(
      'details',
      {},
      h(
        'summary',
        {},
        h('span', { class: 'wrap' }, c.title),
        ' ',
        h(
          'span',
          { class: 'hint' },
          'seen ' +
            c.occurrences +
            '×, ' +
            plural(c.fixes, 'fix', 'fixes') +
            ', ' +
            plural(c.deadEnds, 'dead end', 'dead ends'),
        ),
      ),
      c.files.length
        ? h('p', { class: 'hint wrap' }, 'Files: ' + c.files.join(', '))
        : null,
      c.solutions.length
        ? h(
            'ul',
            { class: 'solutions' },
            ...c.solutions.map((s) => solutionItem(repository, s)),
          )
        : h('p', { class: 'empty' }, 'Nothing learned for this yet.'),
      forgetRow(repository, c.id, 'challenge'),
    ),
  );
}
async function copyText(text, pre) {
  try {
    await navigator.clipboard.writeText(text);
    announce('Copied.');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(pre);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    announce('Press Ctrl+C to copy the selected text.');
  }
}
function lessonsBody(data) {
  const mermaid = h(
    'pre',
    {
      class: 'diff wrap',
      id: 'lessons-mermaid',
      tabindex: '0',
      'aria-label': 'Mermaid source',
    },
    data.mermaid,
  );
  return [
    h(
      'section',
      { 'aria-labelledby': 'lessons-stats-h' },
      h('h3', { id: 'lessons-stats-h' }, 'Do lessons help?'),
      h(
        'pre',
        {
          class: 'diff wrap',
          id: 'lessons-stats',
          tabindex: '0',
          'aria-label': 'Lesson stats',
        },
        data.stats.text,
      ),
    ),
    h(
      'section',
      { 'aria-labelledby': 'lessons-ch-h' },
      h('h3', { id: 'lessons-ch-h' }, 'Challenges'),
      data.challenges.length
        ? h(
            'ul',
            { class: 'lessons', id: 'lessons-list' },
            ...data.challenges.map((c) => challengeItem(data.repository, c)),
          )
        : h(
            'p',
            { class: 'empty' },
            'No lessons recorded for this repository yet.',
          ),
      data.totalChallenges > data.challenges.length
        ? h(
            'p',
            { class: 'hint' },
            'Showing the newest ' +
              data.challenges.length +
              ' of ' +
              data.totalChallenges +
              '.',
          )
        : null,
    ),
    h(
      'section',
      { 'aria-labelledby': 'lessons-mm-h' },
      h('h3', { id: 'lessons-mm-h' }, 'Mermaid source'),
      h(
        'p',
        { class: 'hint' },
        'Paste into any Mermaid renderer to draw the graph.',
      ),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          { type: 'button', onclick: () => copyText(data.mermaid, mermaid) },
          'Copy Mermaid',
        ),
      ),
      mermaid,
    ),
  ];
}
async function openLessons(focus = true) {
  view.root = null;
  const { repositories } = await api('/lessons/repositories');
  const paths = repositories.map((r) => r.path);
  if (!paths.includes(lessonsState.repository))
    lessonsState.repository = paths[0] ?? '';
  const select = h(
    'select',
    { id: 'lessons-repo' },
    ...paths.map((p) =>
      h('option', { value: p, selected: p === lessonsState.repository }, p),
    ),
  );
  select.addEventListener('change', () => {
    lessonsState.repository = select.value;
    localStorage.setItem('xvant-lessons-repo', select.value);
    void openLessons(false);
  });
  const body = h('div', { id: 'lessons-body' });
  $('main').replaceChildren(
    h(
      'article',
      { 'aria-labelledby': 'lessons-title' },
      h(
        'h2',
        { class: 'title', id: 'lessons-title', tabindex: '-1' },
        'Lessons',
      ),
      h(
        'p',
        { class: 'hint' },
        'What went wrong in earlier runs on a repository, and what fixed it. Read-only except Forget.',
      ),
      paths.length
        ? [h('label', { for: 'lessons-repo' }, 'Repository'), select, body]
        : h(
            'p',
            { class: 'empty' },
            'No repositories yet. Start a run and its lessons will appear here.',
          ),
    ),
  );
  if (focus) $('lessons-title').focus();
  void refreshOverview();
  if (!paths.length) return;
  try {
    const data = await api(
      '/lessons?repository=' + encodeURIComponent(lessonsState.repository),
    );
    body.replaceChildren(...lessonsBody(data));
  } catch (error) {
    body.replaceChildren(
      h('p', { class: 'notice error', role: 'alert' }, explain(error)),
    );
  }
}

let cursor = 0;
let pending;
function listen() {
  const source = new EventSource('/api/v1/stream?after=' + cursor);
  source.onmessage = (message) => {
    cursor = Number(message.lastEventId) || cursor;
    const event = JSON.parse(message.data);
    clearTimeout(pending);
    // Coalesce bursts; refresh without stealing focus.
    pending = setTimeout(() => {
      if (view.root === event.graphId) void openRun(view.root, false);
      else void refreshOverview();
    }, 150);
  };
  source.onerror = () => announce('Connection lost; reconnecting…');
  source.onopen = () => {
    if (view.root) void openRun(view.root, false);
  };
}

$('new-run').addEventListener('click', showComposer);
$('open-lessons').addEventListener('click', () =>
  openLessons().catch((error) => announce(explain(error))),
);
$('stop-all').addEventListener('click', async () => {
  if (
    !(await confirm(
      'Stop all work?',
      'Every running worker in every run is interrupted.',
      'Stop everything',
    ))
  )
    return;
  await api('/stop', { method: 'POST', body: '{}' });
  announce('Stopping all work.');
});
try {
  await connect();
  await refreshOverview();
  if (view.overview.roots.length) await openRun(view.overview.roots[0].id);
  else showComposer();
  listen();
} catch (error) {
  $('main').replaceChildren(
    h('p', { class: 'notice error', role: 'alert' }, explain(error)),
  );
}
