const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PR_URL, loadExtension, mount, fileCard, commentCard, inlineRow, singleColumnRow, gatedFetch, iteration, createAdoServer
} = require('./helpers');

const PATH = '/frontend/src/components/playbook/PlaybookItemEditor.vue';
// Push 2 adds a blank line 2, so every later line moves down one; the style line shows which version a row used.
const TEXT_1 = ['<template>', '  <div />', '</template>', '<style>', '.a { color: red; }', '</style>'].join('\n');
const TEXT_2 = ['<template>', '', '  <div />', '</template>', '<style>', '.a { color: red; }', '</style>'].join('\n');

function itemCalls(server) {
  return server.calls
    .filter(call => call.url.pathname.endsWith('/items'))
    .map(call => call.url.searchParams.get('versionDescriptor.version'));
}

function addedCard(text) {
  return fileCard({
    filePath: PATH,
    diff: text.split('\n').map((code, index) => singleColumnRow({ line: index + 1, type: 'added', code })).join('')
  });
}

const languages = highlightCalls => highlightCalls.map(call => call.language);

test('an added file shown at an older push takes the newest push whose lines match the rows', async () => {
  const server = createAdoServer({
    iterations: [iteration(1, 'src1', 'common'), iteration(2, 'src2', 'common')],
    files: { [`src1:${PATH}`]: TEXT_1, [`src2:${PATH}`]: TEXT_2 }
  });
  const { window, highlightCalls } = await loadExtension({ fetch: server.fetch });

  await window.processFileDiff(mount(window, addedCard(TEXT_1)));

  assert.deepEqual(languages(highlightCalls), ['vue-template', 'vue-template', 'vue-template', 'markup', 'css', 'markup']);
  assert.deepEqual(itemCalls(server), ['src2', 'src1']);
});

test('an added file fetches no old side', async () => {
  const server = createAdoServer({ iterations: [iteration(1, 'src1', 'common')], files: { [`src1:${PATH}`]: TEXT_1 } });
  const { window } = await loadExtension({ fetch: server.fetch });

  await window.processFileDiff(mount(window, addedCard(TEXT_1)));

  assert.deepEqual(itemCalls(server), ['src1']);
});

test('the old side tries the common commits newest first until one matches', async () => {
  const server = createAdoServer({
    iterations: [iteration(1, 'src1', 'common1'), iteration(2, 'src2', 'common2')],
    files: { [`common1:${PATH}`]: TEXT_1, [`common2:${PATH}`]: TEXT_2 }
  });
  const { window, highlightCalls } = await loadExtension({ fetch: server.fetch });
  const removed = { oldLine: 5, type: 'removed', code: '.a { color: red; }' };

  await window.processFileDiff(mount(window, fileCard({ filePath: PATH, diff: inlineRow(removed) })));

  assert.deepEqual(languages(highlightCalls), ['css']);
  assert.deepEqual(itemCalls(server), ['common2', 'common1']);
});

test('the iterations list is fetched again on each pass, so a new push is used', async () => {
  const iterations = [iteration(1, 'src1', 'common')];
  const server = createAdoServer({ iterations, files: { [`src1:${PATH}`]: TEXT_1, [`src2:${PATH}`]: TEXT_2 } });
  const { window, highlightCalls } = await loadExtension({ fetch: server.fetch });

  window.applySyntaxHighlighting();
  await window.processFileDiff(mount(window, addedCard(TEXT_1)));
  iterations.push(iteration(2, 'src2', 'common'));
  window.document.body.innerHTML = '';
  highlightCalls.length = 0;
  window.applySyntaxHighlighting();
  await window.processFileDiff(mount(window, addedCard(TEXT_2)));

  assert.equal(server.calls.filter(call => call.url.pathname.endsWith('/iterations')).length, 2);
  assert.deepEqual(itemCalls(server), ['src1', 'src2']);
  assert.deepEqual(languages(highlightCalls), ['vue-template', 'vue-template', 'vue-template', 'vue-template', 'markup', 'css', 'markup']);
});

test('an iteration in the URL is the only version tried', async () => {
  const server = createAdoServer({
    iterations: [iteration(1, 'src1', 'common'), iteration(2, 'src2', 'common')],
    files: { [`src1:${PATH}`]: TEXT_1, [`src2:${PATH}`]: TEXT_2 }
  });
  const { window } = await loadExtension({ url: `${PR_URL}&iteration=2`, fetch: server.fetch });

  await window.processFileDiff(mount(window, addedCard(TEXT_1)));

  assert.deepEqual(itemCalls(server), ['src2']);
});

