const test = require('node:test');
const assert = require('node:assert/strict');
const { SINGLE_FILE_URL, createFakeMonaco, loadBridge, vueLanguageCalls } = require('./monaco-helpers');

const LIGHT = {
  comment: { foreground: '#a0a1a7', fontStyle: 'italic' },
  keyword: { foreground: '#a626a4', fontStyle: '' },
  punctuation: { foreground: '#383a42', fontStyle: '' }
};
const DARK = {
  comment: { foreground: '#999999', fontStyle: '' },
  keyword: { foreground: '#cc99cd', fontStyle: 'bold' }
};
const TS_URL = 'https://dev.azure.com/org/Project/_git/Repo/pullrequest/42?_a=files&path=%2Fsrc%2Futil.ts';

// Opens the single-file view the way ADO does: a diff editor, a model per side, then setModel.
function openVueDiff(fake, document) {
  const diff = fake.createDiffEditor(document);
  const original = fake.createModel();
  const modified = fake.createModel('/TopActionBar.vue');
  diff.setModel({ original, modified });
  return { diff, original, modified };
}

// Objects the bridge builds come from the jsdom realm, which deepEqual treats as a different prototype.
function plain(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function themeFor(fake, themeName) {
  return plain(fake.calls.defineTheme.filter(call => call.themeName === themeName).at(-1)?.themeData);
}

test('the Vue language is registered without extensions, with a Monarch grammar', () => {
  const page = loadBridge();
  page.assignMonaco();

  assert.deepEqual(plain(page.fake.calls.register), [{ id: 'vue' }]);
  const [provider] = page.fake.calls.setMonarchTokensProvider;
  assert.equal(provider.languageId, 'vue');
  assert.ok(Array.isArray(provider.languageDef.tokenizer.root));
});

test('both models of a .vue file in the single-file diff editor switch to vue', async () => {
  const page = loadBridge();
  page.assignMonaco();

  const { original, modified } = openVueDiff(page.fake, page.window.document);
  await page.tick();

  assert.equal(original.language, 'vue');
  assert.equal(modified.language, 'vue');
});

test('a model in a Monaco editor outside a diff editor is left alone', async () => {
  const page = loadBridge();
  page.assignMonaco();
  const container = page.window.document.createElement('div');
  page.window.document.body.appendChild(container);
  const editor = page.fake.createEditor(container);
  const model = page.fake.createModel('/TopActionBar.vue');

  editor.setModel(model);
  await page.tick();

  assert.equal(model.language, 'plaintext');
});

test('a model that no editor shows is left alone', async () => {
  const page = loadBridge();
  page.assignMonaco();
  page.fake.createDiffEditor(page.window.document);
  const model = page.fake.createModel('/TopActionBar.vue');
  await page.tick();

  assert.equal(model.language, 'plaintext');
});

test('a diff of a file that is not .vue is left alone', async () => {
  const page = loadBridge({ url: 'https://dev.azure.com/org/Project/_git/Repo/pullrequest/42?_a=files&path=%2Fnotes.txt' });
  page.assignMonaco();
  const diff = page.fake.createDiffEditor(page.window.document);
  const original = page.fake.createModel();
  const modified = page.fake.createModel('/notes.txt');
  diff.setModel({ original, modified });
  await page.tick();

  assert.equal(original.language, 'plaintext');
  assert.equal(modified.language, 'plaintext');
});

test('a page without a path parameter is left alone', async () => {
  const page = loadBridge({ url: 'https://dev.azure.com/org/Project/_git/Repo/pullrequest/42?_a=files' });
  page.assignMonaco();
  const { original, modified } = openVueDiff(page.fake, page.window.document);
  await page.tick();

  assert.equal(original.language, 'plaintext');
  assert.equal(modified.language, 'plaintext');
});

test('the path parameter matches .vue in any letter case', async () => {
  const page = loadBridge({ url: SINGLE_FILE_URL.replace('.vue', '.VUE') });
  page.assignMonaco();
  const { modified } = openVueDiff(page.fake, page.window.document);
  await page.tick();

  assert.equal(modified.language, 'vue');
});

test('a model whose URI names another file is left alone', async () => {
  const page = loadBridge();
  page.assignMonaco();
  const diff = page.fake.createDiffEditor(page.window.document);
  const original = page.fake.createModel();
  const modified = page.fake.createModel('/notes.txt');
  diff.setModel({ original, modified });
  await page.tick();

  assert.equal(modified.language, 'plaintext');
});

test('a model that ADO gave a language other than plaintext keeps it', async () => {
  const page = loadBridge();
  page.assignMonaco();
  const diff = page.fake.createDiffEditor(page.window.document);
  const original = page.fake.createModel(undefined, 'html');
  const modified = page.fake.createModel('/TopActionBar.vue', 'html');
  diff.setModel({ original, modified });
  await page.tick();

  assert.equal(original.language, 'html');
  assert.equal(modified.language, 'html');
});

test('the diff editor moving to another file is judged by the new URL', async () => {
  const page = loadBridge();
  page.assignMonaco();
  const { diff } = openVueDiff(page.fake, page.window.document);

  page.dom.reconfigure({ url: TS_URL });
  const ts = { original: page.fake.createModel(undefined, 'typescript'), modified: page.fake.createModel('/util.ts', 'typescript') };
  diff.setModel(ts);
  await page.tick();
  assert.equal(ts.original.language, 'typescript');
  assert.equal(ts.modified.language, 'typescript');

  page.dom.reconfigure({ url: SINGLE_FILE_URL });
  const vue = { original: page.fake.createModel(), modified: page.fake.createModel('/TopActionBar.vue') };
  diff.setModel(vue);
  await page.tick();
  assert.equal(vue.original.language, 'vue');
  assert.equal(vue.modified.language, 'vue');
});

test('ADO setting a vue model back to plaintext gets it re-applied, but only three times', async () => {
  const page = loadBridge();
  page.assignMonaco();
  page.fake.monaco.editor.onDidChangeModelLanguage(({ model }) => {
    if (model.language === 'vue') page.fake.monaco.editor.setModelLanguage(model, 'plaintext');
  });

  const { modified } = openVueDiff(page.fake, page.window.document);
  await page.tick();

  assert.equal(vueLanguageCalls(page.fake).filter(call => call.model === modified).length, 3);
  assert.equal(modified.language, 'plaintext');
});

test('late start: models that existing editors show switch to vue while a diff editor is on the page', () => {
  let shown;
  let hidden;
  loadBridge({
    monacoFirst: true,
    beforeBridge: ({ window, fake }) => {
      const diff = fake.createDiffEditor(window.document);
      shown = fake.createModel('/TopActionBar.vue');
      diff.modified.setModel(shown);
      hidden = fake.createModel();
    }
  });

  assert.equal(shown.language, 'vue');
  assert.equal(hidden.language, 'plaintext');
});

test('late start: a model that an existing editor shows after the start switches on the next tick', async () => {
  let diff;
  const page = loadBridge({
    monacoFirst: true,
    beforeBridge: ({ window, fake }) => {
      diff = fake.createDiffEditor(window.document);
    }
  });

  const original = page.fake.createModel();
  const modified = page.fake.createModel('/TopActionBar.vue');
  diff.setModel({ original, modified });
  await page.tick();

  assert.equal(original.language, 'vue');
  assert.equal(modified.language, 'vue');
});

test('late start without a diff editor on the page changes nothing', () => {
  let model;
  loadBridge({
    monacoFirst: true,
    beforeBridge: ({ window, fake }) => {
      const container = window.document.createElement('div');
      window.document.body.appendChild(container);
      model = fake.createModel('/TopActionBar.vue');
      fake.createEditor(container).setModel(model);
    }
  });

  assert.equal(model.language, 'plaintext');
});

test('late start: the page keeps its own window.monaco value', () => {
  const page = loadBridge({ monacoFirst: true });
  assert.equal(page.window.monaco, page.fake.monaco);
});

test('the window.monaco hook keeps the value ADO assigns', () => {
  const page = loadBridge();
  assert.equal(page.window.monaco, undefined);
  page.assignMonaco();
  assert.equal(page.window.monaco, page.fake.monaco);
});

test('a second copy of the bridge on the same page does nothing', () => {
  const page = loadBridge();
  page.window.eval(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'monaco_bridge.js'), 'utf8'));
  page.assignMonaco();

  assert.equal(page.fake.calls.register.length, 1);
  assert.equal(page.themeRequests.length, 1);
});

