const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

for (const manifestFile of ['manifest.chrome.json', 'manifest.firefox.json']) {
  test(`${manifestFile} runs the Monaco bridge in the main world at document_start on the same hosts`, () => {
    const manifest = JSON.parse(read(manifestFile));
    const [isolated, bridge] = manifest.content_scripts;

    assert.equal(manifest.content_scripts.length, 2);
    assert.deepEqual(bridge, {
      matches: isolated.matches,
      js: ['monaco_bridge.js'],
      run_at: 'document_start',
      world: 'MAIN'
    });
    assert.equal(isolated.world, undefined);
    assert.equal(isolated.run_at, 'document_idle');
  });
}

test('the build copies monaco_bridge.js', () => {
  const commonFiles = read('Makefile').match(/COMMON_FILES := \\\n([\s\S]*?)\n\n/)[1];
  assert.match(commonFiles, /^\tmonaco_bridge\.js \\$/m);
});

test('a custom host gets the Monaco bridge in the main world and the content script in the isolated world', () => {
  const scriptCalls = [];
  const browser = {
    scripting: {
      insertCSS: () => Promise.resolve(),
      executeScript: details => {
        scriptCalls.push(details);
        return Promise.resolve([]);
      }
    },
    tabs: { onUpdated: { addListener() {} } }
  };
  const context = vm.createContext({ browser, console: { log() {}, warn() {} } });
  vm.runInContext(read('background.js'), context);

  context.injectContent(7);

  const bridgeCall = scriptCalls.find(call => call.files.includes('monaco_bridge.js'));
  assert.deepEqual(JSON.parse(JSON.stringify(bridgeCall)), { target: { tabId: 7 }, files: ['monaco_bridge.js'], world: 'MAIN' });
  const isolatedCall = scriptCalls.find(call => call.files.includes('content_script.js'));
  assert.equal(isolatedCall.world, undefined);
  assert.equal(isolatedCall.files.includes('monaco_bridge.js'), false);
});
