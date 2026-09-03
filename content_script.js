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
let vueSyntaxHighlighting = true;
let lastAppliedUrl = '';
let lastObservedUrl = window.location.href;

// Load custom patterns and theme preference from storage
async function loadSettings() {
  try {
    const result = await browser.storage.sync.get([
      'customFilePatterns',
      'themePreference',
      'vueSyntaxHighlighting'
    ]);
    customFilePatterns = result.customFilePatterns || {};
    themePreference = result.themePreference || 'auto';
    vueSyntaxHighlighting = result.vueSyntaxHighlighting !== false;
  } catch (error) {
    console.error('ADO Syntax Highlighter: Error loading settings:', error);
    customFilePatterns = {};
    themePreference = 'auto';
    vueSyntaxHighlighting = true;
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

function isVueFile(fileName) {
  return fileName?.toLowerCase().endsWith('.vue') || false;
}

let theme = "";
function getTheme(element) {
  if (themePreference !== 'auto') {
    return themePreference;
  }
  if (theme) return theme;
  const color = window.getComputedStyle(element).color;

  // Extract RGB components
  const rgbMatch = color.match(/\d+/g);
  if (!rgbMatch || rgbMatch.length < 3) {
    return 'prism-one-light';
  }
  const rgb = rgbMatch.map(Number);
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

const nonCodeQuery = '.screen-reader-only, span[aria-hidden="true"]';
// The summary renderer places the content directly under `.monospaced-text`,
// while the dedicated file renderer adds intermediate row wrappers.
const adoLineSelector = '.repos-line-content';
const monacoLineSelector = '.monaco-editor .view-lines > .view-line';
const codeLineSelector = `${adoLineSelector}, ${monacoLineSelector}`;
const virtualizedOriginalContent = new WeakMap();

function isMonacoLine(lineElement) {
  return lineElement.classList.contains('view-line');
}

function isVirtualizedLine(lineElement) {
  return isMonacoLine(lineElement) || !lineElement.closest('.repos-summary-header');
}

function getCodeText(lineElement) {
  if (isMonacoLine(lineElement)) {
    return lineElement.textContent || '';
  }
  const codeContainer = lineElement.cloneNode(true);
  codeContainer.querySelectorAll(nonCodeQuery).forEach(el => el.remove());
  return codeContainer.textContent || '';
}

function getVueBlockMarker(line) {
  const match = line.match(/<\s*(\/?)\s*(script|template|style)\b([^>]*)>/i);
  if (!match) return null;

  const closing = match[1] === '/';
  const section = match[2].toLowerCase();
  const attributes = match[3] || '';
  const langMatch = attributes.match(/\blang\s*=\s*["']?([\w-]+)/i);
  const requestedLanguage = langMatch?.[1]?.toLowerCase();

  const aliases = {
    html: 'markup',
    js: 'javascript',
    ts: 'typescript'
  };
  const defaults = {
    script: 'typescript',
    template: 'markup',
    style: 'css'
  };

  const language = aliases[requestedLanguage] || requestedLanguage || defaults[section];
  return { closing, language, section };
}

function inferVueLanguage(line) {
  const trimmed = line.trim();
  if (
    !trimmed ||
    trimmed.startsWith('<') ||
    trimmed === '>' ||
    trimmed.includes('{{') ||
    /^(?:v-|[:@#])[^=\s]+\s*=/.test(trimmed)
  ) {
    return 'markup';
  }
  if (
    /^(?:[.#][\w-]+|@(?:media|supports|keyframes)|[a-z][\w-]*(?:\s|,|:|\.|#|\[)).*\{\s*$/i.test(trimmed) ||
    /^[\w-]+\s*:\s*[^=].*;\s*$/.test(trimmed)
  ) {
    return 'css';
  }
  return 'typescript';
}

function inferVueRegionLanguage(records) {
  const votes = { markup: 0, css: 0, typescript: 0 };
  const strongVotes = { markup: 0, css: 0, typescript: 0 };
  const previousVotes = { markup: 0, css: 0, typescript: 0 };

  for (const record of records) {
    const trimmed = record.line.trim();
    if (trimmed) {
      const inferred = inferVueLanguage(record.line);
      votes[inferred] += 1;

      // These only occur inside an HTML start tag or Vue template body. Give
      // them extra weight so multiline directive expressions stay markup.
      if (
        trimmed.startsWith('<') ||
        trimmed === '>' ||
        trimmed.includes('{{') ||
        /^(?:v-|[:@#])[^=\s]+\s*=/.test(trimmed)
      ) {
        votes.markup += 2;
        strongVotes.markup += 1;
      } else if (
        /^(?:[.#][\w-]+|@(?:media|supports|keyframes)|[a-z][\w-]*(?:\s|,|:|\.|#|\[)).*\{\s*$/i.test(trimmed) ||
        /^[\w-]+\s*:\s*[^=].*;\s*$/.test(trimmed)
      ) {
        strongVotes.css += 1;
      } else if (
        /^(?:const|let|var|import|export|interface|type|function|class|async|await|return|if|for|while|try|catch|throw|new)\b/.test(trimmed)
      ) {
        strongVotes.typescript += 1;
      }
    }

    const previousLanguage = record.element.dataset.adoSyntaxLanguage;
    if (previousLanguage in previousVotes) {
      previousVotes[previousLanguage] += 1;
    }
  }

  const rankedVotes = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const [inferredLanguage, inferredScore] = rankedVotes[0];
  const secondScore = rankedVotes[1][1];
  const rankedStrongVotes = Object.entries(strongVotes).sort((a, b) => b[1] - a[1]);
  const [strongLanguage, strongScore] = rankedStrongVotes[0];
  const secondStrongScore = rankedStrongVotes[1][1];

  // A decisive visible signature wins when a large scroll jumps across SFC
  // sections. Otherwise retain the section attached to ADO's recycled rows.
  if (strongScore > 0 && strongScore > secondStrongScore) {
    return strongLanguage;
  }

  const [previousLanguage, previousScore] = Object.entries(previousVotes)
    .sort((a, b) => b[1] - a[1])[0];
  if (previousScore > 0) return previousLanguage;
  return inferredScore > secondScore ? inferredLanguage : 'typescript';
}

function classifyVueColumn(lineElements) {
  const records = lineElements.map(element => ({
    element,
    line: getCodeText(element),
    forwardLanguage: null,
    backwardLanguage: null
  }));

  let activeLanguage = null;
  for (const record of records) {
    const marker = getVueBlockMarker(record.line);
    if (marker && !marker.closing) {
      activeLanguage = marker.language;
    }
    record.forwardLanguage = marker ? 'markup' : activeLanguage;
    if (marker?.closing) {
      activeLanguage = null;
    }
  }

  activeLanguage = null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const marker = getVueBlockMarker(record.line);
    if (marker?.closing) {
      activeLanguage = marker.language;
    }
    record.backwardLanguage = marker ? 'markup' : activeLanguage;
    if (marker && !marker.closing) {
      activeLanguage = null;
    }
  }

  const languages = new Map();
  for (let index = 0; index < records.length;) {
    const record = records[index];
    const resolvedLanguage = record.forwardLanguage || record.backwardLanguage;
    if (resolvedLanguage) {
      languages.set(record.element, resolvedLanguage);
      index += 1;
      continue;
    }

    const unresolved = [];
    while (index < records.length) {
      const candidate = records[index];
      if (candidate.forwardLanguage || candidate.backwardLanguage) break;
      unresolved.push(candidate);
      index += 1;
    }
    const regionLanguage = inferVueRegionLanguage(unresolved);
    unresolved.forEach(candidate => languages.set(candidate.element, regionLanguage));
  }

  return languages;
}

function classifyVueLines(lineElements) {
  const columns = new Map();
  for (const element of lineElements) {
    // Side-by-side diffs interleave the old and new file in DOM order. Grouping
    // by horizontal position keeps each Vue block state independent.
    const visibleElement = element.dataset.adoSyntaxProcessed === 'true' && !isVirtualizedLine(element)
      ? element.nextElementSibling || element
      : element;
    const column = Math.round(visibleElement.getBoundingClientRect().left / 20) * 20;
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(element);
  }

  const languages = new Map();
  for (const columnElements of columns.values()) {
    const classified = classifyVueColumn(columnElements);
    for (const [element, language] of classified) {
      languages.set(element, language);
    }
  }
  return languages;
}

function highlightLine(originalLineElement, language) {
  if (!language || !Prism.languages[language]) {
    return;
  }

  const codeText = getCodeText(originalLineElement);
  const virtualized = isVirtualizedLine(originalLineElement);
  if (virtualized) {
    if (
      originalLineElement.dataset.adoSyntaxProcessed === 'true' &&
      originalLineElement.dataset.adoSyntaxSource === codeText
    ) {
      return;
    }
  } else if (
    originalLineElement.classList.contains('ado-syntax-highlighted') ||
    originalLineElement.dataset.adoSyntaxProcessed === 'true'
  ) {
    return;
  }

  const elementsToPreserve = [];
  if (!isMonacoLine(originalLineElement)) {
    originalLineElement.querySelectorAll(nonCodeQuery).forEach(el => {
      elementsToPreserve.push(el.cloneNode(true));
    });
  }

  const highlightedLine = originalLineElement.cloneNode(true);
  const code = document.createElement('code');
  code.className = `language-${language}`;
  code.textContent = codeText;

  Prism.highlightElement(code, false, () => {
    const contentElement = document.createElement(
      virtualized ? 'span' : 'div'
    );
    contentElement.innerHTML = code.innerHTML;
    contentElement.classList.add(getTheme(originalLineElement));

    if (virtualized) {
      virtualizedOriginalContent.set(originalLineElement, originalLineElement.innerHTML);
      originalLineElement.innerHTML = '';
      originalLineElement.appendChild(contentElement);
      originalLineElement.classList.add('ado-syntax-highlighted');
      originalLineElement.dataset.adoSyntaxProcessed = 'true';
      originalLineElement.dataset.adoSyntaxSource = codeText;
      originalLineElement.dataset.adoSyntaxLanguage = language;
      return;
    }

    highlightedLine.innerHTML = '';

    elementsToPreserve.forEach(el => {
      highlightedLine.appendChild(el);
    });

    highlightedLine.appendChild(contentElement);
    highlightedLine.classList.add('ado-syntax-highlighted');
    highlightedLine.dataset.adoSyntaxLanguage = language;

    // Keeping the original line in the DOM preserves Azure DevOps' line
    // comment behavior, which is bound to that element.
    originalLineElement.dataset.adoSyntaxProcessed = 'true';
    if (isMonacoLine(originalLineElement)) {
      // Monaco owns and reuses its line nodes. Keep the source node in place
      // and overlay the highlighted clone so scrolling and hit testing remain
      // stable.
      originalLineElement.style.visibility = 'hidden';
    } else {
      originalLineElement.style.display = 'none';
    }
    originalLineElement.parentNode.insertBefore(highlightedLine, originalLineElement.nextSibling);
  });
}

function processLines(lineElements, fileName) {
  const originals = Array.from(lineElements).filter(
    element => !element.classList.contains('ado-syntax-highlighted') || isVirtualizedLine(element)
  );
  if (originals.length === 0) return;

  const language = getLanguageFromFileName(fileName);
  if (language === 'vue' || (vueSyntaxHighlighting && isVueFile(fileName))) {
    const vueLanguages = classifyVueLines(originals);
    originals.forEach(element => highlightLine(element, vueLanguages.get(element)));
    return;
  }

  originals.forEach(element => highlightLine(element, language));
}

function processFileDiff(fileDiffElement) {
  const fileNameElement = fileDiffElement.querySelector(
    '.repos-change-summary-file-icon-container + .flex-column .text-ellipsis'
  );

  const fileName = fileNameElement
    ? fileNameElement.textContent.trim()
    : getFileNameFromElement(fileDiffElement) || getFileNameFromLocation();
  const lineElements = fileDiffElement.querySelectorAll(codeLineSelector);
  processLines(lineElements, fileName);
}

function extractFileName(value) {
  if (!value) return null;
  const match = value.match(/([^/\\\s]+\.[a-z][a-z0-9]{0,9})(?=\s|$|[?#])/i);
  return match?.[1] || null;
}

function getFileNameFromElement(element) {
  const selectors = [
    '[data-automation-key="file-name"]',
    '.repos-change-summary-file-name',
    '.repos-pr-iteration-file-header .text-ellipsis',
    '.bolt-header-title',
    '.text-ellipsis',
    '[title]',
    '[aria-label]'
  ];

  for (const selector of selectors) {
    for (const candidate of element.querySelectorAll(selector)) {
      const values = [
        candidate.textContent,
        candidate.getAttribute('title'),
        candidate.getAttribute('aria-label')
      ];
      for (const value of values) {
        const fileName = extractFileName(value);
        if (fileName) return fileName;
      }
    }
  }
  return extractFileName(element.textContent);
}

function getFileNameFromLocation() {
  const url = new URL(window.location.href);
  const filePath = url.searchParams.get('path') || url.searchParams.get('itemPath');
  if (!filePath) return null;
  const lastSegment = filePath.split('/').filter(Boolean).pop() || null;
  return extractFileName(lastSegment);
}

function processFullFileView() {
  const fileName = getFileNameFromLocation() || getFileNameFromElement(document);
  if (!fileName) return;

  const lineElements = document.querySelectorAll(codeLineSelector);
  processLines(lineElements, fileName);
}

function resetHighlighting() {
  document.querySelectorAll('.ado-syntax-highlighted').forEach(highlightedLine => {
    if (isVirtualizedLine(highlightedLine)) {
      const originalContent = virtualizedOriginalContent.get(highlightedLine);
      if (originalContent !== undefined) {
        highlightedLine.innerHTML = originalContent;
      }
      highlightedLine.classList.remove('ado-syntax-highlighted');
      delete highlightedLine.dataset.adoSyntaxProcessed;
      delete highlightedLine.dataset.adoSyntaxSource;
      delete highlightedLine.dataset.adoSyntaxLanguage;
      return;
    }

    const originalLine = highlightedLine.previousElementSibling;
    if (originalLine?.dataset.adoSyntaxProcessed === 'true') {
      originalLine.style.display = '';
      originalLine.style.visibility = '';
      delete originalLine.dataset.adoSyntaxSource;
    }
    highlightedLine.remove();
  });
  document.querySelectorAll('[data-ado-syntax-processed="true"]').forEach(originalLine => {
    originalLine.style.display = '';
    originalLine.style.visibility = '';
    delete originalLine.dataset.adoSyntaxProcessed;
    delete originalLine.dataset.adoSyntaxSource;
  });
}

function applySyntaxHighlighting() {
  if (!window.location.href.includes('/_git/')) {
    return;
  }

  console.debug("ADO Syntax Highlighter: Applying...");

  if (lastAppliedUrl !== window.location.href) {
    resetHighlighting();
    theme = '';
    lastAppliedUrl = window.location.href;
  }

  const fileDiffPanels = document.querySelectorAll('.repos-summary-header');
  fileDiffPanels.forEach(fileDiffPanel => {
    processFileDiff(fileDiffPanel);
  });
  processFullFileView();
}

console.debug("ADO Syntax Highlighter: Content script loaded.");

// Load custom patterns and then apply highlighting
loadSettings().then(() => {
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

// Azure DevOps uses pushState for file selection, which does not emit a
// popstate event. Polling only the URL is cheap and also covers renderer
// transitions that reuse the existing line nodes without a matching mutation.
setInterval(() => {
  if (lastObservedUrl !== window.location.href) {
    lastObservedUrl = window.location.href;
    debouncedApplyHighlighting();
  }
}, 250);

// Observe DOM changes for dynamically loaded content
new MutationObserver((mutationsList) => {
  for (const mutation of mutationsList) {
    if (mutation.target.parentElement?.closest('.monaco-editor, .vc-diff-viewer, .diff-frame')) {
      debouncedApplyHighlighting();
      return;
    }
    if (!(mutation.type === 'childList' && mutation.addedNodes.length > 0)) {
      continue;
    }
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }
      if (
        node.matches?.('.repos-summary-code-diff, .vc-diff-viewer, .diff-frame, .repos-diff-contents-row, .bolt-card, .repos-pr-iteration-file-header, .repos-line-content, .view-line') ||
        node.querySelector?.('.repos-summary-code-diff, .vc-diff-viewer, .diff-frame, .repos-diff-contents-row, .bolt-card, .repos-pr-iteration-file-header, .repos-line-content, .view-line')
      ) {
        debouncedApplyHighlighting();
        return;
      }
    }
  }
}).observe(document.body, { childList: true, characterData: true, subtree: true });

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (!changes.customFilePatterns && !changes.themePreference && !changes.vueSyntaxHighlighting) {
    return;
  }
  loadSettings().then(() => {
    resetHighlighting();
    theme = '';
    applySyntaxHighlighting();
  });
});
