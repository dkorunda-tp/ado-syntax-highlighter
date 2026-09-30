const test = require('node:test');
const assert = require('node:assert/strict');
const { loadExtension } = require('./helpers');

let window;
test.before(async () => {
  ({ window } = await loadExtension());
});

function lineLanguages(lines) {
  return Array.from(window.parseVueLineLanguages(lines.join('\n')));
}

test('script setup lang ts, template and scoped scss style', () => {
  assert.deepEqual(lineLanguages([
    '<template>',
    '  <div class="a">{{ msg }}</div>',
    '</template>',
    '<script setup lang="ts">',
    "const msg: string = 'hi'",
    '</script>',
    '<style scoped lang="scss">',
    '.a { .b { color: red; } }',
    '</style>'
  ]), [
    'vue-template', 'vue-template', 'vue-template',
    'markup', 'typescript', 'markup',
    'markup', 'scss', 'markup'
  ]);
});

test('nested template tags close the block only at depth zero', () => {
  assert.deepEqual(lineLanguages([
    '<template>',
    '  <template v-if="ready">',
    '    <p>ready</p>',
    '  </template>',
    '<script>',
    'not code',
    '  <List><template #item="{ row }">{{ row }}</template></List>',
    '  <Slot><template #empty /></Slot>',
    '</template>',
    '<script>',
    'export default {}',
    '</script>'
  ]), [
    'vue-template', 'vue-template', 'vue-template', 'vue-template', 'vue-template', 'vue-template', 'vue-template', 'vue-template', 'vue-template',
    'markup', 'typescript', 'markup'
  ]);
});

test('a byte order mark before the first block does not hide it', () => {
  assert.deepEqual(Array.from(window.parseVueLineLanguages('\uFEFF<script setup lang="ts">\nconst a = 1\n</script>')),
    ['markup', 'typescript', 'markup']);
});

test('block tags inside a root-level HTML comment do not open a block', () => {
  assert.deepEqual(lineLanguages([
    '<!--',
    '<script>',
    'old code',
    '</script>',
    '-->',
    '<!-- disabled:',
    '<template>',
    '-->',
    '<script setup lang="ts">',
    'const a = 1',
    '</script>'
  ]), [
    'markup', 'markup', 'markup', 'markup', 'markup',
    'markup', 'markup', 'markup',
    'markup', 'typescript', 'markup'
  ]);
});

test('template tags inside HTML comments do not change the template depth', () => {
  assert.deepEqual(lineLanguages([
    '<template>',
    '  <!-- <template v-if="old"> -->',
    '  <div />',
    '  <!--',
    '    <template #footer>',
    '  -->',
    '  <!-- </template> --><p />',
    '</template>',
    '<script setup lang="ts">',
    'const a = 1',
    '</script>'
  ]), [
    'vue-template', 'vue-template', 'vue-template', 'vue-template', 'vue-template', 'vue-template', 'vue-template', 'vue-template',
    'markup', 'typescript', 'markup'
  ]);
});

test('a column-0 script tag inside a template does not open a block', () => {
  assert.deepEqual(lineLanguages([
    '<template>',
    '<script>',
    'not code',
    '</template>'
  ]), ['vue-template', 'vue-template', 'vue-template', 'vue-template']);
});

test('a plain style, a scoped style and a non-scss lang are css', () => {
  assert.deepEqual(lineLanguages([
    '<style>',
    '.a { color: red; }',
    '</style>',
    '<style scoped>',
    '.b { color: blue; }',
    '</style>',
    '<style lang="less">',
    '.c { color: green; }',
    '</style>'
  ]), [
    'markup', 'css', 'markup',
    'markup', 'css', 'markup',
    'markup', 'css', 'markup'
  ]);
});

test("single-quoted lang='scss' is scss", () => {
  assert.deepEqual(lineLanguages(["<style lang='scss'>", '$a: 1px;', '</style>']), ['markup', 'scss', 'markup']);
});

