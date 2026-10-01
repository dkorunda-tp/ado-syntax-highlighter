// ADO can rewrite Monaco's color stylesheet with the plain vs palette, for example when the single-file view
// switches files, through a path that calls no public Monaco function. The tests stand in for that path by
// writing the plain stylesheet text back into style.monaco-colors, on the real monaco-editor 0.29 build.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRealMonaco, settle } = require('./monaco-helpers');

const PAYLOAD = {
  vs: { function: { foreground: '#654321', fontStyle: '' }, keyword: { foreground: '#123456', fontStyle: '' } },
  'vs-dark': { function: { foreground: '#fedcba', fontStyle: '' }, keyword: { foreground: '#abcdef', fontStyle: '' } }
};

function colorSheet(window) {
  const sheets = window.document.querySelectorAll('style.monaco-colors');
  return sheets[sheets.length - 1];
}

// An editor on the page gives the active theme through its class, as in ADO. Returns the plain vs stylesheet.
function openEditor(page) {
  const { monaco, window } = page;
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  monaco.editor.create(host, { model: monaco.editor.createModel('const t = f(x)', 'typescript') });
  monaco.editor.setTheme('vs');
  return colorSheet(window).textContent;
}

function countThemeApplies(monaco) {
  const applies = [];
  const defineTheme = monaco.editor.defineTheme;
  monaco.editor.defineTheme = (themeName, themeData) => {
    if (themeName === 'vs') applies.push(themeName);
    return defineTheme(themeName, themeData);
  };
  return applies;
}

for (const bridge of ['before', 'none']) {
  test(`the Prism colors come back after ADO rewrites the color stylesheet (${bridge === 'none' ? 'late start' : 'bridge first'})`, async t => {
    const page = await loadRealMonaco({ bridge });
    t.after(() => page.close());
    const { window } = page;
    const plainCss = openEditor(page);
    if (bridge === 'none') page.startBridge();
    page.sendTheme(PAYLOAD);
    assert.match(colorSheet(window).textContent, /#654321/);

    colorSheet(window).textContent = plainCss;
    await settle(window);

    assert.match(colorSheet(window).textContent, /#654321/);
    assert.match(colorSheet(window).textContent, /#123456/);
  });
}

test('a page that keeps rewriting the color stylesheet gets at most a few theme applies per second', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco, window } = page;
  const plainCss = openEditor(page);
  page.sendTheme(PAYLOAD);
  const applies = countThemeApplies(monaco);
  const sheet = colorSheet(window);
  const adversary = new window.MutationObserver(() => {
    if (sheet.textContent !== plainCss) sheet.textContent = plainCss;
  });
  adversary.observe(sheet, { childList: true, characterData: true, subtree: true });

  sheet.textContent = plainCss;
  await settle(window, 1000);
  adversary.disconnect();

  assert.ok(applies.length >= 2, `${applies.length} applies`);
  assert.ok(applies.length <= 5, `${applies.length} applies`);
});

test('a rewrite that a theme apply cannot undo is not retried for the same stylesheet text', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco, window } = page;
  const plainCss = openEditor(page);
  page.sendTheme(PAYLOAD);
  // The 0.29 build redraws on defineTheme, so both calls do nothing here, as a Monaco that cannot redraw.
  const applies = [];
  monaco.editor.defineTheme = themeName => {
    if (themeName === 'vs') applies.push(themeName);
  };
  monaco.editor.setTheme = () => {};
  const sheet = colorSheet(window);

  sheet.textContent = plainCss;
  await settle(window, 400);
  sheet.textContent = plainCss;
  await settle(window, 400);

  assert.equal(applies.length, 1);
});

test('the stylesheet of a theme without Prism colors, such as hc-black, is left alone', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco, window } = page;
  openEditor(page);
  page.sendTheme(PAYLOAD);
  monaco.editor.setTheme('hc-black');
  const applies = countThemeApplies(monaco);

  colorSheet(window).textContent = '.mtk1 { color: #ffffff; }';
  await settle(window);

  assert.equal(applies.length, 0);
});
