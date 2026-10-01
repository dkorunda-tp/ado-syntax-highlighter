const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadExtension, mount, commentCard, commentRow, fileCard, inlineRow, iteration, createAdoServer, highlightedClones
} = require('./helpers');

const OVERVIEW_URL = 'https://dev.azure.com/org/Project/_git/Repo/pullrequest/42?_a=overview';
const PATH = '/frontend/src/views/admin/playbook-items/PlaybookItemsView.vue';
const FILE_TEXT = [
  '<template>',
  '  <v-text-field',
  '    v-model="title"',
  '  />',
  '</template>',
  '<script setup lang="ts">',
  'const isActionOpen = computed(',
  '  () => editingKey.value !== null,',
  ')',
  '</script>'
].join('\n');
const FILE_LINES = FILE_TEXT.split('\n');
const rowsFor = (from, to) => FILE_LINES.slice(from - 1, to).map((code, index) => ({ line: from + index, type: 'added', code }));

function server() {
  return createAdoServer({ iterations: [iteration(1, 'src1', 'common1')], files: { [`src1:${PATH}`]: FILE_TEXT } });
}

test('an Overview comment-thread card of a .ts file gets the tokens of its file language', async () => {
  const { window, highlightCalls } = await loadExtension({ url: OVERVIEW_URL });
  const card = mount(window, commentCard({ filePath: '/src/util.ts', rows: [{ line: 3, type: 'added', code: 'const a = 1' }] }));

  window.processFileDiff(card);

  assert.deepEqual(highlightCalls.map(call => call.language), ['ts']);
  assert.match(highlightedClones(card)[0].innerHTML, /<span class="token keyword">const<\/span>/);
});

test('a .vue thread snippet reads the path from the card and takes the tokens of the whole file', async () => {
  const ado = server();
  const { window, highlightCalls } = await loadExtension({ url: OVERVIEW_URL, fetch: ado.fetch });
  const card = mount(window, commentCard({ filePath: PATH, rows: rowsFor(2, 8) }));

  await window.processFileDiff(card);

  assert.deepEqual(highlightCalls.map(call => call.language),
    ['vue-template', 'vue-template', 'vue-template', 'vue-template', 'markup', 'typescript', 'typescript']);
  // The attribute line of a multi-line tag only gets an attr-name token from the whole-file tokens.
  assert.match(highlightedClones(card)[1].innerHTML, /token attr-name/);
  assert.ok(ado.calls.some(call => call.url.searchParams.get('path') === PATH && call.url.searchParams.get('versionDescriptor.version') === 'src1'));
});

test('a .vue thread card with no rows yet makes no request, and its first rows are highlighted on a later pass', async () => {
  const ado = server();
  const { window, highlightCalls } = await loadExtension({ url: OVERVIEW_URL, fetch: ado.fetch });
  const card = mount(window, commentCard({ filePath: PATH, rows: [] }));

  await window.processFileDiff(card);
  assert.equal(ado.calls.length, 0);
  assert.equal(highlightCalls.length, 0);

  card.querySelector('.repos-summary-diff-container > div').insertAdjacentHTML('beforeend', rowsFor(3, 3).map(commentRow).join(''));
  await window.processFileDiff(card);

  assert.deepEqual(highlightCalls.map(call => call.language), ['vue-template']);
  assert.match(highlightedClones(card)[0].innerHTML, /token attr-name/);
});

test('a pass highlights the Overview thread cards and the Files tab cards', async () => {
  const { window, highlightCalls } = await loadExtension({ url: OVERVIEW_URL });
  mount(window, commentCard({ filePath: '/src/a.ts', rows: [{ line: 1, type: 'added', code: 'let a = 1' }] }));
  mount(window, fileCard({ filePath: '/src/b.cs', diff: inlineRow({ oldLine: 1, newLine: 1, type: 'unchanged', code: 'var b = 1;' }) }));

  window.applySyntaxHighlighting();

  assert.deepEqual(highlightCalls.map(call => call.language).sort(), ['cs', 'ts']);
});
