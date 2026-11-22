'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/feed-core.js');

const image = 'https://pbs.twimg.com/media/Example.jpg';
const thumbnail = 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/frame.jpg';
const gaps = (post, settings, extra = {}) => core.checkGaps({post, settings, searched:true, ...extra});

test('the verdict marker is stripped and mapped from tolerated decorations', () => {
  assert.deepEqual(core.verdictOutput('VERDICT: MIXED\n\nBody'), {text:'Body', verdict:'mixed', limits:[], pending:false});
  for (const [line, verdict] of [['**Verdict: accurate**', 'accurate'], ['`VERDICT：FALSE`', 'inaccurate'], ['# VERDICT: NO_CLAIM', 'none'],
    ['VERDICT: INSUFFICIENT_EVIDENCE', 'unproven'], ['> VERDICT: misleading', 'mixed']]) {
    const output = core.verdictOutput(`${line}\nFindings.`);
    assert.equal(output.verdict, verdict, line); assert.equal(output.text, 'Findings.', line);
  }
});

test('the marker lists only known limits in canonical order', () => {
  const output = core.verdictOutput('VERDICT: MIXED; LIMITS: video, MEDIA, images, SOUND\nBody');
  assert.deepEqual(output.limits, ['media', 'video']); assert.equal(output.text, 'Body');
});

test('an unknown code is still removed, while text without a first-line marker is untouched', () => {
  assert.deepEqual(core.verdictOutput('VERDICT: MAYBE\nBody'), {text:'Body', verdict:null, limits:[], pending:false});
  const later = 'First finding.\n\nSecond finding.\nVERDICT: ACCURATE';
  assert.deepEqual(core.verdictOutput(later, {final:true}), {text:later, verdict:null, limits:[], pending:false});
  assert.equal(core.verdictOutput(undefined).text, '');
});

test('a streaming first line is held back only while it can still become the marker', () => {
  for (const value of ['', 'VER', '**Verd', 'VERDICT: MIX']) assert.deepEqual(core.verdictOutput(value), {text:'', verdict:null, limits:[], pending:true}, value);
  assert.equal(core.verdictOutput('Verizon reported').pending, false);
  assert.equal(core.verdictOutput('Verizon reported').text, 'Verizon reported');
  const long = 'VERDICT ' + 'x'.repeat(160);
  assert.deepEqual(core.verdictOutput(long), {text:long, verdict:null, limits:[], pending:false});
  assert.deepEqual(core.verdictOutput('VERDICT: MIXED', {final:true}), {text:'', verdict:'mixed', limits:[], pending:false});
  assert.equal(core.verdictOutput('VER', {final:true}).text, 'VER');
});

test('formatVerdictLine is the inverse of verdictOutput', () => {
  for (const verdict of core.VERDICTS) for (const limits of [[], ['video', 'text'], ['media', 'search']]) {
    const output = core.verdictOutput(core.formatVerdictLine(verdict, limits) + '\nBody');
    assert.equal(output.verdict, verdict); assert.deepEqual(output.limits, core.CHECK_GAPS.filter(gap => gap !== 'search' && limits.includes(gap)));
  }
  assert.equal(core.formatVerdictLine('unproven', ['video', 'text']), 'VERDICT: UNPROVEN; LIMITS: TEXT,VIDEO');
  assert.equal(core.formatVerdictLine('maybe'), '');
});

test('truncated text is a gap unless the connection can read the post from X itself', () => {
  const post = {textTruncated:true};
  assert.deepEqual(gaps(post, {provider:'claude', xSearch:true}), ['text']);
  assert.deepEqual(gaps(post, {provider:'api', xSearch:true}), []);
  assert.deepEqual(gaps(post, {provider:'api', xSearch:false}), ['text']);
  assert.deepEqual(gaps(post, {provider:'api', xSearch:true}, {limits:['text']}), ['text'], 'A failed X read is reported through LIMITS');
});

