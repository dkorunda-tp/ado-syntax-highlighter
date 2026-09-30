// Function calls in the single-file view: the bridge's copies of Monaco's typescript, javascript and csharp
// grammars give a call a function token. Runs on the real monaco-editor 0.29 build, whose own grammars load
// lazily, the first time a language is used, as in ADO.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRealMonaco, waitFor, tokenizeLines, waitForEmbeddedGrammars, renderedColors, coloredPieces } = require('./monaco-helpers');

const LANGUAGES = ['typescript', 'javascript', 'csharp'];
const POSTFIX = { typescript: 'ts', javascript: 'js', csharp: 'cs' };

function tokenize(monaco, text, language) {
  return tokenizeLines(monaco, text.split('\n'), language);
}

// The type of the `nth` token whose text is exactly `text`.
function typeOf(line, text, nth = 0) {
  const token = line.filter(candidate => candidate.text === text)[nth];
  assert.ok(token, `no "${text}" #${nth} in ${JSON.stringify(line.map(candidate => candidate.text))}`);
  return token.type;
}

// Only the bridge's copy has a function token, and a keyword shows that a grammar has loaded at all.
function hasCallTokens(monaco, language) {
  return tokenize(monaco, 'f(1)', language)[0].some(token => token.type === `function.${POSTFIX[language]}`);
}

function hasGrammar(monaco, language) {
  return tokenize(monaco, 'if (a) {}', language)[0].some(token => token.type.startsWith('keyword'));
}

// Monaco's lazy loader sets the language configuration when ADO's grammar module has loaded, a few microtasks
// before it registers that grammar. The record tells a test when ADO's grammar has had its chance to win.
function recordAdoGrammarLoads(monaco) {
  const loaded = [];
  const setLanguageConfiguration = monaco.languages.setLanguageConfiguration;
  monaco.languages.setLanguageConfiguration = (languageId, configuration) => {
    loaded.push(languageId);
    return setLanguageConfiguration(languageId, configuration);
  };
  return loaded;
}

function settle(window) {
  return new Promise(resolve => window.setTimeout(resolve, 50));
}

async function waitForCallTokens(monaco, languages = LANGUAGES) {
  await waitFor(() => languages.every(language => hasCallTokens(monaco, language)), `function tokens in ${languages.join(', ')}`);
}

