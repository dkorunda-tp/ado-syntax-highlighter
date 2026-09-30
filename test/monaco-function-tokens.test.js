// Function calls in the single-file view: the bridge's copies of Monaco's typescript, javascript and csharp
// grammars give a call a function token. Runs on the real monaco-editor 0.29 build, whose own grammars load
// lazily, the first time a language is used, as in ADO.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { loadRealMonaco, waitFor, tokenizeLines, waitForEmbeddedGrammars, renderedColors, coloredPieces } = require('./monaco-helpers');

const LANGUAGES = ['typescript', 'javascript', 'csharp'];
const POSTFIX = { typescript: 'ts', javascript: 'js', csharp: 'cs' };
const root = path.join(__dirname, '..');

// The bundled Prism, which the multi-file view uses.
function loadPrism() {
  const { window } = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  window.eval(fs.readFileSync(path.join(root, 'prism', 'prism.js'), 'utf8'));
  return window.Prism;
}

// Prism's tokens of one line as text ranges, each with its types and aliases and those of the tokens around it.
function prismPieces(Prism, line, language) {
  const pieces = [];
  let offset = 0;
  const walk = (content, types) => {
    if (typeof content === 'string') {
      pieces.push({ start: offset, end: offset + content.length, types });
      offset += content.length;
    } else if (Array.isArray(content)) {
      content.forEach(item => walk(item, types));
    } else {
      walk(content.content, [...types, content.type, ...[].concat(content.alias || [])]);
    }
  };
  walk(Prism.tokenize(line, Prism.languages[language]), []);
  return pieces;
}

// A function token in Prism: a call, or a name that is assigned a function (`function-variable`).
function isPrismCall(pieces, offset) {
  const { types } = pieces.find(piece => piece.start <= offset && offset < piece.end);
  return types.includes('function');
}