test('video is a gap for connections that only see a still frame', () => {
  const post = {hasMedia:true, hasVideo:true, images:[{url:thumbnail, kind:'video-thumbnail'}]};
  assert.deepEqual(gaps(post, {provider:'claude', xSearch:true}), ['video']);
  assert.deepEqual(gaps(post, {provider:'oauth', xSearch:true}), [], 'A video thumbnail never counts as an unread image');
  assert.deepEqual(gaps(post, {provider:'oauth', xSearch:true}, {limits:['video']}), ['video']);
  assert.deepEqual(gaps(post, {provider:'build', xSearch:false}), ['video']);
});

test('image gaps count only the target post, and drafts only their unsent attachments', () => {
  const settings = {provider:'api', xSearch:true};
  assert.deepEqual(gaps({hasMedia:true, images:[{url:image}]}, settings), []);
  assert.deepEqual(gaps({hasMedia:true, images:[{url:image}, {url:'https://example.com/elsewhere.jpg'}]}, settings), ['media']);
  assert.deepEqual(gaps({hasMedia:true, images:[]}, settings), ['media'], 'Media without a readable image');
  assert.deepEqual(gaps({text:'', quotedContext:[{hasMedia:true, images:[]}]}, settings), [], 'Quoted media is reported only by the model');
  assert.deepEqual(gaps({kind:'draft', hasUncheckedMedia:true, textTruncated:true, hasVideo:true}, settings, {limits:['text', 'video']}), ['media']);
  assert.deepEqual(gaps({kind:'draft', hasMedia:true, images:[{url:'data:image/png;base64,AAAA'}]}, settings), []);
});

test('a missing search is a gap unless there was no checkable claim, and order is canonical', () => {
  const settings = {provider:'claude'};
  assert.deepEqual(core.checkGaps({post:{}, settings, searched:false, verdict:'accurate'}), ['search']);
  assert.deepEqual(core.checkGaps({post:{}, settings, searched:false, verdict:null}), ['search']);
  assert.deepEqual(core.checkGaps({post:{}, settings, searched:false, verdict:'none'}), []);
  assert.deepEqual(core.checkGaps({post:{textTruncated:true, hasVideo:true, hasMedia:true, images:[]}, settings, searched:false, limits:['video', 'media']}),
    ['text', 'media', 'video', 'search']);
});

test('verdictView re-validates stored data and marks unsupported verdicts as tentative', () => {
  assert.deepEqual(core.verdictView({verdict:'maybe', gaps:['search', 'later', 'text', 'text']}), {verdict:null, gaps:['text', 'search'], tentative:false});
  assert.deepEqual(core.verdictView(undefined), {verdict:null, gaps:[], tentative:false});
  for (const verdict of core.VERDICTS) {
    assert.equal(core.verdictView({verdict, gaps:['search']}).tentative, ['accurate', 'inaccurate', 'mixed'].includes(verdict), verdict);
    assert.equal(core.verdictView({verdict, gaps:['media']}).tentative, false, verdict);
  }
});

test('verdictRow supplies translated labels, tooltips and one accessible summary', () => {
  const t = (key, vars = {}) => key + (Object.keys(vars).length ? JSON.stringify(vars) : '');
  const row = core.verdictRow({verdict:'mixed', gaps:['media', 'search']}, t);
  assert.equal(row.label, 'verdict.mixed'); assert.equal(row.prefix, 'gaps.label'); assert.equal(row.tentative, true); assert.equal(row.empty, false);
  assert.deepEqual(row.gaps, [{gap:'media', label:'gaps.media', title:'gaps.mediaTitle'}, {gap:'search', label:'gaps.search', title:'gaps.searchTitle'}]);
  assert.equal(row.aria, 'verdict.aria{"verdict":"verdict.mixed"}. gaps.aria{"gaps":"gaps.media, gaps.search"}');
  assert.equal(core.verdictRow({}, t).empty, true);
  assert.equal(core.verdictRow({gaps:['text']}, t).aria, 'gaps.aria{"gaps":"gaps.text"}');
});