test('function calls', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco } = page;
  LANGUAGES.forEach(language => hasCallTokens(monaco, language));
  await waitForCallTokens(monaco);
  await waitForEmbeddedGrammars(monaco);

  for (const language of ['typescript', 'javascript']) {
    const postfix = POSTFIX[language];

    await t.test(`${language}: formatDollars(x) and a.b.c( are calls`, () => {
      const [line] = tokenize(monaco, 'const total = formatDollars(x) + a.b.c(1) + pad (2)', language);

      assert.equal(typeOf(line, 'formatDollars'), `function.${postfix}`);
      assert.equal(typeOf(line, 'c'), `function.${postfix}`);
      assert.equal(typeOf(line, 'pad'), `function.${postfix}`, 'whitespace before (');
      for (const name of ['total', 'x', 'a', 'b']) assert.equal(typeOf(line, name), `identifier.${postfix}`, name);
      assert.equal(typeOf(line, '('), `delimiter.parenthesis.${postfix}`);
      assert.equal(typeOf(line, 'const'), `keyword.${postfix}`);
    });

    await t.test(`${language}: keywords before ( stay keywords`, () => {
      const [line] = tokenize(monaco, 'if (a) { for (;;) {} while (b) {} switch (c) {} try {} catch (e) {} return (x) + typeof (y) }', language);

      for (const keyword of ['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof']) {
        assert.equal(typeOf(line, keyword), `keyword.${postfix}`, keyword);
      }
    });

    await t.test(`${language}: property access without a call stays identifier`, () => {
      const [line] = tokenize(monaco, 'const v = a.b.c; d = e', language);

      for (const name of ['v', 'a', 'b', 'c', 'd', 'e']) assert.equal(typeOf(line, name), `identifier.${postfix}`, name);
    });
  }

  await t.test('csharp: FormatDollars(x) and a.b.c( are calls', () => {
    const [line] = tokenize(monaco, 'var total = FormatDollars(x) + a.b.c(1) + Pad (2);', 'csharp');

    assert.equal(typeOf(line, 'FormatDollars'), 'function.cs');
    assert.equal(typeOf(line, 'c'), 'function.cs');
    assert.equal(typeOf(line, 'Pad'), 'function.cs', 'whitespace before (');
    for (const name of ['total', 'x', 'a', 'b']) assert.equal(typeOf(line, name), 'identifier.cs', name);
    assert.equal(typeOf(line, 'var'), 'keyword.var.cs');
  });

  await t.test('csharp: keywords before ( stay keywords', () => {
    const [line] = tokenize(monaco, 'if (a) { for (;;) { } foreach (var i in l) { } while (b) { } switch (c) { } try { } catch (Exception e) { } using (var s = f) { } return (x) + typeof(y) + nameof(z); }', 'csharp');

    for (const keyword of ['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'return', 'typeof', 'nameof']) {
      assert.equal(typeOf(line, keyword), `keyword.${keyword}.cs`, keyword);
    }
  });

  await t.test('csharp: property access without a call stays identifier', () => {
    const [line] = tokenize(monaco, 'var v = a.b.c; d = e;', 'csharp');

    for (const name of ['v', 'a', 'b', 'c', 'd', 'e']) assert.equal(typeOf(line, name), 'identifier.cs', name);
  });

  await t.test('vue: calls in a template interpolation, a directive value and the script', () => {
    const lines = tokenizeLines(monaco, [
      '<template>',
      '  <p :title="a.b.c(1)" @click="save()">{{ formatDollars(x) }} {{ a.b }} {{ typeof (y) }}</p>',
      '</template>',
      '<script setup lang="ts">',
      'const v = formatDollars(1)',
      '</script>'
    ]);

    assert.equal(typeOf(lines[1], 'c'), 'function.ts');
    assert.equal(typeOf(lines[1], 'save'), 'function.ts');
    assert.equal(typeOf(lines[1], 'formatDollars'), 'function.ts');
    assert.equal(typeOf(lines[1], 'a'), 'identifier.ts');
    assert.equal(typeOf(lines[1], 'b', 1), 'identifier.ts', 'a.b without a call');
    assert.equal(typeOf(lines[1], 'typeof'), 'keyword.ts');
    assert.equal(typeOf(lines[4], 'formatDollars'), 'function.ts');
  });
});

const CSHARP_SAMPLE = `using System;
using System.Collections.Generic;
namespace Top.Provider.Matching
{
    #region Types
    [Serializable]
    public sealed class Matcher<T> : IMatcher where T : class
    {
        private readonly Dictionary<string, int> _counts = new Dictionary<string, int>();
        public int Count { get; private set; }
        // A line comment with a call(inside)
        /* A block comment
           over two lines */
        public async Task<bool> MatchAsync(T item, int limit = 10)
        {
            var name = $"Item {item.Name} of {limit,5:N0}";
            var path = @"C:\\temp\\file.txt";
            var raw = $@"Line {name} ""quoted""";
            char c = 'x', tab = '\\t';
            double d = 1.5e3; int hex = 0xFF; int bin = 0b1010;
            if (item == null) throw new ArgumentNullException(nameof(item));
            foreach (var pair in _counts.Where(p => p.Value > 0).OrderBy(p => p.Key))
            {
                Console.WriteLine("{0}: {1}", pair.Key, pair.Value);
            }
            var query = from p in _counts where p.Value > limit select p.Key;
            return await Task.FromResult(Count++ >= limit && !string.IsNullOrEmpty(name));
        }
    }
    #endregion
}`;

const TYPESCRIPT_SAMPLE = `import { ref, computed } from 'vue';
interface Cap { amount: number; label?: string }
export function formatDollars(value: number): string {
  const re = /\\d+(\\.\\d+)?/g;
  return \`$\${value.toFixed(2)} \${re.test(String(value)) ? 'ok' : "no"}\`;
}
class Card<T extends Cap> implements Iterable<T> {
  private items: T[] = [];
  constructor(public readonly name: string) { super(); }
  get size() { return this.items.length }
  *[Symbol.iterator]() { yield* this.items; }
}
const total = caps.reduce((sum, cap) => sum + cap.amount, 0n) ?? 0x1f;
/** JSDoc with a call(inside) */
let x = a?.b?.(1) || await load<Cap>('x');`;

