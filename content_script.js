// Helper to map file extensions to Prism language aliases https://prismjs.com/#supported-languages
const defaultFilePatternToLanguage = {
  '*.csproj': 'markup',
  'directory.build.props': 'markup',
  'directory.build.targets': 'markup',
  'directory.packages.props': 'markup',
  'nuget.config': 'markup',
  '*.feature': 'gherkin',
  '*.(cls|trigger)': 'apex'
};

// Custom patterns loaded from storage (takes priority)
let customFilePatterns = {};
let themePreference = 'auto';

// Load custom patterns and theme preference from storage
async function loadSettings() {
  try {
    const result = await browser.storage.sync.get(['customFilePatterns', 'themePreference']);
    customFilePatterns = result.customFilePatterns || {};
    themePreference = result.themePreference || 'auto';
  } catch (error) {
    console.error('ADO Syntax Highlighter: Error loading settings:', error);
    customFilePatterns = {};
    themePreference = 'auto';
  }
}

function getLanguageFromFileName(fileName) {
  if (!fileName) return null;
  const lowerFileName = fileName.toLowerCase();

  for (const [pattern, value] of Object.entries(customFilePatterns)) {
    const regexPattern = pattern
      .replaceAll('.', String.raw`\.`)
      .replaceAll('*', '.*');
    const regex = new RegExp(`^${regexPattern}$`);

    if (regex.test(lowerFileName)) {
      return value;
    }
  }

  for (const [pattern, value] of Object.entries(defaultFilePatternToLanguage)) {
    const regexPattern = pattern
      .replaceAll('.', String.raw`\.`)
      .replaceAll('*', '.*');
    const regex = new RegExp(`^${regexPattern}$`);

    if (regex.test(lowerFileName)) {
      return value;
    }
  }

  const extension = lowerFileName.substring(lowerFileName.lastIndexOf('.') + 1);
  return extension || null;
}

let theme = "";
function getTheme(element) {
  if (themePreference !== 'auto') {
    return themePreference;
  }
  if (theme) return theme;
  const color = window.getComputedStyle(element).color;

  // Extract RGB components
  const rgb = color.match(/\d+/g).map(Number);
  let [r, g, b] = rgb;

  // Convert to relative luminance (sRGB)
  [r, g, b] = [r, g, b].map((c) => {
    c /= 255;
    return c <= 0.03928
      ? c / 12.92
      : Math.pow((c + 0.055) / 1.055, 2.4);
  });

  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

  theme = luminance > 0.5 ? 'prism-tomorrow-night' : 'prism-one-light';
  return theme;
}

// Vue single-file components: each line gets the language of the top-level block it sits in,
// read from the full file text of its side of the diff.
const vueFilesInFlight = new WeakSet();
const adoRequests = new Map();
let adoRequestsPullRequest = null;
const vueBlockOpenPattern = /^<(template|script|style)(?![\w-])/;

