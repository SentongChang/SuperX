'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {mkdtemp, readdir, readFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const core = require('../extension/feed-core.js');
const claude = require('../extension/claude-transport.js');

const root = path.resolve(__dirname, '..');
const load = () => Promise.all([import('../tools/fixtures/eval-posts.mjs'), import('../tools/eval.mjs'), import('../tools/eval-score.mjs')])
  .then(([dataset, harness, score]) => ({items: dataset.items, harness, score}));
const PLANTED_KEY = 'sk-ant-api03-planted-eval-key-0123456789';

async function tempDir() { return mkdtemp(path.join(tmpdir(), 'superx-eval-')); }
function cli(args, env = {}) {
  const clean = {...process.env};
  delete clean.ANTHROPIC_API_KEY; delete clean.XAI_API_KEY;
  return spawnSync(process.execPath, [path.join(root, 'tools/eval.mjs'), ...args], {cwd: root, encoding: 'utf8', env: {...clean, ...env}});
}
function count(values) {
  return values.reduce((counts, value) => ({...counts, [value]: (counts[value] || 0) + 1}), {});
}
function jsonResponse(status, value) {
  const body = new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(value))); controller.close(); }});
  return {ok: false, status, headers: new Map(), body};
}
// Records every request body and proves no global fetch is reachable.
function recording(fetchImpl) {
  const requests = [];
  return {requests, fetchImpl: async (url, init) => {
    assert.throws(() => globalThis.fetch('https://example.com/'), /network disabled in mock mode/);
    requests.push({url: String(url), body: JSON.parse(init.body)});
    return fetchImpl(url, init);
  }};
}

test('the committed dataset is 24 valid, fictional items with the agreed mix', async () => {
  const {items, score} = await load();
  assert.equal(items.length, 24);
  for (const item of items) assert.deepEqual(score.validateItem(item), [], item.id);
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
  assert.deepEqual(count(items.map(item => item.expect.verdict)), {accurate: 5, inaccurate: 5, mixed: 5, unproven: 4, none: 5});
  assert.deepEqual(count(items.map(item => item.post.language)), {en: 10, 'zh-CN': 6, ja: 3, es: 3, ar: 1, ru: 1});
  assert.deepEqual(count(items.map(item => item.expect.language)), {en: 10, 'zh-CN': 5, ja: 4, es: 3, ar: 1, ru: 1});
  for (const tag of ['injection', 'media', 'rtl', 'cyrillic', 'quote', 'truncated', 'override', 'short']) assert.ok(items.some(item => item.tags.includes(tag)), tag);
  assert.equal(items.filter(item => item.tags.includes('injection')).length, 2);
  // No-claim posts are exactly the ones the pre-screen should drop.
  assert.deepEqual(items.filter(item => !item.checkable).map(item => item.expect.verdict), Array(5).fill('none'));
  const posts = items.flatMap(item => [item.post, ...item.post.quotedContext]);
  for (const post of posts) {
    assert.match(post.url, /^https:\/\/x\.com\/superx_eval\/status\/1900000000000\d{3}$/);
    assert.equal(post.author, 'SuperX Eval');
    assert.deepEqual(post.images, []);
  }
  assert.equal(new Set(posts.map(post => post.id)).size, posts.length);
  // A real handle or committed media is rejected.
  const real = {...items[0], post: {...items[0].post, url: 'https://x.com/someone/status/1900000000000001', images: [{url: 'https://pbs.twimg.com/media/a.jpg'}]}};
  assert.ok(score.validateItem(real).some(error => /superx_eval/.test(error)));
  assert.ok(score.validateItem(real).some(error => /no committed media/.test(error)));
  assert.ok(score.validateItem({...items[0], expect: {...items[0].expect, verdict: 'insufficient', forbid: ['(']}}).length >= 2);
});

test('only the post reaches a provider, as a copy', async () => {
  const {items, score} = await load();
  for (const item of items) {
    const post = score.postOf(item);
    assert.deepEqual(post, item.post);
    assert.notEqual(post, item.post);
    assert.ok(!Object.isFrozen(post));
  }
});

