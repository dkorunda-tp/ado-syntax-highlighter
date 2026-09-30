// Vue template expressions in the single-file view: {{ }} interpolations and directive values are TypeScript.
// Runs the vue grammar of monaco_bridge.js on the real monaco-editor 0.29 build.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRealMonaco, tokenizeLines, languagesOf, waitForEmbeddedGrammars } = require('./monaco-helpers');

// Wraps `body` in a template block, tokenizes it, and returns the tokens of the body lines.
function tokenizeTemplate(monaco, body) {
  return tokenizeLines(monaco, ['<template>', ...body, '</template>']).slice(1, -1);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The token that covers the first `text` in the line, after the first `after` when given. Monaco merges
// neighbors of the same type, so `>{{` can be one token. A word only matches as a whole word.
function tokenAt(line, text, after) {
  const source = line.map(token => token.text).join('');
  const from = after === undefined ? 0 : source.indexOf(after) + after.length;
  const word = /^\w/.test(text) ? '(?<![\\w-])' : '';
  const match = new RegExp(`${word}${escapeRegExp(text)}${/\w$/.test(text) ? '(?![\\w-])' : ''}`, 'g');
  match.lastIndex = from;
  const found = after === undefined || source.includes(after) ? match.exec(source) : null;
  assert.ok(found, `no "${text}" in ${JSON.stringify(source)}`);
  let offset = 0;
  for (const token of line) {
    const end = offset + token.text.length;
    if (found.index >= offset && found.index < end) {
      assert.ok(found.index + text.length <= end, `"${text}" is split across tokens in ${JSON.stringify(line)}`);
      return token;
    }
    offset = end;
  }
}

function typeOf(line, text, after) {
  return tokenAt(line, text, after).type;
}

test('vue template expressions', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco } = page;
  await waitForEmbeddedGrammars(monaco);

  await t.test('an interpolation is TypeScript between delimiter braces', () => {
    const [line] = tokenizeTemplate(monaco, ['  <span>{{ group.label }}</span>']);

    assert.equal(typeOf(line, '{{'), 'delimiter.vue');
    assert.equal(typeOf(line, 'group'), 'identifier.ts');
    assert.equal(typeOf(line, '.'), 'delimiter.ts');
    assert.equal(typeOf(line, 'label'), 'identifier.ts');
    assert.equal(typeOf(line, '}}'), 'delimiter.vue');
    assert.equal(typeOf(line, 'span', '}}'), 'tag.vue');
    assert.equal(tokenAt(line, '{{').language, 'vue');
  });

  await t.test('an interpolation over several lines, with < and > inside', () => {
    const lines = tokenizeTemplate(monaco, ['  <p>{{', '    a < b ? x : y > z', '  }}</p>', '  <b>after</b>']);

    assert.deepEqual(languagesOf(lines[1]), ['typescript']);
    assert.equal(typeOf(lines[1], 'a'), 'identifier.ts');
    assert.equal(typeOf(lines[2], '}}'), 'delimiter.vue');
    assert.equal(typeOf(lines[2], 'p'), 'tag.vue');
    assert.equal(typeOf(lines[3], 'b'), 'tag.vue');
  });

  await t.test('a single brace in text stays template text', () => {
    const [line] = tokenizeTemplate(monaco, ['  <p>a { b } c</p>']);

    assert.deepEqual(languagesOf(line), ['vue']);
    assert.equal(typeOf(line, 'p', '</'), 'tag.vue');
  });

  await t.test('a v-for value is TypeScript, and the quotes stay attribute values', () => {
    const [line] = tokenizeTemplate(monaco, ['  <div v-for="(group, groupIndex) in stage.groups" :key="group.label ?? \'\'">']);

    assert.equal(typeOf(line, 'v-for'), 'attribute.name.vue');
    assert.equal(typeOf(line, '='), 'delimiter.vue');
    assert.equal(typeOf(line, '"'), 'attribute.value.vue');
    assert.equal(typeOf(line, 'group'), 'identifier.ts');
    assert.equal(typeOf(line, 'groupIndex'), 'identifier.ts');
    assert.equal(typeOf(line, 'in'), 'keyword.ts');
    assert.equal(typeOf(line, 'stage'), 'identifier.ts');
    assert.equal(typeOf(line, 'groups'), 'identifier.ts');
    assert.equal(typeOf(line, '"', 'groups'), 'attribute.value.vue');

    assert.equal(typeOf(line, ':key'), 'attribute.name.vue');
    assert.equal(typeOf(line, 'label', ':key'), 'identifier.ts');
    assert.equal(typeOf(line, "''", ':key'), 'string.ts');
    assert.equal(typeOf(line, '"', "''"), 'attribute.value.vue');
    assert.equal(typeOf(line, '>', "''"), 'delimiter.vue');
  });

  await t.test('an @ event with a colon in its name has a TypeScript value', () => {
    const [line] = tokenizeTemplate(monaco, ['  <Check @update:model-value="onToggleItem(item)" />']);

    assert.equal(typeOf(line, '@update:model-value'), 'attribute.name.vue');
    assert.equal(typeOf(line, 'onToggleItem'), 'identifier.ts');
    assert.equal(typeOf(line, 'item'), 'identifier.ts');
    assert.equal(typeOf(line, '/>'), 'delimiter.vue');
  });

  await t.test('v-bind:x, v-on:x and v-model values are TypeScript', () => {
    const [line] = tokenizeTemplate(monaco, ['  <In v-bind:id="uid" v-on:blur="save()" v-model="form.name">']);

    for (const name of ['v-bind:id', 'v-on:blur', 'v-model']) assert.equal(typeOf(line, name), 'attribute.name.vue', name);
    for (const name of ['uid', 'save', 'form', 'name']) assert.equal(typeOf(line, name), 'identifier.ts', name);
  });

  await t.test('slot shorthand and v-slot, with and without a value', () => {
    const lines = tokenizeTemplate(monaco, [
      '  <List v-slot="{ item }">',
      '    <template #label>{{ item }}</template>',
      '    <template v-slot:row="{ row }"><b>{{ row }}</b></template>',
      '  </List>',
      '  <Table #cell="{ value }"></Table>'
    ]);

    assert.equal(typeOf(lines[0], 'v-slot'), 'attribute.name.vue');
    assert.equal(typeOf(lines[0], '{'), 'delimiter.bracket.ts');
    assert.equal(typeOf(lines[0], 'item'), 'identifier.ts');
    assert.equal(typeOf(lines[0], '}'), 'delimiter.bracket.ts');
    assert.equal(typeOf(lines[1], '#label'), 'attribute.name.vue');
    assert.equal(typeOf(lines[1], '>'), 'delimiter.vue');
    assert.equal(typeOf(lines[1], 'item'), 'identifier.ts');
    assert.equal(typeOf(lines[2], 'v-slot:row'), 'attribute.name.vue');
    assert.equal(typeOf(lines[2], 'row', 'v-slot:row'), 'identifier.ts');
    assert.equal(typeOf(lines[2], 'b'), 'tag.vue');
    assert.equal(typeOf(lines[3], 'List'), 'tag.vue');
    assert.equal(typeOf(lines[4], '#cell'), 'attribute.name.vue');
    assert.equal(typeOf(lines[4], 'value'), 'identifier.ts');
    assert.equal(typeOf(lines[4], 'Table', '}'), 'tag.vue');
  });

  await t.test('a directive with no value leaves the next attribute alone', () => {
    const [line] = tokenizeTemplate(monaco, ['  <p v-else class="x" #empty :a="b">']);

    assert.equal(typeOf(line, 'v-else'), 'attribute.name.vue');
    assert.equal(typeOf(line, 'class'), 'attribute.name.vue');
    assert.equal(typeOf(line, '"x"'), 'attribute.value.vue');
    assert.equal(typeOf(line, '#empty'), 'attribute.name.vue');
    assert.equal(typeOf(line, 'b'), 'identifier.ts');
  });

  await t.test('a directive value over several lines is TypeScript on every line', () => {
    const lines = tokenizeTemplate(monaco, [
      '  <div :class="{',
      '    active: count > 1,',
      "    'is-open': open",
      '  }">x</div>',
      '  <span class="y">z</span>'
    ]);

    assert.equal(typeOf(lines[0], ':class'), 'attribute.name.vue');
    assert.equal(typeOf(lines[0], '{'), 'delimiter.bracket.ts');
    assert.deepEqual(languagesOf(lines[1]), ['typescript']);
    assert.equal(typeOf(lines[1], 'active'), 'identifier.ts');
    assert.equal(typeOf(lines[1], '1'), 'number.ts');
    assert.equal(typeOf(lines[2], "'is-open'"), 'string.ts');
    assert.equal(typeOf(lines[3], '}'), 'delimiter.bracket.ts');
    assert.equal(typeOf(lines[3], '"'), 'attribute.value.vue');
    assert.equal(typeOf(lines[3], 'div'), 'tag.vue');
    assert.equal(typeOf(lines[4], '"y"'), 'attribute.value.vue');
  });

  await t.test('a > inside a directive value does not end the tag', () => {
    const [line] = tokenizeTemplate(monaco, ['  <p v-if="a > b" class="c">t</p>']);

    assert.equal(typeOf(line, 'b'), 'identifier.ts');
    assert.equal(typeOf(line, 'class'), 'attribute.name.vue');
    assert.equal(typeOf(line, '"c"'), 'attribute.value.vue');
  });

  await t.test('a single-quoted directive value ends at its own quote', () => {
    const [line] = tokenizeTemplate(monaco, ['  <p :title=\'"a" + b\' id="i">']);

    assert.equal(typeOf(line, "'"), 'attribute.value.vue');
    assert.equal(typeOf(line, '"a"'), 'string.ts');
    assert.equal(typeOf(line, 'b'), 'identifier.ts');
    assert.equal(typeOf(line, 'id'), 'attribute.name.vue');
    assert.equal(typeOf(line, '"i"'), 'attribute.value.vue');
  });

  await t.test('plain attributes keep one attribute value token', () => {
    const [line] = tokenizeTemplate(monaco, ['  <v-btn class="x" density="compact" data-v="y">']);

    assert.deepEqual(languagesOf(line), ['vue']);
    assert.equal(typeOf(line, 'v-btn'), 'tag.vue');
    assert.equal(typeOf(line, '"x"'), 'attribute.value.vue');
    assert.equal(typeOf(line, 'density'), 'attribute.name.vue');
    assert.equal(typeOf(line, '"compact"'), 'attribute.value.vue');
    assert.equal(typeOf(line, 'data-v'), 'attribute.name.vue');
  });

  await t.test('nested templates with directives still close the right template', () => {
    const tokens = tokenizeLines(monaco, [
      '<template>',
      '  <template v-if="ready">',
      '    <p>{{ a }}</p>',
      '  </template>',
      '<script>',
      '</template>',
      '<script setup lang="ts">',
      'const a = 1',
      '</script>'
    ]);

    assert.deepEqual(languagesOf(tokens[4]), ['vue'], 'a <script> inside the template is not a block');
    assert.equal(typeOf(tokens[5], 'template'), 'tag.vue');
    assert.equal(typeOf(tokens[6], '"ts"'), 'attribute.value.vue');
    assert.equal(typeOf(tokens[7], 'const'), 'keyword.ts');
  });

  await t.test('directives and braces outside the template stay markup', () => {
    const tokens = tokenizeLines(monaco, ['<i18n :locale="en">', '{{ "en": {} }}', '</i18n>']);

    assert.deepEqual(languagesOf(tokens[0]), ['vue']);
    assert.equal(typeOf(tokens[0], '"en"'), 'attribute.value.vue');
    assert.deepEqual(languagesOf(tokens[1]), ['vue']);
  });
});

