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

function getCodeText(lineElement) {
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
  if (!trimmed || trimmed.startsWith('<') || trimmed.includes('{{')) {
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

  return new Map(records.map(record => [
    record.element,
    record.forwardLanguage || record.backwardLanguage || inferVueLanguage(record.line)
  ]));
}

function classifyVueLines(lineElements) {
  const columns = new Map();
  for (const element of lineElements) {
    // Side-by-side diffs interleave the old and new file in DOM order. Grouping
    // by horizontal position keeps each Vue block state independent.
    const visibleElement = element.dataset.adoSyntaxProcessed === 'true'
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
  if (
    originalLineElement.classList.contains('ado-syntax-highlighted') ||
    originalLineElement.dataset.adoSyntaxProcessed === 'true'
  ) {
    return;
  }
  if (!language || !Prism.languages[language]) {
    return;
  }

  const elementsToPreserve = [];
  originalLineElement.querySelectorAll(nonCodeQuery).forEach(el => {
    elementsToPreserve.push(el.cloneNode(true));
  });

  const highlightedLine = originalLineElement.cloneNode(true);
  const code = document.createElement('code');
  code.className = `language-${language}`;
  code.textContent = getCodeText(originalLineElement);

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
    highlightedLine.dataset.adoSyntaxLanguage = language;

    // Keeping the original line in the DOM preserves Azure DevOps' line
    // comment behavior, which is bound to that element.
    originalLineElement.dataset.adoSyntaxProcessed = 'true';
    originalLineElement.style.display = 'none';
    originalLineElement.parentNode.insertBefore(highlightedLine, originalLineElement.nextSibling);
  });
}

function processLines(lineElements, fileName) {
  const originals = Array.from(lineElements).filter(
    element => !element.classList.contains('ado-syntax-highlighted')
  );
  if (originals.length === 0) return;

  if (vueSyntaxHighlighting && isVueFile(fileName)) {
    const vueLanguages = classifyVueLines(originals);
    originals.forEach(element => highlightLine(element, vueLanguages.get(element)));
    return;
  }

  const language = getLanguageFromFileName(fileName);
  originals.forEach(element => highlightLine(element, language));
}

function processFileDiff(fileDiffElement) {
  const fileNameElement = fileDiffElement.querySelector(
    '.repos-change-summary-file-icon-container + .flex-column .text-ellipsis'
  );

  const fileName = fileNameElement ? fileNameElement.textContent.trim() : null;
  const lineElements = fileDiffElement.querySelectorAll(
    '.monospaced-text > .repos-line-content'
  );
  processLines(lineElements, fileName);
}

function getFileNameFromLocation() {
  const url = new URL(window.location.href);
  const filePath = url.searchParams.get('path') || url.searchParams.get('itemPath');
  if (!filePath) return null;
  return filePath.split('/').filter(Boolean).pop() || null;
}

function processFullFileView(processedDiffLines) {
  const fileName = getFileNameFromLocation();
  if (!fileName) return;

  const lineElements = Array.from(document.querySelectorAll(
    '.monospaced-text > .repos-line-content'
  )).filter(element => !processedDiffLines.has(element));
  processLines(lineElements, fileName);
}

function resetHighlighting() {
  document.querySelectorAll('.ado-syntax-highlighted').forEach(highlightedLine => {
    const originalLine = highlightedLine.previousElementSibling;
    if (originalLine?.classList.contains('repos-line-content')) {
      originalLine.style.display = '';
    }
    highlightedLine.remove();
  });
  document.querySelectorAll('[data-ado-syntax-processed="true"]').forEach(originalLine => {
    originalLine.style.display = '';
    delete originalLine.dataset.adoSyntaxProcessed;
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
  const processedDiffLines = new Set();
  fileDiffPanels.forEach(fileDiffPanel => {
    fileDiffPanel.querySelectorAll('.monospaced-text > .repos-line-content')
      .forEach(element => processedDiffLines.add(element));
    processFileDiff(fileDiffPanel);
  });
  processFullFileView(processedDiffLines);
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
