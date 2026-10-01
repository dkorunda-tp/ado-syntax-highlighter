const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadExtension, mount, fileCard, inlineRow } = require('./helpers');
const { loadBridge, readBridge, createFakeMonaco } = require('./monaco-helpers');

// jsdom has no CSS nesting, so these flat rules stand in for the scoped prism.css that the build generates.
const ONE_LIGHT = `
  .prism-one-light .token.comment { color: #a0a1a7; font-style: italic; }
  .prism-one-light .token.keyword { color: #a626a4; }
  .prism-one-light .token.class-name { color: #c18401; font-weight: bold; }
  .prism-one-light .token.punctuation { color: rgb(56, 58, 66); }
`;
const TOMORROW_NIGHT = `
  .prism-tomorrow-night .token.comment { color: #999; }
  .prism-tomorrow-night .token.keyword { color: #cc99cd; }
`;
const DRACULA = `
  .prism-dracula .token.comment { color: slategray; }
  .prism-dracula .token.string { color: rgba(0, 0, 0, 0); }
`;

const ONE_LIGHT_TOKENS = {
  comment: { foreground: '#a0a1a7', fontStyle: 'italic' },
  keyword: { foreground: '#a626a4', fontStyle: '' },
  'class-name': { foreground: '#c18401', fontStyle: 'bold' },
  punctuation: { foreground: '#383a42', fontStyle: '' }
};
const TOMORROW_NIGHT_TOKENS = {
  comment: { foreground: '#999999', fontStyle: '' },
  keyword: { foreground: '#cc99cd', fontStyle: '' }
};

test('the chosen Prism theme colors both Monaco bases, sent once on load', async () => {
  const { themeEvents } = await loadExtension({ themePreference: 'prism-one-light', css: ONE_LIGHT });

  assert.deepEqual(themeEvents, [{ vs: ONE_LIGHT_TOKENS, 'vs-dark': ONE_LIGHT_TOKENS }]);
});

test('auto gives vs the light Prism theme and vs-dark the dark one', async () => {
  const { themeEvents } = await loadExtension({ themePreference: 'auto', css: ONE_LIGHT + TOMORROW_NIGHT });

  assert.deepEqual(themeEvents, [{ vs: ONE_LIGHT_TOKENS, 'vs-dark': TOMORROW_NIGHT_TOKENS }]);
});

test('named colors become #rrggbb, and transparent or unstyled tokens are left out', async () => {
  const { themeEvents } = await loadExtension({ themePreference: 'prism-dracula', css: DRACULA });

  assert.deepEqual(themeEvents[0].vs, { comment: { foreground: '#708090', fontStyle: '' } });
});

test('the color probe is removed from the page', async () => {
  const { window } = await loadExtension({ css: ONE_LIGHT });

  assert.equal(window.document.body.children.length, 0);
});

test('a theme change in the options is sent again', async () => {
  const { themeEvents, changeStorage } = await loadExtension({ css: ONE_LIGHT + DRACULA });

  changeStorage({ themePreference: { oldValue: 'prism-one-light', newValue: 'prism-dracula' } });

  assert.equal(themeEvents.length, 2);
  assert.deepEqual(themeEvents[1].vs, { comment: { foreground: '#708090', fontStyle: '' } });
});

test('a theme reset to the default is sent as auto', async () => {
  const { themeEvents, changeStorage } = await loadExtension({ css: ONE_LIGHT + TOMORROW_NIGHT });

  changeStorage({ themePreference: { oldValue: 'prism-one-light' } });

  assert.deepEqual(themeEvents[1], { vs: ONE_LIGHT_TOKENS, 'vs-dark': TOMORROW_NIGHT_TOKENS });
});

test('other storage changes send nothing', async () => {
  const { themeEvents, changeStorage } = await loadExtension({ css: ONE_LIGHT });

  changeStorage({ customFilePatterns: { newValue: {} } });
  changeStorage({ themePreference: { newValue: 'prism-dracula' } }, 'local');

  assert.equal(themeEvents.length, 1);
});

