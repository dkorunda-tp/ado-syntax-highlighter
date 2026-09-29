const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadExtension,
  mount,
  fileCard,
  inlineRow,
  singleColumnRow,
  sideBySide,
  iteration,
  createAdoServer,
  highlightedClones
} = require('./helpers');

const PATH = '/frontend/src/components/Account/AccountCapCards.vue';

const NEW_LINES = [
  '<template>',
  '  <Datepicker',
  '    v-model="date"',
  '    :enable-time-picker="false"',
  '    auto-apply',
  '  />',
  '  <v-btn',
  '    color="primary"',
  '  >',
  '    Save',
  '  </v-btn>',
  '  <!-- first',
  '    second -->',
  '</template>',
  '',
  '<script setup lang="ts">',
  '/* one',
  '   two */',
  'const label = `a',
  'b ${x}`',
  '</script>'
];

// Old line 3 has the same text as new line 3, but sits in a comment instead of a tag.
const OLD_LINES = [
  '<template>',
  '  <!--',
  '    v-model="date"',
  '  -->',
  '</template>'
];

function server(files = { [`common2:${PATH}`]: OLD_LINES.join('\n'), [`src2:${PATH}`]: NEW_LINES.join('\n') }) {
  return createAdoServer({ iterations: [iteration(1, 'src1', 'common1'), iteration(2, 'src2', 'common2')], files });
}

async function highlight(diff, filePath = PATH, files) {
  const { window } = await loadExtension({ fetch: server(files).fetch });
  const file = mount(window, fileCard({ filePath, diff }));
  await window.processFileDiff(file);
  return { window, file, contents: highlightedClones(file).map(clone => clone.querySelector(':scope > div')) };
}

function addedFile() {
  return highlight(NEW_LINES.map((code, index) => singleColumnRow({ line: index + 1, type: 'added', code })).join(''));
}

function texts(content, selector) {
  return [...content.querySelectorAll(selector)].map(element => element.textContent);
}

// The HTML that per-row highlighting gives, serialized the way the page serializes it.
function perRow(window, text, language) {
  const grammar = window.Prism.languages[language];
  const element = window.document.createElement('div');
  element.innerHTML = grammar ? window.Prism.highlight(text, grammar, language) : window.Prism.util.encode(text);
  return element.innerHTML;
}

test('each line of the file token list has the text of its file line', async () => {
  const { window } = await loadExtension();
  const lines = Array.from(window.parseVueFileLines(NEW_LINES.join('\r\n')));

  assert.deepEqual(lines.map(line => line.text), NEW_LINES);
  const text = tokens => tokens.map(item => (typeof item === 'string' ? item : text(item.content))).join('');
  assert.deepEqual(lines.map(line => text(line.tokens)), NEW_LINES);
  assert.deepEqual(lines.map(line => line.language), Array.from(window.parseVueLineLanguages(NEW_LINES.join('\n'))));
});

test('a multi-line opening tag gets tag, attr-name and attr-value tokens on every row', async () => {
  const { contents } = await addedFile();

  assert.deepEqual(texts(contents[1], '.token.tag .token.punctuation'), ['<']);
  assert.match(contents[1].querySelector('.token.tag').textContent, /^<Datepicker$/);
  assert.deepEqual(texts(contents[2], '.token.tag .token.attr-name'), ['v-model']);
  assert.deepEqual(texts(contents[2], '.token.tag .token.attr-value'), ['="date"']);
  assert.deepEqual(texts(contents[3], '.token.tag .token.attr-name'), [':enable-time-picker']);
  assert.deepEqual(texts(contents[3], '.token.tag .token.attr-value'), ['="false"']);
  assert.deepEqual(texts(contents[4], '.token.tag .token.attr-name'), ['auto-apply']);
  assert.deepEqual(texts(contents[7], '.token.tag .token.attr-name'), ['color']);
  contents.forEach((content, index) => assert.equal(content.textContent, NEW_LINES[index]));
});

test('the closing /> and > rows of a multi-line tag are tag punctuation', async () => {
  const { contents } = await addedFile();

  assert.deepEqual(texts(contents[5], '.token.tag .token.punctuation'), ['/>']);
  assert.deepEqual(texts(contents[8], '.token.tag .token.punctuation'), ['>']);
});

test('a multi-line HTML comment in the template is a comment on every row', async () => {
  const { contents } = await addedFile();

  assert.deepEqual(texts(contents[11], '.token.comment'), ['<!-- first']);
  assert.deepEqual(texts(contents[12], '.token.comment'), ['    second -->']);
});

test('a multi-line block comment and template string in the script keep their tokens on every row', async () => {
  const { contents } = await addedFile();

  assert.deepEqual(texts(contents[16], '.token.comment'), ['/* one']);
  assert.deepEqual(texts(contents[17], '.token.comment'), ['   two */']);
  assert.deepEqual(texts(contents[18], '.token.template-string'), ['`a']);
  assert.deepEqual(texts(contents[19], '.token.template-string'), ['b ${x}`']);
  assert.deepEqual(texts(contents[19], '.token.template-string .token.interpolation'), ['${x}']);
  assert.deepEqual(texts(contents[19], '.token.template-string .token.template-punctuation'), ['`']);
});

