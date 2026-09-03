const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadContentScript() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'content_script.js'),
    'utf8'
  );
  const context = {
    URL,
    console: { debug() {}, error() {} },
    Node: { ELEMENT_NODE: 1 },
    Prism: { languages: {} },
    MutationObserver: class {
      observe() {}
    },
    browser: {
      storage: {
        sync: { get: async () => ({}) },
        onChanged: { addListener() {} }
      }
    },
    document: {
      body: {},
      querySelectorAll: () => []
    },
    window: {
      location: { href: 'https://example.visualstudio.com/project/_git/repo' },
      addEventListener() {},
      getComputedStyle: () => ({ color: 'rgb(0, 0, 0)' })
    },
    setTimeout,
    clearTimeout,
    setInterval() {}
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

function line(text, left = 100) {
  return {
    textContent: text,
    dataset: {},
    classList: { contains: () => false },
    cloneNode() {
      return {
        textContent: text,
        querySelectorAll: () => []
      };
    },
    getBoundingClientRect: () => ({ left })
  };
}

test('reads Vue block language attributes and aliases', () => {
  const context = loadContentScript();
  assert.equal(context.getVueBlockMarker('<script setup lang="ts">').language, 'typescript');
  assert.equal(context.getVueBlockMarker('<script lang=js>').language, 'javascript');
  assert.equal(context.getVueBlockMarker('<style scoped lang="scss">').language, 'scss');
  assert.equal(context.getVueBlockMarker('<template>').language, 'markup');
});

test('classifies a truncated hunk before a closing script tag', () => {
  const context = loadContentScript();
  const lines = [
    line('const rows = computed(() => [])'),
    line('</script>'),
    line('<template>'),
    line('  <div>{{ rows.length }}</div>'),
    line('</template>'),
    line('<style scoped lang="scss">'),
    line('.queue {'),
    line('  color: red;'),
    line('</style>')
  ];
  const languages = context.classifyVueColumn(lines);

  assert.deepEqual(
    lines.map(item => languages.get(item)),
    [
      'typescript',
      'markup',
      'markup',
      'markup',
      'markup',
      'markup',
      'scss',
      'scss',
      'markup'
    ]
  );
});

test('keeps side-by-side diff state independent', () => {
  const context = loadContentScript();
  const oldScript = line('const oldValue: string = "old"', 100);
  const newTemplate = line('<template>', 700);
  const oldClose = line('</script>', 100);
  const newMarkup = line('<div>new</div>', 700);
  const newClose = line('</template>', 700);

  const languages = context.classifyVueLines([
    oldScript,
    newTemplate,
    oldClose,
    newMarkup,
    newClose
  ]);

  assert.equal(languages.get(oldScript), 'typescript');
  assert.equal(languages.get(oldClose), 'markup');
  assert.equal(languages.get(newMarkup), 'markup');
});

test('treats a markerless multiline Vue template viewport as markup', () => {
  const context = loadContentScript();
  const lines = [
    line('<v-chip'),
    line(':color="'),
    line("matchRequest.stage === 'matched'"),
    line("? 'success'"),
    line(": 'warning'"),
    line('>'),
    line('{{ matchRequest.stage }}'),
    line('</v-chip>')
  ];
  const languages = context.classifyVueColumn(lines);

  assert.deepEqual(
    lines.map(item => languages.get(item)),
    Array(lines.length).fill('markup')
  );
});

test('retains the Vue section on ambiguous recycled rows', () => {
  const context = loadContentScript();
  const lines = [
    line("matchRequest.stage === 'matched'"),
    line("? 'success'"),
    line(": 'warning'")
  ];
  lines.forEach(item => {
    item.dataset.adoSyntaxLanguage = 'markup';
  });
  const languages = context.classifyVueColumn(lines);

  assert.deepEqual(
    lines.map(item => languages.get(item)),
    Array(lines.length).fill('markup')
  );
});

test('gets the full-file name from the Azure DevOps path query', () => {
  const context = loadContentScript();
  context.window.location.href =
    'https://example.visualstudio.com/project/_git/repo?path=/src/views/Queue.vue';
  assert.equal(context.getFileNameFromLocation(), 'Queue.vue');
});

test('extracts the file name from a dedicated diff header', () => {
  const context = loadContentScript();
  assert.equal(
    context.extractFileName('ExpandedAdClickDetails.vue  -11 +2'),
    'ExpandedAdClickDetails.vue'
  );
  assert.equal(context.extractFileName('/src/a/file.ts?version=1'), 'file.ts');
  assert.equal(context.extractFileName('/src/components'), null);
});

test('uses an explicit vue custom mapping even when automatic Vue support is off', () => {
  const context = loadContentScript();
  vm.runInContext(`
    customFilePatterns = { '*.component': 'vue' };
    vueSyntaxHighlighting = false;
  `, context);
  assert.equal(context.getLanguageFromFileName('Example.component'), 'vue');
});