const WORD_TOKEN = /^(?:identifier|keyword|type\.identifier|function)(?:\.|$)/;

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
    for (const name of ['total', 'x', 'a', 'b', 'Pad']) assert.equal(typeOf(line, name), 'identifier.cs', `${name}; Prism's C# call has no whitespace before (`);
    assert.equal(typeOf(line, 'var'), 'keyword.var.cs');
  });

  await t.test('csharp: keywords before ( stay keywords', () => {
    const [line] = tokenize(monaco, 'if (a) { for (;;) { } foreach (var i in l) { } while (b) { } switch (c) { } try { } catch (Exception e) { } using (var s = f) { } return (x) + typeof(y) + nameof(z); }', 'csharp');

    for (const keyword of ['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'return', 'typeof', 'nameof']) {
      assert.equal(typeOf(line, keyword), `keyword.${keyword}.cs`, keyword);
    }
  });

  // Arguments that end at a line end must leave the attribute, or a later `),` would return to it.
  await t.test('csharp: attribute arguments that end at a line end leave the attribute', () => {
    const lines = tokenizeLines(monaco, ['[Foo, Bar(', '    1)', ']', 'Call(Run(1), Walk(2));'], 'csharp');

    assert.equal(typeOf(lines[0], 'Bar'), 'identifier.cs');
    assert.equal(typeOf(lines[3], 'Walk'), 'function.cs');
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

// TypeScript syntax is also valid input for the javascript grammars, so one corpus serves both.
const SCRIPT_CALLS = [
  'const total = formatDollars(x) + a.b.c(1) + pad (2);',
  'map.get(k); map.set(k, v); const list = Array.from(items); obj.delete(k); obj.default(1); obj.type(2); obj.is(3);',
  'p.then(done).catch(fail).finally(end);',
  'const n = Number(x) + String(y).length + Boolean(z) + Foo() + Date.now() + TypeError(e);',
  'const b = new Foo(); const c = new Bar.Baz(1); const d = new foo(); const e = new Intl.NumberFormat(\'en-US\').format(1);',
  'const cap = load<Cap>(\'x\'); const m = new Map<string, number>(); api.get<Cap[]>(\'/caps\'); Foo<T>();',
  'const nested = load<Map<string, Cap>>(\'x\') + api.get<Array<Record<string, Cap>>>(1);',
  'if (a) { for (;;) {} while (b) {} switch (c) {} } try { x() } catch (e) { y() }',
  'return typeof (y) === void (0) ? super.render() : this.save(URL(u), MAX_COUNT(2));',
  'handler.call(this, e); fn.apply(null, args); cb.bind(this);',
  'class Card extends Base { constructor(name: string) { super(name); } get size() { return this.items.length } set size(v) {} }',
  'export function formatCapPercent(value: number): string { return `${round(value * 100)}%`; }',
  'emit(\'update\', value); nextTick(() => focus()); watch(() => props.id, load);',
  'import(\'./x\').then(m => m.default(1)); require(\'y\'); get(1); set(2); from(3); async (x) => x;',
  'x.$emit(\'close\'); _private(1); $jq(1); a?.b?.(1); a?.c(2); ...spread(3);',
  // Names that are assigned a function: Prism's function-variable rule.
  'const handler = (e) => emit(e); const load = async () => fetch(x); const fn = function (a) { return a; };',
  'export default { props: { items: { type: Array, default: () => [] } }, methods: { save: async (id) => post(id), close: x => x } };',
  'this.onChange = (v) => v; obj.run = function () {}; let cb: Handler = (a) => a; x.y = z => z; const k = async x => x;',
  'const MAX = () => 1; const Pick = ({ a }) => a; const t = (a, (b)) => 1; if (a == function () {}) {} x += () => 1;'
];

const CSHARP_CALLS = [
  'var total = FormatDollars(x) + a.b.C(1) + Pad (2);',
  'if (a) { } typeof(x); nameof(x); sizeof(int); default(T); using (var s = Open()) { } foreach (var i in Items()) { } lock (x) { }',
  'var list = new List<int> { 1 }; var foo = new Foo(1); var bar = new Foo.Bar(2); var d = new Dictionary<string, int>();',
  'services.AddScoped<IFoo, Foo>(); var x = Get<T>(); var y = a.Get<List<int>>(); var z = Get <T> ();',
  'return string.IsNullOrEmpty(s) ? int.Parse(s) : await Task.FromResult(Count(x));',
  'Console.WriteLine($"Item {item.Name} of {Format(limit)}");',
  'public async Task<bool> MatchAsync(T item, int limit = 10) => await Check(item);',
  '[HttpGet("{id}")]',
  '[ProducesResponseType<List<CapModel>>(StatusCodes.Status200OK)]',
  '    [Authorize(Roles = "Admin"), Produces(typeof(Foo))]',
  '[Route("api/[controller]")]',
  '[Authorize][HttpGet("{id}")]',
  '[Route("api/)")]',
  '[Foo(typeof(Bar), Name = nameof(Baz))]',
  '[1, Run()]',
  'Take([item + Run()]); Take(1, [item + Run()]); Take([a, b]);',
  'var value = matrix',
  '    [row][GetIndex() + 1];',
  '[Foo(1) /* comment */]',
  'public void M() { Call(Run(1), Walk(2)); }',
  '[Foo(',
  '    Bar(1)',
  '    + Baz(2))]',
  'public IActionResult Get([FromQuery(Name = "id")] int id, [FromRoute(Name = "x")] string x) => Ok(id);',
  'public record CapDto(int Id, string Name);',
  'public class CapsController(IMediator mediator) : ControllerBase',
  'base.Dispose(); this.Save(); x?.Foo(1); checked(x + 1); from(1); var q = from p in list where p.Ok() select p;',
  'throw new ArgumentNullException(nameof(item));'
];

const SCRIPT_OPERATORS = [
  'const ok = a < b && c > d || !e ? f : g ?? h;',
  'let x: Array<string> = [...items]; y?.z; y?.(1); y?.[0]; a!.b; x += 1; x **= 2; i++; --j; a >>> 2; ~c;',
  'const f = (a: number): boolean => a === 1 || a !== 2 && a <= 3 && a >= 0;',
  'const flags = { on: true, off: false, none: null, n: -1 }; if (!false) {} obj.true; x = y ? true : false;',
  'type U = A | B & C; function g<T extends object>(v?: T): v is T { return v != null; }',
  'const s = `sum ${a + b * c} of ${list.length > 0}`; x ||= y; x &&= z; x ??= w; x %= 3; x ^= 1; x <<= 1;'
];

const TYPESCRIPT_OPERATORS = [
  '@Component({ name: \'x\' }) class A { @Prop() readonly value!: string; }'
];

const CSHARP_OPERATORS = [
  'var ok = a < b && c > d || !e ? f : g ?? h; x ??= y;',
  'var r = arr[1..^1]; Func<int, bool> p = i => i >= 0 && i != 3; x += 1; x <<= 2; y = ~y; i++; --j;',
  'var d = new Dictionary<string, List<int>>(); List<int> xs = new(); int? n = null; var m = a?.b ?? c;',
  'global::System.Console.WriteLine(true); if (x is not null && flag == false || done != true) { }',
  'public Task<ActionResult<List<CapModel>>> Get(Expression<Func<T, bool>> predicate) => Query<T>(predicate);',
  'var t = flag ? true : false; bool b = !(a > 0); var q = items.Where(i => i.Ok).Select(i => i.Id * 2 - 1 / 3 % 4);',
  'using ReviewEntity = TopProviderDb.Lib.Models.QualityReview.Review;',
  'var presented = header[prefix.Length..].Trim() + s[..n] + s[a..b];',
  'var label = $"{createdAt:yyyy-MM-dd} {total:N2} {(ok ? "yes" : "no")} {x,10:C} {a - b}";',
  'using Lookup = System.Collections.Generic.Dictionary<string, object>;',
  'List <int> items = new(); var z = Get <T> ();',
  '        return new ServerSidePaginatedResult<QualityReviewQueueEntryModel>'
];

// Each operator and boolean character in the corpus has the operator or boolean token in Monaco exactly where
// Prism gives it that type, one line at a time as the multi-file view highlights a row.
test('an operator or a boolean has its token where Prism shows one', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco } = page;
  const Prism = loadPrism();
  LANGUAGES.forEach(language => hasCallTokens(monaco, language));
  await waitForCallTokens(monaco);
  const corpora = {
    typescript: [...SCRIPT_OPERATORS, ...TYPESCRIPT_OPERATORS, ...SCRIPT_CALLS],
    javascript: [...SCRIPT_OPERATORS, ...SCRIPT_CALLS],
    csharp: [...CSHARP_OPERATORS, ...CSHARP_CALLS]
  };

  for (const [language, corpus] of Object.entries(corpora)) {
    const mismatches = [];
    tokenize(monaco, corpus.join('\n'), language).forEach((tokens, index) => {
      const pieces = prismPieces(Prism, corpus[index], language);
      let offset = 0;
      for (const token of tokens) {
        for (let char = offset; char < offset + token.text.length; char++) {
          if (/\s/.test(corpus[index][char])) continue;
          const { types } = pieces.find(piece => piece.start <= char && char < piece.end);
          for (const kind of ['operator', 'boolean']) {
            if (token.type.startsWith(`${kind}.`) !== types.includes(kind)) {
              mismatches.push(`${kind} "${corpus[index][char]}" at ${char} (${token.type}, Prism ${types.join('/') || 'plain'}) in: ${corpus[index]}`);
            }
          }
        }
        offset += token.text.length;
      }
    });
    assert.deepEqual(mismatches, [], language);
  }
});

// Each name in the corpus is a function token in Monaco exactly where Prism tokenizes it as a function, one
// line at a time as the multi-file view highlights a row.
test('a call has the function token where Prism shows a function', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco } = page;
  const Prism = loadPrism();
  LANGUAGES.forEach(language => hasCallTokens(monaco, language));
  await waitForCallTokens(monaco);

  for (const [language, corpus] of [['typescript', SCRIPT_CALLS], ['javascript', SCRIPT_CALLS], ['csharp', CSHARP_CALLS]]) {
    const mismatches = [];
    tokenize(monaco, corpus.join('\n'), language).forEach((tokens, index) => {
      const pieces = prismPieces(Prism, corpus[index], language);
      let offset = 0;
      for (const token of tokens) {
        const monacoCall = token.type.startsWith('function.');
        if (WORD_TOKEN.test(token.type) && monacoCall !== isPrismCall(pieces, offset)) {
          mismatches.push(`${token.text} (${token.type}) in: ${corpus[index]}`);
        }
        offset += token.text.length;
      }
    });
    assert.deepEqual(mismatches, [], language);
  }
});