test('a theme request from the bridge gets the current theme', async () => {
  const { window, themeEvents, changeStorage } = await loadExtension({ css: ONE_LIGHT + DRACULA });
  changeStorage({ themePreference: { newValue: 'prism-dracula' } });

  window.document.dispatchEvent(new window.CustomEvent('ado-syntax-highlighter:monaco-theme-request'));

  assert.equal(themeEvents.length, 3);
  assert.deepEqual(themeEvents[2], themeEvents[1]);
});

test('a theme change does not change the theme of the multi-file view', async () => {
  const { window, changeStorage } = await loadExtension({ css: ONE_LIGHT });
  changeStorage({ themePreference: { newValue: 'prism-dracula' } });

  const file = mount(window, fileCard({
    filePath: '/src/util.ts',
    diff: inlineRow({ oldLine: 1, newLine: 1, type: 'unchanged', code: 'const a = 1' })
  }));
  window.processFileDiff(file);

  assert.ok(file.querySelector('.ado-syntax-highlighted > .prism-one-light'));
});

// Collects unhandled rejections instead of letting node:test fail on them, while `run` is in progress.
async function collectUnhandledRejections(run) {
  const listeners = process.listeners('unhandledRejection');
  const rejections = [];
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', reason => rejections.push(reason));
  try {
    const result = await run();
    await new Promise(resolve => setImmediate(resolve));
    return { result, rejections };
  } finally {
    process.removeAllListeners('unhandledRejection');
    listeners.forEach(listener => process.on('unhandledRejection', listener));
  }
}

test('an error in the multi-file pass does not stop the Monaco theme', async () => {
  const { result, rejections } = await collectUnhandledRejections(() => loadExtension({
    css: ONE_LIGHT,
    beforeContent: ({ window }) => {
      mount(window, fileCard({
        filePath: '/src/util.ts',
        diff: inlineRow({ oldLine: 1, newLine: 1, type: 'unchanged', code: 'const a = 1' })
      }));
      window.Prism.highlightElement = () => {
        throw new Error('unexpected markup');
      };
    }
  }));

  assert.deepEqual(rejections.map(error => error.message), ['unexpected markup']);
  assert.deepEqual(result.themeEvents, [{ vs: ONE_LIGHT_TOKENS, 'vs-dark': ONE_LIGHT_TOKENS }]);
});

// The real pair: the bridge in the page, the content script sending, and a fake Monaco recording defineTheme.
function vsRules(fake) {
  const vs = fake.calls.defineTheme.filter(call => call.themeName === 'vs').at(-1);
  return vs && JSON.parse(JSON.stringify(vs.themeData.rules));
}

test('the content script theme reaches the bridge on load and after a theme change', async () => {
  const fake = createFakeMonaco();
  const { changeStorage } = await loadExtension({
    css: ONE_LIGHT + DRACULA,
    beforeContent: ({ window }) => {
      window.eval(readBridge());
      window.monaco = fake.monaco;
    }
  });
  assert.deepEqual(vsRules(fake).find(rule => rule.token === 'comment'), { token: 'comment', foreground: 'a0a1a7', fontStyle: 'italic' });

  changeStorage({ themePreference: { newValue: 'prism-dracula' } });
  assert.deepEqual(vsRules(fake), [{ token: 'comment', foreground: '708090', fontStyle: '' }]);
});

test('a bridge that starts after the content script asks for the theme and gets it', async () => {
  const fake = createFakeMonaco();
  const { window } = await loadExtension({ css: ONE_LIGHT });

  window.monaco = fake.monaco;
  window.eval(readBridge());

  assert.deepEqual(vsRules(fake).find(rule => rule.token === 'keyword'), { token: 'keyword', foreground: 'a626a4', fontStyle: '' });
});

