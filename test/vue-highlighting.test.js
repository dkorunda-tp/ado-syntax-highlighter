const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PR_URL,
  loadExtension,
  mount,
  fileCard,
  inlineRow,
  sideBySide,
  deferred,
  jsonResponse,
  iteration,
  createAdoServer,
  highlightedClones
} = require('./helpers');

const PATH = '/frontend/src/components/queues/matchRequest/TopActionBar.vue';

const OLD_TEXT = [
  '<template>',
  '  <div>{{ msg }}</div>',
  '</template>',
  '<script setup lang="ts">',
  "const msg: string = 'hi'",
  '</script>'
].join('\n');

const NEW_TEXT = [
  '<template>',
  '  <div>{{ msg }}</div>',
  '</template>',
  '',
  '<script setup lang="ts">',
  "const msg: string = 'hello'",
  '</script>',
  '',
  '<style scoped lang="scss">',
  '.a { .b { color: red; } }',
  '</style>'
].join('\n');

const ITERATIONS = [iteration(1, 'src1', 'common1'), iteration(2, 'src2', 'common2')];

function standardServer(overrides = {}) {
  return createAdoServer({
    iterations: ITERATIONS,
    files: {
      [`common2:${PATH}`]: OLD_TEXT,
      [`src2:${PATH}`]: NEW_TEXT,
      [`src1:${PATH}`]: OLD_TEXT
    },
    ...overrides
  });
}

// Rows of the inline diff between OLD_TEXT and NEW_TEXT, with the language each row must get.
const INLINE_ROWS = [
  [{ oldLine: 1, newLine: 1, type: 'unchanged', code: '<template>' }, 'markup'],
  [{ oldLine: 2, newLine: 2, type: 'unchanged', code: '  <div>{{ msg }}</div>' }, 'markup'],
  [{ oldLine: 3, newLine: 3, type: 'unchanged', code: '</template>' }, 'markup'],
  [{ newLine: 4, type: 'added', code: '' }, 'markup'],
  [{ oldLine: 4, newLine: 5, type: 'unchanged', code: '<script setup lang="ts">' }, 'markup'],
  [{ oldLine: 5, type: 'removed', code: "const msg: string = 'hi'" }, 'typescript'],
  [{ newLine: 6, type: 'added', code: "const msg: string = 'hello'" }, 'typescript'],
  [{ oldLine: 6, newLine: 7, type: 'unchanged', code: '</script>' }, 'markup'],
  [{ newLine: 8, type: 'added', code: '' }, 'markup'],
  [{ newLine: 9, type: 'added', code: '<style scoped lang="scss">' }, 'markup'],
  [{ newLine: 10, type: 'added', code: '.a { .b { color: red; } }' }, 'scss'],
  [{ newLine: 11, type: 'added', code: '</style>' }, 'markup']
];

function inlineCard(filePath = PATH, rows = INLINE_ROWS) {
  return fileCard({ filePath, diff: rows.map(([row]) => inlineRow(row)).join('') });
}

function languages(highlightCalls) {
  return highlightCalls.map(call => call.language);
}

test('inline: each line gets the language of its block in its own side of the diff', async () => {
  const server = standardServer();
  const { window, highlightCalls } = await loadExtension({ fetch: server.fetch });
  const file = mount(window, inlineCard());

  await window.processFileDiff(file);

  assert.deepEqual(languages(highlightCalls), INLINE_ROWS.map(([, language]) => language));
  assert.equal(highlightedClones(file).length, INLINE_ROWS.length);
  const tsClone = highlightedClones(file)[6];
  assert.match(tsClone.innerHTML, /<span class="token keyword">const<\/span>/);
  assert.match(tsClone.innerHTML, /<span class="screen-reader-only">Added line<\/span>/);
});