test('a vue language that is already registered is not replaced, and no model is switched', async () => {
  const fake = createFakeMonaco({ languages: ['plaintext', 'typescript', 'vue'] });
  const page = loadBridge({ fake });
  page.assignMonaco();
  const { modified } = openVueDiff(fake, page.window.document);
  await page.tick();

  assert.equal(fake.calls.register.length, 0);
  assert.equal(fake.calls.setMonarchTokensProvider.length, 0);
  assert.equal(modified.language, 'plaintext');
});

test('a grammar that Monaco rejects leaves every model to ADO', async () => {
  const fake = createFakeMonaco({ throwing: ['languages.setMonarchTokensProvider'] });
  const page = loadBridge({ fake });
  assert.doesNotThrow(() => page.assignMonaco());
  const { modified } = openVueDiff(fake, page.window.document);
  await page.tick();

  assert.equal(modified.language, 'plaintext');
});

for (const missing of ['editor.onDidCreateEditor', 'editor.setModelLanguage', 'editor.getModels', 'languages.setMonarchTokensProvider']) {
  test(`without ${missing}, no language is registered and the theme still applies`, () => {
    const fake = createFakeMonaco({ remove: [missing] });
    const page = loadBridge({ fake });
    assert.doesNotThrow(() => page.assignMonaco());
    page.sendTheme({ vs: LIGHT });

    assert.equal(fake.calls.register.length, 0);
    assert.ok(themeFor(fake, 'vs'));
  });
}