function getVueBlockLanguage(name, attributes) {
  if (name === 'script') return 'typescript';
  if (name === 'style') return /(?:^|\s)lang\s*=\s*(["']?)scss\1(?=[\s/]|$)/.test(attributes) ? 'scss' : 'css';
  return 'markup';
}

function countMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}

function getTemplateDepthChange(text) {
  return countMatches(text, /<template(?![\w-])/g)
    - countMatches(text, /<template(?![\w-])[^>]*\/>/g)
    - countMatches(text, /<\/template(?![\w-])/g);
}

// Returns the text outside HTML comments. `state.inComment` carries an open comment to the next line.
function removeHtmlComments(text, state) {
  let visible = '';
  let rest = text;
  while (rest) {
    if (state.inComment) {
      const end = rest.indexOf('-->');
      if (end === -1) break;
      state.inComment = false;
      rest = rest.slice(end + 3);
    } else {
      const start = rest.indexOf('<!--');
      if (start === -1) return visible + rest;
      visible += rest.slice(0, start);
      state.inComment = true;
      rest = rest.slice(start + 4);
    }
  }
  return visible;
}

// Returns the index of the `>` that ends an opening tag, or -1. `state.quote` carries an open quote to the next line.
function findTagEnd(text, state) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (state.quote) {
      if (char === state.quote) state.quote = null;
    } else if (char === '"' || char === "'") {
      state.quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}

// Returns one Prism language per line; index 0 is line 1.
function parseVueLineLanguages(text) {
  const languages = [];
  const rootComment = { inComment: false };
  let block = null;

  // Reads the rest of an opening tag. Returns the block, or null when the block also closes here.
  const readOpenTag = (rest) => {
    const end = findTagEnd(rest, block);
    if (end === -1) {
      block.attributes += `${rest} `;
      return block;
    }
    block.attributes += rest.slice(0, end);
    block.inOpenTag = false;
    block.language = getVueBlockLanguage(block.name, block.attributes);
    const after = rest.slice(end + 1);
    if (block.attributes.trimEnd().endsWith('/')) return null;
    if (block.name === 'template') {
      block.depth = 1 + getTemplateDepthChange(removeHtmlComments(after, block));
      return block.depth > 0 ? block : null;
    }
    return after.includes(`</${block.name}`) ? null : block;
  };

  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!block) {
      languages.push('markup');
      const match = !rootComment.inComment && line.match(vueBlockOpenPattern);
      if (match) {
        block = { name: match[1], attributes: '', inOpenTag: true };
        block = readOpenTag(line.slice(match[0].length));
      } else {
        removeHtmlComments(line, rootComment);
      }
    } else if (block.inOpenTag) {
      languages.push('markup');
      block = readOpenTag(line);
    } else if (block.name === 'template') {
      languages.push('markup');
      block.depth += getTemplateDepthChange(removeHtmlComments(line, block));
      if (block.depth <= 0) block = null;
    } else if (line.includes(`</${block.name}`)) {
      languages.push('markup');
      block = null;
    } else {
      languages.push(block.language);
    }
  }
  return languages;
}

function readIterationParam(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function getPullRequestContext(location) {
  const match = location.pathname.match(/^(.*)\/_git\/([^/]+)\/pullrequest\/(\d+)(?:\/|$)/i);
  if (!match) return null;
  const [, projectPath, repository, id] = match;
  const params = new URLSearchParams(location.search);
  const apiBase = `${location.origin}${projectPath}/_apis/git/repositories/${repository}`;
  const pullRequestId = Number(id);
  const iteration = readIterationParam(params.get('iteration'));
  const base = readIterationParam(params.get('base'));
  return { apiBase, pullRequestId, iteration, base, key: `${apiBase}|${pullRequestId}|${iteration}|${base}` };
}

function chooseDiffCommits(iterations, iterationId, baseId) {
  const newIteration = iterationId
    ? iterations.find(item => item.id === iterationId)
    : iterations.reduce((last, item) => (!last || item.id > last.id ? item : last), null);
  const newCommit = newIteration?.sourceRefCommit?.commitId;
  const oldCommit = baseId
    ? iterations.find(item => item.id === baseId)?.sourceRefCommit?.commitId
    : newIteration?.commonRefCommit?.commitId;
  return newCommit && oldCommit ? { old: oldCommit, new: newCommit } : null;
}

// Same-origin fetch, so the page session cookies go with it. A failed request is removed from the cache, so a later call retries it.
function fetchFromAdo(url, accept, read) {
  if (!adoRequests.has(url)) {
    const request = fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: accept, 'X-TFS-FedAuthRedirect': 'Suppress' }
    }).then(response => {
      const contentType = response.headers.get('content-type') || '';
      if (response.status !== 200 || contentType.includes('text/html')) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return read(response);
    });
    request.catch(() => {
      if (adoRequests.get(url) === request) adoRequests.delete(url);
    });
    adoRequests.set(url, request);
  }
  return adoRequests.get(url);
}

