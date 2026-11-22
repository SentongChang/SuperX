// Evaluation harness for the post fact check (developer tooling; never
// shipped). It runs a dataset through the real provider code path,
// GrokFirstAPI.run or GrokFirstAPI.triage, with an injected fetch, so prompts,
// request building, stream parsing, the verdict marker and cost estimation are
// exactly what users get. Mock mode replays synthetic streams and makes no
// network call; it is what CI runs. See docs/EVAL.md.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compare, renderComparison, renderMarkdown, scoreItem, scoreTriage, summarize, summaryTable, validateItem, postOf } from './eval-score.mjs';

const require = createRequire(import.meta.url);
const Core = require('../extension/feed-core.js');
const Claude = require('../extension/claude-transport.js');
const API = require('../extension/api-provider.js');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DATASET = resolve(root, 'tools/fixtures/eval-posts.mjs');
const DEFAULT_OUT = resolve(root, 'artifacts/eval');
// Only connections that run headless. Keys come from these variables only.
export const PROVIDERS = Object.freeze({
  claude: Object.freeze({env: 'ANTHROPIC_API_KEY', host: 'api.anthropic.com', mockKey: 'sk-ant-eval-mock-key-0000', billing: 'the Anthropic Console'}),
  api: Object.freeze({env: 'XAI_API_KEY', host: 'api.x.ai', mockKey: 'xai-eval-mock-key-0000', billing: 'the xAI Console'})
});
const KEY_LIKE = /(?:sk-ant-|xai-)[A-Za-z0-9_-]{8,}/;
const RETRYABLE = new Set(['RATE_LIMIT', 'API_CAPACITY']);
const TIMEOUT_MS = 120000;
const LANGUAGE_IDS = Core.LANGUAGES.map(language => language.value);
export const EXIT = Object.freeze({ok: 0, threshold: 1, usage: 2, budget: 3});

export class UsageError extends Error {}

const HELP = `Usage: node tools/eval.mjs [options]
       node tools/eval.mjs --compare A.json B.json

Runs the fact-check evaluation set. Mock mode is the default: no network, no Key.

  --mock | --live            Mock replay (default) or a paid live run
  --provider claude|api      Connection (default claude). Live Keys come only
                             from ANTHROPIC_API_KEY or XAI_API_KEY
  --stage verify|triage      Fact check (default) or the Claude pre-screen
  --model ID                 Default: the extension's default for the provider
  --effort LEVEL             Default: the extension's default for the model
  --max-searches 1..10       Claude web searches per check (default 3)
  --language auto|TAG        Answer language (default auto); an item's own wins
  --prompt FILE              Custom fact-check task (explanation mode custom)
  --dataset FILE             .mjs exporting items, or .json (default: the committed set)
  --only ID,ID  --tag T,T    Select items; a tag matches item tags, language,
  --limit N                  difficulty or expected verdict, and all must match
  --repeat N                 Run each item N times and report verdict agreement
  --concurrency N            Default 2 live, 8 mock
  --max-usd X                Spend cap (default 3.00); exit 3 when reached
  --out DIR                  Report folder (default artifacts/eval)
  --min-verdict-accuracy X   Exit 1 when verdict accuracy is below X (0..1)
  --compare A.json B.json    Metric deltas (B minus A) and flipped items
  --help`;

const VALUE_FLAGS = new Set(['--provider', '--stage', '--model', '--effort', '--max-searches', '--language', '--prompt', '--dataset', '--only', '--tag',
  '--limit', '--repeat', '--concurrency', '--max-usd', '--out', '--min-verdict-accuracy']);
const SWITCHES = new Set(['--mock', '--live', '--help']);

function integer(flag, value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new UsageError(`${flag} must be a whole number from ${min} to ${max}.`);
  return number;
}
function list(value) { return value.split(',').map(part => part.trim()).filter(Boolean); }

