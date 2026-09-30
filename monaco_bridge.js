// Runs in the page's main world, where ADO's Monaco lives. The single-file view of a pull request is a Monaco
// editor, so it is colored through Monaco itself: .vue files get a Vue language, TypeScript, JavaScript and C#
// get Monaco's own grammars with function, operator and boolean tokens, and the built-in vs and vs-dark themes
// get the token colors of the chosen Prism theme, sent by content_script.js.
// Anything missing or throwing leaves ADO's own rendering in place.
(() => {
  const BRIDGE_FLAG = '__adoSyntaxHighlighterMonacoBridge';
  if (window[BRIDGE_FLAG]) return;
  Object.defineProperty(window, BRIDGE_FLAG, { value: true });

  const THEME_EVENT = 'ado-syntax-highlighter:monaco-theme';
  const THEME_REQUEST_EVENT = 'ado-syntax-highlighter:monaco-theme-request';
  const THEME_NAMES = ['vs', 'vs-dark'];
  const ACTIVE_THEME_NAMES = ['vs', 'vs-dark', 'hc-black'];
  const FONT_STYLES = ['', 'italic', 'bold', 'italic bold'];
  // ADO can reset a model's language. The bridge sets vue at most this many times per model, then ADO keeps its choice.
  const MAX_LANGUAGE_APPLIES = 3;

  // Prism token type -> Monaco token types. A theme rule matches by the longest token prefix, so the more
  // specific rules of the built-in themes are listed too, or they would keep their own colors.
  const MONACO_TOKENS = {
    comment: ['comment'],
    keyword: ['keyword', 'keyword.flow'],
    // `boolean` is the true and false token of the bridge's typescript, javascript and csharp grammars.
    boolean: ['keyword.json', 'boolean'],
    string: ['string', 'string.html', 'string.sql', 'string.yaml', 'string.value.json'],
    property: ['key', 'string.key.json', 'attribute.name.css', 'attribute.name.scss'],
    number: ['number', 'number.hex'],
    regex: ['regexp'],
    'class-name': ['type', 'type.identifier'],
    tag: ['tag'],
    selector: ['tag.css', 'tag.scss'],
    'attr-name': ['attribute.name'],
    'attr-value': ['attribute.value', 'attribute.value.html', 'attribute.value.xml',
      'attribute.value.number', 'attribute.value.unit', 'attribute.value.number.css', 'attribute.value.unit.css', 'attribute.value.hex.css'],
    punctuation: ['delimiter', 'delimiter.html', 'delimiter.xml', 'annotation'],
    operator: ['operator', 'operator.scss', 'operator.sql', 'operator.swift'],
    atrule: ['keyword.css', 'keyword.scss', 'keyword.flow.scss'],
    variable: ['variable', 'variable.predefined', 'variable.parameter'],
    constant: ['constant'],
    namespace: ['namespace'],
    doctype: ['metatag', 'metatag.html', 'metatag.xml', 'metatag.content.html'],
    // `function` is the call token of the bridge's typescript, javascript and csharp grammars. Monaco's scss
    // grammar gives a function call such as `darken(` one meta token, and sql its built-ins predefined.
    function: ['function', 'meta.scss', 'predefined.sql']
  };

  const attributeRules = [
    [/"/, 'attribute.value', '@doubleQuoted'],
    [/'/, 'attribute.value', '@singleQuoted'],
    [/[^\s"'<>/=]+/, 'attribute.name'],
    [/=/, 'delimiter'],
    [/[ \t\r\n]+/, '']
  ];

  // Inside the template, a directive (v-..., :x, @x, #x) has a TypeScript value.
  const templateAttributeRules = [
    [/(?:v-|[:@#])[^\s"'<>/=]*/, 'attribute.name', '@directive'],
    ...attributeRules
  ];

  // Top-level blocks: <script> embeds TypeScript, <style> embeds CSS or, with lang="scss", SCSS. The template
  // is tokenized here rather than embedded as html: an embedded block ends at the first matching closing tag
  // on a line, so an embedded template would end at the first nested </template>. Each open <template> pushes
  // one state and each </template> pops one.
  const vueLanguage = {
    defaultToken: '',
    tokenPostfix: '.vue',
    tokenizer: {
      root: [
        [/<!--/, 'comment', '@comment'],
        [/(<)(template)(?![\w-])/, ['delimiter', { token: 'tag', next: '@templateTag' }]],
        [/(<)(script)(?![\w-])/, ['delimiter', { token: 'tag', next: '@scriptTag' }]],
        [/(<)(style)(?![\w-])/, ['delimiter', { token: 'tag', next: '@styleTag.css' }]],
        [/(<\/?)([\w\-.:]+)/, ['delimiter', { token: 'tag', next: '@tag' }]],
        [/</, 'delimiter'],
        [/[^<]+/, '']
      ],
      comment: [
        [/-->/, 'comment', '@pop'],
        [/[^-]+/, 'comment.content'],
        [/./, 'comment.content']
      ],
      tag: [
        [/\/?>/, 'delimiter', '@pop'],
        { include: '@attributes' }
      ],
      closingTag: [
        [/>/, 'delimiter', '@pop'],
        [/[^>]+/, '']
      ],
      attributes: attributeRules,
      doubleQuoted: [
        [/[^"]+/, 'attribute.value'],
        [/"/, 'attribute.value', '@pop']
      ],
      singleQuoted: [
        [/[^']+/, 'attribute.value'],
        [/'/, 'attribute.value', '@pop']
      ],
      templateTag: [
        [/\/>/, 'delimiter', '@pop'],
        [/>/, { token: 'delimiter', switchTo: '@template' }],
        ...templateAttributeRules
      ],
      template: [
        [/<!--/, 'comment', '@comment'],
        [/(<)(template)(?![\w-])/, ['delimiter', { token: 'tag', next: '@templateTag' }]],
        [/(<\/)(template)(?![\w-])/, ['delimiter', { token: 'tag', switchTo: '@closingTag' }]],
        [/(<\/?)([\w\-.:]+)/, ['delimiter', { token: 'tag', next: '@templateElement' }]],
        [/</, 'delimiter'],
        [/\{\{/, { token: 'delimiter', next: '@interpolation', nextEmbedded: 'typescript' }],
        [/[^<{]+/, ''],
        [/\{/, '']
      ],
      templateElement: [
        [/\/?>/, 'delimiter', '@pop'],
        ...templateAttributeRules
      ],
      // An embedded block ends at the first match of its pop rule on a line, as Vue ends at the first }} or quote.
      interpolation: [
        [/\}\}/, { token: 'delimiter', next: '@pop', nextEmbedded: '@pop' }]
      ],
      directive: [
        [/=/, 'delimiter'],
        [/[ \t\r\n]+/, ''],
        [/"/, { token: 'attribute.value', switchTo: '@directiveDoubleQuoted', nextEmbedded: 'typescript' }],
        [/'/, { token: 'attribute.value', switchTo: '@directiveSingleQuoted', nextEmbedded: 'typescript' }],
        [/./, { token: '@rematch', next: '@pop' }]
      ],
      directiveDoubleQuoted: [
        [/"/, { token: 'attribute.value', next: '@pop', nextEmbedded: '@pop' }]
      ],
      directiveSingleQuoted: [
        [/'/, { token: 'attribute.value', next: '@pop', nextEmbedded: '@pop' }]
      ],
      scriptTag: [
        [/\/>/, 'delimiter', '@pop'],
        [/>/, { token: 'delimiter', next: '@scriptBody', nextEmbedded: 'typescript' }],
        [/(<\/)(script)(?![\w-])/, ['delimiter', { token: 'tag', switchTo: '@closingTag' }]],
        { include: '@attributes' }
      ],
      scriptBody: [
        [/<\/script(?![\w-])/, { token: '@rematch', next: '@pop', nextEmbedded: '@pop' }],
        [/[^<]+/, '']
      ],
      // The state name carries the embedded language: styleTag.css or styleTag.scss.
      styleTag: [
        [/\/>/, 'delimiter', '@pop'],
        [/(lang)(\s*)(=)(\s*)("scss"|'scss'|scss(?![\w-]))/, ['attribute.name', '', 'delimiter', '', { token: 'attribute.value', switchTo: '@styleTag.scss' }]],
        [/>/, { token: 'delimiter', next: '@styleBody', nextEmbedded: '$S2' }],
        [/(<\/)(style)(?![\w-])/, ['delimiter', { token: 'tag', switchTo: '@closingTag' }]],
        { include: '@attributes' }
      ],
      styleBody: [
        [/<\/style(?![\w-])/, { token: '@rematch', next: '@pop', nextEmbedded: '@pop' }],
        [/[^<]+/, '']
      ]
    }
  };

  /*
   * The typescript, javascript and csharp grammars below are copied from monaco-editor 0.29.1
   * (esm/vs/basic-languages). The only change is the parts marked "Added": a call, an operator and true or false
   * get the function, operator and boolean tokens, where Prism's grammar of the same language gives those types.
   * The patterns and word lists of the Added parts are
   * taken from the bundled Prism 1.30.0 (prism/prism.js), under the same MIT license.
   *
   * Copyright (c) 2016 - present Microsoft Corporation
   * Prism: Copyright (c) 2012 Lea Verou
   *
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   *
   * The above copyright notice and this permission notice shall be included in all
   * copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   * SOFTWARE.
   */

  // Added. The call rules of the typescript and javascript copies follow Prism's typescript and javascript
  // grammars. A name is a call before `(`, and in TypeScript also before `<...>(`, `.call(`, `.apply(` or
  // `.bind(`. It is not a call where Prism shows a keyword, a constant (capitals only) or, in JavaScript, a
  // built-in class. After `.` fewer names are keywords, and after `new`, `class` and the like a name is a class.
  // A name that is not a call keeps the token of Monaco's own grammar, except that true and false are booleans.
  // The same rules make `...`, `?.` and TypeScript's decorator `@` operators, as in Prism.
  const SCRIPT_NAME_TOKEN = {
    cases: { '~[A-Z].*': 'type.identifier', '~false|true': 'boolean', '@keywords': 'keyword', '@default': 'identifier' }
  };

  function scriptCallRules({ classKeywords, typescript = false, classNames = null }) {
    const call = typescript ? '(?=\\s*(?:<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>\\s*|\\.\\s*(?:apply|bind|call)\\s*)?\\()' : '(?=\\s*\\()';
    const callToken = keywordList => ({
      cases: {
        [`@${keywordList}`]: SCRIPT_NAME_TOKEN,
        ...(classNames ? { [`~${classNames}`]: SCRIPT_NAME_TOKEN } : {}),
        '~[A-Z](?:[A-Z_]|\\dx?)*': SCRIPT_NAME_TOKEN,
        '@default': 'function'
      }
    });
    const keywordToken = { cases: { '@keywords': 'keyword', '@default': 'identifier' } };
    return [
      [/\.\.\./, 'operator'],
      ...(typescript ? [[/@(?=[\w$])/, 'operator']] : []),
      [new RegExp(`(?:${classKeywords})(?=[ \\t]*$)`), {
        cases: { '@keywords': { token: 'keyword', next: '@classNameAfterBreak' }, '@default': { token: 'identifier', next: '@classNameAfterBreak' } }
      }],
      typescript
        ? [new RegExp(`(${classKeywords})([ \\t]+)([a-zA-Z_$][\\w$]*)`), [keywordToken, '', SCRIPT_NAME_TOKEN]]
        : [new RegExp(`(${classKeywords})([ \\t]+)(?=[\\w$])`), [keywordToken, { token: '', next: '@className' }]],
      [new RegExp(`(\\?\\.|\\.)([ \\t]*)([a-zA-Z_$][\\w$]*)${call}`), [
        { cases: { '~\\?\\.': 'operator', '@default': 'delimiter' } }, '', callToken('memberCallKeywords')
      ]],
      [new RegExp(`[a-zA-Z_$][\\w$]*${call}`), callToken('callKeywords')],
      [/(?:false|true)(?![\w$])/, 'boolean'],
      // Prism highlights a .vue script block as a whole and sees a generic call that spans lines. Monaco reads one
      // line, so the Vue compiler macros, which are always calls, are calls before `<`.
      ...(typescript ? [[/(?:defineEmits|defineModel|defineOptions|defineProps|defineSlots)(?=\s*<)/, 'function']] : [])
    ];
  }

  // Added. The class name on a later line than `new`, `class` and the like, as Prism reads it across blank lines.
  function classNameAfterBreak(next) {
    const token = type => ({ token: type, ...next });
    return [
      [/^$/, ''],
      [/[ \t]+/, ''],
      [/[a-zA-Z_$][\w$]*/, { cases: { '~[A-Z].*': token('type.identifier'), '@keywords': token('keyword'), '@default': token('identifier') } }],
      ['', '', '@pop']
    ];
  }

  // The tokenizer that the typescript and javascript grammars share.
  const scriptTokenizer = {
    root: [[/[{}]/, 'delimiter.bracket'], { include: 'common' }],
    common: [
      [/[a-z_$][\w$]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
      [/[A-Z][\w\$]*/, 'type.identifier'],
      { include: '@whitespace' },
      [/\/(?=([^\\\/]|\\.)+\/([dgimsuy]*)(\s*)(\.|;|,|\)|\]|\}|$))/, { token: 'regexp', bracket: '@open', next: '@regexp' }],
      [/[()\[\]]/, '@brackets'],
      // Added: the next three rules give `operator`, where Prism does, in place of '@brackets', 'delimiter' and
      // the operator cases. `?.` is one operator, as in Prism.
      [/[<>](?!@symbols)/, 'operator'],
      [/!(?=([^=]|$))/, 'operator'],
      [/\?\./, 'operator'],
      [/@symbols/, 'operator'],
      [/(@digits)[eE]([\-+]?(@digits))?/, 'number.float'],
      [/(@digits)\.(@digits)([eE][\-+]?(@digits))?/, 'number.float'],
      [/0[xX](@hexdigits)n?/, 'number.hex'],
      [/0[oO]?(@octaldigits)n?/, 'number.octal'],
      [/0[bB](@binarydigits)n?/, 'number.binary'],
      [/(@digits)n?/, 'number'],
      [/[;,.]/, 'delimiter'],
      [/"([^"\\]|\\.)*$/, 'string.invalid'],
      [/'([^'\\]|\\.)*$/, 'string.invalid'],
      [/"/, 'string', '@string_double'],
      [/'/, 'string', '@string_single'],
      [/`/, 'string', '@string_backtick']
    ],
    whitespace: [
      [/[ \t\r\n]+/, ''],
      [/\/\*\*(?!\/)/, 'comment.doc', '@jsdoc'],
      [/\/\*/, 'comment', '@comment'],
      [/\/\/.*$/, 'comment']
    ],
    comment: [
      [/[^\/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[\/*]/, 'comment']
    ],
    jsdoc: [
      [/[^\/*]+/, 'comment.doc'],
      [/\*\//, 'comment.doc', '@pop'],
      [/[\/*]/, 'comment.doc']
    ],
    regexp: [
      [/(\{)(\d+(?:,\d*)?)(\})/, ['regexp.escape.control', 'regexp.escape.control', 'regexp.escape.control']],
      [/(\[)(\^?)(?=(?:[^\]\\\/]|\\.)+)/, ['regexp.escape.control', { token: 'regexp.escape.control', next: '@regexrange' }]],
      [/(\()(\?:|\?=|\?!)/, ['regexp.escape.control', 'regexp.escape.control']],
      [/[()]/, 'regexp.escape.control'],
      [/@regexpctl/, 'regexp.escape.control'],
      [/[^\\\/]/, 'regexp'],
      [/@regexpesc/, 'regexp.escape'],
      [/\\\./, 'regexp.invalid'],
      [/(\/)([dgimsuy]*)/, [{ token: 'regexp', bracket: '@close', next: '@pop' }, 'keyword.other']]
    ],
    regexrange: [
      [/-/, 'regexp.escape.control'],
      [/\^/, 'regexp.invalid'],
      [/@regexpesc/, 'regexp.escape'],
      [/[^\]]/, 'regexp'],
      [/\]/, { token: 'regexp.escape.control', next: '@pop', bracket: '@close' }]
    ],
    string_double: [
      [/[^\\"]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"/, 'string', '@pop']
    ],
    string_single: [
      [/[^\\']+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/'/, 'string', '@pop']
    ],
    string_backtick: [
      [/\$\{/, { token: 'delimiter.bracket', next: '@bracketCounting' }],
      [/[^\\`$]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/`/, 'string', '@pop']
    ],
    bracketCounting: [
      [/\{/, 'delimiter.bracket', '@bracketCounting'],
      [/\}/, 'delimiter.bracket', '@pop'],
      { include: 'common' }
    ]
  };

  const typescriptLanguage = {
    defaultToken: 'invalid',
    tokenPostfix: '.ts',
    keywords: [
      'abstract', 'any', 'as', 'asserts', 'bigint', 'boolean', 'break', 'case', 'catch', 'class', 'continue', 'const',
      'constructor', 'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
      'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'infer', 'instanceof',
      'interface', 'is', 'keyof', 'let', 'module', 'namespace', 'never', 'new', 'null', 'number', 'object', 'package',
      'private', 'protected', 'public', 'override', 'readonly', 'require', 'global', 'return', 'set', 'static',
      'string', 'super', 'switch', 'symbol', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'unique',
      'unknown', 'var', 'void', 'while', 'with', 'yield', 'async', 'await', 'of'
    ],
    operators: [
      '<=', '>=', '==', '!=', '===', '!==', '=>', '+', '-', '**', '*', '/', '%', '++', '--', '<<', '</', '>>', '>>>',
      '&', '|', '^', '!', '~', '&&', '||', '??', '?', ':', '=', '+=', '-=', '*=', '**=', '/=', '%=', '<<=', '>>=',
      '>>>=', '&=', '|=', '^=', '@'
    ],
    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
    digits: /\d+(_+\d+)*/,
    octaldigits: /[0-7]+(_+[0-7]+)*/,
    binarydigits: /[0-1]+(_+[0-1]+)*/,
    hexdigits: /[[0-9a-fA-F]+(_+[0-9a-fA-F]+)*/,
    regexpctl: /[(){}\[\]\$\^|\-*+?\.]/,
    regexpesc: /\\(?:[bBdDfnrstvwWn0\\\/]|@regexpctl|c[A-Z]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/,
    // Added. The names that Prism's typescript grammar shows as keywords before `(`, and after `.`.
    callKeywords: [
      'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
      'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'for', 'function', 'if',
      'implements', 'import', 'in', 'instanceof', 'interface', 'is', 'keyof', 'let', 'new', 'null', 'of', 'package',
      'private', 'protected', 'public', 'readonly', 'require', 'return', 'static', 'super', 'switch', 'this', 'throw',
      'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield'
    ],
    memberCallKeywords: ['abstract', 'declare', 'false', 'is', 'keyof', 'readonly', 'require', 'true'],
    tokenizer: {
      ...scriptTokenizer,
      // Added.
      common: [
        ...scriptCallRules({ classKeywords: 'class|extends|implements|instanceof|interface|new|type', typescript: true }),
        ...scriptTokenizer.common
      ],
      // Added.
      classNameAfterBreak: classNameAfterBreak({ next: '@pop' })
    }
  };

  const javascriptLanguage = {
    ...typescriptLanguage,
    tokenPostfix: '.js',
    keywords: [
      'break', 'case', 'catch', 'class', 'continue', 'const', 'constructor', 'debugger', 'default', 'delete', 'do',
      'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'import', 'in',
      'instanceof', 'let', 'new', 'null', 'return', 'set', 'super', 'switch', 'symbol', 'this', 'throw', 'true', 'try',
      'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield', 'async', 'await', 'of'
    ],
    typeKeywords: [],
    // Added. The same for Prism's javascript grammar, which the bundled JS Extras plugin changes: more keywords
    // match after `.`, the built-in classes are class names, a dotted name after `new` is one class name, and a
    // method token such as `.call` takes the text that would make the name before it a call.
    callKeywords: [
      'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
      'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'implements',
      'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of', 'package', 'private', 'protected',
      'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var',
      'void', 'while', 'with', 'yield'
    ],
    memberCallKeywords: [
      'as', 'await', 'break', 'catch', 'continue', 'default', 'do', 'else', 'export', 'false', 'finally', 'for',
      'from', 'if', 'import', 'null', 'return', 'switch', 'throw', 'true', 'try', 'undefined', 'while', 'yield'
    ],
    tokenizer: {
      ...scriptTokenizer,
      // Added.
      common: [
        ...scriptCallRules({
          classKeywords: 'class|extends|implements|instanceof|interface|new',
          classNames: '(?:(?:Float(?:32|64)|(?:Int|Uint)(?:8|16|32)|Uint8Clamped)?Array|ArrayBuffer|BigInt|Boolean|DataView'
            + '|Date|Error|Function|Intl|JSON|(?:Weak)?(?:Map|Set)|Math|Number|Object|Promise|Proxy|Reflect|RegExp|String'
            + '|Symbol|WebAssembly|[A-Z]\\w*Error)'
        }),
        ...scriptTokenizer.common
      ],
      // Added.
      className: [
        [/[a-zA-Z_$][\w$]*/, SCRIPT_NAME_TOKEN],
        [/\./, 'delimiter'],
        ['', '', '@pop']
      ],
      classNameAfterBreak: classNameAfterBreak({ switchTo: '@className' })
    }
  };

  const csharpIdentifierCases = {
    '@namespaceFollows': { token: 'keyword.$0', next: '@namespace' },
    '@keywords': { token: 'keyword.$0', next: '@qualified' }
  };

  // Added. An attribute starts at `[` before a name at the start of a line, after `(` or after `,`, as in Prism,
  // but not inside the hole of an interpolated string, whose closing brace must still end the hole.
  const CSHARP_ATTRIBUTE_START = {
    cases: {
      '$S2==interpolatedstring': 'delimiter.square',
      '$S2==litinterpstring': 'delimiter.square',
      '@default': { token: 'delimiter.square', next: '@attribute' }
    }
  };

  const csharpLanguage = {
    defaultToken: '',
    tokenPostfix: '.cs',
    brackets: [
      { open: '{', close: '}', token: 'delimiter.curly' },
      { open: '[', close: ']', token: 'delimiter.square' },
      { open: '(', close: ')', token: 'delimiter.parenthesis' },
      { open: '<', close: '>', token: 'delimiter.angle' }
    ],
    keywords: [
      'extern', 'alias', 'using', 'bool', 'decimal', 'sbyte', 'byte', 'short', 'ushort', 'int', 'uint', 'long', 'ulong',
      'char', 'float', 'double', 'object', 'dynamic', 'string', 'assembly', 'is', 'as', 'ref', 'out', 'this', 'base',
      'new', 'typeof', 'void', 'checked', 'unchecked', 'default', 'delegate', 'var', 'const', 'if', 'else', 'switch',
      'case', 'while', 'do', 'for', 'foreach', 'in', 'break', 'continue', 'goto', 'return', 'throw', 'try', 'catch',
      'finally', 'lock', 'yield', 'from', 'let', 'where', 'join', 'on', 'equals', 'into', 'orderby', 'ascending',
      'descending', 'select', 'group', 'by', 'namespace', 'partial', 'class', 'field', 'event', 'method', 'param',
      'public', 'protected', 'internal', 'private', 'abstract', 'sealed', 'static', 'struct', 'readonly', 'volatile',
      'virtual', 'override', 'params', 'get', 'set', 'add', 'remove', 'operator', 'true', 'false', 'implicit',
      'explicit', 'interface', 'enum', 'null', 'async', 'await', 'fixed', 'sizeof', 'stackalloc', 'unsafe', 'nameof',
      'when'
    ],
    namespaceFollows: ['namespace', 'using'],
    parenFollows: ['if', 'for', 'while', 'switch', 'foreach', 'using', 'catch', 'when'],
    operators: [
      '=', '??', '||', '&&', '|', '^', '&', '==', '!=', '<=', '>=', '<<', '+', '-', '*', '/', '%', '!', '~', '++', '--',
      '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>', '=>'
    ],
    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
    // Added. The call rules follow Prism's csharp grammar: a name right before `(`, or before `<...>(`, is a call,
    // except the names Prism shows as keywords there. An attribute name, a declared type name (record Dto( or a
    // primary constructor) and the type after `new` are class names, not calls.
    callKeywords: [
      'abstract', 'add', 'alias', 'and', 'as', 'ascending', 'async', 'await', 'base', 'bool', 'break', 'by', 'byte',
      'case', 'catch', 'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'descending',
      'do', 'double', 'dynamic', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float',
      'for', 'foreach', 'get', 'global', 'goto', 'group', 'if', 'implicit', 'in', 'int', 'interface', 'internal',
      'into', 'is', 'join', 'let', 'lock', 'long', 'nameof', 'namespace', 'new', 'not', 'notnull', 'null', 'object',
      'on', 'operator', 'or', 'orderby', 'out', 'override', 'params', 'partial', 'private', 'protected', 'public',
      'readonly', 'record', 'ref', 'remove', 'return', 'sbyte', 'sealed', 'select', 'set', 'short', 'sizeof',
      'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong',
      'unchecked', 'unmanaged', 'unsafe', 'ushort', 'using', 'value', 'var', 'virtual', 'void', 'volatile', 'when',
      'where', 'while', 'yield'
    ],
    generic: /<(?:[^<>;=+\-*\/%&|^]|<(?:[^<>;=+\-*\/%&|^]|<[^<>;=+\-*\/%&|^]*>)*>)*>/,
    // The first attribute after `[`, as Prism reads one: an optional target, a name, optional generic arguments and
    // arguments, then `,` or `]` on the same line.
    attributeHead: /[ \t]*(?:[a-z]+[ \t]*:[ \t]*)?@?[a-zA-Z_][\w.]*(?:[ \t]*@generic)?[ \t]*(?:\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?[ \t]*[,\]]/,
    tokenizer: {
      root: [
        // Added.
        [/\.\./, 'operator'],
        [/^([ \t]*)(\[)(?=@attributeHead)/, ['', CSHARP_ATTRIBUTE_START]],
        [/(\()([ \t]*)(\[)(?=@attributeHead)/, ['delimiter.parenthesis', '', CSHARP_ATTRIBUTE_START]],
        [/(,)([ \t]*)(\[)(?=@attributeHead)/, ['delimiter', '', CSHARP_ATTRIBUTE_START]],
        [/(class|enum|interface|record|struct)([ \t\v\f\r\n]+)(\@?[a-zA-Z_]\w*)/, [
          { cases: { '@keywords': { token: 'keyword.$1' }, '@default': 'identifier' } },
          '',
          { cases: { '@keywords': { token: 'keyword.$3', next: '@qualified' }, '@default': { token: 'identifier', next: '@qualified' } } }
        ]],
        [/\@?[a-zA-Z_]\w*(?=\(|\s*@generic\s*\()/, {
          cases: {
            '@namespaceFollows': csharpIdentifierCases['@namespaceFollows'],
            '@callKeywords': { cases: { ...csharpIdentifierCases, '@default': { token: 'identifier', next: '@qualified' } } },
            '@default': { token: 'function', next: '@qualified' }
          }
        }],
        // Added: the `new` case and the boolean case.
        [/\@?[a-zA-Z_]\w*/, {
          cases: {
            new: { token: 'keyword.$0', next: '@constructed' },
            '~false|true': { token: 'boolean', next: '@qualified' },
            ...csharpIdentifierCases,
            '@default': { token: 'identifier', next: '@qualified' }
          }
        }],
        { include: '@whitespace' },
        [/}/, {
          cases: {
            '$S2==interpolatedstring': { token: 'string.quote', next: '@pop' },
            '$S2==litinterpstring': { token: 'string.quote', next: '@pop' },
            '@default': '@brackets'
          }
        }],
        [/[{}()\[\]]/, '@brackets'],
        // Added: the next four rules take Prism's types in place of '@brackets' and the operator cases: `?`, `:`
        // and `::` are punctuation, `??` and every other symbol is an operator. The `<` and `>` of type arguments
        // are punctuation (see typeArguments).
        [/[<>](?!@symbols)/, 'operator'],
        [/\?\?=?/, 'operator'],
        [/::?|\?/, 'delimiter'],
        [/[=><!~&|+\-*\/\^%]+/, 'operator'],
        [/[0-9_]*\.[0-9_]+([eE][\-+]?\d+)?[fFdD]?/, 'number.float'],
        [/0[xX][0-9a-fA-F_]+/, 'number.hex'],
        [/0[bB][01_]+/, 'number.hex'],
        [/[0-9_]+/, 'number'],
        [/[;,.]/, 'delimiter'],
        [/"([^"\\]|\\.)*$/, 'string.invalid'],
        [/"/, { token: 'string.quote', next: '@string' }],
        [/\$\@"/, { token: 'string.quote', next: '@litinterpstring' }],
        [/\@"/, { token: 'string.quote', next: '@litstring' }],
        [/\$"/, { token: 'string.quote', next: '@interpolatedstring' }],
        [/'[^\\']'/, 'string'],
        [/(')(@escapes)(')/, ['string', 'string.escape', 'string']],
        [/'/, 'string.invalid']
      ],
      qualified: [
        // Added.
        [/[a-zA-Z_][\w]*(?=\(|\s*@generic\s*\()/, {
          cases: {
            '@callKeywords': { cases: { '@keywords': { token: 'keyword.$0' }, '@default': 'identifier' } },
            '@default': 'function'
          }
        }],
        [/[a-zA-Z_][\w]*/, { cases: { '@keywords': { token: 'keyword.$0' }, '@default': 'identifier' } }],
        // Added: a range `..` after a name, as in s[a..b], is an operator.
        [/\.\./, { token: 'operator', next: '@pop' }],
        [/\./, 'delimiter'],
        // Added.
        [/[ \t]+(?=@generic\s*\()/, ''],
        [/(?=@generic)</, { token: 'delimiter.angle', switchTo: '@typeArguments' }],
        ['', '', '@pop']
      ],
      // Added. The type arguments right after a name, such as <string, List<int>>, where Prism reads the angle
      // brackets as punctuation.
      typeArguments: [
        [/>/, { token: 'delimiter.angle', next: '@pop' }],
        { include: '@root' }
      ],
      // Added. The type after `new`, such as Foo or Foo.Bar in new Foo.Bar(.
      constructed: [
        [/[ \t\v\f\r\n]+/, ''],
        [/\@?[a-zA-Z_]\w*/, { cases: { '@keywords': { token: 'keyword.$0', switchTo: '@typeName' }, '@default': { token: 'identifier', switchTo: '@typeName' } } }],
        ['', '', '@pop']
      ],
      typeName: [
        [/[a-zA-Z_][\w]*/, { cases: { '@keywords': { token: 'keyword.$0' }, '@default': 'identifier' } }],
        [/\./, 'delimiter'],
        // Prism reads the type arguments after `new` as a type only before `(`, `[` or `{` on the same line.
        [/(?=@generic\s*[(\[{])</, { token: 'delimiter.angle', switchTo: '@typeArguments' }],
        ['', '', '@pop']
      ],
      // Added. The names of an attribute such as [HttpGet("{id}")]; its arguments are code. Prism reads a generic
      // name before `(`, as in [ProducesResponseType<Foo>(200)], as a call. The arguments end at a `)` that ends
      // the line or comes before `,` or `]`, so nested parentheses need no state of their own.
      attribute: [
        [/\@?[a-zA-Z_]\w*(?=\s*@generic\s*\()/, { token: 'function', next: '@qualified' }],
        [/\@?[a-zA-Z_]\w*/, { cases: { '@keywords': { token: 'keyword.$0' }, '@default': 'identifier' } }],
        [/\(/, { token: 'delimiter.parenthesis', next: '@attributeArguments' }],
        [/(\])([ \t]*)(\[)(?=@attributeHead)/, ['delimiter.square', '', 'delimiter.square']],
        [/\]/, { token: 'delimiter.square', next: '@pop' }],
        { include: '@root' }
      ],
      attributeArguments: [
        [/\)(?=[ \t]*(?:[,\]]|$))/, { token: 'delimiter.parenthesis', next: '@pop' }],
        { include: '@root' }
      ],
      namespace: [
        { include: '@whitespace' },
        [/[A-Z]\w*/, 'namespace'],
        // Added: `=` of a using alias is an operator, as in Prism; it was part of this 'delimiter' rule.
        [/=/, 'operator'],
        [/\./, 'delimiter'],
        ['', '', '@pop']
      ],
      comment: [
        [/[^\/*]+/, 'comment'],
        ['\\*/', 'comment', '@pop'],
        [/[\/*]/, 'comment']
      ],
      string: [
        [/[^\\"]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/"/, { token: 'string.quote', next: '@pop' }]
      ],
      litstring: [
        [/[^"]+/, 'string'],
        [/""/, 'string.escape'],
        [/"/, { token: 'string.quote', next: '@pop' }]
      ],
      litinterpstring: [
        [/[^"{]+/, 'string'],
        [/""/, 'string.escape'],
        [/{{/, 'string.escape'],
        [/}}/, 'string.escape'],
        [/{/, { token: 'string.quote', next: 'root.litinterpstring' }],
        [/"/, { token: 'string.quote', next: '@pop' }]
      ],
      interpolatedstring: [
        [/[^\\"{]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/{{/, 'string.escape'],
        [/}}/, 'string.escape'],
        [/{/, { token: 'string.quote', next: 'root.interpolatedstring' }],
        [/"/, { token: 'string.quote', next: '@pop' }]
      ],
      whitespace: [
        [/^[ \t\v\f]*#((r)|(load))(?=\s)/, 'directive.csx'],
        [/^[ \t\v\f]*#\w.*$/, 'namespace.cpp'],
        [/[ \t\v\f\r\n]+/, ''],
        [/\/\*/, 'comment', '@comment'],
        [/\/\/.*$/, 'comment']
      ]
    }
  };

  const CALL_GRAMMARS = { typescript: typescriptLanguage, javascript: javascriptLanguage, csharp: csharpLanguage };

  let monaco = null;
  let startedLate = false;
  let themePayload = null;
  let themeRedrawPending = false;
  const editors = new Set();
  const languageApplies = new WeakMap();

  function hasFunctions(object, names) {
    return !!object && names.every(name => typeof object[name] === 'function');
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  // Monaco calls listeners inside its own code, so an error here must not reach ADO.
  function guarded(callback) {
    return (...args) => {
      try {
        callback(...args);
      } catch (error) {
        console.debug('ADO Syntax Highlighter: Monaco bridge error:', error);
      }
    };
  }

  // Accepts only the exact shape that content_script.js sends, since any page script can send this event.
  function parseThemePayload(detail) {
    if (typeof detail !== 'string') return null;
    let payload;
    try {
      payload = JSON.parse(detail);
    } catch {
      return null;
    }
    if (!isPlainObject(payload)) return null;
    for (const [themeName, tokens] of Object.entries(payload)) {
      if (!THEME_NAMES.includes(themeName) || !isPlainObject(tokens)) return null;
      for (const [type, style] of Object.entries(tokens)) {
        if (!Object.hasOwn(MONACO_TOKENS, type) || !isPlainObject(style)) return null;
        const keys = Object.keys(style);
        if (keys.length !== 2 || !keys.includes('foreground') || !keys.includes('fontStyle')) return null;
        if (typeof style.foreground !== 'string' || !/^#[0-9a-f]{6}$/i.test(style.foreground)) return null;
        if (!FONT_STYLES.includes(style.fontStyle)) return null;
      }
    }
    return payload;
  }

  function buildThemeRules(tokens) {
    return Object.entries(tokens).flatMap(([type, style]) => MONACO_TOKENS[type].map(token => ({
      token,
      foreground: style.foreground.slice(1),
      fontStyle: style.fontStyle
    })));
  }

  // Monaco's theme is page-wide, and every editor element carries its name as a class. Null means no editor yet.
  function getActiveThemeName() {
    const editorElement = document.querySelector('.monaco-editor');
    if (!editorElement) return null;
    return ACTIVE_THEME_NAMES.find(name => editorElement.classList.contains(name)) || '';
  }

  // ADO's Monaco does not redraw the active theme after defineTheme, so it is set again under the name ADO chose.
  // With no editor on the page yet, the first editor that is created does it.
  function redrawActiveTheme() {
    const themeName = getActiveThemeName();
    themeRedrawPending = themeName === null;
    if (themeName && typeof monaco.editor.setTheme === 'function') {
      guarded(() => monaco.editor.setTheme(themeName))();
    }
  }

  // Redefining the built-in names keeps ADO's light or dark choice and its editor and diff colors.
  function applyTheme() {
    if (!monaco || !themePayload || typeof monaco.editor.defineTheme !== 'function') return;
    for (const themeName of THEME_NAMES) {
      const tokens = themePayload[themeName];
      if (!tokens) continue;
      guarded(() => monaco.editor.defineTheme(themeName, {
        base: themeName,
        inherit: true,
        rules: buildThemeRules(tokens),
        colors: {}
      }))();
    }
    redrawActiveTheme();
  }

  function getModelLanguage(model) {
    if (typeof model.getModeId === 'function') return model.getModeId();
    return typeof model.getLanguageId === 'function' ? model.getLanguageId() : null;
  }

  function getViewedFileName() {
    const filePath = new URLSearchParams(window.location.search).get('path');
    return filePath ? filePath.slice(filePath.lastIndexOf('/') + 1).toLowerCase() : null;
  }

  // The single-file view shows a diff editor for a changed file and a plain editor for an added one, both in
  // `.repos-changes-viewer`. Monaco widgets with their own editor, such as the rename box, sit inside another
  // editor's `.monaco-editor` element and are not the view.
  function isSingleFileViewEditor(editor) {
    const container = editor.getContainerDomNode();
    return !!container?.closest('.repos-changes-viewer') && !container.parentElement?.closest('.monaco-editor');
  }

  // Editors created before the bridge started are unknown. After a late start, a model attached to some
  // editor counts while the single-file view has an editor on the page.
  function isShownInSingleFileView(model) {
    let shownByKnownEditor = false;
    for (const editor of editors) {
      if (editor.getModel() !== model) continue;
      shownByKnownEditor = true;
      if (isSingleFileViewEditor(editor)) return true;
    }
    if (shownByKnownEditor) return false;
    return startedLate
      && typeof model.isAttachedToEditor === 'function'
      && model.isAttachedToEditor()
      && !!document.querySelector('.repos-changes-viewer .monaco-editor');
  }

  // The original side of the diff has no file name in its URI (for example "2"), so the file comes from the
  // page URL. A model whose URI names another file is not the one on screen.
  function isVueModelOnScreen(model) {
    const fileName = getViewedFileName();
    if (!fileName?.endsWith('.vue') || getModelLanguage(model) !== 'plaintext') return false;
    const uriName = (model.uri?.path || '').split('/').pop().toLowerCase();
    if (uriName.includes('.') && uriName !== fileName) return false;
    return isShownInSingleFileView(model);
  }

  function updateModel(model) {
    if (!model || !isVueModelOnScreen(model)) return;
    const applies = languageApplies.get(model) || 0;
    if (applies >= MAX_LANGUAGE_APPLIES) return;
    languageApplies.set(model, applies + 1);
    monaco.editor.setModelLanguage(model, 'vue');
  }

  function trackEditor(editor) {
    if (!hasFunctions(editor, ['getModel', 'getContainerDomNode', 'onDidChangeModel'])) return;
    editors.add(editor);
    editor.onDidChangeModel(guarded(() => updateModel(editor.getModel())));
    if (typeof editor.onDidDispose === 'function') {
      editor.onDidDispose(() => editors.delete(editor));
    }
    updateModel(editor.getModel());
  }

  function registerVueLanguage() {
    const { languages } = monaco;
    if (languages.getLanguages().some(language => language.id === 'vue')) return false;
    languages.register({ id: 'vue' });
    languages.setMonarchTokensProvider('vue', vueLanguage);
    return true;
  }

  function startVueLanguage() {
    const editorApi = monaco.editor;
    const needed = hasFunctions(editorApi, ['onDidCreateEditor', 'onDidCreateModel', 'onDidChangeModelLanguage', 'getModels', 'setModelLanguage'])
      && hasFunctions(monaco.languages, ['register', 'getLanguages', 'setMonarchTokensProvider']);
    if (!needed || !registerVueLanguage()) return;
    editorApi.onDidCreateEditor(guarded(trackEditor));
    // A new model is attached to its editor after it is created.
    editorApi.onDidCreateModel(guarded(model => setTimeout(guarded(() => updateModel(model)), 0)));
    editorApi.onDidChangeModelLanguage(guarded(event => updateModel(event?.model)));
    editorApi.getModels().forEach(guarded(updateModel));
  }

  // Monaco loads ADO's grammar for a language the first time the language is used, and that grammar then
  // replaces any grammar registered for it before. colorize() waits for a grammar that is still loading, so each
  // copy is registered after ADO's. When colorize() fails, ADO's grammar did not load, and no copy is registered.
  // A language that is not registered yet is handled on its first use. After a late start, a registered language
  // is handled at once: Monaco reports a first use only once, and it may have happened already.
  function startCallGrammars() {
    const { languages, editor } = monaco;
    if (!hasFunctions(languages, ['getLanguages', 'onLanguage', 'setMonarchTokensProvider']) || !hasFunctions(editor, ['colorize'])) return;
    for (const [languageId, grammar] of Object.entries(CALL_GRAMMARS)) {
      const register = guarded(() => languages.setMonarchTokensProvider(languageId, grammar));
      const registerAfterAdoGrammar = () => {
        Promise.resolve().then(() => editor.colorize('', languageId, {})).then(register, () => {});
      };
      if (languages.getLanguages().some(language => language.id === languageId)) {
        registerAfterAdoGrammar();
      } else {
        guarded(() => languages.onLanguage(languageId, guarded(registerAfterAdoGrammar)))();
      }
    }
  }

  function install(api) {
    if (monaco || !isPlainObject(api?.editor) || !isPlainObject(api?.languages)) return;
    monaco = api;
    if (typeof api.editor.onDidCreateEditor === 'function') {
      // The new editor's element is on the page one tick later.
      api.editor.onDidCreateEditor(guarded(() => setTimeout(guarded(() => {
        if (themeRedrawPending) redrawActiveTheme();
      }), 0)));
    }
    applyTheme();
    guarded(startCallGrammars)();
    guarded(startVueLanguage)();
  }

  // ADO assigns window.monaco when its editor bundle loads. A setter catches that moment, before ADO creates
  // any editor, because Monaco does not replay editor and model creation to later listeners.
  function watchForMonaco() {
    if (window.monaco) {
      startedLate = true;
      install(window.monaco);
      return;
    }
    let value = window.monaco;
    try {
      Object.defineProperty(window, 'monaco', {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: next => {
          value = next;
          guarded(install)(next);
        }
      });
    } catch (error) {
      console.debug('ADO Syntax Highlighter: cannot watch window.monaco:', error);
    }
  }

  document.addEventListener(THEME_EVENT, guarded(event => {
    const payload = parseThemePayload(event.detail);
    if (!payload) return;
    themePayload = payload;
    applyTheme();
  }));
  guarded(watchForMonaco)();
  document.dispatchEvent(new CustomEvent(THEME_REQUEST_EVENT));
})();