test('a window.monaco without editor or languages is ignored, and a later real one is used', () => {
  const page = loadBridge();
  assert.doesNotThrow(() => {
    page.window.monaco = {};
    page.window.monaco = null;
    page.sendTheme({ vs: LIGHT });
  });

  page.assignMonaco();
  assert.equal(page.fake.calls.register.length, 1);
  assert.ok(themeFor(page.fake, 'vs'));
});

test('a throwing setModelLanguage does not escape into ADO', async () => {
  const fake = createFakeMonaco({ throwing: ['editor.setModelLanguage'] });
  const page = loadBridge({ fake });
  page.assignMonaco();

  assert.doesNotThrow(() => openVueDiff(fake, page.window.document));
  await page.tick();
});

test('the bridge asks the content script for the theme when it starts', () => {
  const page = loadBridge();
  assert.equal(page.themeRequests.length, 1);
});

test('theme: vs and vs-dark are redefined on their own base with inherit, and setTheme is never called', () => {
  const page = loadBridge();
  page.assignMonaco();
  page.sendTheme({ vs: LIGHT, 'vs-dark': DARK });

  const vs = themeFor(page.fake, 'vs');
  const dark = themeFor(page.fake, 'vs-dark');
  assert.equal(vs.base, 'vs');
  assert.equal(vs.inherit, true);
  assert.deepEqual(vs.colors, {});
  assert.equal(dark.base, 'vs-dark');
  assert.equal(dark.inherit, true);
  assert.deepEqual(page.fake.calls.setTheme, []);
  assert.equal(page.fake.calls.defineTheme.some(call => call.themeName === 'hc-black'), false);
});