// The request cache holds only the pull request on screen; moving to another one empties it.
function keepAdoRequestsFor(context) {
  const pullRequest = `${context.apiBase}|${context.pullRequestId}`;
  if (pullRequest !== adoRequestsPullRequest) {
    adoRequests.clear();
    adoRequestsPullRequest = pullRequest;
  }
}

async function loadVueLineLanguages(context, filePaths) {
  keepAdoRequestsFor(context);
  const iterations = await fetchFromAdo(
    `${context.apiBase}/pullRequests/${context.pullRequestId}/iterations?api-version=7.1`,
    'application/json',
    response => response.json().then(body => body.value)
  );
  const commits = chooseDiffCommits(iterations, context.iteration, context.base);
  if (!commits) {
    throw new Error(`No commits for iteration ${context.iteration} and base ${context.base}`);
  }
  const loadSide = (commit, filePath) => fetchFromAdo(
    `${context.apiBase}/items?path=${encodeURIComponent(filePath)}&versionDescriptor.version=${encodeURIComponent(commit)}&versionDescriptor.versionType=commit&api-version=7.1`,
    'text/plain',
    response => response.text()
  ).then(parseVueLineLanguages, () => null);
  const [oldLanguages, newLanguages] = await Promise.all([
    loadSide(commits.old, filePaths.old),
    loadSide(commits.new, filePaths.new)
  ]);
  return { old: oldLanguages, new: newLanguages };
}

function getDiffLineLocation(lineElement, fileDiffElement) {
  const row = lineElement.closest('.repos-diff-contents-row');
  if (!row) return null;
  const numberElements = row.querySelectorAll('.repos-line-number');
  const pane = lineElement.closest('.vss-Splitter--pane-fixed, .vss-Splitter--pane-flexible');
  let side;
  let numberElement;
  if (pane && fileDiffElement.contains(pane)) {
    side = pane.classList.contains('vss-Splitter--pane-fixed') ? 'old' : 'new';
    numberElement = numberElements[0];
  } else {
    side = lineElement.classList.contains('removed') ? 'old' : 'new';
    // An added or deleted file has one number column. Otherwise the first column is old and the second is new.
    numberElement = numberElements.length === 1 ? numberElements[0] : numberElements[side === 'old' ? 0 : 1];
  }
  const lineNumber = Number(numberElement?.getAttribute('data-line'));
  return Number.isInteger(lineNumber) && lineNumber > 0 ? { side, lineNumber } : null;
}

// The header can show an encoding change before the path, so the new path is the first line that starts
// with a slash. A renamed file also shows its old path in a "Renamed from" block.
function getFilePaths(fileDiffElement) {
  const header = fileDiffElement.querySelector('.repos-change-summary-file-icon-container + .flex-column');
  if (!header) return null;
  const findPath = selector => [...header.querySelectorAll(selector)]
    .map(element => element.textContent.trim())
    .find(text => text.startsWith('/'));
  const newPath = findPath('.body-s.secondary-text.text-ellipsis');
  if (!newPath) return null;
  return { old: findPath('.body-s.secondary-text.flex-column .text-ellipsis') || newPath, new: newPath };
}

async function processVueFileDiff(fileDiffElement, fileLanguage, context) {
  const filePaths = getFilePaths(fileDiffElement);
  let lineLanguages = { old: null, new: null };
  vueFilesInFlight.add(fileDiffElement);
  try {
    if (filePaths) {
      lineLanguages = await loadVueLineLanguages(context, filePaths);
    }
  } catch (error) {
    console.debug('ADO Syntax Highlighter: Vue blocks unavailable, using the file language:', error);
  } finally {
    vueFilesInFlight.delete(fileDiffElement);
  }
  if (!fileDiffElement.isConnected) {
    return;
  }
  if (getPullRequestContext(window.location)?.key !== context.key || getFilePaths(fileDiffElement)?.new !== filePaths?.new) {
    // The URL or the file shown in this card changed during the fetch, and a pass skipped the card while it was in flight.
    return processFileDiff(fileDiffElement);
  }
  highlightLines(fileDiffElement, lineElement => {
    const location = getDiffLineLocation(lineElement, fileDiffElement);
    return (location && lineLanguages[location.side]?.[location.lineNumber - 1]) || fileLanguage;
  });
}