// The color Monaco renders for each piece of `text`, from colorize output and the theme's `.mtkN` rules.
async function renderedColors(monaco, window, text) {
  const html = await monaco.editor.colorize(text, 'vue', {});
  const css = [...window.document.querySelectorAll('style.monaco-colors')].map(style => style.textContent).join('\n');
  const colors = Object.fromEntries([...css.matchAll(/\.mtk(\d+) \{ color: (#[0-9a-f]+); \}/gi)].map(([, id, color]) => [id, color.toLowerCase()]));
  const container = window.document.createElement('div');
  container.innerHTML = html;
  return [...container.querySelectorAll('span[class^="mtk"]')].map(span => ({
    text: span.textContent,
    color: colors[span.className.match(/mtk(\d+)/)[1]]
  }));
}

test('template expressions take the Prism colors of their TypeScript tokens', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco, window } = page;
  await waitForEmbeddedGrammars(monaco);
  const tokens = {
    keyword: { foreground: '#111111', fontStyle: '' },
    punctuation: { foreground: '#222222', fontStyle: '' },
    'attr-value': { foreground: '#333333', fontStyle: '' },
    'attr-name': { foreground: '#444444', fontStyle: '' },
    string: { foreground: '#555555', fontStyle: '' }
  };
  page.sendTheme({ vs: tokens, 'vs-dark': tokens });
  monaco.editor.setTheme('vs');

  const pieces = await renderedColors(monaco, window, '<template>\n  <p v-for="a in b" :k="\'s\'">{{ c }}</p>\n</template>');
  // Neighbors of one type share a span, so `>{{` is one piece.
  const colorOf = text => {
    const piece = pieces.find(candidate => candidate.text.trim() === text) || pieces.find(candidate => candidate.text.includes(text));
    assert.ok(piece, `no "${text}" in ${JSON.stringify(pieces)}`);
    return piece.color;
  };

  assert.equal(colorOf('v-for'), '#444444');
  assert.equal(colorOf('"'), '#333333');
  assert.equal(colorOf('in'), '#111111');
  assert.equal(colorOf("'s'"), '#555555');
  assert.equal(colorOf('{{'), '#222222');
  assert.equal(colorOf('}}'), '#222222');
});