test('theme: rules carry the Prism foreground without # and the font style', () => {
  const page = loadBridge();
  page.assignMonaco();
  page.sendTheme({ vs: LIGHT, 'vs-dark': DARK });

  const rules = themeFor(page.fake, 'vs').rules;
  assert.deepEqual(rules.find(rule => rule.token === 'comment'), { token: 'comment', foreground: 'a0a1a7', fontStyle: 'italic' });
  assert.deepEqual(rules.find(rule => rule.token === 'keyword'), { token: 'keyword', foreground: 'a626a4', fontStyle: '' });
  assert.deepEqual(themeFor(page.fake, 'vs-dark').rules.find(rule => rule.token === 'keyword'),
    { token: 'keyword', foreground: 'cc99cd', fontStyle: 'bold' });
});

test('theme: a Prism type also overrides the more specific built-in rules it would lose to', () => {
  const page = loadBridge();
  page.assignMonaco();
  page.sendTheme({ vs: LIGHT });

  const delimiterTokens = themeFor(page.fake, 'vs').rules
    .filter(rule => rule.foreground === '383a42')
    .map(rule => rule.token);
  assert.deepEqual(delimiterTokens.sort(), ['delimiter', 'delimiter.html', 'delimiter.xml']);
});

test('theme: a payload that arrives before Monaco is applied when ADO assigns it', () => {
  const page = loadBridge();
  page.sendTheme({ vs: LIGHT });
  assert.equal(page.fake.calls.defineTheme.length, 0);

  page.assignMonaco();
  assert.ok(themeFor(page.fake, 'vs'));
});

test('theme: a later payload replaces the rules', () => {
  const page = loadBridge();
  page.assignMonaco();
  page.sendTheme({ vs: LIGHT });
  page.sendTheme({ vs: { comment: { foreground: '#123456', fontStyle: '' } } });

  assert.deepEqual(themeFor(page.fake, 'vs').rules, [{ token: 'comment', foreground: '123456', fontStyle: '' }]);
});

test('theme: a throwing defineTheme does not escape into ADO', () => {
  const fake = createFakeMonaco({ throwing: ['editor.defineTheme'] });
  const page = loadBridge({ fake });
  page.assignMonaco();
  assert.doesNotThrow(() => page.sendTheme({ vs: LIGHT }));
});

const INVALID_PAYLOADS = {
  'not JSON': '{vs:',
  'an array': [],
  'null': null,
  'an unknown theme name': { 'hc-black': LIGHT },
  'an unknown token type': { vs: { ...LIGHT, function: { foreground: '#ffffff', fontStyle: '' } } },
  'a prototype key': '{"vs":{"__proto__":{"foreground":"#ffffff","fontStyle":""}}}',
  'a short color': { vs: { comment: { foreground: '#fff', fontStyle: '' } } },
  'a color without #': { vs: { comment: { foreground: 'a0a1a7', fontStyle: '' } } },
  'a CSS expression as color': { vs: { comment: { foreground: 'url(x)', fontStyle: '' } } },
  'an unknown font style': { vs: { comment: { foreground: '#a0a1a7', fontStyle: 'underline' } } },
  'a missing font style': { vs: { comment: { foreground: '#a0a1a7' } } },
  'an extra style key': { vs: { comment: { foreground: '#a0a1a7', fontStyle: '', background: '#000000' } } },
  'a string as token style': { vs: { comment: '#a0a1a7' } }
};

for (const [name, payload] of Object.entries(INVALID_PAYLOADS)) {
  test(`theme: a payload with ${name} is ignored as a whole`, () => {
    const page = loadBridge();
    page.assignMonaco();
    page.sendTheme(payload);

    assert.equal(page.fake.calls.defineTheme.length, 0);
  });
}

test('theme: an event whose detail is not a string is ignored', () => {
  const page = loadBridge();
  page.assignMonaco();
  page.window.document.dispatchEvent(new page.window.CustomEvent('ado-syntax-highlighter:monaco-theme', { detail: { vs: LIGHT } }));

  assert.equal(page.fake.calls.defineTheme.length, 0);
});
