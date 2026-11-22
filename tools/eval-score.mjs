// Rule-based scoring for the evaluation harness (tools/eval.mjs). No I/O:
// the runner and the tests import it. Scores are regexes and enums only, so a
// run is free to score, repeatable and cannot be steered by model output.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Core = require('../extension/feed-core.js');
const API = require('../extension/api-provider.js');
const Sources = require('../extension/source-quality.js');

export const VERDICTS = Core.VERDICTS;
export const TAGS = Object.freeze(['short', 'injection', 'media', 'override', 'quote', 'truncated', 'rtl', 'cyrillic']);
const LANGUAGE_IDS = Core.LANGUAGES.map(language => language.value).filter(value => value !== 'auto');
const DIFFICULTIES = Core.TRIAGE_DIFFICULTY;
const CITATIONS = ['required', 'optional', 'none'];
// Fictional status ids under the fictional @superx_eval account only.
const FIRST_ID = 1900000000000000n, LAST_ID = 1900000000009999n;
const POST_FIELDS = new Set(['id', 'url', 'text', 'language', 'author', 'timestamp', 'hasMedia', 'images', 'quotedContext', 'textTruncated', 'hasVideo']);
const QUOTE_FIELDS = new Set([...POST_FIELDS].filter(field => field !== 'quotedContext'));
const ANSWER_EXCERPT = 600;

function compile(pattern) { return new RegExp(pattern, 'iu'); }
function patternErrors(list, label) {
  if (!Array.isArray(list)) return [`${label} must be a list`];
  return list.flatMap(pattern => {
    if (typeof pattern !== 'string' || !pattern) return [`${label} has an empty pattern`];
    try { compile(pattern); return []; } catch (error) { return [`${label} /${pattern}/ does not compile: ${error.message}`]; }
  });
}
function postErrors(value, label, fields, committed) {
  const errors = [];
  if (!value || typeof value !== 'object') return [`${label} is missing`];
  for (const key of Object.keys(value)) if (!fields.has(key)) errors.push(`${label}.${key} is not a captured post field`);
  if (typeof value.text !== 'string' || !value.text.trim()) errors.push(`${label}.text is empty`);
  if (!committed) {
    if (Core.canonicalPostUrl(value.url) !== value.url || !value.url.endsWith(`/status/${value.id}`)) errors.push(`${label}.url is not the canonical status URL of ${label}.id`);
    return errors;
  }
  const id = /^\d{16}$/.test(value.id) ? BigInt(value.id) : -1n;
  if (id < FIRST_ID || id > LAST_ID) errors.push(`${label}.id is outside the reserved fictional range`);
  if (value.url !== `https://x.com/superx_eval/status/${value.id}` || Core.canonicalPostUrl(value.url) !== value.url) errors.push(`${label}.url is not a canonical @superx_eval status URL`);
  if (value.author !== 'SuperX Eval') errors.push(`${label}.author must be 'SuperX Eval'`);
  if (!Array.isArray(value.images) || value.images.length) errors.push(`${label}.images must be empty (no committed media)`);
  return errors;
}

