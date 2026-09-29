const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadExtension,
  mount,
  fileCard,
  inlineRow,
  singleColumnRow,
  iteration,
  createAdoServer,
  highlightedClones
} = require('./helpers');

const PATH = '/frontend/src/components/playbooks/PlaybookChecklist.vue';

const LINES = [
  '<template>',
  `  <div v-for="(group, groupIndex) in stage.groups" :key="group.label ?? ''">`,
  '    {{ group.label }}',
  '    <v-checkbox @update:model-value="onToggleItem(item)" class="x" density="compact" />',
  '    <List v-slot="{ item }" title="{{ raw }}">',
  '      <template #label>Name</template>',
  '      <span',
  '        :class="{',
  '          active: item.id === selectedId,',
  '        }"',
  '        :aria-labelledby="',
  '          item.id ? `label-${item.id}` : undefined',
  '        "',
  '      >{{',
  '        item.name',
  '      }}</span>',
  '    </List>',
  '  </div>',
  '</template>',
  '',
  '<script setup lang="ts">',
  'const a = 1',
  '</script>'
];

function server(text = LINES.join('\n')) {
  return createAdoServer({ iterations: [iteration(1, 'src1', 'common1')], files: { [`src1:${PATH}`]: text } });
}

async function highlight(diff, filePath = PATH) {
  const { window, highlightCalls } = await loadExtension({ fetch: server().fetch });
  const file = mount(window, fileCard({ filePath, diff }));
  await window.processFileDiff(file);
  return { window, highlightCalls, contents: highlightedClones(file).map(clone => clone.querySelector(':scope > div')) };
}

function addedFile() {
  return highlight(LINES.map((code, index) => singleColumnRow({ line: index + 1, type: 'added', code })).join(''));
}

function texts(content, selector) {
  return [...content.querySelectorAll(selector)].map(element => element.textContent);
}

// The HTML that per-row highlighting gives, serialized the way the page serializes it.
function perRow(window, text, language) {
  const element = window.document.createElement('div');
  element.innerHTML = window.Prism.highlight(text, window.Prism.languages[language], language);
  return element.innerHTML;
}

test('template content lines are vue-template; root lines and block tag lines stay markup', async () => {
  const { window, highlightCalls } = await addedFile();

  const expected = LINES.map((line, index) => {
    if (index >= 1 && index <= 17) return 'vue-template';
    return index === 21 ? 'typescript' : 'markup';
  });
  assert.deepEqual(Array.from(window.parseVueLineLanguages(LINES.join('\n'))), expected);
  assert.deepEqual(highlightCalls.map(call => call.language), expected);
});

test('an interpolation has brace punctuation and a TypeScript expression', async () => {
  const { contents } = await addedFile();

  assert.deepEqual(texts(contents[2], '.token.interpolation > .token.punctuation'), ['{{', '}}']);
  assert.deepEqual(texts(contents[2], '.token.interpolation > .token.typescript'), [' group.label ']);
  assert.deepEqual(texts(contents[2], '.token.interpolation .token.typescript .token.punctuation'), ['.']);
  assert.equal(contents[2].textContent, LINES[2]);
});

test('a v-for value is TypeScript, with = punctuation and attr-value quotes', async () => {
  const { contents } = await addedFile();
  const row = contents[1];

  assert.deepEqual(texts(row, '.token.tag .token.attr-name'), ['v-for', ':key']);
  assert.deepEqual(texts(row, '.token.special-attr > .token.typescript'), ['(group, groupIndex) in stage.groups', "group.label ?? ''"]);
  assert.deepEqual(texts(row, '.token.special-attr > .token.punctuation'), ['=', '=']);
  assert.deepEqual(texts(row, '.token.special-attr > .token.attr-value'), ['"', '"', '"', '"']);
  assert.deepEqual(texts(row, '.token.special-attr .token.typescript .token.keyword'), ['in']);
  assert.deepEqual(texts(row, '.token.special-attr .token.typescript .token.operator'), ['??']);
  assert.deepEqual(texts(row, '.token.special-attr .token.typescript .token.string'), ["''"]);
  assert.equal(row.textContent, LINES[1]);
});

// Theme CSS colors attr-value, and plain TypeScript identifiers would inherit that string color. Monaco
// colors each TypeScript token by its own type, so the value must not sit inside an attr-value token.
test('a directive value has no attr-value ancestor, so its identifiers keep the base text color', async () => {
  const { contents } = await addedFile();
  const values = [1, 3, 4, 7, 8, 11].flatMap(index => [...contents[index].querySelectorAll('.token.typescript')]);

  assert.ok(values.length >= 6);
  values.forEach(value => assert.equal(value.closest('.token.attr-value'), null, value.textContent));
});

