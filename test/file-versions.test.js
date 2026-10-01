const test = require('node:test');
const assert = require('node:assert/strict');
const { PR_URL, loadExtension, mount, fileCard, inlineRow, singleColumnRow, iteration, createAdoServer } = require('./helpers');

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
    files: { [`common1:${PATH}`]: TEXT_1, [`common2:${PATH}`]: TEXT_2, [`src2:${PATH}`]: TEXT_2 }
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
