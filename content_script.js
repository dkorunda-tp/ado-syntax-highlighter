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

// Markup plus Vue template syntax: `{{ expr }}` and the quoted values of directive attributes (`v-*`, `:x`, `@x`, `#x`)
// are TypeScript. Other attributes keep the markup rules.
function addVueTemplateGrammar() {
  const typescriptPart = pattern => ({
    pattern,
    lookbehind: true,
    alias: ['typescript', 'language-typescript'],
    inside: Prism.languages.typescript
  });
  Prism.languages['vue-template'] = Prism.languages.extend('markup', {});
  // TypeScript identifiers are plain text, so they take the color of the nearest colored token. The value is not
  // inside an attr-value token, and custom_styles.css gives the `vue-template-tag` element token the row color
  // instead of the tag color. They then show the base text color, as in the single-file view. Only the quotes are
  // attr-value, and the tag name keeps its own tag token.
  Prism.languages['vue-template'].tag.alias = 'vue-template-tag';
  Prism.languages['vue-template'].tag.inside['special-attr'].unshift({
    pattern: /(^|["'\s])(?:v-|[:@#])[^\s=>\/"']+\s*=\s*(?:"[^"]*"|'[^']*')/,
    lookbehind: true,
    inside: {
      'value': typescriptPart(/(^[^\s=]+\s*=\s*(["']))[\s\S]+(?=\2$)/),
      'attr-value': /["']/,
      'punctuation': { pattern: /=/, alias: 'attr-equals' },
      'attr-name': /^[^\s=]+/
    }
  });
  // Before `comment` and `tag`, because Vue ends an expression only at `}}`. Both are greedy, so a `{{ }}` inside a
  // comment or an attribute value still becomes part of that comment or tag.
  Prism.languages.insertBefore('vue-template', 'comment', {
    'interpolation': {
      pattern: /\{\{[\s\S]*?\}\}/,
      inside: {
        'expression': typescriptPart(/(^\{\{)[\s\S]+(?=\}\}$)/),
        'punctuation': /\{\{|\}\}/
      }
    }
  });
}
addVueTemplateGrammar();

function getVueBlockLanguage(name, attributes) {
  if (name === 'script') return 'typescript';
  if (name === 'style') return /(?:^|\s)lang\s*=\s*(["']?)scss\1(?=[\s/]|$)/.test(attributes) ? 'scss' : 'css';
  return 'vue-template';
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

function splitFileLines(text) {
  return text.replace(/^﻿/, '').split(/\r?\n/);
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

  // The template tag lines join the template run, so a tag or a comment that crosses one keeps its tokens.
  // Script and style tag lines stay markup.
  const tagLineLanguage = name => (name === 'template' ? getVueBlockLanguage(name) : 'markup');

  for (const line of splitFileLines(text)) {
    if (!block) {
      const match = !rootComment.inComment && line.match(vueBlockOpenPattern);
      languages.push(match ? tagLineLanguage(match[1]) : 'markup');
      if (match) {
        block = { name: match[1], attributes: '', inOpenTag: true };
        block = readOpenTag(line.slice(match[0].length));
      } else {
        removeHtmlComments(line, rootComment);
      }
    } else if (block.inOpenTag) {
      languages.push(tagLineLanguage(block.name));
      block = readOpenTag(line);
    } else if (block.name === 'template') {
      block.depth += getTemplateDepthChange(removeHtmlComments(line, block));
      languages.push(block.language);
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

// Splits a Prism token stream at line breaks. A token that spans lines becomes one token per line with the same type and alias.
function splitTokensIntoLines(stream) {
  if (typeof stream === 'string') {
    return stream.split('\n').map(part => (part ? [part] : []));
  }
  if (Array.isArray(stream)) {
    const lines = [[]];
    for (const item of stream) {
      const [first, ...rest] = splitTokensIntoLines(item);
      lines[lines.length - 1].push(...first);
      lines.push(...rest);
    }
    return lines;
  }
  return splitTokensIntoLines(stream.content)
    .map(part => (part.length ? [new Prism.Token(stream.type, part, stream.alias)] : []));
}

// Returns { language, text, tokens } per line; index 0 is line 1. Each run of lines with one language is tokenized
// once, so tags, comments and strings that span lines keep their tokens on every line.
function parseVueFileLines(text) {
  const languages = parseVueLineLanguages(text);
  const lines = splitFileLines(text);
  const fileLines = [];
  for (let start = 0; start < lines.length;) {
    const language = languages[start];
    let end = start + 1;
    while (end < lines.length && languages[end] === language) end++;
    // Runs the hooks that Prism.highlight runs, so plugins such as js-templates tokenize embedded languages here too.
    const env = { code: lines.slice(start, end).join('\n'), grammar: Prism.languages[language], language };
    Prism.hooks.run('before-tokenize', env);
    env.tokens = Prism.tokenize(env.code, env.grammar);
    Prism.hooks.run('after-tokenize', env);
    splitTokensIntoLines(env.tokens).forEach((tokens, index) => {
      fileLines.push({ language, text: lines[start + index], tokens });
    });
    start = end;
  }
  return fileLines;
}

// Prism hooks get no row, so the file line of the row in highlight is held here for the after-tokenize hook.
let rowFileLine = null;
const foldNonBreakingSpaces = text => text.replace(/\xa0/g, ' ');

function withRowFileLine(fileLine, highlight) {
  rowFileLine = fileLine;
  try {
    highlight();
  } finally {
    rowFileLine = null;
  }
}

Prism.hooks.add('after-tokenize', env => {
  const line = rowFileLine;
  if (line && env.language === line.language && foldNonBreakingSpaces(env.code) === foldNonBreakingSpaces(line.text)) {
    env.tokens = line.tokens;
  }
});

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

// A request that has not finished, body included, after this time is aborted, so a stalled version cannot block
// the older versions or keep its card in flight.
const ADO_REQUEST_TIMEOUT_MS = 15000;

// Same-origin fetch, so the page session cookies go with it. A failed request is removed from the cache, so a later call retries it.
function fetchFromAdo(url, accept, read) {
  if (!adoRequests.has(url)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ADO_REQUEST_TIMEOUT_MS);
    const request = fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: accept, 'X-TFS-FedAuthRedirect': 'Suppress' },
      signal: controller.signal
    }).then(response => {
      const contentType = response.headers.get('content-type') || '';
      if (response.status !== 200 || contentType.includes('text/html')) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return read(response);
    }).finally(() => clearTimeout(timeout));
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

// The iterations list grows with every push, so each pass fetches it again. File texts stay cached, because
// their URL names the commit.
function forgetIterationsLists() {
  for (const url of adoRequests.keys()) {
    if (url.includes('/iterations?')) adoRequests.delete(url);
  }
}

// The page can show an older push than the newest one, for example after a push while the page is open, or in
// an Overview comment thread. So with no iteration in the URL, a side tries the commits of the iterations
// newest first. An iteration or a base in the URL fixes that side to one commit.
const MAX_FILE_VERSIONS = 5;

function chooseCommitCandidates(iterations, iterationId, baseId) {
  const commits = chooseDiffCommits(iterations, iterationId, baseId);
  if (!commits) return null;
  const newestFirst = iterationId ? [] : [...iterations].sort((a, b) => b.id - a.id).slice(0, MAX_FILE_VERSIONS);
  const candidates = (first, others) => [...new Set([first, ...others].filter(Boolean))];
  return {
    new: candidates(commits.new, newestFirst.map(item => item.sourceRefCommit?.commitId)),
    old: candidates(commits.old, baseId ? [] : newestFirst.map(item => item.commonRefCommit?.commitId))
  };
}

const rowsMatchFileLines = (rows, fileLines) => rows.every(row => {
  const line = fileLines[row.lineNumber - 1];
  return line && foldNonBreakingSpaces(line.text) === foldNonBreakingSpaces(row.code);
});

// `rows` holds the visible rows of each side. A side with no rows is not fetched, so an added file fetches no
// old side. A side takes the first version that has the text of every row, or else the first version found.
// With `eitherSide`, the rows in `rows.new` may belong to either side: the new side is tried first, then the old
// side, and `side` in the result names the side that is used.
async function loadVueFileLines(context, filePaths, rows, eitherSide = false) {
  keepAdoRequestsFor(context);
  const iterations = await fetchFromAdo(
    `${context.apiBase}/pullRequests/${context.pullRequestId}/iterations?api-version=7.1`,
    'application/json',
    response => response.json().then(body => body.value)
  );
  const commits = chooseCommitCandidates(iterations, context.iteration, context.base);
  if (!commits) {
    throw new Error(`No commits for iteration ${context.iteration} and base ${context.base}`);
  }
  const loadSide = (commit, filePath) => fetchFromAdo(
    `${context.apiBase}/items?path=${encodeURIComponent(filePath)}&versionDescriptor.version=${encodeURIComponent(commit)}&versionDescriptor.versionType=commit&api-version=7.1`,
    'text/plain',
    response => response.text()
  ).then(parseVueFileLines).catch(() => null);
  const loadMatchingSide = async (side, sideRows) => {
    if (!sideRows.length) return { lines: null, matched: false };
    let firstFound = null;
    for (const commit of commits[side]) {
      const fileLines = await loadSide(commit, filePaths[side]);
      if (!fileLines) continue;
      if (rowsMatchFileLines(sideRows, fileLines)) return { lines: fileLines, matched: true };
      firstFound ??= fileLines;
    }
    return { lines: firstFound, matched: false };
  };
  if (eitherSide) {
    const asNew = await loadMatchingSide('new', rows.new);
    const asOld = asNew.matched ? null : await loadMatchingSide('old', rows.new);
    return asOld?.matched ? { old: asOld.lines, new: null, side: 'old' } : { old: null, new: asNew.lines, side: 'new' };
  }
  const [oldSide, newSide] = await Promise.all([loadMatchingSide('old', rows.old), loadMatchingSide('new', rows.new)]);
  return { old: oldSide.lines, new: newSide.lines };
}

// `oneFileSide` is the side of every row of a card that shows one file, from getOneFileSide.
function getDiffLineLocation(lineElement, fileDiffElement, oneFileSide = null) {
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
    side = oneFileSide || (lineElement.classList.contains('removed') ? 'old' : 'new');
    // An added or deleted file has one number column. Otherwise the first column is old and the second is new.
    numberElement = numberElements.length === 1 ? numberElements[0] : numberElements[side === 'old' ? 0 : 1];
  }
  const lineNumber = Number(numberElement?.getAttribute('data-line'));
  return Number.isInteger(lineNumber) && lineNumber > 0 ? { side, lineNumber } : null;
}

// A Files tab card or an Overview comment-thread card. The thread card shows its file as a link and the path below it.
const FILE_CARD_SELECTOR = '.repos-summary-header, .comment-file-header';
const THREAD_FILE_LINK_SELECTOR = '.comment-file-header-link';

// The header can show an encoding change before the path, so the new path is the first line that starts
// with a slash. A renamed file also shows its old path in a "Renamed from" block.
function getFilePaths(fileDiffElement) {
  const threadPath = fileDiffElement.querySelector(`${THREAD_FILE_LINK_SELECTOR} + .text-ellipsis`)?.textContent.trim();
  if (threadPath?.startsWith('/')) return { old: threadPath, new: threadPath };
  const header = fileDiffElement.querySelector('.repos-change-summary-file-icon-container + .flex-column');
  if (!header) return null;
  const findPath = selector => [...header.querySelectorAll(selector)]
    .map(element => element.textContent.trim())
    .find(text => text.startsWith('/'));
  const newPath = findPath('.body-s.secondary-text.text-ellipsis');
  if (!newPath) return null;
  return { old: findPath('.body-s.secondary-text.flex-column .text-ellipsis') || newPath, new: newPath };
}

// An added or deleted file and an Overview thread snippet show one file: no splitter panes and one number column
// on every row. All rows of such a card are on one side: new with an added row, old with a removed row, and
// 'either' when every row is unchanged. A card with both kinds of rows, or another card, gives null, and each
// row then takes the side of its own class.
function getOneFileSide(fileDiffElement) {
  if (fileDiffElement.querySelector('.vss-Splitter--pane-fixed, .vss-Splitter--pane-flexible')) return null;
  const rows = [...fileDiffElement.querySelectorAll('.repos-diff-contents-row')];
  if (!rows.length || rows.some(row => row.querySelectorAll('.repos-line-number').length !== 1)) return null;
  const lines = [...fileDiffElement.querySelectorAll(LINE_SELECTOR)];
  const added = lines.some(line => line.classList.contains('added'));
  const removed = lines.some(line => line.classList.contains('removed'));
  if (added && removed) return null;
  return added ? 'new' : removed ? 'old' : 'either';
}

// The visible rows of each side. The rows of an 'either' card are held as new rows.
function getSideRows(fileDiffElement, oneFileSide) {
  const rowSide = oneFileSide === 'either' ? 'new' : oneFileSide;
  const rows = { old: [], new: [] };
  fileDiffElement.querySelectorAll(LINE_SELECTOR).forEach(lineElement => {
    const location = getDiffLineLocation(lineElement, fileDiffElement, rowSide);
    if (location) rows[location.side].push({ lineNumber: location.lineNumber, code: getLineCode(lineElement) });
  });
  return rows;
}

async function processVueFileDiff(fileDiffElement, fileLanguage, context) {
  const filePaths = getFilePaths(fileDiffElement);
  const oneFileSide = getOneFileSide(fileDiffElement);
  const rows = getSideRows(fileDiffElement, oneFileSide);
  if (!rows.old.length && !rows.new.length) {
    // The rows of an Overview thread render after its card, and a later pass processes the card again.
    return highlightLines(fileDiffElement, () => fileLanguage);
  }
  const rowsSnapshot = JSON.stringify(rows);
  let fileLines = { old: null, new: null };
  vueFilesInFlight.add(fileDiffElement);
  try {
    if (filePaths) {
      fileLines = await loadVueFileLines(context, filePaths, rows, oneFileSide === 'either');
    }
  } catch (error) {
    console.debug('ADO Syntax Highlighter: Vue blocks unavailable, using the file language:', error);
  } finally {
    vueFilesInFlight.delete(fileDiffElement);
  }
  if (!fileDiffElement.isConnected) {
    return;
  }
  if (getPullRequestContext(window.location)?.key !== context.key || getFilePaths(fileDiffElement)?.new !== filePaths?.new ||
    JSON.stringify(getSideRows(fileDiffElement, getOneFileSide(fileDiffElement))) !== rowsSnapshot) {
    // The URL, the file shown in this card or its rows changed during the fetch, and a pass skipped the card while
    // it was in flight. The fetched versions stay cached, so the second choice costs few requests.
    return processFileDiff(fileDiffElement);
  }
  const lineSide = fileLines.side || (oneFileSide === 'either' ? 'new' : oneFileSide);
  const getFileLine = lineElement => {
    const location = getDiffLineLocation(lineElement, fileDiffElement, lineSide);
    return (location && fileLines[location.side]?.[location.lineNumber - 1]) || null;
  };
  highlightLines(fileDiffElement, lineElement => getFileLine(lineElement)?.language || fileLanguage, getFileLine);
}

function processFileDiff(fileDiffElement) {
  if (fileDiffElement.querySelector('.ado-syntax-highlighted') || vueFilesInFlight.has(fileDiffElement)) {
    return;
  }

  let fileNameElement = fileDiffElement.querySelector(`.repos-change-summary-file-icon-container + .flex-column .text-ellipsis, ${THREAD_FILE_LINK_SELECTOR}`);

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

const LINE_SELECTOR = '.monospaced-text > .repos-line-content';
const NON_CODE_QUERY = '.screen-reader-only, span[aria-hidden="true"]';

// The code of a row as Prism reads it, without the screen reader text and the line icon.
function getLineCode(lineElement) {
  const codeContainer = lineElement.cloneNode(true);
  codeContainer.querySelectorAll(NON_CODE_QUERY).forEach(el => el.remove());
  return codeContainer.textContent;
}

function highlightLines(fileDiffElement, getLineLanguage, getFileLine = () => null) {
  let originalLineElements = fileDiffElement.querySelectorAll(LINE_SELECTOR);

  originalLineElements.forEach(originalLineElement => {
    if (!originalLineElement.classList.contains('ado-syntax-highlighted')) {
      const language = getLineLanguage(originalLineElement);

      const elementsToPreserve = [];
      originalLineElement.querySelectorAll(NON_CODE_QUERY).forEach(el => {
        elementsToPreserve.push(el.cloneNode(true));
      });

      const codeContainer = originalLineElement.cloneNode(true);
      codeContainer.querySelectorAll(NON_CODE_QUERY).forEach(el => el.remove());
      const codeToHighlight = codeContainer.innerHTML;

      const highlightedLine = originalLineElement.cloneNode(true);

      const code = document.createElement('code'); // Temporary element
      code.className = `language-${language}`;
      code.innerHTML = codeToHighlight;
      withRowFileLine(getFileLine(originalLineElement), () => Prism.highlightElement(code, false, () => {
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
      }));
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
  'attr-name', 'attr-value', 'punctuation', 'operator', 'atrule', 'variable', 'constant', 'namespace', 'doctype', 'function'
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
  forgetIterationsLists();

  const fileDiffPanels = document.querySelectorAll(FILE_CARD_SELECTOR);
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