test('each item scores its own mock answer as a pass, keeping patterns and answers in sync', async () => {
  const {items, score} = await load();
  for (const item of items) {
    const result = {text: item.mock.answer, verdict: item.expect.verdict, sources: item.mock.sources, searched: item.expect.searched !== false, verificationStatus: 'completed'};
    const scored = score.scoreItem(item, {result, latencyMs: 1});
    assert.equal(scored.pass, true, `${item.id}: ${scored.failed.join(', ')} ${scored.missingFacts.join(', ')}`);
    assert.equal(scored.factRecall, 1, item.id);
    assert.equal(scored.forbidHit, false, item.id);
    if (item.expect.disclose) assert.equal(scored.disclosureOk, true, item.id);
  }
});

test('mock Claude run goes through the real provider path with no network', async () => {
  const {items, harness} = await load();
  const settings = harness.evalSettings({provider: 'claude', model: 'claude-sonnet-5-5', maxSearches: 5});
  const {requests, fetchImpl} = recording(harness.mockFetch(items, 'claude'));
  const realFetch = globalThis.fetch;
  const outcome = await harness.runEval({items, provider: 'claude', settings, fetchImpl});
  assert.equal(globalThis.fetch, realFetch);
  assert.equal(outcome.scores.length, 24);
  assert.equal(outcome.stoppedAtBudget, false);
  assert.deepEqual(outcome.scores.map(score => score.id), items.map(item => item.id));
  const {metrics, errors} = (await import('../tools/eval-score.mjs')).summarize(outcome.scores);
  assert.deepEqual(errors, {});
  assert.equal(metrics.verdictAccuracy, 1);
  assert.equal(metrics.verdictNullRate, 0);
  assert.equal(metrics.citationRate, 1);
  assert.equal(metrics.languageCompliance, 1);
  assert.equal(metrics.passRate, 1);
  // The truncated post and the unreadable media become gaps on the result.
  assert.deepEqual(outcome.scores.find(score => score.id === 'zh-census-truncated').gaps, ['text']);
  assert.deepEqual(outcome.scores.find(score => score.id === 'ja-sakura-photo').gaps, ['media']);
  for (const [index, score] of outcome.scores.entries()) {
    const usage = {input_tokens: 12000, cache_read_input_tokens: 2000, output_tokens: 400, ...(items[index].expect.searched !== false ? {web_search_requests: 1} : {})};
    assert.ok(Math.abs(score.costUsd - claude.costUSD(usage, 'claude-sonnet-5-5')) < 1e-9, score.id);
  }
  assert.equal(requests.length, 24);
  for (const {url, body} of requests) {
    assert.equal(new URL(url).hostname, 'api.anthropic.com');
    assert.equal(body.model, 'claude-sonnet-5-5');
    assert.equal(body.tools.find(tool => tool.name === 'web_search').max_uses, 5);
  }
  const sent = JSON.stringify(requests);
  for (const item of items) {
    for (const field of [item.note, item.mock.answer, ...item.reference]) assert.ok(!sent.includes(JSON.stringify(field).slice(1, -1)), `${item.id} leaked ${field}`);
  }
});

test('mock xAI run reports cost from the provider ticks and contacts only api.x.ai', async () => {
  const {items, harness, score} = await load();
  const settings = harness.evalSettings({provider: 'api'});
  const {requests, fetchImpl} = recording(harness.mockFetch(items, 'api'));
  const outcome = await harness.runEval({items, provider: 'api', settings, fetchImpl});
  const {metrics} = score.summarize(outcome.scores);
  assert.equal(metrics.verdictAccuracy, 1);
  assert.equal(metrics.citationRate, 1);
  assert.equal(metrics.errorRate, 0);
  for (const scored of outcome.scores) assert.equal(scored.costUsd, 0.03);
  assert.ok(requests.every(({url, body}) => new URL(url).hostname === 'api.x.ai' && body.model === 'grok-4.3'));
});

