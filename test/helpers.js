const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.join(__dirname, '..');
const prismSource = fs.readFileSync(path.join(root, 'prism', 'prism.js'), 'utf8');
const contentScriptSource = fs.readFileSync(path.join(root, 'content_script.js'), 'utf8');

const PR_URL = 'https://dev.azure.com/org/Project/_git/Repo/pullrequest/42?_a=files';

// Loads Prism and the content script into a jsdom window. The MutationObserver is stubbed
// so that tests call processFileDiff themselves and control the timing.
// `css` stands in for the injected Prism theme styles. `themeEvents` collects the parsed details sent to the
// Monaco bridge, and `changeStorage` fires a storage change as the options page would. `beforeContent` runs after
// Prism loads and before the content script, as a document_start script would.
async function loadExtension({ url = PR_URL, fetch, customFilePatterns = {}, themePreference = 'prism-one-light', css = '', beforeContent } = {}) {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body></body></html>`, {
    url,
    runScripts: 'outside-only',
    virtualConsole
  });
  const { window } = dom;
  window.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  const storageListeners = [];
  window.browser = {
    storage: {
      sync: { get: async () => ({ themePreference, customFilePatterns }) },
      onChanged: { addListener: listener => storageListeners.push(listener) }
    }
  };
  const themeEvents = [];
  window.document.addEventListener('ado-syntax-highlighter:monaco-theme', event => themeEvents.push(JSON.parse(event.detail)));
  window.fetch = fetch || (() => Promise.reject(new Error('unexpected fetch')));
  window.eval(prismSource);
  beforeContent?.({ window });
  window.eval(contentScriptSource);
  await new Promise(resolve => window.setTimeout(resolve, 0));
  const changeStorage = (changes, areaName = 'sync') => storageListeners.forEach(listener => listener(changes, areaName));

  const highlightCalls = [];
  const originalHighlight = window.Prism.highlightElement;
  window.Prism.highlightElement = function (element, async, callback) {
    highlightCalls.push({
      language: element.className.replace(/^language-/, ''),
      text: element.textContent
    });
    return originalHighlight.call(this, element, async, callback);
  };

  return { dom, window, highlightCalls, themeEvents, changeStorage };
}

function mount(window, html) {
  const container = window.document.createElement('div');
  container.innerHTML = html;
  window.document.body.appendChild(container);
  return container.querySelector('.repos-summary-header, .comment-file-header');
}

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function lineNumber(line) {
  if (line == null) {
    return '<div class="repos-line-number"></div>';
  }
  return `<div class="repos-line-number" data-line="${line}"><span class="screen-reader-only">Line ${line}</span>${line}</div>`;
}

// `html` replaces `code` when a row needs ADO's own spans, such as span.added-content.
function lineContent(type, code, html) {
  const label = { added: 'Added', removed: 'Removed', unchanged: 'Unchanged' }[type];
  return `<div class="repos-line-content ${type}"><span class="screen-reader-only">${label} line</span>${html ?? escapeHtml(code)}</div>`;
}

// Inline view: two number columns per row, old line first and new line second.
function inlineRow({ oldLine = null, newLine = null, type, code, html }) {
  return `<div class="repos-diff-contents-row monospaced-text">` +
    `<div class="flex-row secondary-text">${lineNumber(oldLine)}${lineNumber(newLine)}</div>` +
    `${lineContent(type, code, html)}</div>`;
}

// Side-by-side view: one number column per row.
function paneRow({ line = null, type, code }) {
  return `<div class="repos-diff-contents-row monospaced-text">` +
    `<div class="flex-row secondary-text">${lineNumber(line)}</div>` +
    `${lineContent(type, code)}</div>`;
}

// Added or deleted file: no splitter panes, and one number column per row, even in side-by-side mode.
// Markup taken from PR 9420, LeaveReasonDialog.vue.
function singleColumnRow({ line = null, type, code }) {
  return `<div class="repos-diff-contents-row monospaced-text">` +
    `<div class="repos-add-comment-widget"></div>` +
    `<div class="padding-horizontal-8 text-right secondary-text">${lineNumber(line)}</div>` +
    `<div class="repos-collapsed-comment"></div>` +
    `${lineContent(type, code)}</div>`;
}

function sideBySide({ oldRows, newRows }) {
  return `<div class="vss-Splitter--container">` +
    `<div class="vss-Splitter--pane-fixed">${oldRows.map(paneRow).join('')}</div>` +
    `<div class="vss-Splitter--divider"></div>` +
    `<div class="vss-Splitter--pane-flexible">${newRows.map(paneRow).join('')}</div>` +
    `</div>`;
}

// `encoding` and `renamedFrom` add the header rows of a file whose encoding changed or that was renamed.
// Markup taken from PR 9418, AbandonedAttemptsReport.vue.
function fileCard({ filePath, diff, encoding, renamedFrom }) {
  const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
  const encodingRow = encoding
    ? `<div class="flex flex-center body-s secondary-text text-ellipsis"><div class="text-ellipsis">${encoding}</div></div>`
    : '';
  const renamedRow = renamedFrom
    ? `<div class="body-s secondary-text flex-column margin-top-8"><div>Renamed from</div><div class="text-ellipsis">${renamedFrom}</div></div>`
    : '';
  return `<div class="repos-summary-header">` +
    `<div class="flex-row">` +
    `<div class="repos-change-summary-file-icon-container"><span class="fabric-icon"></span></div>` +
    `<div class="flex-column">` +
    `<div class="text-ellipsis">${fileName}</div>` +
    encodingRow +
    `<div class="body-s secondary-text text-ellipsis">${filePath}</div>` +
    renamedRow +
    `</div></div>` +
    `<div class="repos-summary-code-diff">${diff}</div>` +
    `</div>`;
}

// A comment-thread card on the Overview tab: one number column per row and no splitter panes.
// Markup taken from PR 9414, PlaybookItemsView.vue.
function commentRow({ line, type, code }) {
  return `<div class="repos-diff-contents-row monospaced-text" role="row">` +
    `<span role="cell" class="padding-horizontal-8 text-right secondary-text"><span class="screen-reader-only">${line} </span>` +
    `<span aria-hidden="true"><span class="repos-line-number" data-line="${line}"></span></span></span>` +
    `<span tabindex="-1" class="padding-right-8 repos-line-content ${type}" role="cell"><span class="screen-reader-only">Plus &nbsp;</span>` +
    `<span aria-hidden="true"><span class="line-icon ${type}"></span></span>${escapeHtml(code)}</span></div>`;
}

function commentCard({ filePath, rows }) {
  const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
  return `<div class="flex-row flex-grow no-padding bolt-card flex-column depth-8 bolt-card-white"><div class="bolt-card-content flex-row flex-grow">` +
    `<div class="flex-column flex-grow scroll-hidden"><div class="comment-file-header flex-column">` +
    `<div class="comment-file-header-title flex-row">` +
    `<div class="body-s secondary-text flex-self-center"><span class="repos-change-summary-file-icon fabric-icon ms-Icon--Page"></span></div>` +
    `<div class="flex-column flex-start flex-grow scroll-hidden">` +
    `<a class="comment-file-header-link body-m font-weight-semibold text-ellipsis bolt-link" href="/P/_git/R/pullrequest/42?_a=files&amp;path=${filePath}&amp;discussionId=1">${fileName}</a>` +
    `<span class="body-s secondary-text text-ellipsis flex-self-stretch">${filePath}</span></div></div>` +
    `<div class="comment-file-diff-container margin-top-16 flex-row"><div class="repos-summary-code-diff custom-scrollbar">` +
    `<div class="repos-summary-diff-container body-s"><div>${rows.map(commentRow).join('')}</div></div></div></div>` +
    `</div></div></div></div>`;
}

// Holds every request until `open()` runs, so a test can act while a fetch is in flight.
function gatedFetch(fetch) {
  let open;
  const gate = new Promise(resolve => {
    open = resolve;
  });
  return {
    fetch: async (url, options) => {
      await gate;
      return fetch(url, options);
    },
    open
  };
}

function response({ status = 200, contentType, body }) {
  return {
    status,
    headers: { get: name => (name.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => JSON.parse(body),
    text: async () => body
  };
}

function jsonResponse(data, status = 200) {
  return response({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(data) });
}

function textResponse(text, status = 200) {
  return response({ status, contentType: 'text/plain; charset=utf-8', body: text });
}

function iteration(id, source, common) {
  return {
    id,
    sourceRefCommit: { commitId: source },
    commonRefCommit: { commitId: common }
  };
}

// A fake ADO server. `files` maps "commit:path" to file text; a missing entry is a 404.
function createAdoServer({ iterations, files = {}, iterationsStatus = 200 }) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    if (parsed.pathname.endsWith('/iterations')) {
      return iterationsStatus === 200
        ? jsonResponse({ count: iterations.length, value: iterations })
        : jsonResponse({ message: 'error' }, iterationsStatus);
    }
    if (parsed.pathname.endsWith('/items')) {
      const key = `${parsed.searchParams.get('versionDescriptor.version')}:${parsed.searchParams.get('path')}`;
      return key in files ? textResponse(files[key]) : jsonResponse({ message: 'not found' }, 404);
    }
    return jsonResponse({ message: 'unknown' }, 404);
  };
  return { fetch, calls };
}

function highlightedClones(fileDiffElement) {
  return [...fileDiffElement.querySelectorAll('.repos-line-content.ado-syntax-highlighted')];
}

function texts(content, selector) {
  return [...content.querySelectorAll(selector)].map(element => element.textContent);
}

// The HTML that per-row highlighting gives, serialized the way the page serializes it.
function perRowHtml(window, text, language) {
  const grammar = window.Prism.languages[language];
  const element = window.document.createElement('div');
  element.innerHTML = grammar ? window.Prism.highlight(text, grammar, language) : window.Prism.util.encode(text);
  return element.innerHTML;
}

module.exports = {
  PR_URL,
  loadExtension,
  mount,
  inlineRow,
  singleColumnRow,
  sideBySide,
  fileCard,
  commentCard,
  commentRow,
  gatedFetch,
  jsonResponse,
  iteration,
  createAdoServer,
  highlightedClones,
  texts,
  perRowHtml
};