// The multi-file view highlights a .vue script block as a whole, so Prism sees the `>(` of a generic call on a
// later line. Monaco reads one line, so the Vue compiler macros, which are always calls, are calls before `<`.
test('a Vue macro whose generic spans lines is a call and a new before a line break is not, as in Prism\'s whole-block highlighting', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco } = page;
  const Prism = loadPrism();
  await waitForEmbeddedGrammars(monaco);
  const script = [
    'const props = defineProps<{',
    '  items: Array<string>;',
    '}>();',
    'const emit = defineEmits<{',
    '  (e: \'change\', id: number): void',
    '}>();',
    'const model = defineModel<',
    '  string',
    '>();',
    'const options: Partial<{',
    '  a: string',
    '}> = {};',
    'const value = new',
    '',
    '  Factory();',
    'const ok = !props.items?.length && emit(\'change\', 1) === undefined ? true : false;',
    'const onSave = async (id: number) => emit(\'change\', id);'
  ];
  const lines = tokenizeLines(monaco, ['<script setup lang="ts">', ...script, '</script>']).slice(1, -1);
  const pieces = prismPieces(Prism, script.join('\n'), 'typescript');
  let offset = 0;
  const mismatches = [];
  const text = script.join('\n');
  lines.forEach((tokens, index) => {
    for (const token of tokens) {
      if (WORD_TOKEN.test(token.type) && token.type.startsWith('function.') !== isPrismCall(pieces, offset)) {
        mismatches.push(`${token.text} (${token.type}) in: ${script[index]}`);
      }
      for (let char = offset; char < offset + token.text.length; char++) {
        if (/\s/.test(text[char])) continue;
        const { types } = pieces.find(piece => piece.start <= char && char < piece.end);
        for (const kind of ['operator', 'boolean']) {
          if (token.type.startsWith(`${kind}.`) !== types.includes(kind)) mismatches.push(`${kind} "${text[char]}" in: ${script[index]}`);
        }
      }
      offset += token.text.length;
    }
    offset++;
  });

  assert.deepEqual(mismatches, []);
  for (const [index, name] of [[0, 'defineProps'], [3, 'defineEmits'], [6, 'defineModel']]) {
    assert.equal(typeOf(lines[index], name), 'function.ts', name);
  }
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

