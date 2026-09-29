const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.join(__dirname, '..');
const vsUrl = pathToFileURL(path.join(root, 'node_modules', 'monaco-editor', 'min', 'vs')).href;

const THEME_EVENT = 'ado-syntax-highlighter:monaco-theme';
const THEME_REQUEST_EVENT = 'ado-syntax-highlighter:monaco-theme-request';
const VUE_PATH = '/frontend/src/components/queues/matchRequest/TopActionBar.vue';
const SINGLE_FILE_URL = `https://dev.azure.com/org/Project/_git/Repo/pullrequest/42?_a=files&path=${encodeURIComponent(VUE_PATH)}`;

function readBridge() {
  return fs.readFileSync(path.join(root, 'monaco_bridge.js'), 'utf8');
}

// ADO's single-file view: `.repos-changes-viewer > .vss-base-editor.<editorClass> > ...`. Returns the host.
function createViewerHost(document, editorClass) {
  const viewer = document.createElement('div');
  viewer.className = 'repos-changes-viewer';
  const host = document.createElement('div');
  host.className = `vss-base-editor ${editorClass}`;
  viewer.appendChild(host);
  document.body.appendChild(viewer);
  return host;
}

function createEmitter() {
  const listeners = [];
  const event = listener => {
    listeners.push(listener);
    return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) };
  };
  event.fire = value => listeners.slice().forEach(listener => listener(value));
  return event;
}

// A stand-in for ADO's Monaco 0.29 API surface. Models without a URI get "/1", "/2", ... as Monaco does.
// `remove` deletes functions by "editor.name" or "languages.name"; `throwing` makes them throw. Like ADO's build,
// defineTheme does not redraw; `activeTheme` is the theme class that every editor element carries.
function createFakeMonaco({ languages = ['plaintext', 'typescript', 'css', 'scss', 'html'], remove = [], throwing = [], activeTheme = 'vs' } = {}) {
  const onDidCreateEditor = createEmitter();
  const onDidCreateModel = createEmitter();
  const onDidChangeModelLanguage = createEmitter();
  const models = [];
  const languageIds = [...languages];
  const calls = { setModelLanguage: [], defineTheme: [], setTheme: [], register: [], setMonarchTokensProvider: [], themeOrder: [] };
  let nextModelId = 1;

  const monaco = {
    editor: {
      onDidCreateEditor,
      onDidCreateModel,
      onDidChangeModelLanguage,
      getModels: () => models.slice(),
      setModelLanguage(model, languageId) {
        calls.setModelLanguage.push({ model, languageId });
        const oldLanguage = model.language;
        model.language = languageId;
        onDidChangeModelLanguage.fire({ model, oldLanguage });
      },
      defineTheme(themeName, themeData) {
        calls.defineTheme.push({ themeName, themeData });
        calls.themeOrder.push(`defineTheme:${themeName}`);
      },
      setTheme(themeName) {
        calls.setTheme.push(themeName);
        calls.themeOrder.push(`setTheme:${themeName}`);
      }
    },
    languages: {
      register(language) {
        calls.register.push(language);
        languageIds.push(language.id);
      },
      getLanguages: () => languageIds.map(id => ({ id })),
      setMonarchTokensProvider(languageId, languageDef) {
        calls.setMonarchTokensProvider.push({ languageId, languageDef });
      }
    }
  };
  for (const name of remove) {
    const [namespace, member] = name.split('.');
    delete monaco[namespace][member];
  }
  for (const name of throwing) {
    const [namespace, member] = name.split('.');
    monaco[namespace][member] = () => {
      throw new Error(`${name} failed`);
    };
  }

  function createModel(uriPath = `/${nextModelId}`, language = 'plaintext') {
    nextModelId++;
    const model = {
      uri: { path: uriPath },
      language,
      editorCount: 0,
      getModeId: () => model.language,
      isAttachedToEditor: () => model.editorCount > 0
    };
    models.push(model);
    onDidCreateModel.fire(model);
    return model;
  }

  // Like Monaco, the editor puts its own `.monaco-editor` element inside the container it is given.
  function createEditor(container) {
    let model = null;
    const onDidChangeModel = createEmitter();
    const onDidDispose = createEmitter();
    const domNode = container.ownerDocument.createElement('div');
    domNode.className = `monaco-editor ${activeTheme}`;
    container.appendChild(domNode);
    const editor = {
      domNode,
      getModel: () => model,
      getContainerDomNode: () => container,
      onDidChangeModel,
      onDidDispose,
      setModel(next) {
        if (model) model.editorCount--;
        model = next;
        if (next) next.editorCount++;
        onDidChangeModel.fire({});
      },
      dispose() {
        editor.setModel(null);
        onDidDispose.fire();
      }
    };
    onDidCreateEditor.fire(editor);
    return editor;
  }

  // A changed file: two inner editors inside `.monaco-diff-editor`, as Monaco builds it.
  function createDiffEditor(document) {
    const element = document.createElement('div');
    element.className = 'monaco-diff-editor side-by-side';
    const originalNode = document.createElement('div');
    originalNode.className = 'editor original';
    const modifiedNode = document.createElement('div');
    modifiedNode.className = 'editor modified';
    element.append(originalNode, modifiedNode);
    createViewerHost(document, 'repos-diff-editor').appendChild(element);
    const original = createEditor(originalNode);
    const modified = createEditor(modifiedNode);
    return {
      original,
      modified,
      setModel(pair) {
        original.setModel(pair.original);
        modified.setModel(pair.modified);
      }
    };
  }

  // An added file: one plain editor, not a diff editor.
  function createFileEditor(document) {
    const container = document.createElement('div');
    createViewerHost(document, 'repos-file-editor').appendChild(container);
    return createEditor(container);
  }

  // A Monaco widget with its own editor, such as the rename box, inside another editor's element.
  function createWidgetEditor(parentEditor) {
    const document = parentEditor.domNode.ownerDocument;
    const widgets = document.createElement('div');
    widgets.className = 'overflowingContentWidgets';
    const container = document.createElement('div');
    container.className = 'rename-box';
    widgets.appendChild(container);
    parentEditor.domNode.appendChild(widgets);
    return createEditor(container);
  }

  return { monaco, calls, createModel, createEditor, createDiffEditor, createFileEditor, createWidgetEditor };
}