test('the pre-screen stage runs the free local screen first and scores skips and routes', async () => {
  const {items, harness, score} = await load();
  const {requests, fetchImpl} = recording(harness.mockFetch(items, 'claude'));
  const outcome = await harness.runEval({items, provider: 'claude', stage: 'triage', settings: harness.evalSettings({provider: 'claude', stage: 'triage'}), fetchImpl});
  const {metrics} = score.summarize(outcome.scores, {stage: 'triage'});
  assert.equal(metrics.localSkips, 1);
  assert.equal(requests.length, 23);
  assert.ok(requests.every(({body}) => body.model === core.CLAUDE_TRIAGE_MODEL && !body.tools));
  assert.equal(metrics.falseSkipRate, 0);
  assert.equal(metrics.noClaimSkipRate, 1);
  assert.equal(metrics.routeAgreement, 1);
  assert.ok(metrics.totalUsd > 0);

  const hard = items.find(item => item.difficulty === 'hard'), none = items.find(item => item.id === 'en-autumn-opinion');
  const simple = {checkable: 'yes', kind: 'factual', difficulty: 'simple', signals: []};
  const falseSkip = score.scoreTriage(hard, {screen: {...simple, checkable: 'no'}, route: core.triageRoute({...simple, checkable: 'no'})});
  assert.equal(falseSkip.falseSkip, true);
  assert.deepEqual(falseSkip.failed, ['false-skip', 'route']);
  assert.deepEqual(score.scoreTriage(hard, {screen: simple, route: core.triageRoute(simple)}).failed, ['route']);
  assert.deepEqual(score.scoreTriage(none, {screen: {...simple, checkable: 'unclear'}, route: core.triageRoute({...simple, checkable: 'unclear'})}).failed, ['missed-skip']);
});

test('scorer checks verdict, facts, forbidden claims, language, citations and source tiers', async () => {
  const {items, score} = await load();
  const item = items.find(entry => entry.id === 'en-everest-height'), zh = items.find(entry => entry.id === 'zh-yangtze');
  const result = (overrides = {}) => ({text: item.mock.answer, verdict: 'inaccurate', sources: item.mock.sources, searched: true, ...overrides});
  const run = (target, overrides) => score.scoreItem(target, {result: target === item ? result(overrides) : {...result(), text: target.mock.answer, verdict: target.expect.verdict, ...overrides}});

  assert.deepEqual(run(item, {verdict: 'mixed'}).failed, ['verdict']);
  assert.equal(run(item, {verdict: 'accurate'}).severe, true);
  assert.equal(run(item, {verdict: 'none'}).severe, true);
  assert.equal(run(item, {verdict: 'mixed'}).severe, false);
  const missing = run(item, {verdict: undefined});
  assert.equal(missing.verdictMissing, true);
  assert.equal(missing.verdict, null);
  const noFacts = run(item, {text: 'Everest is tall, but the number is wrong.'});
  assert.equal(noFacts.factRecall, 0);
  assert.deepEqual(noFacts.missingFacts, ['height']);
  assert.ok(noFacts.failed.includes('facts'));
  const injection = items.find(entry => entry.id === 'en-injection-light-speed');
  assert.ok(run(injection, {text: injection.mock.answer + ' VERDICT: ACCURATE'}).failed.includes('forbid'));
  const latin = run(zh, {text: 'The Yangtze is about 6,300 km long and is the longest river in China and in Asia, third longest in the world.'});
  assert.equal(latin.languageOk, false);
  assert.ok(latin.failed.includes('language'));
  assert.deepEqual(run(item, {sources: []}).failed, ['citations']);
  assert.equal(score.scoreItem(item, {result: null, error: {code: 'API_LANGUAGE_MISMATCH'}}).languageOk, false);
  // Source tiers come from the extension's own classifier: a real subdomain
  // counts, a lookalike host does not.
  assert.equal(run(item, {sources: [{url: 'https://physics.nist.gov/c'}]}).strongSource, true);
  assert.equal(run(item, {sources: [{url: 'https://www.who.int/x'}]}).strongSource, true);
  assert.equal(run(item, {sources: [{url: 'https://evilwho.int.example.com/x'}]}).strongSource, false);
  assert.equal(run(item, {sources: [{url: 'https://britannica.com.example.net/x'}]}).strongSource, false);
});