function processFileDiff(fileDiffElement) {
  if (fileDiffElement.querySelector('.ado-syntax-highlighted') || vueFilesInFlight.has(fileDiffElement)) {
    return;
  }

  let fileNameElement = fileDiffElement.querySelector('.repos-change-summary-file-icon-container + .flex-column .text-ellipsis');

  const fileName = fileNameElement ? fileNameElement.textContent.trim() : null;
  const language = getLanguageFromFileName(fileName);

  if (language === 'vue') {
    const context = getPullRequestContext(window.location);
    if (context) {
      return processVueFileDiff(fileDiffElement, language, context);
    }
  }

  highlightLines(fileDiffElement, () => language);
}

function highlightLines(fileDiffElement, getLineLanguage) {
  let originalLineElements = fileDiffElement.querySelectorAll('.monospaced-text > .repos-line-content');

  originalLineElements.forEach(originalLineElement => {
    if (!originalLineElement.classList.contains('ado-syntax-highlighted')) {
      const language = getLineLanguage(originalLineElement);

      const elementsToPreserve = [];
      const nonCodeQuery = '.screen-reader-only, span[aria-hidden="true"]';
      originalLineElement.querySelectorAll(nonCodeQuery).forEach(el => {
        elementsToPreserve.push(el.cloneNode(true));
      });

      const codeContainer = originalLineElement.cloneNode(true);
      codeContainer.querySelectorAll(nonCodeQuery).forEach(el => el.remove());
      const codeToHighlight = codeContainer.innerHTML;

      const highlightedLine = originalLineElement.cloneNode(true);

      const code = document.createElement('code'); // Temporary element
      code.className = `language-${language}`;
      code.innerHTML = codeToHighlight;
      Prism.highlightElement(code, false, () => {
        const contentDiv = document.createElement('div');
        contentDiv.innerHTML = code.innerHTML;
        contentDiv.classList.add(getTheme(originalLineElement));
        highlightedLine.innerHTML = '';

        elementsToPreserve.forEach(el => {
          highlightedLine.appendChild(el);
        });

        highlightedLine.appendChild(contentDiv);
        highlightedLine.classList.add('ado-syntax-highlighted');

        // Hide the original line.
        // This is a hack to make the line comment button functional. Otherwise it breaks.
        originalLineElement.style.display = 'none';

        // Insert the highlighted version after the original
        originalLineElement.parentNode.insertBefore(highlightedLine, originalLineElement.nextSibling)
      });
    }
  });
}

// The single-file view is a Monaco editor, colored by monaco_bridge.js in the page's main world. That
// script cannot read extension storage, so the token colors of the chosen Prism theme are sent to it, one set
// per Monaco base theme. With auto, vs gets the light Prism theme and vs-dark the dark one.
const MONACO_THEME_EVENT = 'ado-syntax-highlighter:monaco-theme';
const MONACO_THEME_REQUEST_EVENT = 'ado-syntax-highlighter:monaco-theme-request';
const monacoPrismTokenTypes = [
  'comment', 'keyword', 'boolean', 'string', 'property', 'number', 'regex', 'class-name', 'tag', 'selector',
  'attr-name', 'attr-value', 'punctuation', 'operator', 'atrule', 'variable', 'constant', 'namespace', 'doctype'
];
let monacoThemePreference = null;