// Every problem with one dataset item, as readable messages. The committed
// set must also stay fictional; a private --dataset may hold real posts.
export function validateItem(item, {committed = true} = {}) {
  if (!item || typeof item !== 'object') return ['item is not an object'];
  const errors = [], {expect, mock} = item;
  if (typeof item.id !== 'string' || !/^[a-z0-9-]{3,60}$/.test(item.id)) errors.push('id must match /^[a-z0-9-]{3,60}$/');
  if (!Array.isArray(item.tags) || item.tags.some(tag => !TAGS.includes(tag))) errors.push(`tags must come from ${TAGS.join(', ')}`);
  if (!DIFFICULTIES.includes(item.difficulty)) errors.push(`difficulty must be ${DIFFICULTIES.join(' or ')}`);
  if (typeof item.checkable !== 'boolean') errors.push('checkable must be a boolean');
  errors.push(...postErrors(item.post, 'post', POST_FIELDS, committed));
  for (const [index, quote] of (Array.isArray(item.post?.quotedContext) ? item.post.quotedContext : []).entries()) errors.push(...postErrors(quote, `post.quotedContext[${index}]`, QUOTE_FIELDS, committed));
  if (item.settings !== undefined && (Object.keys(item.settings).join() !== 'language' || !LANGUAGE_IDS.includes(item.settings.language))) errors.push('settings may only set a supported language');
  if (!expect || typeof expect !== 'object') return [...errors, 'expect is missing'];
  if (!VERDICTS.includes(expect.verdict)) errors.push(`expect.verdict must be one of ${VERDICTS.join(', ')}`);
  if (!LANGUAGE_IDS.includes(expect.language)) errors.push('expect.language is not a supported answer language');
  if (!CITATIONS.includes(expect.citations)) errors.push(`expect.citations must be ${CITATIONS.join(', ')}`);
  if (expect.searched !== undefined && typeof expect.searched !== 'boolean') errors.push('expect.searched must be a boolean when set');
  if (!Array.isArray(expect.facts)) errors.push('expect.facts must be a list');
  else for (const fact of expect.facts) errors.push(...patternErrors(fact?.any, `expect.facts.${fact?.id}`));
  errors.push(...patternErrors(expect.forbid, 'expect.forbid'));
  if (expect.disclose !== undefined) errors.push(...patternErrors(expect.disclose, 'expect.disclose'));
  if (!Array.isArray(item.reference) || !item.reference.length || item.reference.some(url => !/^https:\/\/\S+$/.test(url))) errors.push('reference must list https URLs');
  if (typeof mock?.answer !== 'string' || !mock.answer.trim()) errors.push('mock.answer is empty');
  if (!Array.isArray(mock?.sources) || mock.sources.some(source => !/^https:\/\//.test(source?.url))) errors.push('mock.sources must list https URLs');
  if (mock?.limits !== undefined && (!Array.isArray(mock.limits) || mock.limits.some(gap => !['text', 'media', 'video'].includes(gap)))) errors.push('mock.limits must be text, media or video');
  return errors;
}

// The only part of an item a provider ever sees.
export function postOf(item) { return structuredClone(item.post); }

function visibleText(result) { return String(result?.text || '').normalize('NFKC'); }
function languageOk(text, language) {
  if (!text.trim()) return false;
  try { API.assertMatchingScript(text, language); return true; } catch { return false; }
}
function costOf(usage) {
  const ticks = usage?.cost_in_usd_ticks;
  return Number.isFinite(ticks) && ticks > 0 ? ticks / 1e10 : 0;
}
function severe(expected, got) {
  return expected === 'accurate' && got === 'inaccurate' || expected === 'inaccurate' && got === 'accurate' || expected === 'inaccurate' && got === 'none';
}

// Scores one fact-check outcome: {result|null, error|null, latencyMs,
// firstTextMs, attempts, costUsd}. Unmeasurable checks are null.
export function scoreItem(item, outcome, repeat = 0) {
  const {expect} = item, result = outcome.result || null, error = outcome.error || null;
  const text = visibleText(result), sources = Array.isArray(result?.sources) ? result.sources : [];
  const verdict = result && VERDICTS.includes(result.verdict) ? result.verdict : null;
  const matchedFacts = expect.facts.filter(fact => fact.any.some(pattern => compile(pattern).test(text)));
  const score = {
    id: item.id, repeat, language: expect.language, difficulty: item.difficulty, expected: expect.verdict, tags: [...item.tags],
    verdict, verdictOk: verdict === expect.verdict, verdictMissing: result ? !verdict : null, severe: Boolean(result) && severe(expect.verdict, verdict),
    factRecall: result && expect.facts.length ? matchedFacts.length / expect.facts.length : null,
    missingFacts: result ? expect.facts.filter(fact => !matchedFacts.includes(fact)).map(fact => fact.id) : [],
    forbidHit: Boolean(result) && expect.forbid.some(pattern => compile(pattern).test(text)),
    citationsOk: result && expect.citations === 'required' ? sources.length > 0 : null,
    strongSource: result && expect.citations === 'required' ? sources.some(source => Sources.STRONG.includes(Sources.tier(source.url))) : null,
    languageOk: error?.code === 'API_LANGUAGE_MISMATCH' ? false : result ? languageOk(text, expect.language) : null,
    searched: result ? result.searched === true : null,
    searchedOk: result && typeof expect.searched === 'boolean' ? result.searched === expect.searched : null,
    disclosureOk: result && expect.disclose ? expect.disclose.some(pattern => compile(pattern).test(text)) : null,
    gaps: Array.isArray(result?.gaps) ? [...result.gaps] : [],
    status: result?.verificationStatus || 'error',
    error, costUsd: outcome.costUsd ?? costOf(result?.usage), latencyMs: outcome.latencyMs, firstTextMs: outcome.firstTextMs ?? null, attempts: outcome.attempts ?? 1,
    answer: result?.text || '', sources, usage: result?.usage || {}, model: result?.model || ''
  };
  score.failed = [
    error && 'error', !score.verdictOk && 'verdict', score.factRecall !== null && score.factRecall < 0.5 && 'facts', score.forbidHit && 'forbid',
    score.languageOk === false && 'language', score.citationsOk === false && 'citations', score.disclosureOk === false && 'disclosure'
  ].filter(Boolean);
  score.pass = !score.failed.length;
  return score;
}

// Scores one pre-screen outcome: {screen|null, route|null, error|null,
// latencyMs, costUsd}. `screen` is the free local skip or the model codes.
export function scoreTriage(item, outcome, repeat = 0) {
  const screen = outcome.screen || null, error = outcome.error || null, skipped = screen?.checkable === 'no';
  const score = {
    id: item.id, repeat, language: item.expect.language, difficulty: item.difficulty, expectedCheckable: item.checkable, tags: [...item.tags],
    local: screen?.local === true, checkable: screen?.checkable || null, kind: screen?.kind || null, screenedDifficulty: screen?.difficulty || null,
    signals: screen?.signals ? [...screen.signals] : [], skipped,
    falseSkip: item.checkable && skipped, missedSkip: !item.checkable && Boolean(screen) && !skipped,
    route: outcome.route ? {...outcome.route} : null,
    // Auto routing matters only for posts that will be checked.
    routeOk: item.checkable && outcome.route ? (outcome.route.model === Core.CLAUDE_HARD_MODEL) === (item.difficulty === 'hard') : null,
    error, costUsd: outcome.costUsd ?? 0, latencyMs: outcome.latencyMs, attempts: outcome.attempts ?? 1
  };
  score.failed = [error && 'error', score.falseSkip && 'false-skip', score.missedSkip && 'missed-skip', score.routeOk === false && 'route'].filter(Boolean);
  score.pass = !score.failed.length;
  return score;
}

function share(list, pick) {
  const values = list.map(pick).filter(value => typeof value === 'boolean');
  return values.length ? values.filter(Boolean).length / values.length : null;
}
function mean(values) {
  const known = values.filter(Number.isFinite);
  return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
}
// Nearest-rank percentile.
export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
}
function tally(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}
function groups(scores, keysOf) {
  const result = {};
  for (const score of scores) for (const key of keysOf(score)) (result[key] ||= []).push(score);
  return result;
}
function common(scores) {
  const total = scores.reduce((sum, score) => sum + score.costUsd, 0);
  return {
    items: scores.length, passRate: share(scores, score => score.pass), errorRate: share(scores, score => Boolean(score.error)),
    latencyP50Ms: percentile(scores.map(score => score.latencyMs), 0.5), latencyP90Ms: percentile(scores.map(score => score.latencyMs), 0.9),
    totalUsd: total, meanUsd: scores.length ? total / scores.length : null
  };
}
function verdictMetrics(scores) {
  const correct = scores.filter(score => score.verdictOk).length;
  return {
    ...common(scores),
    verdictAccuracy: scores.length ? correct / scores.length : null,
    verdictNullRate: share(scores, score => score.verdictMissing),
    severeErrors: scores.filter(score => score.severe).length,
    factRecall: mean(scores.map(score => score.factRecall)),
    forbidHits: scores.filter(score => score.forbidHit).length,
    citationRate: share(scores, score => score.citationsOk),
    strongSourceRate: share(scores, score => score.strongSource),
    languageCompliance: share(scores, score => score.languageOk),
    searchRate: share(scores, score => score.searched),
    searchAgreement: share(scores, score => score.searchedOk),
    incompleteRate: share(scores, score => score.status === 'incomplete'),
    disclosureRate: share(scores, score => score.disclosureOk),
    firstTextP50Ms: percentile(scores.map(score => score.firstTextMs), 0.5), firstTextP90Ms: percentile(scores.map(score => score.firstTextMs), 0.9),
    usdPerCorrect: correct ? scores.reduce((sum, score) => sum + score.costUsd, 0) / correct : null
  };
}
function triageMetrics(scores) {
  const checkable = scores.filter(score => score.expectedCheckable), other = scores.filter(score => !score.expectedCheckable);
  return {
    ...common(scores),
    falseSkipRate: share(checkable, score => score.error ? null : score.falseSkip),
    noClaimSkipRate: share(other, score => score.error ? null : score.skipped),
    localSkips: scores.filter(score => score.local).length,
    routeAgreement: share(scores, score => score.routeOk)
  };
}
// Share of items whose verdict was identical in every repeat.
function agreement(scores) {
  const byItem = Object.values(groups(scores, score => [score.id]));
  return byItem.length ? byItem.filter(list => new Set(list.map(score => score.verdict)).size === 1).length / byItem.length : null;
}

export function summarize(scores, {stage = 'verify', repeat = 1} = {}) {
  const triage = stage === 'triage', metricsOf = triage ? triageMetrics : verdictMetrics;
  const metrics = metricsOf(scores);
  if (!triage && repeat > 1) metrics.verdictAgreement = agreement(scores);
  const brief = list => {
    const value = metricsOf(list);
    return triage ? {items: value.items, passRate: value.passRate, routeAgreement: value.routeAgreement}
      : {items: value.items, passRate: value.passRate, verdictAccuracy: value.verdictAccuracy};
  };
  const breakdown = keysOf => Object.fromEntries(Object.entries(groups(scores, keysOf)).sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => [key, brief(list)]));
  const summary = {
    metrics, errors: tally(scores.filter(score => score.error).map(score => score.error.code || 'UNKNOWN')),
    breakdowns: {
      language: breakdown(score => [score.language]), difficulty: breakdown(score => [score.difficulty]),
      ...(triage ? {checkable: breakdown(score => [score.expectedCheckable ? 'checkable' : 'no claim'])} : {verdict: breakdown(score => [score.expected])}),
      tag: breakdown(score => score.tags)
    },
    failures: scores.filter(score => !score.pass).map(score => ({id: score.id, repeat: score.repeat, failed: score.failed,
      ...(triage ? {screen: [score.checkable, score.kind, score.screenedDifficulty].filter(Boolean).join(' / '), route: score.route?.reason || ''} : {answer: score.answer.slice(0, ANSWER_EXCERPT)})}))
  };
  if (!triage) {
    const columns = [...VERDICTS, 'null', 'error'];
    summary.confusion = {columns, rows: Object.fromEntries(VERDICTS.map(expected => [expected, Object.fromEntries(columns.map(column => [column,
      scores.filter(score => score.expected === expected && (column === 'error' ? score.error : column === 'null' ? !score.error && !score.verdict : score.verdict === column)).length]))]))};
  }
  return summary;
}