test('ADO spans in a row survive, and the row still gets the file tokens', async () => {
  const { contents } = await highlight([
    inlineRow({ newLine: 3, type: 'added', code: '', html: '    v-model="<span class="added-content" data-offset="13">date</span>"' }),
    inlineRow({ newLine: 4, type: 'added', code: `${'\xa0'.repeat(4)}:enable-time-picker="false"` })
  ].join(''));

  const added = contents[0].querySelector('span.added-content');
  assert.equal(added.getAttribute('data-offset'), '13');
  assert.equal(added.textContent, 'date');
  assert.ok(added.closest('.token.attr-value'));
  assert.deepEqual(texts(contents[0], '.token.tag .token.attr-name'), ['v-model']);

  // Non-breaking spaces match spaces in the file line. Prism turns them into spaces, as it does for per-row highlighting.
  assert.deepEqual(texts(contents[1], '.token.tag .token.attr-name'), [':enable-time-picker']);
  assert.equal(contents[1].textContent, '    :enable-time-picker="false"');
});

test('a row whose text differs from its file line gets per-row highlighting', async () => {
  const { window, contents } = await highlight(
    inlineRow({ newLine: 3, type: 'added', code: '    v-model="other"' })
  );

  assert.equal(contents[0].innerHTML, perRow(window, '    v-model="other"', 'markup'));
});

test('side-by-side rows use the tokens of their own side', async () => {
  const { contents } = await highlight(sideBySide({
    oldRows: [{ line: 3, type: 'removed', code: '    v-model="date"' }],
    newRows: [{ line: 3, type: 'added', code: '    v-model="date"' }]
  }));

  assert.deepEqual(texts(contents[0], '.token.comment'), ['    v-model="date"']);
  assert.deepEqual(texts(contents[0], '.token.attr-name'), []);
  assert.deepEqual(texts(contents[1], '.token.attr-name'), ['v-model']);
  assert.deepEqual(texts(contents[1], '.token.comment'), []);
});

test('inline rows use the tokens of their own side', async () => {
  const { contents } = await highlight([
    inlineRow({ oldLine: 3, type: 'removed', code: '    v-model="date"' }),
    inlineRow({ newLine: 3, type: 'added', code: '    v-model="date"' })
  ].join(''));

  assert.deepEqual(texts(contents[0], '.token.comment'), ['    v-model="date"']);
  assert.deepEqual(texts(contents[1], '.token.attr-name'), ['v-model']);
});

test('a side whose fetch fails gets per-row highlighting', async () => {
  const { window, contents } = await highlight([
    inlineRow({ oldLine: 3, type: 'removed', code: '    v-model="date"' }),
    inlineRow({ newLine: 3, type: 'added', code: '    v-model="date"' })
  ].join(''), PATH, { [`src2:${PATH}`]: NEW_LINES.join('\n') });

  assert.equal(contents[0].innerHTML, perRow(window, '    v-model="date"', 'vue'));
  assert.deepEqual(texts(contents[1], '.token.attr-name'), ['v-model']);
});

test('a side whose tokenizing throws gets per-row highlighting, and the other side keeps its tokens', async () => {
  const oldText = [...OLD_LINES, '<!-- tokenizer fails here -->'].join('\n');
  const { window } = await loadExtension({ fetch: server({ [`common2:${PATH}`]: oldText, [`src2:${PATH}`]: NEW_LINES.join('\n') }).fetch });
  const tokenize = window.Prism.tokenize;
  window.Prism.tokenize = (code, grammar) => {
    if (code.includes('tokenizer fails here')) throw new Error('tokenizer failure');
    return tokenize(code, grammar);
  };
  const file = mount(window, fileCard({
    filePath: PATH,
    diff: [
      inlineRow({ oldLine: 3, type: 'removed', code: '    v-model="date"' }),
      inlineRow({ newLine: 3, type: 'added', code: '    v-model="date"' })
    ].join('')
  }));

  await window.processFileDiff(file);

  const contents = highlightedClones(file).map(clone => clone.querySelector(':scope > div'));
  assert.equal(contents[0].innerHTML, perRow(window, '    v-model="date"', 'vue'));
  assert.deepEqual(texts(contents[1], '.token.attr-name'), ['v-model']);
});

test('a row that throws while it is highlighted does not give its file tokens to a later highlight', async () => {
  const { window } = await loadExtension({ fetch: server().fetch });
  const highlightElement = window.Prism.highlightElement;
  window.Prism.highlightElement = function () {
    window.Prism.highlightElement = highlightElement;
    throw new Error('highlight failure');
  };
  const file = mount(window, fileCard({
    filePath: PATH,
    diff: inlineRow({ newLine: 3, type: 'added', code: '    v-model="date"' })
  }));

  await assert.rejects(window.processFileDiff(file), /highlight failure/);

  assert.equal(
    window.Prism.highlight('    v-model="date"', window.Prism.languages.markup, 'markup'),
    window.Prism.util.encode('    v-model="date"')
  );
});

test('a non-vue file keeps per-row highlighting, also after a .vue file', async () => {
  const { window } = await addedFile();
  const rows = ['  <Datepicker', '    v-model="date"', '  />'];
  const file = mount(window, fileCard({
    filePath: '/src/page.html',
    diff: rows.map((code, index) => inlineRow({ oldLine: index + 2, newLine: index + 2, type: 'unchanged', code })).join('')
  }));

  window.processFileDiff(file);

  const contents = highlightedClones(file).map(clone => clone.querySelector(':scope > div'));
  assert.deepEqual(contents.map(content => content.innerHTML), rows.map(code => perRow(window, code, 'html')));
});