// Attribute lines that could trap the copy in a state: deep parentheses, and an unclosed bracket in an
// interpolation hole, whose closing brace must still end the hole.
const CSHARP_EDGES = [
  `[A(${'('.repeat(120)}1${')'.repeat(120)})]`,
  // A symbol run that Monaco's own grammar reads as one, such as :// in a raw string it does not know, starts
  // no comment (PR 9408, PlaybookChecklistStateTests.cs line 354).
  '        var json = """{"url": "https://example.com/a"}""" ; var n = Count(1);',
  'var a = b ?// c',
  'var d = e ?? f ://* g */ h;',
  'x ::/* y */ z;',
  'var s = $@"{',
  '[x',
  '}"; var n = Count(1);',
  'var t = $"{',
  '[y',
  '}"; var m = Count(2);'
];

// A call as the copies find one: a name, then `(`, `<...>(` or `.call(` and the like.
const CALL_FOLLOWS = /^\s*(?:<.*>\s*|\.\s*(?:apply|bind|call)\s*)?\(/;
// Or a name that is assigned a function: `= (...) =>`, `: async x =>`, `= function`.
const FUNCTION_VALUE_FOLLOWS = /^\s*[=:]\s*(?:async\s*)?(?:function\b|(?:\((?:[^()]|\([^()]*\))*\)|[a-zA-Z_$][\w$]*)\s*=>)/;

// The token type of each character of a line. Monaco merges neighbors of the same type, so a change of type can
// move token boundaries; characters keep their place.
function charTypes(line) {
  return line.flatMap(token => [...token.text].map(() => token.type));
}

// The changes that the copies make, as [new type, old type]: a call becomes a function, an operator character
// (a delimiter, an untyped symbol or TypeScript's `@`) becomes an operator, true and false become booleans, and
// C# punctuation such as `?` and `:` becomes a delimiter.
const ALLOWED_CHANGES = [
  [/^function\./, /^(?:identifier|keyword|type\.identifier)(?:\.|$)/],
  [/^operator\./, /^(?:delimiter(?:\.|$)|invalid\.|$)/],
  [/^boolean\./, /^keyword\./],
  [/^delimiter\./, /^(?:delimiter\.|$)/]
];

// Monaco's own grammars on the left, the bridge's copies on the right: only a call changes, from an identifier,
// a keyword or a type name to function, and every token keeps its offset.
test('every other token is the same as in Monaco\'s own grammar', async t => {
  const page = await loadRealMonaco({ bridge: 'none' });
  t.after(() => page.close());
  const { monaco } = page;
  const scripts = ['monaco_bridge.js', 'content_script.js'].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  const scriptSample = [TYPESCRIPT_SAMPLE, ...SCRIPT_CALLS, ...SCRIPT_OPERATORS, ...TYPESCRIPT_OPERATORS, scripts].join('\n');
  const samples = {
    typescript: scriptSample,
    javascript: scriptSample,
    csharp: [CSHARP_SAMPLE, ...CSHARP_CALLS, ...CSHARP_OPERATORS, ...CSHARP_EDGES].join('\n')
  };
  await waitFor(() => LANGUAGES.every(language => hasGrammar(monaco, language)), 'Monaco\'s own grammars');
  const before = Object.fromEntries(LANGUAGES.map(language => [language, tokenize(monaco, samples[language], language)]));

  page.startBridge();
  await waitForCallTokens(monaco);

  for (const language of LANGUAGES) {
    const after = tokenize(monaco, samples[language], language);
    const lines = samples[language].split('\n');
    const changes = { function: 0, operator: 0, boolean: 0 };
    after.forEach((line, index) => {
      const oldTypes = charTypes(before[language][index]);
      assert.equal(charTypes(line).length, oldTypes.length, `${language} line ${index + 1}: ${lines[index]}`);
      let offset = 0;
      for (const token of line) {
        const end = offset + token.text.length;
        for (let char = offset; char < end; char++) {
          if (token.type === oldTypes[char]) continue;
          const where = `${language} line ${index + 1}, "${token.text}" was ${oldTypes[char]}: ${lines[index]}`;
          const change = ALLOWED_CHANGES.find(([next, previous]) => next.test(token.type) && previous.test(oldTypes[char]));
          assert.ok(change, `${where} is now ${token.type}`);
          if (change[0] === ALLOWED_CHANGES[0][0]) {
            const rest = lines[index].slice(end);
            assert.ok(CALL_FOLLOWS.test(rest) || FUNCTION_VALUE_FOLLOWS.test(rest), `${where}: no call or function value follows`);
          }
          const kind = token.type.split('.')[0];
          if (kind in changes) changes[kind]++;
        }
        offset = end;
      }
    });
    for (const [kind, count] of Object.entries(changes)) assert.ok(count >= 5, `${language}: ${count} ${kind} characters`);
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
  const page = await loadRealMonaco({ bridge: 'none' });
  t.after(() => page.close());
  const { monaco, window } = page;
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const model = monaco.editor.createModel('const t = formatDollars(x)', 'typescript');
  monaco.editor.create(host, { model });
  await waitFor(() => hasGrammar(monaco, 'typescript'), 'ADO\'s TypeScript grammar');
  // Tokenizes the model with ADO's grammar, so the model holds ADO's tokens when the copy registers.
  monaco.editor.colorizeModelLine(model, 1);

  page.startBridge();
  const functionColor = { function: { foreground: '#654321', fontStyle: '' } };
  page.sendTheme({ vs: functionColor, 'vs-dark': functionColor });
  monaco.editor.setTheme('vs');
  await waitForCallTokens(monaco, ['typescript']);
  await settle(window);

  const pieces = coloredPieces(window, monaco.editor.colorizeModelLine(model, 1));
  assert.equal(pieces.find(piece => piece.text === 'formatDollars')?.color, '#654321', JSON.stringify(pieces));
});

test('a TypeScript model opened after the bridge starts gets function tokens', async t => {
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

// The first use here has no model, as when the file that used a language is closed. Monaco reports a language's
// first use once, so a late start must register the copy of every registered language at once.
test('a bridge that starts after the first use replaces ADO\'s loaded grammars, with no model left', async t => {
  const page = await loadRealMonaco({ bridge: 'none' });
  t.after(() => page.close());
  const { monaco } = page;
  await waitFor(() => LANGUAGES.every(language => hasGrammar(monaco, language)), 'ADO\'s grammars');
  for (const language of LANGUAGES) assert.equal(hasCallTokens(monaco, language), false, language);

  page.startBridge();

  await waitForCallTokens(monaco);
});

test('after a late start, a .vue model opened later embeds the TypeScript copy that was used before with no model', async t => {
  const page = await loadRealMonaco({ bridge: 'none' });
  t.after(() => page.close());
  const { monaco, window } = page;
  await waitFor(() => hasGrammar(monaco, 'typescript'), 'ADO\'s TypeScript grammar');

  page.startBridge();
  await settle(window);
  const model = monaco.editor.createModel('<script setup lang="ts">\nconst v = formatDollars(1)\n</script>', 'vue');

  await waitFor(() => tokenizeLines(monaco, model.getLinesContent())[1].some(token => token.type === 'function.ts'), 'function tokens in the vue script');
  assert.equal(typeOf(tokenizeLines(monaco, model.getLinesContent())[1], 'formatDollars'), 'function.ts');
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

test('an onLanguage that throws for one language leaves the others their copies', async t => {
  const page = await loadRealMonaco({ bridge: 'none' });
  t.after(() => page.close());
  const { monaco, window } = page;
  // The three languages look unregistered, as to a bridge that starts before Monaco's contributions.
  const getLanguages = monaco.languages.getLanguages;
  monaco.languages.getLanguages = () => getLanguages().filter(language => !LANGUAGES.includes(language.id));
  const onLanguage = monaco.languages.onLanguage;
  monaco.languages.onLanguage = (languageId, callback) => {
    if (languageId === 'typescript') throw new Error('rejected');
    return onLanguage(languageId, callback);
  };

  assert.doesNotThrow(() => page.startBridge());
  LANGUAGES.forEach(language => hasCallTokens(monaco, language));
  await waitForCallTokens(monaco, ['javascript', 'csharp']);
  await settle(window);

  assert.equal(hasCallTokens(monaco, 'typescript'), false);
});

test('a colorize that rejects, as when ADO\'s grammar fails to load, registers no copy', async t => {
  const page = await loadRealMonaco({ bridge: 'none' });
  t.after(() => page.close());
  const { monaco, window } = page;
  await waitFor(() => LANGUAGES.every(language => hasGrammar(monaco, language)), 'ADO\'s grammars');
  monaco.editor.colorize = () => Promise.reject(new Error('load failed'));

  page.startBridge();
  await settle(window);

  for (const language of LANGUAGES) assert.equal(hasCallTokens(monaco, language), false, language);
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

test('operator and boolean tokens render in the Prism operator and boolean colors in both bases', async t => {
  const page = await loadRealMonaco();
  t.after(() => page.close());
  const { monaco, window } = page;
  const style = foreground => ({ foreground, fontStyle: '' });
  page.sendTheme({
    vs: { operator: style('#111111'), boolean: style('#222222') },
    'vs-dark': { operator: style('#333333'), boolean: style('#444444') }
  });
  LANGUAGES.forEach(language => hasCallTokens(monaco, language));
  await waitForCallTokens(monaco);
  await waitForEmbeddedGrammars(monaco);
  const cases = [
    ['const t = a === true', 'typescript'],
    ['const t = a === true', 'javascript'],
    ['var t = a == true;', 'csharp'],
    ['<template>\n  <p>{{ a === true }}</p>\n</template>', 'vue']
  ];

  for (const [themeName, operator, boolean] of [['vs', '#111111', '#222222'], ['vs-dark', '#333333', '#444444']]) {
    monaco.editor.setTheme(themeName);
    for (const [text, language] of cases) {
      const pieces = await renderedColors(monaco, window, text, language);
      const where = `${themeName} ${language}: ${JSON.stringify(pieces)}`;
      assert.equal(pieces.find(piece => /^={2,3}$/.test(piece.text))?.color, operator, where);
      assert.equal(pieces.find(piece => piece.text === 'true')?.color, boolean, where);
    }
  }
});