test('fetches iterations and both file versions with the session and the redirect header', async () => {
  const server = standardServer();
  const { window } = await loadExtension({ fetch: server.fetch });
  await window.processFileDiff(mount(window, inlineCard()));

  const [iterationsCall, ...itemCalls] = server.calls;
  assert.equal(iterationsCall.url.origin, 'https://dev.azure.com');
  assert.equal(iterationsCall.url.pathname, '/org/Project/_apis/git/repositories/Repo/pullRequests/42/iterations');
  assert.equal(iterationsCall.url.searchParams.get('api-version'), '7.1');
  assert.equal(iterationsCall.options.headers.Accept, 'application/json');

  assert.deepEqual(itemCalls.map(call => call.url.searchParams.get('versionDescriptor.version')).sort(), ['common2', 'src2']);
  for (const call of itemCalls) {
    assert.equal(call.url.pathname, '/org/Project/_apis/git/repositories/Repo/items');
    assert.equal(call.url.searchParams.get('path'), PATH);
    assert.equal(call.url.searchParams.get('versionDescriptor.versionType'), 'commit');
    assert.equal(call.url.searchParams.get('api-version'), '7.1');
    assert.equal(call.options.headers.Accept, 'text/plain');
  }
  for (const call of server.calls) {
    assert.equal(call.options.credentials, 'same-origin');
    assert.equal(call.options.headers['X-TFS-FedAuthRedirect'], 'Suppress');
  }
});

test('side-by-side: the left pane uses the old file and the right pane the new file', async () => {
  const server = standardServer();
  const { window, highlightCalls } = await loadExtension({ fetch: server.fetch });
  const file = mount(window, fileCard({
    filePath: PATH,
    diff: sideBySide({
      oldRows: [
        { line: 4, type: 'unchanged', code: '<script setup lang="ts">' },
        { line: 5, type: 'removed', code: "const msg: string = 'hi'" }
      ],
      newRows: [
        { line: 5, type: 'unchanged', code: '<script setup lang="ts">' },
        { line: 6, type: 'added', code: "const msg: string = 'hello'" },
        { line: 10, type: 'added', code: '.a { .b { color: red; } }' }
      ]
    })
  }));

  await window.processFileDiff(file);

  assert.deepEqual(languages(highlightCalls), ['markup', 'typescript', 'markup', 'typescript', 'scss']);
});

test('iteration and base in the URL pick the compared commits', async () => {
  const server = standardServer();
  const { window } = await loadExtension({ url: `${PR_URL}&iteration=2&base=1`, fetch: server.fetch });
  await window.processFileDiff(mount(window, inlineCard()));

  const versions = server.calls.slice(1).map(call => call.url.searchParams.get('versionDescriptor.version')).sort();
  assert.deepEqual(versions, ['src1', 'src2']);
});

test('a failed file fetch leaves every line as upstream leaves a .vue line', async () => {
  const server = standardServer({ files: {} });
  const { window, highlightCalls } = await loadExtension({ fetch: server.fetch });
  const file = mount(window, inlineCard());

  await window.processFileDiff(file);

  assert.deepEqual(languages(highlightCalls), INLINE_ROWS.map(() => 'vue'));
  assert.equal(highlightedClones(file).length, INLINE_ROWS.length);
});

test('a failed iterations fetch falls back and fetches no file', async () => {
  const server = standardServer({ iterationsStatus: 401 });
  const { window, highlightCalls } = await loadExtension({ fetch: server.fetch });
  await window.processFileDiff(mount(window, inlineCard()));

  assert.deepEqual(languages(highlightCalls), INLINE_ROWS.map(() => 'vue'));
  assert.equal(server.calls.length, 1);
});

test('a network error falls back', async () => {
  const { window, highlightCalls } = await loadExtension({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
  await window.processFileDiff(mount(window, inlineCard()));

  assert.deepEqual(languages(highlightCalls), INLINE_ROWS.map(() => 'vue'));
});

test('a sign-in HTML page with status 200 falls back', async () => {
  const fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html; charset=utf-8' },
    json: async () => { throw new SyntaxError('Unexpected token <'); },
    text: async () => '<html>sign in</html>'
  });
  const { window, highlightCalls } = await loadExtension({ fetch });
  await window.processFileDiff(mount(window, inlineCard()));

  assert.deepEqual(languages(highlightCalls), INLINE_ROWS.map(() => 'vue'));
});