test('every Prism token type the content script sends is one the bridge accepts', async () => {
  // One rule for every token span makes the content script send each type it probes.
  const { themeEvents } = await loadExtension({ css: '.prism-one-light .token { color: #123456; }' });
  const [payload] = themeEvents;

  const page = loadBridge();
  page.assignMonaco();
  page.sendTheme(payload);

  assert.ok(Object.keys(payload.vs).length > 10);
  assert.ok(payload.vs.function, 'the function color is sent, for calls, scss function calls and sql built-ins');
  assert.equal(page.fake.calls.defineTheme.length, 2);
});

test('the Prism function color colors the function token of calls in both bases', () => {
  const page = loadBridge();
  page.assignMonaco();
  page.sendTheme({
    vs: { function: { foreground: '#654321', fontStyle: '' } },
    'vs-dark': { function: { foreground: '#fedcba', fontStyle: 'italic' } }
  });

  for (const [themeName, foreground, fontStyle] of [['vs', '654321', ''], ['vs-dark', 'fedcba', 'italic']]) {
    const theme = page.fake.calls.defineTheme.find(call => call.themeName === themeName);
    const rule = theme.themeData.rules.find(candidate => candidate.token === 'function');
    assert.deepEqual({ ...rule }, { token: 'function', foreground, fontStyle }, themeName);
  }
});

test('the Prism operator and boolean colors color the operator and boolean tokens in both bases', () => {
  const page = loadBridge();
  page.assignMonaco();
  page.sendTheme({
    vs: { operator: { foreground: '#111111', fontStyle: '' }, boolean: { foreground: '#222222', fontStyle: '' } },
    'vs-dark': { operator: { foreground: '#333333', fontStyle: '' }, boolean: { foreground: '#444444', fontStyle: 'italic' } }
  });

  for (const [themeName, operator, boolean] of [['vs', '111111', ['222222', '']], ['vs-dark', '333333', ['444444', 'italic']]]) {
    const { rules } = page.fake.calls.defineTheme.find(call => call.themeName === themeName).themeData;
    assert.deepEqual({ ...rules.find(rule => rule.token === 'operator') }, { token: 'operator', foreground: operator, fontStyle: '' }, themeName);
    assert.deepEqual({ ...rules.find(rule => rule.token === 'boolean') }, { token: 'boolean', foreground: boolean[0], fontStyle: boolean[1] }, themeName);
  }
});

// Every token color rule of Monaco 0.29.1's built-in vs and vs-dark themes, read from the bundle.
function builtInRuleTokens() {
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min', 'vs', 'editor', 'editor.main.js'), 'utf8');
  const tokens = new Set();
  for (const base of ['vs', 'vs-dark']) {
    const rules = bundle.match(new RegExp(`base:"${base}",inherit:!1,rules:\\[([^\\]]*)\\]`))[1];
    for (const [, token] of rules.matchAll(/token:"([^"]*)"/g)) tokens.add(token);
  }
  return tokens;
}

// A built-in rule that no Prism rule replaces keeps its built-in color. These are left on purpose: `invalid` is
// the TypeScript and JavaScript default token and has no Prism type, `emphasis`, `strong` and `metatag.php` set
// only a font style, the pug id and class rules match Prism types the probe does not read, and no 0.29.1 grammar
// emits `meta.tag`.
const UNMAPPED_BUILT_IN_RULES = ['', 'invalid', 'emphasis', 'strong', 'metatag.php', 'tag.id.pug', 'tag.class.pug', 'meta.tag'];

test('the colors the content script sends replace every built-in color rule, apart from the listed ones', async () => {
  const { themeEvents } = await loadExtension({ css: '.prism-one-light .token { color: #123456; }' });
  const page = loadBridge();
  page.assignMonaco();
  page.sendTheme(themeEvents[0]);

  for (const themeName of ['vs', 'vs-dark']) {
    const theme = page.fake.calls.defineTheme.find(call => call.themeName === themeName);
    const mapped = new Set(theme.themeData.rules.map(rule => rule.token));
    const unmapped = [...builtInRuleTokens()].filter(token => !mapped.has(token));
    assert.deepEqual(unmapped.sort(), [...UNMAPPED_BUILT_IN_RULES].sort(), themeName);
  }
});