test('an @ event with an argument is TypeScript, and plain attributes on the same tag stay strings', async () => {
  const { contents } = await addedFile();
  const row = contents[3];

  assert.deepEqual(texts(row, '.token.tag .token.attr-name'), ['@update:model-value', 'class', 'density']);
  assert.deepEqual(texts(row, '.token.special-attr > .token.typescript'), ['onToggleItem(item)']);
  assert.deepEqual(texts(row, '.token.special-attr .token.typescript .token.function'), ['onToggleItem']);
  assert.deepEqual(texts(row, '.token.attr-value'), ['"', '"', '="x"', '="compact"']);
});

test('a v-slot value is TypeScript, a #slot without a value is an attribute name, and {{ }} in a plain attribute is a string', async () => {
  const { contents } = await addedFile();

  assert.deepEqual(texts(contents[4], '.token.tag .token.attr-name'), ['v-slot', 'title']);
  assert.deepEqual(texts(contents[4], '.token.special-attr > .token.typescript'), ['{ item }']);
  assert.deepEqual(texts(contents[4], '.token.attr-value'), ['"', '"', '="{{ raw }}"']);
  assert.deepEqual(texts(contents[4], '.token.interpolation'), []);

  assert.deepEqual(texts(contents[5], '.token.tag .token.attr-name'), ['#label']);
  assert.deepEqual(texts(contents[5], '.token.typescript'), []);
});

test('a multi-line :class object is TypeScript on every row', async () => {
  const { contents } = await addedFile();

  assert.deepEqual(texts(contents[7], '.token.tag .token.attr-name'), [':class']);
  assert.deepEqual(texts(contents[7], '.token.special-attr > .token.punctuation'), ['=']);
  assert.deepEqual(texts(contents[7], '.token.special-attr > .token.attr-value'), ['"']);
  assert.deepEqual(texts(contents[7], '.token.special-attr .token.typescript .token.punctuation'), ['{']);
  assert.deepEqual(texts(contents[8], '.token.special-attr .token.typescript .token.operator'), [':', '===']);
  assert.deepEqual(texts(contents[8], '.token.special-attr .token.typescript .token.punctuation'), ['.', ',']);
  assert.deepEqual(texts(contents[9], '.token.special-attr .token.typescript .token.punctuation'), ['}']);
  assert.deepEqual(texts(contents[9], '.token.special-attr > .token.attr-value'), ['"']);
});

test('a multi-line :aria-labelledby value is TypeScript on its middle row, with quote punctuation on the first and last rows', async () => {
  const { contents } = await addedFile();

  assert.deepEqual(texts(contents[10], '.token.tag .token.attr-name'), [':aria-labelledby']);
  assert.deepEqual(texts(contents[10], '.token.special-attr > .token.punctuation'), ['=']);
  assert.deepEqual(texts(contents[10], '.token.special-attr > .token.attr-value'), ['"']);
  assert.deepEqual(texts(contents[11], '.token.special-attr .token.typescript .token.template-string'), ['`label-${item.id}`']);
  assert.deepEqual(texts(contents[11], '.token.special-attr .token.typescript .token.keyword'), ['undefined']);
  assert.deepEqual(texts(contents[12], '.token.special-attr > .token.attr-value'), ['"']);
  // Only the indentation before the closing quote is left of the value on this row.
  assert.equal(texts(contents[12], '.token.typescript').join('').trim(), '');
});

test('an interpolation over three rows has its braces and a TypeScript expression on every row', async () => {
  const { contents } = await addedFile();

  assert.deepEqual(texts(contents[13], '.token.tag > .token.punctuation'), ['>']);
  assert.deepEqual(texts(contents[13], '.token.interpolation > .token.punctuation'), ['{{']);
  assert.deepEqual(texts(contents[14], '.token.interpolation > .token.typescript .token.punctuation'), ['.']);
  assert.match(texts(contents[14], '.token.interpolation > .token.typescript').join(''), /item\.name/);
  assert.deepEqual(texts(contents[15], '.token.interpolation > .token.punctuation'), ['}}']);
  assert.deepEqual(texts(contents[15], '.token.tag .token.tag'), ['</span']);
  contents.forEach((content, index) => assert.equal(content.textContent, LINES[index]));
});