test('a base without an iteration fixes the old side and searches the new side', async () => {
  const server = createAdoServer({
    iterations: [iteration(1, 'src1', 'common'), iteration(2, 'src2', 'common'), iteration(3, 'src3', 'common')],
    files: { [`src1:${PATH}`]: TEXT_1, [`src2:${PATH}`]: TEXT_1, [`src3:${PATH}`]: TEXT_2 }
  });
  const { window, highlightCalls } = await loadExtension({ url: `${PR_URL}&base=1`, fetch: server.fetch });
  const rows = [
    { oldLine: 5, type: 'removed', code: '.a { color: red; }' },
    { newLine: 5, type: 'added', code: '.a { color: red; }' }
  ];

  await window.processFileDiff(mount(window, fileCard({ filePath: PATH, diff: rows.map(inlineRow).join('') })));

  assert.deepEqual(languages(highlightCalls), ['css', 'css']);
  assert.deepEqual(itemCalls(server).sort(), ['src1', 'src2', 'src3']);
});

test('non-breaking spaces and ADO spans in a row still match the version that has its text', async () => {
  const server = createAdoServer({
    iterations: [iteration(1, 'src1', 'common'), iteration(2, 'src2', 'common')],
    files: { [`src1:${PATH}`]: TEXT_1, [`src2:${PATH}`]: TEXT_2 }
  });
  const { window, highlightCalls } = await loadExtension({ fetch: server.fetch });
  const html = '.a&nbsp;{&nbsp;color:&nbsp;<span class="added-content">red</span>;&nbsp;}';
  const card = mount(window, fileCard({ filePath: PATH, diff: inlineRow({ newLine: 5, type: 'added', html }) }));

  await window.processFileDiff(card);

  assert.deepEqual(itemCalls(server), ['src2', 'src1']);
  assert.deepEqual(languages(highlightCalls), ['css']);
  assert.match(card.querySelector('.ado-syntax-highlighted').innerHTML, /class="added-content"/);
});

test('at most five versions are tried, and with no match the newest fetched version is used', async () => {
  const iterations = [];
  const files = {};
  for (let id = 1; id <= 8; id++) {
    iterations.push(iteration(id, `src${id}`, 'common'));
    files[`src${id}:${PATH}`] = TEXT_2;
  }
  const server = createAdoServer({ iterations, files });
  const { window, highlightCalls } = await loadExtension({ fetch: server.fetch });

  await window.processFileDiff(mount(window, addedCard(TEXT_1)));

  assert.deepEqual(itemCalls(server), ['src8', 'src7', 'src6', 'src5', 'src4']);
  // TEXT_2 line 5 is the style tag, so row 5 gets markup from the newest version, as before this check existed.
  assert.equal(languages(highlightCalls)[4], 'markup');
});

test('a version that is missing is skipped for the next one', async () => {
  const server = createAdoServer({
    iterations: [iteration(1, 'src1', 'common'), iteration(2, 'src2', 'common')],
    files: { [`src1:${PATH}`]: TEXT_1 }
  });
  const { window, highlightCalls } = await loadExtension({ fetch: server.fetch });

  await window.processFileDiff(mount(window, addedCard(TEXT_1)));

  assert.deepEqual(itemCalls(server), ['src2', 'src1']);
  assert.equal(languages(highlightCalls)[4], 'css');
});

