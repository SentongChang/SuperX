(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SuperXSourceQuality = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Labels describe the publisher type inferred from the URL, never
  // truthfulness. They are computed when an answer is drawn and never stored,
  // so editing these lists relabels old history entries too.
  //
  // Inclusion rules:
  // - official: governments, legislatures, courts, central banks and
  //   intergovernmental bodies that the gov/mil/int patterns below miss.
  // - academic: preprint servers, the DOI resolver and peer-reviewed journals;
  //   universities come from the edu/ac patterns.
  // - news: wire services and IFCN-signatory fact-checkers only. Individual
  //   outlets are deliberately left to "other" so the list does not rank
  //   newspapers; state-controlled outlets are never added.
  // - reference: encyclopedias and the web archive.
  // - social: platforms where any user can publish.
  // Keep each list sorted, lowercase, registrable domains or specific
  // subdomains, without www. Add entries only with a reason in the PR.
  //
  // Known consequences, pinned by tests: pubmed.ncbi.nlm.nih.gov is official
  // (the .gov pattern), and any archive.org page other than an unwrappable
  // Wayback capture is reference.
  const TIERS = Object.freeze(['official', 'academic', 'news', 'reference', 'social', 'other']);
  const STRONG = Object.freeze(['official', 'academic', 'news']);
  const DOMAINS = Object.freeze({
    official: Object.freeze(['canada.ca', 'europa.eu', 'imf.org', 'oecd.org', 'un.org', 'worldbank.org']),
    academic: Object.freeze(['arxiv.org', 'biorxiv.org', 'doi.org', 'medrxiv.org', 'nature.com', 'nejm.org', 'science.org', 'thelancet.com']),
    news: Object.freeze([
      'aap.com.au', 'afp.com', 'africacheck.org', 'ansa.it', 'aosfatos.org', 'apnews.com', 'boomlive.in', 'chequeado.com', 'correctiv.org',
      'efe.com', 'factcheck.org', 'fullfact.org', 'kyodonews.net', 'leadstories.com', 'lusa.pt', 'maldita.es', 'politifact.com', 'reuters.com',
      'snopes.com', 'yna.co.kr'
    ]),
    reference: Object.freeze(['archive.org', 'britannica.com', 'wikipedia.org']),
    social: Object.freeze([
      'bilibili.com', 'blogspot.com', 'bsky.app', 'facebook.com', 'github.com', 'github.io', 'instagram.com', 'linkedin.com', 'medium.com',
      'reddit.com', 'substack.com', 't.co', 't.me', 'threads.com', 'threads.net', 'tiktok.com', 'twitter.com', 'vk.com', 'weibo.com',
      'wordpress.com', 'x.com', 'youtu.be', 'youtube.com', 'zhihu.com'
    ])
  });
  const OFFICIAL_SECOND_LEVELS = new Set(['gov', 'mil', 'gob', 'gouv', 'govt']);
  // "go." is also a commercial label in some countries, so only these
  // government second levels count.
  const OFFICIAL_SUFFIXES = Object.freeze(['gc.ca', 'go.id', 'go.jp', 'go.ke', 'go.kr', 'go.th', 'go.tz', 'go.ug', 'gv.at']);
  const ACADEMIC_SECOND_LEVELS = new Set(['edu', 'ac']);
  const ARCHIVE_CAPTURE = /^\/web\/\d+[a-z_]*\/(https?:\/\/.+)$/;
  const STATUS_PATH = /^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/(\d+)/;

  const MAP = new Map();
  for (const tier of TIERS) for (const domain of DOMAINS[tier] || []) {
    if (MAP.has(domain)) throw new Error(`SuperX source tiers overlap: ${domain}`);
    MAP.set(domain, tier);
  }

  function parse(value) {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
    } catch { return null; }
  }
  function hostname(url) {
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return /^[\d.]+$/.test(host) || /[:[]/.test(host) ? '' : host;
  }
  const endsWithLabels = (host, suffix) => host === suffix || host.endsWith('.' + suffix);

  function tierOf(url, unwrap) {
    const host = url && hostname(url);
    if (!host) return 'other';
    if (unwrap && host === 'web.archive.org') {
      const capture = (url.pathname + url.search).match(ARCHIVE_CAPTURE)?.[1];
      if (capture) {const original = parse(capture);return original ? tierOf(original, false) : 'reference';}
    }
    const labels = host.split('.');
    if (labels.length < 2) return 'other';
    for (let index = 0; index < labels.length - 1; index++) {
      const tier = MAP.get(labels.slice(index).join('.'));
      if (tier) return tier;
    }
    const last = labels.at(-1), second = labels.at(-2), country = /^[a-z]{2}$/.test(last);
    if (['gov', 'mil', 'int'].includes(last) || country && OFFICIAL_SECOND_LEVELS.has(second) || OFFICIAL_SUFFIXES.some(suffix => endsWithLabels(host, suffix))) return 'official';
    if (last === 'edu' || country && ACADEMIC_SECOND_LEVELS.has(second)) return 'academic';
    return 'other';
  }
  function tier(value) { return tierOf(parse(value), true); }
  function displayHost(value) {
    const url = parse(value);
    return url ? url.hostname.toLowerCase().replace(/\.$/, '').replace(/^(?:www|m)\./, '') : '';
  }
  function statusId(url) {
    return /(?:^|\.)(?:x|twitter)\.com$/.test(hostname(url)) ? url.pathname.match(STATUS_PATH)?.[1] || null : null;
  }

  // Counts distinct cited pages by tier. Links to the checked post itself are
  // not evidence, so callers pass its permalink in `exclude`.
  function summarize(urls, { exclude = [] } = {}) {
    const excluded = new Set(exclude.map(parse).filter(Boolean).map(statusId).filter(Boolean));
    const seen = new Set(), counts = Object.fromEntries(TIERS.map(name => [name, 0]));
    for (const value of urls) {
      const url = parse(value);
      if (!url) continue;
      url.hash = '';
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      if (excluded.has(statusId(url))) continue;
      counts[tierOf(url, true)]++;
    }
    const total = TIERS.reduce((sum, name) => sum + counts[name], 0), strong = STRONG.reduce((sum, name) => sum + counts[name], 0);
    return { counts, total, strong, weak: total > 0 && strong === 0 };
  }
  // Display strings for a summary; null when nothing was cited, because the
  // completeness row already owns "no search" messaging.
  function mixView(summary, t, number) {
    if (!summary.total) return null;
    const list = TIERS.filter(name => summary.counts[name]).map(name => `${t('source.' + name)} ${number(summary.counts[name])}`).join(' · ');
    return { text: t('source.summary', { list }), hint: t('source.hint'), weak: summary.weak ? t('source.weak') : '' };
  }

  return Object.freeze({ TIERS, STRONG, DOMAINS, tier, displayHost, summarize, mixView });
});