test('a missing old file (renamed path) falls back for old-side lines only', async () => {
  const server = standardServer({ files: { [`src2:${PATH}`]: NEW_TEXT } });
  const { window, highlightCalls } = await loadExtension({ fetch: server.fetch });
  await window.processFileDiff(mount(window, inlineCard()));

  const expected = INLINE_ROWS.map(([row, language]) => (row.type === 'removed' ? 'vue' : language));
  assert.deepEqual(languages(highlightCalls), expected);
});

test('a row without a line number falls back', async () => {
  const server = standardServer();
  const { window, highlightCalls } = await loadExtension({ fetch: server.fetch });
  const rows = [
    [{ newLine: 6, type: 'added', code: "const msg: string = 'hello'" }],
    [{ type: 'added', code: 'const other = 1' }],
    [{ newLine: 99, type: 'added', code: 'past the end' }]
  ];
  await window.processFileDiff(mount(window, inlineCard(PATH, rows)));

  assert.deepEqual(languages(highlightCalls), ['typescript', 'vue', 'vue']);
});

test('a file is not processed twice while its fetch is in flight', async () => {
  const server = standardServer();
  const gate = deferred();
  const fetch = async (url, options) => {
    await gate.promise;
    return server.fetch(url, options);
  };
  const { window, highlightCalls } = await loadExtension({ fetch });
  const file = mount(window, inlineCard());

  const first = window.processFileDiff(file);
  const second = window.processFileDiff(file);
  window.applySyntaxHighlighting();
  gate.resolve();
  await first;
  await second;

  assert.equal(highlightedClones(file).length, INLINE_ROWS.length);
  assert.equal(highlightCalls.length, INLINE_ROWS.length);
  assert.equal(server.calls.filter(call => call.url.pathname.endsWith('/items')).length, 2);
});

test('a response that lands after navigation to another PR is dropped, and the card is processed for the new PR', async () => {
  const server = standardServer();
  const gate = deferred();
  const fetch = async (url, options) => {
    await gate.promise;
    if (url.includes('/pullRequests/43/')) return jsonResponse({ message: 'not found' }, 404);
    return server.fetch(url, options);
  };
  const { dom, window, highlightCalls } = await loadExtension({ fetch });
  const file = mount(window, inlineCard());

  const pending = window.processFileDiff(file);
  dom.reconfigure({ url: 'https://dev.azure.com/org/Project/_git/Repo/pullrequest/43?_a=files' });
  gate.resolve();
  await pending;

  // PR 43 has no iterations here, so the file falls back; the map fetched for PR 42 is never used.
  assert.deepEqual(languages(highlightCalls), INLINE_ROWS.map(() => 'vue'));
  assert.equal(highlightedClones(file).length, INLINE_ROWS.length);
});

test('a card that a pass skipped while its fetch was in flight is processed for the new iteration', async () => {
  const server = standardServer();
  const gate = deferred();
  const fetch = async (url, options) => {
    await gate.promise;
    return server.fetch(url, options);
  };
  const { dom, window, highlightCalls } = await loadExtension({ fetch });
  const file = mount(window, inlineCard());

  const pending = window.processFileDiff(file);
  dom.reconfigure({ url: `${PR_URL}&iteration=2&base=1` });
  window.applySyntaxHighlighting();
  gate.resolve();
  await pending;

  assert.deepEqual(languages(highlightCalls), INLINE_ROWS.map(([, language]) => language));
  assert.equal(highlightedClones(file).length, INLINE_ROWS.length);
  const versions = server.calls.map(call => call.url.searchParams.get('versionDescriptor.version'));
  assert.ok(versions.includes('src1'));
});

test('a file removed from the page while its fetch is in flight is left alone', async () => {
  const server = standardServer();
  const gate = deferred();
  const fetch = async (url, options) => {
    await gate.promise;
    return server.fetch(url, options);
  };
  const { window, highlightCalls } = await loadExtension({ fetch });
  const file = mount(window, inlineCard());

  const pending = window.processFileDiff(file);
  file.remove();
  gate.resolve();
  await pending;

  assert.equal(highlightCalls.length, 0);
});