// Monaco's own grammars on the left, the bridge's copies on the right: only a call changes, from identifier to
// function, and every token keeps its offset. JavaScript and TypeScript share one tokenizer.
test('every other token is the same as in Monaco\'s own grammar', async t => {
  const page = await loadRealMonaco({ bridge: 'none' });
  t.after(() => page.close());
  const { monaco } = page;
  const root = path.join(__dirname, '..');
  const scripts = ['monaco_bridge.js', 'content_script.js'].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  const samples = { typescript: `${TYPESCRIPT_SAMPLE}\n${scripts}`, javascript: `${TYPESCRIPT_SAMPLE}\n${scripts}`, csharp: CSHARP_SAMPLE };
  await waitFor(() => LANGUAGES.every(language => hasGrammar(monaco, language)), 'Monaco\'s own grammars');
  const before = Object.fromEntries(LANGUAGES.map(language => [language, tokenize(monaco, samples[language], language)]));

  page.startBridge();
  await waitForCallTokens(monaco);

  for (const language of LANGUAGES) {
    const postfix = POSTFIX[language];
    const after = tokenize(monaco, samples[language], language);
    const lines = samples[language].split('\n');
    let calls = 0;
    after.forEach((line, index) => {
      const old = before[language][index];
      assert.deepEqual(line.map(token => token.text), old.map(token => token.text), `${language} line ${index + 1}: ${lines[index]}`);
      line.forEach((token, tokenIndex) => {
        if (token.type === old[tokenIndex].type) return;
        const where = `${language} line ${index + 1}, "${token.text}": ${lines[index]}`;
        assert.equal(token.type, `function.${postfix}`, where);
        assert.equal(old[tokenIndex].type, `identifier.${postfix}`, where);
        assert.match(lines[index].slice(line.slice(0, tokenIndex + 1).map(piece => piece.text).join('').length), /^\s*\(/, where);
        calls++;
      });
    });
    assert.ok(calls >= 5, `${language}: ${calls} calls`);
  }
});

test('a bridge that starts first replaces each grammar after ADO\'s loads on first use', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco, window } = page;
  const adoLoads = recordAdoGrammarLoads(monaco);

  LANGUAGES.forEach(language => hasCallTokens(monaco, language));
  await waitFor(() => LANGUAGES.every(language => adoLoads.includes(language)), 'ADO\'s grammars');
  await settle(window);

  for (const language of LANGUAGES) assert.ok(hasCallTokens(monaco, language), language);
});

test('a TypeScript model that ADO tokenized first is tokenized again with function tokens', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco, window } = page;
  const adoLoads = recordAdoGrammarLoads(monaco);
  const functionColor = { function: { foreground: '#654321', fontStyle: '' } };
  page.sendTheme({ vs: functionColor, 'vs-dark': functionColor });
  monaco.editor.setTheme('vs');
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const model = monaco.editor.createModel('const t = formatDollars(x)', 'typescript');
  monaco.editor.create(host, { model });

  await waitFor(() => adoLoads.includes('typescript'), 'ADO\'s TypeScript grammar');
  await settle(window);

  const pieces = coloredPieces(window, monaco.editor.colorizeModelLine(model, 1));
  assert.equal(pieces.find(piece => piece.text === 'formatDollars')?.color, '#654321', JSON.stringify(pieces));
});

test('a bridge that starts first replaces the TypeScript that the vue grammar uses first', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco, window } = page;
  const adoLoads = recordAdoGrammarLoads(monaco);
  const lines = ['<template>', '  <p>{{ formatDollars(x) }}</p>', '</template>'];

  tokenizeLines(monaco, lines);
  await waitFor(() => adoLoads.includes('typescript'), 'ADO\'s TypeScript grammar');
  await settle(window);

  assert.equal(typeOf(tokenizeLines(monaco, lines)[1], 'formatDollars'), 'function.ts');
});

