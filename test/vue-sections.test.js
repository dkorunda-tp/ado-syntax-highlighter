const test = require('node:test');
const assert = require('node:assert/strict');
const { loadExtension } = require('./helpers');

let window;
test.before(async () => {
  ({ window } = await loadExtension());
});

function sections(lines) {
  return Array.from(window.parseVueSections(lines.join('\n')));
}

test('script setup lang ts, template and scoped scss style', () => {
  assert.deepEqual(sections([
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
    'markup', 'markup', 'markup',
    'markup', 'typescript', 'markup',
    'markup', 'scss', 'markup'
  ]);
});

test('nested template tags close the block only at depth zero', () => {
  assert.deepEqual(sections([
    '<template>',
    '  <template v-if="ready">',
    '    <p>ready</p>',
    '  </template>',
    '  <List><template #item="{ row }">{{ row }}</template></List>',
    '  <Slot><template #empty /></Slot>',
    '</template>',
    '<script>',
    'export default {}',
    '</script>'
  ]), [
    'markup', 'markup', 'markup', 'markup', 'markup', 'markup', 'markup',
    'markup', 'typescript', 'markup'
  ]);
});

test('template tags inside HTML comments do not change the template depth', () => {
  assert.deepEqual(sections([
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
    'markup', 'markup', 'markup', 'markup', 'markup', 'markup', 'markup', 'markup',
    'markup', 'typescript', 'markup'
  ]);
});

test('a column-0 script tag inside a template does not open a block', () => {
  assert.deepEqual(sections([
    '<template>',
    '<script>',
    'not code',
    '</template>'
  ]), ['markup', 'markup', 'markup', 'markup']);
});

test('a plain style, a scoped style and a non-scss lang are css', () => {
  assert.deepEqual(sections([
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
  assert.deepEqual(sections(["<style lang='scss'>", '$a: 1px;', '</style>']), ['markup', 'scss', 'markup']);
});

test('script without lang, and with lang="js", is typescript', () => {
  assert.deepEqual(sections([
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
    Array.from(window.parseVueSections(lines.join('\r\n'))),
    sections(lines)
  );
  assert.deepEqual(Array.from(window.parseVueSections(lines.join('\r\n'))),
    ['markup', 'markup', 'markup', 'markup', 'typescript', 'markup']);
});

test('lines between and around blocks are markup', () => {
  assert.deepEqual(sections([
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

test('a one-line block is markup and closes on the same line', () => {
  assert.deepEqual(sections([
    '<style>.a { color: red; }</style>',
    '.not-style {}',
    '<template><div /></template>',
    '<script setup lang="ts">',
    'const a = 1',
    '</script>'
  ]), ['markup', 'markup', 'markup', 'markup', 'typescript', 'markup']);
});

test('an opening tag with attributes over several lines', () => {
  assert.deepEqual(sections([
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

test('an indented or longer tag name does not open a block', () => {
  assert.deepEqual(sections([
    '  <script>',
    'a',
    '<scripts>',
    'b',
    '</scripts>'
  ]), ['markup', 'markup', 'markup', 'markup', 'markup']);
});

test('an unclosed script block runs to the end of the file', () => {
  assert.deepEqual(sections(['<script setup lang="ts">', 'const a = 1', 'const b = 2']),
    ['markup', 'typescript', 'typescript']);
});
