'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Sources = require('../extension/source-quality.js');
const core = require('../extension/feed-core.js');
const ui = require('../extension/ui-i18n.js');

const expectTier = (tier, urls) => { for (const url of urls) assert.equal(Sources.tier(url), tier, url); };

test('government, intergovernmental and national patterns are labelled official', () => {
  expectTier('official', ['https://www.cdc.gov/x', 'https://www.gov.uk/y', 'https://stats.gov.cn', 'https://who.int', 'https://ec.europa.eu/z',
    'https://www.mhlw.go.jp', 'https://www.canada.ca', 'https://www.army.mil', 'https://www.gob.mx', 'https://www.service-public.gouv.fr',
    'https://www.govt.nz', 'https://www.canada.gc.ca', 'https://pubmed.ncbi.nlm.nih.gov/1']);
});

test('universities, preprint servers, journals and the DOI resolver are labelled academic', () => {
  expectTier('academic', ['https://mit.edu', 'https://www.ox.ac.uk', 'https://arxiv.org/abs/1', 'https://www.nature.com/a', 'https://doi.org/10.1/x', 'https://www.unsw.edu.au', 'https://www.u-tokyo.ac.jp']);
});

test('wire services and fact-checkers are news; encyclopedias are reference; open platforms are social', () => {
  expectTier('news', ['https://www.reuters.com/a', 'https://apnews.com', 'https://www.afp.com/en', 'https://factcheck.afp.com/x', 'https://en.yna.co.kr/view/1', 'https://www.snopes.com', 'https://fullfact.org/a']);
  expectTier('reference', ['https://en.wikipedia.org/wiki/X', 'https://zh.m.wikipedia.org/wiki/X', 'https://www.britannica.com/topic/x', 'https://archive.org/details/x', 'https://web.archive.org/details/x']);
  expectTier('social', ['https://x.com/u/status/1', 'https://foo.substack.com', 'https://user.github.io', 'https://gist.github.com/a', 'https://youtu.be/x', 'https://t.co/abc', 'https://www.youtube.com/watch?v=1']);
});

test('unlisted publishers fall back to other rather than a judgement', () => {
  expectTier('other', ['https://www.nytimes.com/a', 'https://example.com', 'https://abcnews.go.com/x', 'https://blog.example.org/post']);
});

test('lookalike hosts, unsafe schemes and malformed input are never promoted', () => {
  expectTier('other', ['https://gov.uk.evil.com', 'https://notgov.uk', 'https://evil-gov.com', 'https://gov.com', 'https://reuters.com.evil.net', 'https://go.com',
    'https://xn--reuters-xxx.com', 'https://notreuters.com', 'http://127.0.0.1', 'http://[::1]', 'http://gov/', 'javascript:alert(1)', 'ftp://x.gov',
    'https://user:pw@cdc.gov', 'not-a-url', undefined, null, 42]);
});

test('case and a trailing dot do not change the label', () => {
  assert.equal(Sources.tier('HTTPS://WWW.REUTERS.COM./a'), 'news');
  assert.equal(Sources.displayHost('HTTPS://WWW.REUTERS.COM./a'), 'reuters.com');
});

test('a Wayback capture is labelled by its original page, unwrapped only once', () => {
  assert.equal(Sources.tier('https://web.archive.org/web/2020id_/https://www.cdc.gov/x'), 'official');
  assert.equal(Sources.tier('https://web.archive.org/web/20200101000000/https://www.reuters.com/a?b=1'), 'news');
  assert.equal(Sources.tier('https://web.archive.org/web/1/https://web.archive.org/web/2/https://www.cdc.gov/x'), 'reference');
  assert.equal(Sources.tier('https://web.archive.org/web/2020/http://%zz'), 'reference');
  assert.equal(Sources.tier('https://web.archive.org/web/2020/javascript:alert(1)'), 'reference');
});