const RATE = 'rate', USD = 'usd', MS = 'ms', COUNT = 'count', MEAN = 'mean';
const METRICS = Object.freeze({
  verify: [['passRate', 'Pass rate', RATE], ['verdictAccuracy', 'Verdict accuracy', RATE], ['verdictNullRate', 'Verdict missing (marker miss)', RATE],
    ['severeErrors', 'Severe verdict errors', COUNT], ['factRecall', 'Key-fact recall', MEAN], ['forbidHits', 'Forbidden-claim hits', COUNT],
    ['citationRate', 'Citations on required items', RATE], ['strongSourceRate', 'Official, academic or news source', RATE],
    ['languageCompliance', 'Language compliance', RATE], ['searchRate', 'Search used', RATE], ['searchAgreement', 'Search matched expectation', RATE],
    ['incompleteRate', 'Incomplete', RATE], ['disclosureRate', 'Gap disclosed in answer', RATE], ['errorRate', 'Errors', RATE],
    ['verdictAgreement', 'Verdict agreement across repeats', RATE],
    ['latencyP50Ms', 'Latency p50', MS], ['latencyP90Ms', 'Latency p90', MS], ['firstTextP50Ms', 'First text p50', MS], ['firstTextP90Ms', 'First text p90', MS],
    ['totalUsd', 'Estimated cost, total', USD], ['meanUsd', 'Estimated cost per item', USD], ['usdPerCorrect', 'Estimated cost per correct verdict', USD]],
  triage: [['passRate', 'Pass rate', RATE], ['falseSkipRate', 'False skips (checkable posts screened out)', RATE], ['noClaimSkipRate', 'No-claim posts skipped', RATE],
    ['localSkips', 'Skipped by the free local pre-screen', COUNT], ['routeAgreement', 'Auto route agrees with difficulty', RATE], ['errorRate', 'Errors', RATE],
    ['latencyP50Ms', 'Latency p50', MS], ['latencyP90Ms', 'Latency p90', MS], ['totalUsd', 'Estimated cost, total', USD], ['meanUsd', 'Estimated cost per item', USD]]
});
function format(value, kind) {
  if (value === null || value === undefined) return 'n/a';
  if (kind === RATE) return `${(value * 100).toFixed(1)}%`;
  if (kind === USD) return `$${value.toFixed(4)}`;
  if (kind === MS) return `${Math.round(value)} ms`;
  if (kind === MEAN) return value.toFixed(2);
  return String(value);
}
function signed(value, kind) {
  if (!Number.isFinite(value)) return 'n/a';
  const text = kind === RATE ? `${(value * 100).toFixed(1)} pt` : format(Math.abs(value), kind);
  return (value > 0 ? '+' : value < 0 ? '-' : '±') + (kind === RATE ? text.replace(/^-/, '') : text);
}
// Untrusted text (answers, ids from a private dataset) inside a table cell.
export function cell(value) { return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/([|`\\])/g, '\\$1'); }
// Untrusted text inside a fenced block: a ``` run cannot close the fence.
export function fenced(value) { return '```text\n' + String(value ?? '').replace(/```/g, '`\u200b``') + '\n```'; }
function table(head, rows) { return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n'); }
export function metricRows(stage, metrics) { return METRICS[stage].filter(([key]) => key in metrics); }
export function summaryTable(stage, metrics) {
  return table(['Metric', 'Value'], metricRows(stage, metrics).map(([key, label, kind]) => [label, format(metrics[key], kind)]));
}

export function renderMarkdown({run, summary}) {
  const triage = run.stage === 'triage', lines = [`# SuperX eval: ${cell(run.stage)} · ${cell(run.provider)} · ${cell(run.model)}`, ''];
  if (run.mode === 'mock') lines.push('**MOCK - pipeline check only, not model quality.**', '');
  if (run.stoppedAtBudget) lines.push(`**Stopped at the spend cap ($${run.maxUsd.toFixed(2)}); this is a partial report.**`, '');
  lines.push(table(['Run', 'Value'], [
    ['Mode', run.mode], ['Stage', run.stage], ['Provider', run.provider], ['Model', run.model], ['Effort', run.effort],
    ...(run.provider === 'claude' && !triage ? [['Max searches', run.maxSearches]] : []), ['Language', run.language], ['Repeats', run.repeat],
    ['Dataset', `${run.dataset} (${run.items} items, sha256 ${run.datasetSha256.slice(0, 12)})`], ['Prompt sha256', run.promptSha256 ? run.promptSha256.slice(0, 12) : 'preset'],
    ['Git commit', run.gitCommit || 'unknown'], ['Node', run.node], ['Started', run.startedAt], ['Finished', run.finishedAt]
  ].map(([key, value]) => [key, cell(value)])), '', '## Summary', '');
  lines.push(summaryTable(run.stage, summary.metrics), '');
  if (!triage) lines.push('Costs are estimates from the local price table; the provider console is the billing record. ' +
    'Language compliance detects only a change of writing system, not es versus fr.', '');
  if (Object.keys(summary.errors).length) lines.push('## Errors', '', table(['Code', 'Items'], Object.entries(summary.errors).map(([code, count]) => [cell(code), count])), '');
  if (summary.confusion) {
    lines.push('## Verdict confusion (rows expected, columns returned)', '',
      table(['Expected', ...summary.confusion.columns], Object.entries(summary.confusion.rows).map(([expected, row]) => [expected, ...summary.confusion.columns.map(column => row[column])])), '');
  }
  const accuracyKey = triage ? 'routeAgreement' : 'verdictAccuracy', accuracyLabel = triage ? 'Route agreement' : 'Verdict accuracy';
  for (const [name, breakdown] of Object.entries(summary.breakdowns)) {
    if (!Object.keys(breakdown).length) continue;
    lines.push(`## By ${name}`, '', table([name[0].toUpperCase() + name.slice(1), 'Items', 'Pass', accuracyLabel],
      Object.entries(breakdown).map(([key, value]) => [cell(key), value.items, format(value.passRate, RATE), format(value[accuracyKey], RATE)])), '');
  }
  lines.push('## Failures', '');
  if (!summary.failures.length) lines.push('None.', '');
  for (const failure of summary.failures) {
    lines.push(`### ${cell(failure.id)}${run.repeat > 1 ? ` (repeat ${failure.repeat + 1})` : ''}`, '', `Failed: ${failure.failed.map(cell).join(', ')}`, '');
    if (triage) lines.push(`Screen: ${cell(failure.screen || 'none')} · route: ${cell(failure.route || 'none')}`, '');
    else lines.push(fenced(failure.answer), '');
  }
  return lines.join('\n');
}

// Metric deltas (b minus a) and the items whose pass/fail result flipped.
export function compare(a, b) {
  if (a.run.stage !== b.run.stage) throw new Error(`Cannot compare a ${a.run.stage} report with a ${b.run.stage} report.`);
  const rows = metricRows(a.run.stage, {...a.summary.metrics, ...b.summary.metrics}).map(([key, label, kind]) => {
    const before = a.summary.metrics[key] ?? null, after = b.summary.metrics[key] ?? null;
    return {key, label, kind, a: before, b: after, delta: Number.isFinite(before) && Number.isFinite(after) ? after - before : null};
  });
  const passes = report => new Map(Object.entries(groups(report.scores, score => [score.id])).map(([id, list]) => [id, list.every(score => score.pass)]));
  const before = passes(a), after = passes(b);
  const flipped = [...before].filter(([id, pass]) => after.has(id) && after.get(id) !== pass).map(([id, pass]) => ({id, from: pass ? 'pass' : 'fail', to: pass ? 'fail' : 'pass'}));
  return {rows, flipped};
}

export function renderComparison({rows, flipped}, a, b) {
  const label = report => `${report.run.mode} · ${report.run.provider} · ${report.run.model} · ${report.run.startedAt}`;
  return [`# SuperX eval comparison: ${cell(a.run.stage)}`, '', `A: ${cell(label(a))}`, `B: ${cell(label(b))}`, '',
    table(['Metric', 'A', 'B', 'B - A'], rows.map(row => [row.label, format(row.a, row.kind), format(row.b, row.kind), signed(row.delta, row.kind)])), '',
    '## Flipped items', '', flipped.length ? table(['Item', 'A', 'B'], flipped.map(item => [cell(item.id), item.from, item.to])) : 'None.', ''].join('\n');
}