test('only a lang attribute with the exact value scss is scss', () => {
  assert.deepEqual(lineLanguages([
    '<style lang=scss>',
    '$a: 1px;',
    '</style>',
    '<style data-lang="scss">',
    '.a {}',
    '</style>',
    '<style lang="scss-extra">',
    '.b {}',
    '</style>'
  ]), [
    'markup', 'scss', 'markup',
    'markup', 'css', 'markup',
    'markup', 'css', 'markup'
  ]);
});

test('script without lang, and with lang="js", is typescript', () => {
  assert.deepEqual(lineLanguages([
    '<script>',
    'const a = 1',
    '</script>',
    '<script lang="js">',
    'const b = 2',
    '</script>'
  ]), ['markup', 'typescript', 'markup', 'markup', 'typescript', 'markup']);
});

test('CRLF text gives the same map as LF text', () => {
  const lines = ['<template>', '  <div />', '</template>', '<script setup lang="ts">', 'const a = 1', '</script>'];
  assert.deepEqual(
    Array.from(window.parseVueLineLanguages(lines.join('\r\n'))),
    lineLanguages(lines)
  );
  assert.deepEqual(Array.from(window.parseVueLineLanguages(lines.join('\r\n'))),
    ['vue-template', 'vue-template', 'vue-template', 'markup', 'typescript', 'markup']);
});

test('lines between and around blocks are markup', () => {
  assert.deepEqual(lineLanguages([
    '<!-- header comment -->',
    '<script setup lang="ts">',
    'const a = 1',
    '</script>',
    '',
    '<i18n>',
    '{ "en": {} }',
    '</i18n>',
    '',
    '<style>',
    '.a {}',
    '</style>',
    ''
  ]), [
    'markup', 'markup', 'typescript', 'markup',
    'markup', 'markup', 'markup', 'markup', 'markup',
    'markup', 'css', 'markup', 'markup'
  ]);
});

test('a one-line block closes on the same line; a style line is markup and a template line is vue-template', () => {
  assert.deepEqual(lineLanguages([
    '<style>.a { color: red; }</style>',
    '.not-style {}',
    '<template><div /></template>',
    '<script setup lang="ts">',
    'const a = 1',
    '</script>'
  ]), ['markup', 'markup', 'vue-template', 'markup', 'typescript', 'markup']);
});

test('a template opening tag over several lines is vue-template on every line', () => {
  assert.deepEqual(lineLanguages([
    '<template',
    '  lang="html"',
    '>',
    '  <div />',
    '</template>',
    '<script>',
    'const a = 1',
    '</script>'
  ]), ['vue-template', 'vue-template', 'vue-template', 'vue-template', 'vue-template', 'markup', 'typescript', 'markup']);
});

test('an opening tag with attributes over several lines', () => {
  assert.deepEqual(lineLanguages([
    '<script',
    '  setup',
    '  lang="ts"',
    '>',
    'const a = 1',
    '</script>',
    '<style',
    '  scoped',
    '  lang="scss"',
    '>',
    '$b: 2px;',
    '</style>'
  ]), [
    'markup', 'markup', 'markup', 'markup', 'typescript', 'markup',
    'markup', 'markup', 'markup', 'markup', 'scss', 'markup'
  ]);
});

test('a > inside a quoted attribute of a multi-line opening tag does not end the tag', () => {
  assert.deepEqual(lineLanguages([
    '<style',
    '  data-note="first',
    '> second"',
    '  lang="scss"',
    '>',
    '$a: 1px;',
    '</style>',
    '<script',
    '  data-x="a > b"',
    '  lang="ts"',
    '>',
    'const a = 1',
    '</script>'
  ]), [
    'markup', 'markup', 'markup', 'markup', 'markup', 'scss', 'markup',
    'markup', 'markup', 'markup', 'markup', 'typescript', 'markup'
  ]);
});

test('an indented or longer tag name does not open a block', () => {
  assert.deepEqual(lineLanguages([
    '  <script>',
    'a',
    '<scripts>',
    'b',
    '</scripts>'
  ]), ['markup', 'markup', 'markup', 'markup', 'markup']);
});

test('an unclosed script block runs to the end of the file', () => {
  assert.deepEqual(lineLanguages(['<script setup lang="ts">', 'const a = 1', 'const b = 2']),
    ['markup', 'typescript', 'typescript']);
});