test('the curated lists are lean, normalized, sorted and disjoint', () => {
  assert.deepEqual(Sources.TIERS, ['official', 'academic', 'news', 'reference', 'social', 'other']);
  assert.deepEqual(Sources.STRONG, ['official', 'academic', 'news']);
  assert.deepEqual(Object.keys(Sources.DOMAINS), Sources.TIERS.filter(tier => tier !== 'other'));
  const all = Object.values(Sources.DOMAINS).flat();
  for (const [tier, list] of Object.entries(Sources.DOMAINS)) {
    assert.deepEqual([...list].sort(), list, `${tier} is sorted`);
    for (const domain of list) {
      assert.match(domain, /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/, domain);
      assert.doesNotMatch(domain, /^www\./, domain);
      assert.equal(Sources.tier(`https://${domain}/`), tier, domain);
    }
  }
  assert.equal(new Set(all).size, all.length, 'no domain is listed twice');
  assert.ok(all.length <= 70, `the seed list stays lean (${all.length})`);
  assert.ok(Object.isFrozen(Sources.DOMAINS) && Object.values(Sources.DOMAINS).every(Object.isFrozen));
});

test('displayHost drops one www. or m. prefix and rejects unsafe input', () => {
  assert.equal(Sources.displayHost('https://m.youtube.com/watch'), 'youtube.com');
  assert.equal(Sources.displayHost('https://www.bbc.co.uk/news'), 'bbc.co.uk');
  assert.equal(Sources.displayHost('https://en.m.wikipedia.org/wiki/X'), 'en.m.wikipedia.org');
  assert.equal(Sources.displayHost('javascript:alert(1)'), '');
  assert.equal(Sources.displayHost('https://user:pw@cdc.gov'), '');
});

test('summarize dedupes pages, skips the checked post and flags answers without a strong source', () => {
  const summary = Sources.summarize([
    'https://www.reuters.com/a#top', 'https://www.reuters.com/a', 'https://x.com/someone/status/2', 'not-a-url',
    'https://x.com/author/status/1/photo/1', 'https://twitter.com/i/web/status/1', 'https://x.com/author/status/10'
  ], { exclude: ['https://x.com/author/status/1'] });
  assert.deepEqual(summary.counts, { official: 0, academic: 0, news: 1, reference: 0, social: 2, other: 0 });
  assert.equal(summary.total, 3);assert.equal(summary.strong, 1);assert.equal(summary.weak, false);
  for (const urls of [['https://x.com/a/status/3'], ['https://en.wikipedia.org/wiki/X'], ['https://example.com']]) assert.equal(Sources.summarize(urls).weak, true, urls[0]);
  assert.deepEqual(Sources.summarize([]), { counts: { official: 0, academic: 0, news: 0, reference: 0, social: 0, other: 0 }, total: 0, strong: 0, weak: false });
  assert.equal(Sources.summarize(['https://x.com/a/status/3'], { exclude: ['https://x.com/a/status/3'] }).weak, false, 'only the checked post is not a weak answer');
});

test('mixView formats tiers in fixed order, localizes them and stays silent without sources', () => {
  const summary = Sources.summarize(['https://x.com/a/status/3', 'https://www.cdc.gov/a', 'https://example.com', 'https://www.reuters.com/a', 'https://www.cdc.gov/b']);
  const t = language => (key, vars) => ui.t(key, language, vars);
  assert.deepEqual(Sources.mixView(summary, t('en'), String), { text: 'Sources: Official 2 · News 1 · Social 1 · Other 1', hint: "Labels come from the web address only; they don't rate the page itself.", weak: '' });
  assert.equal(Sources.mixView(Sources.summarize(['https://x.com/a/status/3']), t('zh-CN'), String).weak, '未引用官方、学术或新闻来源');
  assert.equal(Sources.mixView(Sources.summarize(['https://x.com/a/status/3']), t('ar'), value => new Intl.NumberFormat('ar-EG').format(value)).text, 'المصادر: تواصل اجتماعي ١');
  assert.equal(Sources.mixView(Sources.summarize([]), t('en'), String), null);
});

test('feed-core exposes the module as Core.Sources', () => {
  assert.equal(core.Sources, Sources);
});
