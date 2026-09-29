// Runs monaco_bridge.js against the real monaco-editor 0.29 build, the API range ADO ships.
const test = require('node:test');
const assert = require('node:assert/strict');
const { VUE_PATH, loadRealMonaco, waitFor } = require('./monaco-helpers');

// The tokens of one line with their text. Monaco merges neighbors of the same type, so a quoted value is one token.
function lineTokens(tokens, line) {
  return Array.from(tokens, (token, index) => {
    const end = index + 1 < tokens.length ? tokens[index + 1].offset : line.length;
    return { text: line.slice(token.offset, end), type: token.type, language: token.language };
  });
}

function tokenizeLines(monaco, lines) {
  return Array.from(monaco.editor.tokenize(lines.join('\n'), 'vue'), (tokens, index) => lineTokens(tokens, lines[index]));
}

function typesOf(line) {
  return line.map(token => token.type);
}

function visibleTypesOf(line) {
  return typesOf(line.filter(token => token.text.trim()));
}

function languagesOf(line) {
  return [...new Set(line.map(token => token.language))];
}

function tokenOf(line, text) {
  return line.find(token => token.text === text);
}

// Embedded grammars load on first use, so tokenize until TypeScript, CSS and SCSS all answer.
async function waitForEmbeddedGrammars(monaco) {
  const lines = ['<script>', 'const a = 1', '</script>', '<style>', '.a {}', '</style>', '<style lang="scss">', '$a: 1px;', '</style>'];
  await waitFor(() => {
    const tokens = tokenizeLines(monaco, lines);
    return typesOf(tokens[1]).includes('keyword.ts') && typesOf(tokens[4]).includes('tag.css') && tokens[7].some(token => token.type.endsWith('.scss'));
  }, 'the embedded grammars');
}

