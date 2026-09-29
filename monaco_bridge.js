// Runs in the page's main world, where ADO's Monaco lives. The single-file view of a pull request is a Monaco
// editor, so it is colored through Monaco itself: .vue files get a Vue language, and the built-in vs and
// vs-dark themes get the token colors of the chosen Prism theme, sent by content_script.js.
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
    boolean: ['keyword.json'],
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
    // Monaco's scss grammar gives a function call such as `darken(` one meta token, and sql its built-ins predefined.
    function: ['meta.scss', 'predefined.sql']
  };

  const attributeRules = [
    [/"/, 'attribute.value', '@doubleQuoted'],
    [/'/, 'attribute.value', '@singleQuoted'],
    [/[^\s"'<>/=]+/, 'attribute.name'],
    [/=/, 'delimiter'],
    [/[ \t\r\n]+/, '']
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
        { include: '@attributes' }
      ],
      template: [
        [/<!--/, 'comment', '@comment'],
        [/(<)(template)(?![\w-])/, ['delimiter', { token: 'tag', next: '@templateTag' }]],
        [/(<\/)(template)(?![\w-])/, ['delimiter', { token: 'tag', switchTo: '@closingTag' }]],
        [/(<\/?)([\w\-.:]+)/, ['delimiter', { token: 'tag', next: '@tag' }]],
        [/</, 'delimiter'],
        [/[^<]+/, '']
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