test('a bridge that starts after the first use replaces ADO\'s loaded grammars', async t => {
  const page = await loadRealMonaco({ bridge: 'none' });
  t.after(() => page.close());
  const { monaco } = page;
  await waitFor(() => LANGUAGES.every(language => hasGrammar(monaco, language)), 'ADO\'s grammars');
  for (const language of LANGUAGES) assert.equal(hasCallTokens(monaco, language), false, language);

  page.startBridge();

  await waitForCallTokens(monaco);
});

test('a bridge that starts after Monaco but before the first use replaces the grammars that load later', async t => {
  const page = await loadRealMonaco({ bridge: 'none' });
  t.after(() => page.close());
  const { monaco, window } = page;
  const adoLoads = recordAdoGrammarLoads(monaco);

  page.startBridge();
  LANGUAGES.forEach(language => hasCallTokens(monaco, language));
  await waitFor(() => LANGUAGES.every(language => adoLoads.includes(language)), 'ADO\'s grammars');
  await settle(window);

  for (const language of LANGUAGES) assert.ok(hasCallTokens(monaco, language), language);
});

test('a copy that Monaco rejects leaves ADO\'s grammar for that language only', async t => {
  const page = await loadRealMonaco({ bridge: 'none' });
  t.after(() => page.close());
  const { monaco, window } = page;
  await waitFor(() => LANGUAGES.every(language => hasGrammar(monaco, language)), 'ADO\'s grammars');
  const setMonarchTokensProvider = monaco.languages.setMonarchTokensProvider;
  monaco.languages.setMonarchTokensProvider = (languageId, languageDef) => {
    if (languageId === 'typescript') throw new Error('rejected');
    return setMonarchTokensProvider(languageId, languageDef);
  };

  assert.doesNotThrow(() => page.startBridge());
  await waitForCallTokens(monaco, ['javascript', 'csharp']);
  await settle(window);

  assert.equal(hasCallTokens(monaco, 'typescript'), false);
  assert.ok(hasGrammar(monaco, 'typescript'));
  assert.ok(monaco.languages.getLanguages().some(language => language.id === 'vue'));
});

for (const missing of ['editor.colorize', 'languages.onLanguage']) {
  test(`without ${missing}, every language keeps ADO's grammar and the vue language still registers`, async t => {
    const page = await loadRealMonaco({ bridge: 'none' });
    t.after(() => page.close());
    const { monaco, window } = page;
    await waitFor(() => LANGUAGES.every(language => hasGrammar(monaco, language)), 'ADO\'s grammars');
    const [namespace, member] = missing.split('.');
    delete monaco[namespace][member];

    assert.doesNotThrow(() => page.startBridge());
    await settle(window);

    for (const language of LANGUAGES) assert.equal(hasCallTokens(monaco, language), false, language);
    assert.ok(monaco.languages.getLanguages().some(language => language.id === 'vue'));
  });
}

test('a function token renders in the Prism function color in both bases', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco, window } = page;
  page.sendTheme({
    vs: { function: { foreground: '#654321', fontStyle: '' } },
    'vs-dark': { function: { foreground: '#fedcba', fontStyle: '' } }
  });
  LANGUAGES.forEach(language => hasCallTokens(monaco, language));
  await waitForCallTokens(monaco);
  await waitForEmbeddedGrammars(monaco);
  const cases = [
    ['const t = formatDollars(x)', 'typescript', 'formatDollars'],
    ['const t = formatDollars(x)', 'javascript', 'formatDollars'],
    ['var t = FormatDollars(x);', 'csharp', 'FormatDollars'],
    ['<template>\n  <p>{{ formatDollars(x) }}</p>\n</template>', 'vue', 'formatDollars']
  ];

  for (const [themeName, color] of [['vs', '#654321'], ['vs-dark', '#fedcba']]) {
    monaco.editor.setTheme(themeName);
    for (const [text, language, name] of cases) {
      const pieces = await renderedColors(monaco, window, text, language);
      assert.equal(pieces.find(piece => piece.text === name)?.color, color, `${themeName} ${language}: ${JSON.stringify(pieces)}`);
      assert.notEqual(pieces.find(piece => piece.text === 'x')?.color, color, `${themeName} ${language}: x is not a call`);
    }
  }
});