// Loads monaco_bridge.js into a jsdom page. By default the bridge runs first and ADO assigns window.monaco
// later, as with a document_start script. `monacoFirst` gives the bridge a page where Monaco already exists,
// and `beforeBridge` builds that page's editors and models before the bridge runs.
function loadBridge({ url = SINGLE_FILE_URL, fake = createFakeMonaco(), monacoFirst = false, beforeBridge } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const { window } = dom;
  const themeRequests = [];
  window.document.addEventListener(THEME_REQUEST_EVENT, () => themeRequests.push(true));
  if (monacoFirst) window.monaco = fake.monaco;
  beforeBridge?.({ window, fake });
  window.eval(readBridge());
  return {
    dom,
    window,
    fake,
    themeRequests,
    assignMonaco: () => {
      window.monaco = fake.monaco;
    },
    sendTheme: detail => window.document.dispatchEvent(new window.CustomEvent(THEME_EVENT, {
      detail: typeof detail === 'string' ? detail : JSON.stringify(detail)
    })),
    tick: () => new Promise(resolve => window.setTimeout(resolve, 0))
  };
}

function vueLanguageCalls(fake) {
  return fake.calls.setModelLanguage.filter(call => call.languageId === 'vue');
}

// Loads the real monaco-editor 0.29 AMD build into jsdom. `bridge: 'before'` evaluates monaco_bridge.js before
// Monaco loads; `bridge: 'none'` leaves it to the test, through `startBridge()`.
async function loadRealMonaco({ url = SINGLE_FILE_URL, bridge = 'before' } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(`<!doctype html><html><head></head><body><script src="${vsUrl}/loader.js"></script></body></html>`, {
    url,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.document.queryCommandSupported = () => false;
      window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      const context = new Proxy({}, { get: (target, name) => (name in target ? target[name] : () => ({ width: 0 })) });
      window.HTMLCanvasElement.prototype.getContext = () => context;
      if (bridge === 'before') window.eval(readBridge());
    }
  });
  const { window } = dom;
  await waitFor(() => typeof window.require === 'function', 'the AMD loader', errors);
  await new Promise((resolve, reject) => {
    window.require.config({ paths: { vs: vsUrl } });
    window.require(['vs/editor/editor.main'], resolve, reject);
  });
  return {
    dom,
    window,
    monaco: window.monaco,
    startBridge: () => window.eval(readBridge()),
    sendTheme: payload => window.document.dispatchEvent(new window.CustomEvent(THEME_EVENT, { detail: JSON.stringify(payload) })),
    close: () => window.close()
  };
}

const WAIT_TIMEOUT_MS = 5000;

async function waitFor(check, what, errors = []) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > WAIT_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for ${what}. Page errors: ${errors.join(' | ')}`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

module.exports = {
  THEME_EVENT,
  THEME_REQUEST_EVENT,
  VUE_PATH,
  SINGLE_FILE_URL,
  readBridge,
  createViewerHost,
  createFakeMonaco,
  loadBridge,
  vueLanguageCalls,
  loadRealMonaco,
  waitFor
};