test('a version request that never finishes times out, and the older version is used', async () => {
  const server = createAdoServer({
    iterations: [iteration(1, 'src1', 'common'), iteration(2, 'src2', 'common')],
    files: { [`src1:${PATH}`]: TEXT_1, [`src2:${PATH}`]: TEXT_2 }
  });
  const stalled = [];
  const fetch = (url, options) => {
    if (!new URL(url).searchParams.get('versionDescriptor.version')?.startsWith('src2')) return server.fetch(url, options);
    stalled.push(options.signal);
    return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  const { window, highlightCalls } = await loadExtension({ fetch });
  // Run the request timeout at once instead of after its full delay.
  const setTimeoutOf = window.setTimeout;
  window.setTimeout = (callback, delay, ...args) => setTimeoutOf(callback, delay >= 10000 ? 0 : delay, ...args);

  await window.processFileDiff(mount(window, addedCard(TEXT_1)));

  assert.equal(stalled.length, 1);
  assert.equal(stalled[0]?.aborted, true);
  assert.equal(languages(highlightCalls)[4], 'css');
});

test('the last five pushes bound the search even when their commits repeat', async () => {
  // Pushes 2 to 6 share one common commit; push 1 is the sixth newest, so its common commit is never tried.
  const iterations = [iteration(1, 'src1', 'commonB')];
  for (let id = 2; id <= 6; id++) iterations.push(iteration(id, `src${id}`, 'commonA'));
  const server = createAdoServer({ iterations, files: { [`commonA:${PATH}`]: TEXT_2, [`commonB:${PATH}`]: TEXT_1 } });
  const { window } = await loadExtension({ fetch: server.fetch });
  const removed = { oldLine: 5, type: 'removed', code: '.a { color: red; }' };

  await window.processFileDiff(mount(window, fileCard({ filePath: PATH, diff: inlineRow(removed) })));

  assert.deepEqual(itemCalls(server), ['commonA']);
});

test('rows that appear while the fetch is in flight take part in the version choice', async () => {
  const server = createAdoServer({
    iterations: [iteration(1, 'src1', 'common'), iteration(2, 'src2', 'common')],
    files: { [`src1:${PATH}`]: TEXT_1, [`src2:${PATH}`]: TEXT_2 }
  });
  const gated = gatedFetch(server.fetch);
  const { window, highlightCalls } = await loadExtension({ fetch: gated.fetch });
  // Row 1 is the same in both pushes; row 5 shows that the page holds push 1.
  const card = mount(window, fileCard({ filePath: PATH, diff: singleColumnRow({ line: 1, type: 'added', code: '<template>' }) }));

  const pending = window.processFileDiff(card);
  card.querySelector('.repos-summary-code-diff')
    .insertAdjacentHTML('beforeend', singleColumnRow({ line: 5, type: 'added', code: '.a { color: red; }' }));
  gated.open();
  await pending;

  assert.deepEqual(languages(highlightCalls), ['vue-template', 'css']);
});

const THREAD_URL = 'https://dev.azure.com/org/Project/_git/Repo/pullrequest/42?_a=overview';
// The old file has the style block two lines earlier than the new one.
const OLD_FILE = TEXT_1;
const NEW_FILE = ['<template>', '  <div />', '  <p />', '  <p />', '</template>', '<style>', '.a { color: red; }', '</style>'].join('\n');

function threadServer() {
  return createAdoServer({
    iterations: [iteration(1, 'src1', 'common1')],
    files: { [`common1:${PATH}`]: OLD_FILE, [`src1:${PATH}`]: NEW_FILE }
  });
}

test('a thread on the left side of an edited file reads its unchanged rows from the old file', async () => {
  const server = threadServer();
  const { window, highlightCalls } = await loadExtension({ url: THREAD_URL, fetch: server.fetch });
  const rows = [
    { line: 4, type: 'unchanged', code: '<style>' },
    { line: 5, type: 'removed', code: '.a { color: red; }' }
  ];

  await window.processFileDiff(mount(window, commentCard({ filePath: PATH, rows })));

  assert.deepEqual(languages(highlightCalls), ['markup', 'css']);
  assert.deepEqual(itemCalls(server), ['common1']);
});

test('a thread with unchanged rows only takes the new file when they match it, else the old file', async () => {
  const languagesFor = async rows => {
    const server = threadServer();
    const { window, highlightCalls } = await loadExtension({ url: THREAD_URL, fetch: server.fetch });
    await window.processFileDiff(mount(window, commentCard({ filePath: PATH, rows })));
    return { languages: languages(highlightCalls), items: itemCalls(server) };
  };

  // Line 7 of the new file and line 5 of the old file are the same CSS line.
  assert.deepEqual(await languagesFor([{ line: 7, type: 'unchanged', code: '.a { color: red; }' }]),
    { languages: ['css'], items: ['src1'] });
  assert.deepEqual(await languagesFor([{ line: 5, type: 'unchanged', code: '.a { color: red; }' }]),
    { languages: ['css'], items: ['src1', 'common1'] });
});