test('grammar', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco } = page;
  await waitForEmbeddedGrammars(monaco);

  await t.test('template, nested templates, script and styles each get their own tokens', () => {
    const lines = [
      '<template>',
      '  <div :class="box" @click="go">{{ msg }}</div>',
      '  <template v-if="ready">',
      '    <p>ready</p>',
      '  </template>',
      '  <List><template #item="{ row }">{{ row }}</template></List>',
      '  <Slot><template #empty /></Slot>',
      '  <!-- <template v-if="old"> -->',
      '  <span class="x">after</span>',
      '<script>',
      'not code: a script tag inside the template',
      '</template>',
      '<script setup lang="ts">',
      "const msg: string = 'hi'",
      '</script>',
      '<style scoped lang="scss">',
      '$gap: 4px;',
      '</style>',
      '<style>',
      '.a { color: red; }',
      '</style>'
    ];
    const tokens = tokenizeLines(monaco, lines);

    // Only a template that ended early would let the inner <script> on line 10 start TypeScript.
    for (let index = 0; index <= 11; index++) {
      assert.deepEqual(languagesOf(tokens[index]), ['vue'], `line ${index + 1}: ${lines[index]}`);
    }
    assert.equal(tokenOf(tokens[0], 'template').type, 'tag.vue');
    assert.equal(tokenOf(tokens[0], '<').type, 'delimiter.vue');
    assert.equal(tokenOf(tokens[1], ':class').type, 'attribute.name.vue');
    assert.equal(tokenOf(tokens[1], '@click').type, 'attribute.name.vue');
    assert.equal(tokenOf(tokens[1], '"box"').type, 'attribute.value.vue');
    assert.equal(tokenOf(tokens[6], '#empty').type, 'attribute.name.vue');
    assert.ok(visibleTypesOf(tokens[7]).every(type => type.startsWith('comment')), 'a comment inside the template');
    assert.equal(tokenOf(tokens[8], 'span').type, 'tag.vue');
    assert.equal(tokenOf(tokens[11], 'template').type, 'tag.vue');

    assert.equal(tokenOf(tokens[12], 'script').type, 'tag.vue');
    assert.equal(tokenOf(tokens[12], 'setup').type, 'attribute.name.vue');
    assert.deepEqual(languagesOf(tokens[13]), ['typescript']);
    assert.equal(tokenOf(tokens[13], 'const').type, 'keyword.ts');
    assert.equal(tokenOf(tokens[14], 'script').type, 'tag.vue');

    assert.deepEqual(languagesOf(tokens[16]), ['scss']);
    assert.equal(tokenOf(tokens[17], 'style').type, 'tag.vue');
    assert.deepEqual(languagesOf(tokens[19]), ['css']);
    assert.equal(tokenOf(tokens[19], '.a').type, 'tag.css');
    assert.equal(tokenOf(tokens[20], 'style').type, 'tag.vue');
  });

  await t.test('opening tags over several lines', () => {
    const tokens = tokenizeLines(monaco, [
      '<script',
      '  setup',
      '  lang="ts"',
      '>',
      'const a = 1',
      '</script>',
      '<style',
      '  lang="scss"',
      '>',
      '$b: 2px;',
      '</style>'
    ]);

    assert.equal(tokenOf(tokens[1], 'setup').type, 'attribute.name.vue');
    assert.equal(tokenOf(tokens[4], 'const').type, 'keyword.ts');
    assert.equal(tokenOf(tokens[7], 'lang').type, 'attribute.name.vue');
    assert.deepEqual(languagesOf(tokens[9]), ['scss']);
    assert.equal(tokenOf(tokens[10], 'style').type, 'tag.vue');
  });

  await t.test('an attribute value over several lines, with a > inside', () => {
    const tokens = tokenizeLines(monaco, [
      '<template>',
      '  <div :class="{',
      '    active: count > 1',
      '  }">x</div>',
      '</template>',
      '<script>',
      'let a = 1',
      '</script>'
    ]);

    assert.deepEqual(typesOf(tokens[2]), ['attribute.value.vue']);
    assert.equal(tokenOf(tokens[3], 'div').type, 'tag.vue');
    assert.equal(tokenOf(tokens[6], 'let').type, 'keyword.ts');
  });

  await t.test('only a lang attribute with the exact value scss embeds scss', () => {
    const cases = {
      '<style lang="scss">': 'scss',
      "<style lang='scss'>": 'scss',
      '<style lang=scss>': 'scss',
      '<style lang="scss-extra">': 'css',
      '<style data-lang="scss">': 'css',
      '<style lang="less">': 'css',
      '<style scoped>': 'css'
    };
    for (const [openTag, language] of Object.entries(cases)) {
      const tokens = tokenizeLines(monaco, [openTag, '.a { color: red; }', '</style>']);
      assert.deepEqual(languagesOf(tokens[1]), [language], openTag);
      assert.equal(tokenOf(tokens[2], 'style').type, 'tag.vue', openTag);
    }
  });

  await t.test('a one-line block closes on its own line', () => {
    const tokens = tokenizeLines(monaco, ['<style>.a { color: red; }</style>', '<script>', 'let a = 1', '</script>']);

    assert.ok(languagesOf(tokens[0]).includes('css'));
    assert.equal(tokens[0].at(-2).type, 'tag.vue');
    assert.equal(tokenOf(tokens[2], 'let').type, 'keyword.ts');
  });

  await t.test('root-level comments and custom blocks stay markup', () => {
    const tokens = tokenizeLines(monaco, ['<!--', '<script>', '-->', '<i18n>', '{ "en": {} }', '</i18n>', '<script>', 'let a = 1', '</script>']);

    assert.ok(visibleTypesOf(tokens[1]).every(type => type.startsWith('comment')));
    assert.equal(tokenOf(tokens[3], 'i18n').type, 'tag.vue');
    assert.deepEqual(languagesOf(tokens[4]), ['vue']);
    assert.equal(tokenOf(tokens[7], 'let').type, 'keyword.ts');
  });
});