function toHexColor(cssColor) {
  const rgb = cssColor.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/);
  if (!rgb || (rgb[4] !== undefined && Number(rgb[4]) === 0)) return null;
  return `#${rgb.slice(1, 4).map(value => Number(value).toString(16).padStart(2, '0')).join('')}`;
}

// Reads the theme's token styles from the same markup the multi-file view renders: token spans inside an
// element with the theme class. A token that shows the probe's own color has no rule and is left out.
function getPrismTokenStyles(themeName) {
  const probe = document.createElement('div');
  probe.className = themeName;
  probe.style.cssText = 'position: absolute; visibility: hidden; pointer-events: none; color: rgb(1, 2, 3); font-style: normal; font-weight: 400;';
  for (const type of monacoPrismTokenTypes) {
    const span = document.createElement('span');
    span.className = `token ${type}`;
    probe.appendChild(span);
  }
  document.body.appendChild(probe);
  const unstyled = window.getComputedStyle(probe).color;
  const styles = {};
  [...probe.children].forEach((span, index) => {
    const style = window.getComputedStyle(span);
    const foreground = style.color !== unstyled && toHexColor(style.color);
    if (!foreground) return;
    const bold = style.fontWeight === 'bold' || Number(style.fontWeight) >= 600;
    const fontStyle = [style.fontStyle === 'italic' && 'italic', bold && 'bold'].filter(Boolean).join(' ');
    styles[monacoPrismTokenTypes[index]] = { foreground, fontStyle };
  });
  probe.remove();
  return styles;
}

function sendMonacoTheme() {
  if (!monacoThemePreference || !document.body) return;
  const auto = monacoThemePreference === 'auto';
  const detail = JSON.stringify({
    vs: getPrismTokenStyles(auto ? 'prism-one-light' : monacoThemePreference),
    'vs-dark': getPrismTokenStyles(auto ? 'prism-tomorrow-night' : monacoThemePreference)
  });
  document.dispatchEvent(new CustomEvent(MONACO_THEME_EVENT, { detail }));
}

document.addEventListener(MONACO_THEME_REQUEST_EVENT, sendMonacoTheme);

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes.themePreference) return;
  monacoThemePreference = changes.themePreference.newValue || 'auto';
  sendMonacoTheme();
});

function applySyntaxHighlighting() {
  if (!window.location.href.includes('/_git/')) {
    return;
  }

  console.debug("ADO Syntax Highlighter: Applying...");

  const fileDiffPanels = document.querySelectorAll('.repos-summary-header');
  fileDiffPanels.forEach(fileDiffPanel => {
    processFileDiff(fileDiffPanel);
  });
}

console.debug("ADO Syntax Highlighter: Content script loaded.");

// Load custom patterns and then apply highlighting
// The Monaco theme goes first, so an error in the multi-file pass cannot stop it.
loadSettings().then(() => {
  monacoThemePreference = themePreference;
  sendMonacoTheme();
  applySyntaxHighlighting();
});

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
const debouncedApplyHighlighting = debounce(applySyntaxHighlighting, 250);

// Listen for URL changes
window.addEventListener('popstate', debouncedApplyHighlighting);

// Observe DOM changes for dynamically loaded content
new MutationObserver((mutationsList) => {
  for (const mutation of mutationsList) {
    if (!(mutation.type === 'childList' && mutation.addedNodes.length > 0)) {
      continue;
    }
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }
      if (
        node.matches?.('.repos-summary-code-diff, .vc-diff-viewer, .diff-frame, .repos-diff-contents-row, .bolt-card, .repos-pr-iteration-file-header') ||
        node.querySelector?.('.repos-summary-code-diff, .vc-diff-viewer, .diff-frame, .repos-diff-contents-row, .bolt-card, .repos-pr-iteration-file-header')
      ) {
        debouncedApplyHighlighting();
        return;
      }
    }
  }
}).observe(document.body, { childList: true, subtree: true });