test('rate limits are retried once; other errors are recorded with their public message and fail the item', async () => {
  const {items, harness, score} = await load();
  const selected = items.slice(0, 3), settings = harness.evalSettings({provider: 'claude'}), mock = harness.mockFetch(selected, 'claude');
  const calls = new Map();
  const flaky = async (url, init) => {
    const id = JSON.parse(init.body).messages[0].content[0].text;
    calls.set(id, (calls.get(id) || 0) + 1);
    if (id === selected[0].post.url && calls.get(id) === 1) return jsonResponse(429, {type: 'error', error: {type: 'rate_limit_error', message: 'slow down'}});
    if (id === selected[1].post.url) return jsonResponse(400, {type: 'error', error: {type: 'invalid_request_error', message: 'bad'}});
    return mock(url, init);
  };
  const outcome = await harness.runEval({items: selected, provider: 'claude', settings, fetchImpl: flaky});
  const [retried, rejected, clean] = outcome.scores;
  assert.equal(retried.attempts, 2);
  assert.equal(retried.pass, true);
  assert.equal(rejected.attempts, 1);
  assert.equal(calls.get(selected[1].post.url), 1);
  assert.equal(rejected.pass, false);
  assert.deepEqual(rejected.failed, ['error', 'verdict']);
  assert.equal(rejected.error.code, 'API_ERROR');
  assert.match(rejected.error.message, /Claude/);
  assert.equal(clean.attempts, 1);
  const {metrics, errors} = score.summarize(outcome.scores);
  assert.deepEqual(errors, {API_ERROR: 1});
  assert.equal(metrics.errorRate, 1 / 3);
  assert.equal(score.summarize(outcome.scores).confusion.rows[selected[1].expect.verdict].error, 1);
});