export function parseArgs(argv) {
  if (argv.some(arg => KEY_LIKE.test(arg))) throw new UsageError('Keys are never accepted as command-line arguments. Set ANTHROPIC_API_KEY or XAI_API_KEY in the environment.');
  const raw = {};
  for (let index = 0; index < argv.length; index++) {
    const [flag, inline] = argv[index].split(/=(.*)/s);
    if (flag === '--compare') {
      raw.compare = argv.slice(index + 1, index + 3);
      if (raw.compare.length !== 2 || raw.compare.some(path => path.startsWith('--'))) throw new UsageError('--compare needs two report files.');
      index += 2;
    } else if (SWITCHES.has(flag)) raw[flag] = true;
    else if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? argv[++index];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value.`);
      raw[flag] = value;
    } else throw new UsageError(`Unknown option ${argv[index]}. Run with --help for usage.`);
  }
  if (raw['--mock'] && raw['--live']) throw new UsageError('Choose --mock or --live, not both.');
  const provider = raw['--provider'] ?? 'claude', stage = raw['--stage'] ?? 'verify', live = Boolean(raw['--live']);
  if (['oauth', 'build'].includes(provider)) throw new UsageError(`The ${provider} connection needs a browser sign-in or a local Grok CLI and cannot run headless. Use --provider claude or api.`);
  if (!Object.hasOwn(PROVIDERS, provider)) throw new UsageError(`Unknown provider ${provider}. Use claude or api.`);
  if (!['verify', 'triage'].includes(stage)) throw new UsageError('--stage must be verify or triage.');
  if (stage === 'triage' && !Core.providers.get(provider).caps.triage) throw new UsageError(`The ${provider} connection has no pre-screen; --stage triage needs --provider claude.`);
  if (stage === 'triage' && (raw['--model'] || raw['--effort'] || raw['--max-searches'] || raw['--prompt'] || raw['--min-verdict-accuracy']))
    throw new UsageError('The pre-screen always uses its fixed model and prompt; --model, --effort, --max-searches, --prompt and --min-verdict-accuracy apply to --stage verify.');
  const language = raw['--language'] ?? 'auto';
  if (!LANGUAGE_IDS.includes(language)) throw new UsageError(`--language must be one of ${LANGUAGE_IDS.join(', ')}.`);
  const maxUsd = raw['--max-usd'] === undefined ? 3 : Number(raw['--max-usd']);
  if (!(maxUsd > 0)) throw new UsageError('--max-usd must be a positive number.');
  const minVerdictAccuracy = raw['--min-verdict-accuracy'] === undefined ? null : Number(raw['--min-verdict-accuracy']);
  if (minVerdictAccuracy !== null && !(minVerdictAccuracy >= 0 && minVerdictAccuracy <= 1)) throw new UsageError('--min-verdict-accuracy must be from 0 to 1.');
  return {
    help: Boolean(raw['--help']), compare: raw.compare || null, mode: live ? 'live' : 'mock', provider, stage, language,
    model: raw['--model'] ?? null, effort: raw['--effort'] ?? null,
    maxSearches: raw['--max-searches'] === undefined ? null : integer('--max-searches', raw['--max-searches'], 1, 10),
    prompt: raw['--prompt'] ?? null, dataset: raw['--dataset'] ?? null,
    only: raw['--only'] ? list(raw['--only']) : [], tags: raw['--tag'] ? list(raw['--tag']) : [],
    limit: raw['--limit'] === undefined ? null : integer('--limit', raw['--limit'], 1, 10000),
    repeat: raw['--repeat'] === undefined ? 1 : integer('--repeat', raw['--repeat'], 1, 20),
    concurrency: raw['--concurrency'] === undefined ? (live ? 2 : 8) : integer('--concurrency', raw['--concurrency'], 1, 16),
    maxUsd, out: raw['--out'] ?? null, minVerdictAccuracy
  };
}

// The extension's own normalized settings for this run. A choice the
// extension would silently replace is a usage error here instead.
export function evalSettings({provider, stage = 'verify', language = 'auto', model = null, effort = null, maxSearches = null, prompt = null}) {
  const claude = provider === 'claude', input = {...Core.DEFAULT_SETTINGS, provider, language};
  if (model !== null) input[claude ? 'claudeModel' : 'apiModel'] = model;
  if (effort !== null) input[claude ? 'claudeEffort' : 'apiReasoningEffort'] = effort;
  if (maxSearches !== null) input.claudeMaxSearches = maxSearches;
  if (prompt !== null) Object.assign(input, {explanationMode: 'custom', verifyPrompt: prompt});
  const settings = Core.normalizeSettings(input);
  if (stage === 'triage') return settings;
  const chosenModel = Core.providerModel(settings);
  if (model !== null && (chosenModel !== model || claude && !Core.claudeModelProfile(model))) throw new UsageError(`--model ${model} is not a ${claude ? 'Claude' : 'text'} model the extension accepts${claude ? ` (${Core.CLAUDE_MODELS.map(item => item.value).join(', ')}; measure auto with --stage triage)` : ''}.`);
  if (!claude && Core.isNonTextGenerationModel(chosenModel)) throw new UsageError(`--model ${model} generates images or video and cannot fact-check posts.`);
  if (effort !== null && Core.providerEffort(settings) !== effort) throw new UsageError(`--effort ${effort} is not available for ${chosenModel}.`);
  if (prompt !== null && settings.verifyPrompt !== Core.normalizePrompt(prompt, '')) throw new UsageError('--prompt is empty or longer than the extension accepts.');
  return settings;
}

export async function loadDataset(file = DEFAULT_DATASET) {
  const path = resolve(file);
  let items;
  try {
    if (/\.m?js$/.test(path)) items = (await import(pathToFileURL(path).href)).items;
    else if (path.endsWith('.json')) { const value = JSON.parse(await readFile(path, 'utf8')); items = Array.isArray(value) ? value : value?.items; }
    else throw new UsageError('--dataset must be a .mjs or .json file.');
  } catch (error) {
    throw error instanceof UsageError ? error : new UsageError(`Cannot read dataset ${file}: ${error.message}`);
  }
  if (!Array.isArray(items) || !items.length) throw new UsageError(`Dataset ${file} has no items.`);
  const errors = items.flatMap((item, index) => validateItem(item, {committed: path === DEFAULT_DATASET}).map(error => `${item?.id || `#${index}`}: ${error}`));
  const seen = new Set();
  for (const item of items) { if (seen.has(item.id)) errors.push(`${item.id}: duplicate id`); seen.add(item.id); }
  if (errors.length) throw new UsageError(`Dataset ${file} is invalid:\n  ${errors.join('\n  ')}`);
  return items;
}

export function selectItems(items, {only = [], tags = [], limit = null}) {
  const labels = item => [...item.tags, item.expect.language, item.difficulty, item.expect.verdict];
  const unknown = only.filter(id => !items.some(item => item.id === id));
  if (unknown.length) throw new UsageError(`Unknown item id: ${unknown.join(', ')}.`);
  const selected = items.filter(item => (!only.length || only.includes(item.id)) && tags.every(tag => labels(item).includes(tag)));
  if (!selected.length) throw new UsageError('No items match the selection.');
  return limit ? selected.slice(0, limit) : selected;
}

// Synthetic provider streams. --------------------------------------------
const encoder = new TextEncoder();
const CLAUDE_USAGE = Object.freeze({input_tokens: 12000, cache_read_input_tokens: 2000, output_tokens: 400});
const TRIAGE_USAGE = Object.freeze({input_tokens: 900, output_tokens: 40});
const XAI_USAGE = Object.freeze({input_tokens: 12000, output_tokens: 400, total_tokens: 12400, cost_in_usd_ticks: 3e8});

function stream(text) { return new ReadableStream({start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); }}); }
function streamResponse(text) { return {ok: true, status: 200, headers: new Map(), body: stream(text)}; }
function unknownPost() {
  return {ok: false, status: 400, headers: new Map(), body: stream(JSON.stringify({type: 'error', error: {type: 'invalid_request_error', message: 'The mock knows no eval item for this request.'}}))};
}
function claudeEvents({model, text, sources = [], search, usage}) {
  const events = [{type: 'message_start', message: {model, usage: {input_tokens: usage.input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens || 0, output_tokens: 1}}}];
  let index = 0;
  if (search) {
    events.push({type: 'content_block_start', index, content_block: {type: 'server_tool_use', id: 'srvtoolu_eval', name: 'web_search', input: {}}},
      {type: 'content_block_delta', index, delta: {type: 'input_json_delta', partial_json: '{"query":"eval"}'}}, {type: 'content_block_stop', index});
    index++;
    events.push({type: 'content_block_start', index, content_block: {type: 'web_search_tool_result', tool_use_id: 'srvtoolu_eval',
      content: sources.map(source => ({type: 'web_search_result', url: source.url, title: source.title, encrypted_content: 'eval'}))}}, {type: 'content_block_stop', index});
    index++;
  }
  events.push({type: 'content_block_start', index, content_block: {type: 'text', text: ''}}, {type: 'content_block_delta', index, delta: {type: 'text_delta', text}});
  for (const source of sources) events.push({type: 'content_block_delta', index, delta: {type: 'citations_delta', citation: {type: 'web_search_result_location', url: source.url, title: source.title, cited_text: '', encrypted_index: 'eval'}}});
  events.push({type: 'content_block_stop', index},
    {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {...usage, ...(search ? {server_tool_use: {web_search_requests: 1}} : {})}}, {type: 'message_stop'});
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
function xaiEvents({model, text, sources, search}) {
  const deltas = text.match(/[\s\S]{1,40}/gu).map(delta => ({type: 'response.output_text.delta', delta}));
  const completed = {type: 'response.completed', response: {status: 'completed', model, output: [{type: 'message', content: [{type: 'output_text', text}]}],
    citations: sources, usage: {...XAI_USAGE, server_side_tool_usage_details: {web_search_calls: search ? 1 : 0}}}};
  return [...deltas, completed].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
}
// What a pre-screen would answer if it agreed with the item's labels.
function mockTriage(item) {
  return {checkable: item.checkable ? 'yes' : 'no', kind: item.checkable ? 'factual' : 'opinion', difficulty: item.difficulty, signals: []};
}

// A fetch that answers each request with the item's own mock answer, in the
// provider's stream shape, and never touches the network.
export function mockFetch(items, provider) {
  const byUrl = new Map(items.map(item => [item.post.url, item])), byText = new Map(items.map(item => [item.post.text, item]));
  const {host} = PROVIDERS[provider];
  return async (url, init) => {
    if (new URL(url).hostname !== host) throw new Error(`The ${provider} mock refuses ${url}.`);
    const body = JSON.parse(init.body);
    if (provider === 'claude' && body.system?.[0]?.text === Claude.TRIAGE_PROMPT) {
      const screened = JSON.parse(body.messages[0].content[0].text.slice(body.messages[0].content[0].text.indexOf('\n') + 1));
      const item = byText.get(screened.text);
      return item ? streamResponse(claudeEvents({model: body.model, text: JSON.stringify(mockTriage(item)), search: false, usage: TRIAGE_USAGE})) : unknownPost();
    }
    const item = byUrl.get(provider === 'claude' ? body.messages?.[0]?.content?.[0]?.text : body.input?.[0]?.content);
    if (!item) return unknownPost();
    const answer = {model: body.model, text: Core.formatVerdictLine(item.expect.verdict, item.mock.limits) + '\n' + item.mock.answer,
      sources: item.mock.sources, search: item.expect.searched !== false};
    return streamResponse(provider === 'claude' ? claudeEvents({...answer, usage: CLAUDE_USAGE}) : xaiEvents(answer));
  };
}

// The live fetch can reach the provider's own API host and nothing else.
export function liveFetch(provider) {
  const {host} = PROVIDERS[provider];
  return (url, init) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== host) throw new Error(`The eval harness only contacts ${host}; refused ${target.hostname}.`);
    return fetch(target, init);
  };
}

// Running. ---------------------------------------------------------------
function costOf(usage) {
  const ticks = usage?.cost_in_usd_ticks;
  return Number.isFinite(ticks) && ticks > 0 ? ticks / 1e10 : 0;
}
function errorRecord(error) {
  const visible = API.publicError(error);
  return {code: visible.code, ...(error?.verificationFailure?.code ? {failure: error.verificationFailure.code} : {}), message: visible.error};
}
async function checkOnce(post, settings, apiKey, fetchImpl) {
  const started = performance.now();
  let firstTextMs = null;
  const onUpdate = update => { if (firstTextMs === null && update.text) firstTextMs = performance.now() - started; };
  try {
    const result = await API.run(post, settings, apiKey, {signal: AbortSignal.timeout(TIMEOUT_MS), fetchImpl, onUpdate});
    return {result, error: null, latencyMs: performance.now() - started, firstTextMs, costUsd: costOf(result.usage)};
  } catch (error) {
    return {result: null, error: errorRecord(error), latencyMs: performance.now() - started, firstTextMs, costUsd: costOf(error?.usage)};
  }
}
// The worker's order: the free local pre-screen first, then the paid one.
async function screenOnce(post, settings, apiKey, fetchImpl) {
  const local = Core.triagePrefilter(post);
  if (local) return {screen: local, route: Core.triageRoute(local), error: null, latencyMs: 0, costUsd: 0};
  const started = performance.now();
  try {
    const value = await API.triage(post, settings, apiKey, {signal: AbortSignal.timeout(TIMEOUT_MS), fetchImpl});
    return {screen: value.triage, route: Core.triageRoute(value.triage), error: null, latencyMs: performance.now() - started, costUsd: costOf(value.usage)};
  } catch (error) {
    return {screen: null, route: null, error: errorRecord(error), latencyMs: performance.now() - started, costUsd: costOf(error?.usage)};
  }
}
function networkDisabled() { throw new Error('network disabled in mock mode'); }

// Runs every selected item `repeat` times with at most `concurrency` in
// flight. Once the estimated spend reaches `maxUsd`, nothing new starts.
export async function runEval({items, provider, stage = 'verify', mode = 'mock', settings, apiKey = PROVIDERS[provider].mockKey,
  concurrency = mode === 'live' ? 2 : 8, maxUsd = Infinity, repeat = 1, fetchImpl, retryDelayMs = mode === 'live' ? Core.AUTO_RETRY_DELAY_MS : 0}) {
  const transport = fetchImpl || (mode === 'mock' ? mockFetch(items, provider) : liveFetch(provider));
  const attempt = stage === 'triage' ? screenOnce : checkOnce, score = stage === 'triage' ? scoreTriage : scoreItem;
  const jobs = items.flatMap(item => Array.from({length: repeat}, (_, index) => ({item, repeat: index})));
  const scores = [];
  let next = 0, totalUsd = 0, stopped = false;
  async function worker() {
    while (!stopped && next < jobs.length) {
      const order = next++, {item, repeat: index} = jobs[order];
      // Labels, mock answers and references never reach a provider.
      const post = postOf(item), itemSettings = Core.normalizeSettings({...settings, ...item.settings});
      let outcome = await attempt(post, itemSettings, apiKey, transport), attempts = 1;
      if (RETRYABLE.has(outcome.error?.code)) {
        await new Promise(done => setTimeout(done, retryDelayMs));
        const retried = await attempt(post, itemSettings, apiKey, transport);
        outcome = {...retried, costUsd: retried.costUsd + outcome.costUsd};
        attempts = 2;
      }
      scores.push({order, score: score(item, {...outcome, attempts}, index)});
      totalUsd += outcome.costUsd;
      if (totalUsd >= maxUsd) stopped = true;
    }
  }
  const realFetch = globalThis.fetch;
  if (mode === 'mock') globalThis.fetch = networkDisabled;
  try {
    await Promise.all(Array.from({length: Math.min(concurrency, jobs.length)}, worker));
  } finally {
    globalThis.fetch = realFetch;
  }
  return {scores: scores.sort((a, b) => a.order - b.order).map(entry => entry.score), totalUsd, stoppedAtBudget: next < jobs.length};
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function gitCommit() {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: root, encoding: 'utf8'});
  return result.status === 0 ? result.stdout.trim() : '';
}
export function buildReport({options, settings, items, outcome, dataset = DEFAULT_DATASET, startedAt, finishedAt}) {
  const triage = options.stage === 'triage';
  const run = {
    mode: options.mode, stage: options.stage, provider: options.provider,
    model: triage ? Core.CLAUDE_TRIAGE_MODEL : Core.providerModel(settings), effort: triage ? 'low' : Core.providerEffort(settings),
    maxSearches: settings.claudeMaxSearches, language: options.language, repeat: options.repeat ?? 1,
    dataset: relative(root, resolve(dataset)) || basename(dataset), items: items.length, datasetSha256: sha256(JSON.stringify(items)),
    promptSha256: options.prompt ? sha256(options.prompt) : '', gitCommit: gitCommit(), node: process.version, startedAt, finishedAt,
    maxUsd: options.maxUsd ?? Infinity, totalUsd: outcome.totalUsd, stoppedAtBudget: outcome.stoppedAtBudget
  };
  return {run, summary: summarize(outcome.scores, {stage: options.stage, repeat: run.repeat}), scores: outcome.scores};
}

// Serializes the report, refusing to write anything that contains the Key.
export async function writeReport(report, outDir, apiKey) {
  const json = JSON.stringify(report, null, 2) + '\n', markdown = renderMarkdown(report);
  if (apiKey && (json.includes(apiKey) || markdown.includes(apiKey))) throw new Error('The report contains the API Key; nothing was written.');
  const {run} = report, stamp = run.startedAt.replace(/[:.]/g, '-');
  const name = [stamp, run.mode, run.provider, run.model, ...(run.stage === 'triage' ? ['triage'] : [])].join('-').replace(/[^A-Za-z0-9._-]/g, '_');
  await mkdir(outDir, {recursive: true});
  const paths = {json: resolve(outDir, name + '.json'), markdown: resolve(outDir, name + '.md')};
  await writeFile(paths.json, json);
  await writeFile(paths.markdown, markdown + '\n');
  return paths;
}

function liveLine(options, settings, count) {
  const work = options.stage === 'triage' ? `${Core.CLAUDE_TRIAGE_MODEL} pre-screen`
    : `${Core.providerModel(settings)} (effort ${Core.providerEffort(settings)}${options.provider === 'claude' ? `, <=${settings.claudeMaxSearches} searches` : ''})`;
  return `Live run: ${count} items x ${work}, spend cap $${options.maxUsd.toFixed(2)}. Results are estimates; ${PROVIDERS[options.provider].billing} is the billing record.`;
}

export async function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  const options = parseArgs(argv);
  if (options.help) { log(HELP); return EXIT.ok; }
  const outDir = resolve(options.out ?? DEFAULT_OUT);
  if (options.compare) {
    const [a, b] = await Promise.all(options.compare.map(async file => JSON.parse(await readFile(file, 'utf8'))));
    const markdown = renderComparison(compare(a, b), a, b), path = resolve(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-compare.md`);
    await mkdir(outDir, {recursive: true});
    await writeFile(path, markdown);
    log(markdown);
    log(`Wrote ${path}`);
    return EXIT.ok;
  }
  const {env: variable, mockKey} = PROVIDERS[options.provider];
  const apiKey = options.mode === 'live' ? env[variable]?.trim() : mockKey;
  if (!apiKey) throw new UsageError(`--live requires ${variable} in the environment. Keys are never accepted as command-line arguments.`);
  if (options.mode === 'live' && !(options.provider === 'claude' ? Claude.validKey(apiKey) : /^xai-/.test(apiKey))) log(`Warning: ${variable} does not look like a ${options.provider === 'claude' ? 'Claude' : 'xAI'} API Key.`);
  const prompt = options.prompt === null ? null : await readFile(options.prompt, 'utf8').catch(error => { throw new UsageError(`Cannot read --prompt: ${error.message}`); });
  const dataset = options.dataset ?? DEFAULT_DATASET;
  const items = selectItems(await loadDataset(dataset), options), settings = evalSettings({...options, prompt});
  if (options.mode === 'live') log(liveLine(options, settings, items.length * options.repeat));
  const startedAt = new Date().toISOString();
  const outcome = await runEval({items, provider: options.provider, stage: options.stage, mode: options.mode, settings, apiKey,
    concurrency: options.concurrency, maxUsd: options.maxUsd, repeat: options.repeat});
  const report = buildReport({options: {...options, prompt}, settings, items, outcome, dataset, startedAt, finishedAt: new Date().toISOString()});
  const paths = await writeReport(report, outDir, apiKey);
  if (options.mode === 'mock') log('MOCK - pipeline check only, not model quality.');
  log(summaryTable(options.stage, report.summary.metrics));
  log(`Wrote ${paths.markdown}\n      ${paths.json}`);
  if (outcome.stoppedAtBudget) { log(`Stopped at the spend cap after ${outcome.scores.length} of ${items.length * options.repeat} checks.`); return EXIT.budget; }
  const accuracy = report.summary.metrics.verdictAccuracy;
  if (options.minVerdictAccuracy !== null && !(accuracy >= options.minVerdictAccuracy)) {
    log(`Verdict accuracy ${(accuracy * 100).toFixed(1)}% is below --min-verdict-accuracy ${options.minVerdictAccuracy}.`);
    return EXIT.threshold;
  }
  return EXIT.ok;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(error instanceof UsageError ? error.message : `Eval failed: ${error.message}`);
    process.exitCode = EXIT.usage;
  });
}
