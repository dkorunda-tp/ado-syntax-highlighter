const test = require('node:test');
const assert = require('node:assert/strict');
const { loadExtension, iteration } = require('./helpers');

let window;
test.before(async () => {
  ({ window } = await loadExtension());
});

function context(href) {
  const result = window.getPullRequestContext(new window.URL(href));
  return result ? JSON.parse(JSON.stringify(result)) : null;
}

test('reads the API base, pull request, iteration and base from a dev.azure.com URL', () => {
  const result = context('https://dev.azure.com/org/My%20Project/_git/My%20Repo/pullrequest/42?_a=files&iteration=3&base=1&path=/a.vue');
  assert.equal(result.apiBase, 'https://dev.azure.com/org/My%20Project/_apis/git/repositories/My%20Repo');
  assert.equal(result.pullRequestId, 42);
  assert.equal(result.iteration, 3);
  assert.equal(result.base, 1);
});

test('reads a visualstudio.com URL, and no iteration or base means null', () => {
  const result = context('https://org.visualstudio.com/Project/_git/Repo/pullRequest/7?_a=files');
  assert.equal(result.apiBase, 'https://org.visualstudio.com/Project/_apis/git/repositories/Repo');
  assert.equal(result.pullRequestId, 7);
  assert.equal(result.iteration, null);
  assert.equal(result.base, null);
});

test('base=0 means the common commit, like no base', () => {
  assert.equal(context('https://dev.azure.com/org/P/_git/R/pullrequest/1?iteration=2&base=0').base, null);
});

test('the key changes with the pull request, the iteration and the base, not with the path', () => {
  const a = context('https://dev.azure.com/org/P/_git/R/pullrequest/1?_a=files&path=/a.vue');
  assert.equal(a.key, context('https://dev.azure.com/org/P/_git/R/pullrequest/1?_a=files&path=/b.vue').key);
  assert.notEqual(a.key, context('https://dev.azure.com/org/P/_git/R/pullrequest/2?_a=files').key);
  assert.notEqual(a.key, context('https://dev.azure.com/org/P/_git/R/pullrequest/1?iteration=1').key);
  assert.notEqual(a.key, context('https://dev.azure.com/org/P/_git/R/pullrequest/1?iteration=2&base=1').key);
});

test('commit and branch compare pages are not pull requests', () => {
  assert.equal(context('https://dev.azure.com/org/P/_git/R/commit/abc123'), null);
  assert.equal(context('https://dev.azure.com/org/P/_git/R/branchCompare?baseVersion=GBmain'), null);
  assert.equal(context('https://dev.azure.com/org/P/_git/R/pullrequests?_a=mine'), null);
});

const iterations = [iteration(1, 'src1', 'common1'), iteration(2, 'src2', 'common2'), iteration(3, 'src3', 'common3')];

function commits(iterationId, baseId) {
  const result = window.chooseDiffCommits(iterations, iterationId, baseId);
  return result ? { old: result.old, new: result.new } : null;
}

test('no iteration: the last iteration source against its common commit', () => {
  assert.deepEqual(commits(null, null), { new: 'src3', old: 'common3' });
});

test('iteration only: that iteration source against its common commit', () => {
  assert.deepEqual(commits(1, null), { new: 'src1', old: 'common1' });
});

test('iteration and base: the iteration source against the base iteration source', () => {
  assert.deepEqual(commits(3, 1), { new: 'src3', old: 'src1' });
});

test('base without iteration: the last iteration against the base iteration source', () => {
  assert.deepEqual(commits(null, 2), { new: 'src3', old: 'src2' });
});

test('an unknown iteration or base gives no commits', () => {
  assert.equal(commits(9, null), null);
  assert.equal(commits(3, 9), null);
  assert.equal(window.chooseDiffCommits([], null, null), null);
});

test('the last iteration is the highest id, not the last array element', () => {
  const unordered = [iterations[2], iterations[0], iterations[1]];
  const result = window.chooseDiffCommits(unordered, null, null);
  assert.equal(result.new, 'src3');
});