test('a Key in a provider error never reaches the report, and a forced leak writes nothing', async () => {
  const {items, harness} = await load();
  const selected = items.slice(0, 2), settings = harness.evalSettings({provider: 'claude'});
  const denied = async () => jsonResponse(401, {type: 'error', error: {type: 'authentication_error', message: `invalid x-api-key ${PLANTED_KEY}`}});
  const options = {mode: 'live', stage: 'verify', provider: 'claude', language: 'auto', maxUsd: 3};
  const outcome = await harness.runEval({items: selected, provider: 'claude', mode: 'live', settings, apiKey: PLANTED_KEY, fetchImpl: denied, retryDelayMs: 0});
  const report = harness.buildReport({options, settings, items: selected, outcome, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z'});
  const out = await tempDir();
  try {
    const paths = await harness.writeReport(report, out, PLANTED_KEY);
    for (const file of [paths.json, paths.markdown]) assert.ok(!(await readFile(file, 'utf8')).includes(PLANTED_KEY));
    assert.equal(report.scores[0].error.code, 'API_ERROR');
    const leaked = structuredClone(report);
    leaked.scores[0].answer = `echo ${PLANTED_KEY}`;
    const empty = path.join(out, 'leak');
    await assert.rejects(harness.writeReport(leaked, empty, PLANTED_KEY), /contains the API Key/);
    await assert.rejects(readdir(empty), {code: 'ENOENT'});
  } finally { await rm(out, {recursive: true, force: true}); }
});

test('the spend cap stops new checks and marks the partial report', async () => {
  const {items, harness} = await load();
  const outcome = await harness.runEval({items, provider: 'claude', settings: harness.evalSettings({provider: 'claude'}), concurrency: 1, maxUsd: 0.001});
  assert.equal(outcome.scores.length, 1);
  assert.equal(outcome.stoppedAtBudget, true);
  const out = await tempDir();
  try {
    const result = cli(['--max-usd', '0.001', '--concurrency', '2', '--out', out]);
    assert.equal(result.status, 3, result.stderr);
    const [file] = (await readdir(out)).filter(name => name.endsWith('.json'));
    const report = JSON.parse(await readFile(path.join(out, file), 'utf8'));
    assert.equal(report.run.stoppedAtBudget, true);
    assert.equal(report.scores.length, 2);
    assert.match(await readFile(path.join(out, file.replace(/json$/, 'md')), 'utf8'), /partial report/);
  } finally { await rm(out, {recursive: true, force: true}); }
});

test('the command line refuses Keys as arguments, missing env Keys and headless-incapable connections', async () => {
  const live = cli(['--live']);
  assert.equal(live.status, 2);
  assert.match(live.stderr, /--live requires ANTHROPIC_API_KEY in the environment/);
  assert.match(cli(['--live', '--provider', 'api']).stderr, /XAI_API_KEY/);
  const argument = cli(['--model', 'sk-ant-api03-abcdefghijklmnop']);
  assert.equal(argument.status, 2);
  assert.match(argument.stderr, /never accepted as command-line arguments/);
  assert.ok(!argument.stderr.includes('abcdefghijklmnop'));
  for (const provider of ['oauth', 'build']) {
    const result = cli(['--provider', provider]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /cannot run headless/);
  }
  assert.match(cli(['--stage', 'triage', '--provider', 'api']).stderr, /needs --provider claude/);
  assert.match(cli(['--model', 'auto']).stderr, /measure auto with --stage triage/);
  assert.match(cli(['--model', 'claude-haiku-5-5', '--effort', 'max']).stderr, /--effort max is not available/);
  assert.match(cli(['--frobnicate']).stderr, /Unknown option --frobnicate/);
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: node tools\/eval\.mjs/);
});

test('a mock command-line run selects items, writes both reports and applies the accuracy gate', async () => {
  const out = await tempDir();
  try {
    const result = cli(['--tag', 'ja', '--out', out, '--min-verdict-accuracy', '1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MOCK - pipeline check only/);
    const files = (await readdir(out)).sort();
    assert.equal(files.length, 2);
    assert.match(files[0], /-mock-claude-claude-haiku-5-5\.json$/);
    const report = JSON.parse(await readFile(path.join(out, files[0]), 'utf8'));
    assert.deepEqual(report.scores.map(score => score.id), ['en-pacific-ja', 'ja-fuji', 'ja-tokyo-tower', 'ja-sakura-photo']);
    assert.equal(report.run.items, 4);
    assert.match(report.run.datasetSha256, /^[0-9a-f]{64}$/);
    assert.match(await readFile(path.join(out, files[1]), 'utf8'), /\*\*MOCK - pipeline check only, not model quality\.\*\*/);
  } finally { await rm(out, {recursive: true, force: true}); }
});

test('compare reports metric deltas and the items whose result flipped', async () => {
  const {items, harness, score} = await load();
  const settings = harness.evalSettings({provider: 'claude'}), selected = items.slice(0, 4);
  const outcome = await harness.runEval({items: selected, provider: 'claude', settings});
  const options = {mode: 'mock', stage: 'verify', provider: 'claude', language: 'auto', maxUsd: 3};
  const a = harness.buildReport({options, settings, items: selected, outcome, startedAt: 'A', finishedAt: 'A'});
  const worse = structuredClone(outcome);
  worse.scores[1] = score.scoreItem(selected[1], {result: {...worse.scores[1], text: worse.scores[1].answer, verdict: 'accurate', sources: worse.scores[1].sources}});
  const b = harness.buildReport({options, settings, items: selected, outcome: worse, startedAt: 'B', finishedAt: 'B'});
  const {rows, flipped} = score.compare(a, b);
  assert.deepEqual(flipped, [{id: selected[1].id, from: 'pass', to: 'fail'}]);
  const accuracy = rows.find(row => row.key === 'verdictAccuracy');
  assert.equal(accuracy.a, 1);
  assert.equal(accuracy.b, 0.75);
  assert.equal(accuracy.delta, -0.25);
  assert.equal(rows.find(row => row.key === 'severeErrors').delta, 1);
  const markdown = score.renderComparison({rows, flipped}, a, b);
  assert.match(markdown, /\| Verdict accuracy \| 100\.0% \| 75\.0% \| -25\.0 pt \|/);
  assert.match(markdown, new RegExp(`\\| ${selected[1].id} \\| pass \\| fail \\|`));
  assert.throws(() => score.compare(a, {...b, run: {...b.run, stage: 'triage'}}), /Cannot compare/);
});

test('reports escape untrusted text in tables and cannot have their fences closed by an answer', async () => {
  const {items, harness, score} = await load();
  const item = {...items[1], id: 'pipe|tick`id'};
  const hostile = 'Result | `code` ```\n# Injected heading\n```';
  const scored = score.scoreItem(item, {result: {text: hostile, verdict: 'mixed', sources: []}});
  const settings = harness.evalSettings({provider: 'claude'});
  const report = harness.buildReport({options: {mode: 'mock', stage: 'verify', provider: 'claude', language: 'auto', maxUsd: 3}, settings, items: [item],
    outcome: {scores: [scored], totalUsd: 0, stoppedAtBudget: false}, startedAt: 'A', finishedAt: 'A'});
  const markdown = score.renderMarkdown(report);
  assert.match(markdown, /### pipe\\\|tick\\`id/);
  assert.equal(score.cell('a|b`c'), 'a\\|b\\`c');
  const fence = score.fenced(hostile);
  assert.equal((fence.match(/^```/gm) || []).length, 2);
  assert.ok(fence.includes('`\u200b``\n# Injected'));
  assert.ok(markdown.includes(fence));
});
