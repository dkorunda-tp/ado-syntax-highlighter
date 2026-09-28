const test = require('node:test');
const assert = require('node:assert/strict');
const { loadExtension, mount, fileCard, inlineRow, sideBySide } = require('./helpers');

let window;
test.before(async () => {
  ({ window } = await loadExtension());
});

function locations(file) {
  return [...file.querySelectorAll('.monospaced-text > .repos-line-content')].map(line => {
    const location = window.getDiffLineLocation(line, file);
    return location ? { side: location.side, lineNumber: location.lineNumber } : null;
  });
}

test('side-by-side: the left pane is the old file and the right pane is the new file', () => {
  const file = mount(window, fileCard({
    filePath: '/src/A.vue',
    diff: sideBySide({
      oldRows: [
        { line: 4, type: 'unchanged', code: '<template>' },
        { line: 5, type: 'removed', code: '  <p>old</p>' }
      ],
      newRows: [
        { line: 4, type: 'unchanged', code: '<template>' },
        { line: 5, type: 'added', code: '  <p>new</p>' }
      ]
    })
  }));
  assert.deepEqual(locations(file), [
    { side: 'old', lineNumber: 4 },
    { side: 'old', lineNumber: 5 },
    { side: 'new', lineNumber: 4 },
    { side: 'new', lineNumber: 5 }
  ]);
});

test('side-by-side: a filler row without data-line has no location', () => {
  const file = mount(window, fileCard({
    filePath: '/src/A.vue',
    diff: sideBySide({
      oldRows: [{ line: null, type: 'unchanged', code: '' }],
      newRows: [{ line: 9, type: 'added', code: 'x' }]
    })
  }));
  assert.deepEqual(locations(file), [null, { side: 'new', lineNumber: 9 }]);
});

test('inline: removed rows read the old number, other rows read the new number', () => {
  const file = mount(window, fileCard({
    filePath: '/src/A.vue',
    diff: [
      inlineRow({ oldLine: 10, newLine: 12, type: 'unchanged', code: '<script setup lang="ts">' }),
      inlineRow({ oldLine: 11, type: 'removed', code: 'const a = 1' }),
      inlineRow({ newLine: 13, type: 'added', code: 'const a = 2' })
    ].join('')
  }));
  assert.deepEqual(locations(file), [
    { side: 'new', lineNumber: 12 },
    { side: 'old', lineNumber: 11 },
    { side: 'new', lineNumber: 13 }
  ]);
});

test('inline: a missing number column gives no location', () => {
  const file = mount(window, fileCard({
    filePath: '/src/A.vue',
    diff: '<div class="repos-diff-contents-row monospaced-text">' +
      '<div class="flex-row secondary-text"><div class="repos-line-number" data-line="3">3</div></div>' +
      '<div class="repos-line-content added">x</div></div>'
  }));
  assert.deepEqual(locations(file), [null]);
});

test('inline: a page splitter around the file card does not count as a diff pane', () => {
  window.document.body.innerHTML =
    '<div class="vss-Splitter--container"><div class="vss-Splitter--pane-fixed">tree</div>' +
    '<div class="vss-Splitter--pane-flexible" id="outer"></div></div>';
  const outer = window.document.getElementById('outer');
  outer.innerHTML = fileCard({
    filePath: '/src/A.vue',
    diff: [
      inlineRow({ oldLine: 1, type: 'removed', code: 'a' }),
      inlineRow({ oldLine: 1, newLine: 2, type: 'unchanged', code: 'b' })
    ].join('')
  });
  const file = outer.querySelector('.repos-summary-header');
  assert.deepEqual(locations(file), [
    { side: 'old', lineNumber: 1 },
    { side: 'new', lineNumber: 2 }
  ]);
});