// ADO puts the single-file view's editor in `.repos-changes-viewer > .vss-base-editor.<editorClass>`.
function viewerHost(document, editorClass) {
  const viewer = document.createElement('div');
  viewer.className = 'repos-changes-viewer';
  const host = document.createElement('div');
  host.className = `vss-base-editor ${editorClass}`;
  viewer.appendChild(host);
  document.body.appendChild(viewer);
  return host;
}

// The single-file view of a changed file: ADO creates a diff editor and gives it a model per side. The original
// model has no URI, so Monaco names it "inmemory://model/N".
function openDiff(monaco, document, fileName) {
  const diffEditor = monaco.editor.createDiffEditor(viewerHost(document, 'repos-diff-editor'), {});
  const original = monaco.editor.createModel('<template>\n  <div />\n</template>\n');
  const modified = monaco.editor.createModel('<template>\n  <p />\n</template>\n', undefined, monaco.Uri.parse(`inmemory://model${fileName}`));
  diffEditor.setModel({ original, modified });
  return { diffEditor, original, modified };
}

test('a bridge that starts before Monaco switches the diff models of a .vue file to vue', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco, window } = page;

  const { original, modified } = openDiff(monaco, window.document, VUE_PATH);
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const standalone = monaco.editor.create(host, { model: monaco.editor.createModel('plain text', undefined, monaco.Uri.parse('inmemory://model/2b')) });
  await new Promise(resolve => window.setTimeout(resolve, 0));

  assert.match(original.uri.toString(), /^inmemory:\/\/model\/\d+$/);
  assert.equal(original.getModeId(), 'vue');
  assert.equal(modified.getModeId(), 'vue');
  assert.equal(standalone.getModel().getModeId(), 'plaintext');
});

test('a bridge that starts after the diff editor exists still switches its models', async t => {
  const page = await loadRealMonaco({ bridge: 'none' });
  t.after(() => page.close());
  const { monaco, window } = page;

  const { original, modified } = openDiff(monaco, window.document, VUE_PATH);
  page.startBridge();

  assert.equal(original.getModeId(), 'vue');
  assert.equal(modified.getModeId(), 'vue');
});

test('an added .vue file in a plain editor of the single-file view switches to vue, and an editor nested in it does not', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco, window } = page;

  const fileEditor = monaco.editor.create(viewerHost(window.document, 'repos-file-editor'), {
    model: monaco.editor.createModel('<template>\n  <p />\n</template>\n', undefined, monaco.Uri.parse(`inmemory://model${VUE_PATH}`))
  });
  const widgetHost = window.document.createElement('div');
  fileEditor.getDomNode().appendChild(widgetHost);
  const widget = monaco.editor.create(widgetHost, { model: monaco.editor.createModel('newName') });
  await new Promise(resolve => window.setTimeout(resolve, 0));

  assert.equal(fileEditor.getModel().getModeId(), 'vue');
  assert.equal(widget.getModel().getModeId(), 'plaintext');
});

test('the Prism colors reach Monaco through vs, without setTheme', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco, window } = page;
  const setThemeCalls = [];
  const setTheme = monaco.editor.setTheme;
  monaco.editor.setTheme = name => {
    setThemeCalls.push(name);
    return setTheme(name);
  };
  openDiff(monaco, window.document, VUE_PATH);

  page.sendTheme({
    vs: { comment: { foreground: '#a0a1a7', fontStyle: 'italic' } },
    'vs-dark': { comment: { foreground: '#999999', fontStyle: '' } }
  });

  const css = [...window.document.querySelectorAll('style.monaco-colors')].map(style => style.textContent).join('\n').toLowerCase();
  assert.match(css, /color: #a0a1a7/);
  assert.match(css, /background-color: #fffffe/, 'the vs editor background stays');
  assert.deepEqual(setThemeCalls, []);
});