test('one iterations fetch per PR and one file fetch per commit and path', async () => {
  const server = standardServer({
    files: {
      [`common2:${PATH}`]: OLD_TEXT,
      [`src2:${PATH}`]: NEW_TEXT,
      'common2:/src/Other.vue': OLD_TEXT,
      'src2:/src/Other.vue': NEW_TEXT
    }
  });
  const { window } = await loadExtension({ fetch: server.fetch });

  await Promise.all([
    window.processFileDiff(mount(window, inlineCard())),
    window.processFileDiff(mount(window, inlineCard('/src/Other.vue')))
  ]);
  await window.processFileDiff(mount(window, inlineCard()));

  const paths = server.calls.map(call => call.url.pathname);
  assert.equal(paths.filter(path => path.endsWith('/iterations')).length, 1);
  assert.equal(paths.filter(path => path.endsWith('/items')).length, 4);
});

test('a failed request is not cached, so a later file retries it', async () => {
  const server = standardServer();
  let failNext = true;
  const fetch = async (url, options) => {
    if (failNext) {
      failNext = false;
      return jsonResponse({ message: 'busy' }, 503);
    }
    return server.fetch(url, options);
  };
  const { window, highlightCalls } = await loadExtension({ fetch });

  await window.processFileDiff(mount(window, inlineCard(PATH, [INLINE_ROWS[6]])));
  await window.processFileDiff(mount(window, inlineCard(PATH, [INLINE_ROWS[6]])));

  assert.deepEqual(languages(highlightCalls), ['vue', 'typescript']);
});

test('a non-vue file takes the upstream path: synchronous, no fetch, file language', async () => {
  const server = standardServer();
  const { window, highlightCalls } = await loadExtension({ fetch: server.fetch });
  const file = mount(window, fileCard({
    filePath: '/src/util.ts',
    diff: inlineRow({ oldLine: 1, newLine: 1, type: 'unchanged', code: 'const a = 1' })
  }));

  const result = window.processFileDiff(file);

  assert.equal(result, undefined);
  assert.equal(server.calls.length, 0);
  assert.deepEqual(languages(highlightCalls), ['ts']);
  assert.match(highlightedClones(file)[0].innerHTML, /token keyword/);
});

test('a .vue file outside a pull request keeps upstream behavior', async () => {
  const server = standardServer();
  const { window, highlightCalls } = await loadExtension({
    url: 'https://dev.azure.com/org/Project/_git/Repo/commit/abc123',
    fetch: server.fetch
  });
  const file = mount(window, inlineCard());

  const result = window.processFileDiff(file);

  assert.equal(result, undefined);
  assert.equal(server.calls.length, 0);
  assert.deepEqual(languages(highlightCalls), INLINE_ROWS.map(() => 'vue'));
});

test('a custom pattern for *.vue keeps upstream behavior', async () => {
  const server = standardServer();
  const { window, highlightCalls } = await loadExtension({
    fetch: server.fetch,
    customFilePatterns: { '*.vue': 'markup' }
  });
  window.processFileDiff(mount(window, inlineCard()));

  assert.equal(server.calls.length, 0);
  assert.deepEqual(languages(highlightCalls), INLINE_ROWS.map(() => 'markup'));
});

test('CRLF file text maps lines the same way', async () => {
  const server = standardServer({
    files: {
      [`common2:${PATH}`]: OLD_TEXT.replaceAll('\n', '\r\n'),
      [`src2:${PATH}`]: NEW_TEXT.replaceAll('\n', '\r\n')
    }
  });
  const { window, highlightCalls } = await loadExtension({ fetch: server.fetch });
  await window.processFileDiff(mount(window, inlineCard()));

  assert.deepEqual(languages(highlightCalls), INLINE_ROWS.map(([, language]) => language));
});