test('v-bind:x, v-on:x with modifiers, v-model and v-if values are TypeScript', async () => {
  const { window } = await loadExtension();
  const content = window.document.createElement('div');
  content.innerHTML = perRow(window, `<a v-bind:href="url" v-on:click.stop="go()" v-model='name' v-if="ok">`, 'vue-template');

  assert.deepEqual(texts(content, '.token.attr-name'), ['v-bind:href', 'v-on:click.stop', 'v-model', 'v-if']);
  assert.deepEqual(texts(content, '.token.special-attr > .token.typescript'), ['url', 'go()', 'name', 'ok']);
  assert.deepEqual(texts(content, '.token.special-attr > .token.punctuation'), ['=', '=', '=', '=']);
  assert.deepEqual(texts(content, '.token.special-attr > .token.attr-value'), ['"', '"', '"', '"', "'", "'", '"', '"']);
});

test('a {{ }} inside an HTML comment stays part of the comment', async () => {
  const { window } = await loadExtension();
  const content = window.document.createElement('div');
  content.innerHTML = perRow(window, '<!-- {{ old }} --><p>{{ now }}</p>', 'vue-template');

  assert.deepEqual(texts(content, '.token.comment'), ['<!-- {{ old }} -->']);
  assert.deepEqual(texts(content, '.token.interpolation'), ['{{ now }}']);
});

// Vue reads everything up to the first }} as the expression, so a string that looks like a tag or a comment stays in it.
test('a tag or a comment inside a {{ }} string stays part of the TypeScript expression', async () => {
  const { window } = await loadExtension();
  const content = window.document.createElement('div');
  content.innerHTML = perRow(window, `<p>{{ '<b>' + x }}</p><i>{{ '<!--y-->' }}</i>`, 'vue-template');

  assert.deepEqual(texts(content, '.token.interpolation'), [`{{ '<b>' + x }}`, `{{ '<!--y-->' }}`]);
  assert.deepEqual(texts(content, '.token.interpolation .token.string'), [`'<b>'`, `'<!--y-->'`]);
  assert.deepEqual(texts(content, '.token.comment'), []);
  assert.deepEqual(texts(content, '.token.tag > .token.tag'), ['<p', '</p', '<i', '</i']);
});

test('plain attributes give the same tokens as markup', async () => {
  const { window } = await loadExtension();
  const text = '<v-btn class="x" density="compact" style="color: red" onclick="go()" disabled>Save &amp; close</v-btn>';

  assert.equal(perRow(window, text, 'vue-template'), perRow(window, text, 'markup'));
});

test('an ADO span inside an interpolation and inside a directive value survives', async () => {
  const { contents } = await highlight([
    inlineRow({ newLine: 3, type: 'added', code: '', html: '    {{ <span class="added-content" data-offset="7">group</span>.label }}' }),
    inlineRow({ newLine: 4, type: 'added', code: '', html: '    &lt;v-checkbox @update:model-value="<span class="added-content">onToggleItem</span>(item)" class="x" density="compact" /&gt;' })
  ].join(''));

  const inInterpolation = contents[0].querySelector('span.added-content');
  assert.equal(inInterpolation.getAttribute('data-offset'), '7');
  assert.equal(inInterpolation.textContent, 'group');
  assert.ok(inInterpolation.closest('.token.interpolation > .token.typescript'));

  const inDirective = contents[1].querySelector('span.added-content');
  assert.equal(inDirective.textContent, 'onToggleItem');
  assert.ok(inDirective.closest('.token.special-attr > .token.typescript'));
  assert.equal(contents[1].textContent, LINES[3]);
});

test('a template row whose text differs from its file line gets per-row vue-template highlighting', async () => {
  const code = '    {{ other.label }}';
  const { window, contents } = await highlight(inlineRow({ newLine: 3, type: 'added', code }));

  assert.equal(contents[0].innerHTML, perRow(window, code, 'vue-template'));
  assert.deepEqual(texts(contents[0], '.token.interpolation > .token.punctuation'), ['{{', '}}']);
});

test('a non-vue file keeps markup rules: no interpolation and no TypeScript directive values', async () => {
  const { window } = await addedFile();
  const rows = ['<div :key="a" v-if="b">{{ x }}</div>'];
  const file = mount(window, fileCard({
    filePath: '/src/page.html',
    diff: rows.map((code, index) => inlineRow({ oldLine: index + 1, newLine: index + 1, type: 'unchanged', code })).join('')
  }));

  window.processFileDiff(file);

  const [content] = highlightedClones(file).map(clone => clone.querySelector(':scope > div'));
  assert.equal(content.innerHTML, perRow(window, rows[0], 'html'));
  assert.deepEqual(texts(content, '.token.interpolation'), []);
  assert.deepEqual(texts(content, '.token.typescript'), []);
  assert.deepEqual(texts(content, '.token.attr-value'), ['="a"', '="b"']);
});
