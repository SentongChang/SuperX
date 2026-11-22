'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../extension/ui-i18n.js');

const OTHER_LANGUAGES = ui.SUPPORTED_LANGUAGES.filter(language => language !== 'en');

// Key/language pairs whose value may equal English. Add to this map only when the value is
// brand or format only (a product name, a Key label, a token count), never ordinary copy.
const ALL = Object.freeze([...OTHER_LANGUAGES]);
const IDENTICAL_ALLOWED = Object.freeze({
  'common.api': ALL,
  'usage.total': ALL,
  'usage.known': ALL,
  'options.providerKey': ALL,
  'options.apiSubscriptionTitle': ALL,
  'options.apiKeyLabel': ALL,
  'claude.provider': ALL,
  'claude.keyLabel': ALL,
  'history.tokens': Object.freeze(['zh-CN','zh-TW','ja','ko','es','fr','de','pt']),
  'popup.buildLabel': Object.freeze(['es','fr','pt']),
  'common.pause': Object.freeze(['fr']),
  'options.version': Object.freeze(['fr','de']),
  'options.reasoning.minimal': Object.freeze(['fr','de']),
  'options.promptsTitle': Object.freeze(['de'])
});

// Every key the Claude connection and the WP1-WP9 fact-check work added, listed by hand so a
// new key has to be added here (and reviewed) rather than slipping in under a prefix.
const PROJECT_KEYS = Object.freeze([
  // Claude connection
  'claude.provider','claude.intro','claude.keyLabel','claude.keyPlaceholder','claude.keyHelp','claude.keyLink','claude.billingLink',
  'claude.keyReady','claude.keyMissing','claude.clearKey','claude.keyInvalid','claude.keyRequired','claude.keyStorageError','claude.keyCleared',
  'claude.model','claude.modelHelp','claude.effort','claude.effortLow','claude.effortMedium','claude.effortHigh','claude.maxSearches',
  'claude.maxSearchesHelp','claude.budget','claude.budgetHelp','claude.cycleDay','claude.cycleDayHelp','claude.spend','claude.spendNoLimit',
  'claude.spendEstimate','claude.resetSpend','claude.autoTrigger','claude.autoTriggerHelp','claude.budgetReached','claude.keyRejected',
  'claude.requestRejected','claude.serverError','claude.modeLabel','claude.popupHint',
  // WP1 verdict row and gaps
  'verdict.accurate','verdict.inaccurate','verdict.mixed','verdict.unproven','verdict.none','verdict.aria',
  'gaps.label','gaps.aria','gaps.text','gaps.media','gaps.video','gaps.search','gaps.textTitle','gaps.mediaTitle','gaps.videoTitle','gaps.searchTitle',
  // WP4 Claude X gap
  'gaps.links','gaps.linksTitle','options.claude.xContext',
  // WP2 source quality
  'source.summary','source.official','source.academic','source.news','source.reference','source.social','source.other','source.weak','source.hint',
  // WP3 pre-screen and routing
  'claude.modelAuto','claude.modelAutoHelp','claude.triage','claude.triageHelp','status.screening','triage.checkAnyway','triage.detailModel',
  'triage.detailLocal','triage.kind.opinion','triage.kind.personal','triage.kind.joke','triage.kind.promo','triage.kind.question','triage.kind.short',
  'triage.kind.other','route.hard','route.simple','route.fallback','route.short',
  // WP5 answer cache
  'options.answerCacheTitle','options.cacheRetention','options.cacheRetentionSession','options.cacheRetention1d','options.cacheRetention7d',
  'options.cacheRetentionHelp','options.cacheRetentionHistoryOff','options.cacheStatsEmpty','options.cacheStats','options.cacheSavedUsd',
  'options.cacheSavedTokens','options.cacheStatsReset','options.cacheStorageError','options.cacheHelp',
  // WP8 layout self-check
  'layout.title','layout.posts','layout.actions','layout.report','layout.dismiss','layout.popup',
  // WP6 onboarding
  'onboarding.title','onboarding.subtitle','onboarding.skip','onboarding.progress','onboarding.back','onboarding.continue','onboarding.finish',
  'onboarding.connectTitle','onboarding.oauthTitle','onboarding.oauthBody','onboarding.recommended','onboarding.keyTitle','onboarding.keyBody',
  'onboarding.localLink','onboarding.oauthHelp','onboarding.authKeyTitle','onboarding.getGrokKey','onboarding.getClaudeKey','onboarding.keyPrivacy',
  'onboarding.keySaved','onboarding.replaceKey','onboarding.usageTitle','onboarding.clickTitle','onboarding.clickBody','onboarding.autoTitle',
  'onboarding.autoBody','onboarding.autoClaudeBody','onboarding.doneTitle','onboarding.doneBody','onboarding.openX','onboarding.moreSettings',
  'onboarding.reopen','trigger.clickOnlyStatus'
]);

const SCRIPTS = Object.freeze({
  'zh-CN': /\p{Script=Han}/u,
  'zh-TW': /\p{Script=Han}/u,
  ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  ko: /\p{Script=Hangul}/u,
  ar: /\p{Script=Arabic}/u,
  ru: /\p{Script=Cyrillic}/u,
  hi: /\p{Script=Devanagari}/u
});

// Brand names, model names and literal tokens that translations must carry over unchanged.
const PROTECTED = Object.freeze(['SuperX','Claude Console','Claude Max','Claude','Anthropic','Grok','xAI','Key','sk-ant-','Haiku 5.5','Sonnet 5.5','Opus 5.5','$','Billing → Promotional credits']);

const identicalAllowed = (key, language) => IDENTICAL_ALLOWED[key]?.includes(language) === true;

test('every project key exists in the English catalog and the list has no duplicates', () => {
  assert.equal(new Set(PROJECT_KEYS).size, PROJECT_KEYS.length);
  assert.deepEqual(PROJECT_KEYS.filter(key => typeof ui.catalog.en[key] !== 'string'), []);
});

test('every non-English value differs from English unless the pair is a reviewed brand or format string', () => {
  for (const [key, languages] of Object.entries(IDENTICAL_ALLOWED)) {
    assert.equal(typeof ui.catalog.en[key], 'string', `${key} is still in the catalog`);
    for (const language of languages) assert.equal(ui.catalog[language][key], ui.catalog.en[key], `${language}: ${key} allowlist entry is still needed`);
  }
  const untranslated = [];
  for (const language of OTHER_LANGUAGES) for (const [key, english] of Object.entries(ui.catalog.en)) {
    if (ui.catalog[language][key] === english && !identicalAllowed(key, language)) untranslated.push(`${language}: ${key}`);
  }
  assert.deepEqual(untranslated, []);
});

test('project keys are written in the script of each non-Latin language', () => {
  const wrongScript = [];
  for (const [language, script] of Object.entries(SCRIPTS)) for (const key of PROJECT_KEYS) {
    if (!identicalAllowed(key, language) && !script.test(ui.catalog[language][key])) wrongScript.push(`${language}: ${key}`);
  }
  assert.deepEqual(wrongScript, []);
});

test('project keys keep brand names, model names and literal tokens from English', () => {
  const dropped = [];
  for (const key of PROJECT_KEYS) {
    const tokens = PROTECTED.filter(token => ui.catalog.en[key].includes(token));
    for (const language of OTHER_LANGUAGES) for (const token of tokens) {
      if (!ui.catalog[language][key].includes(token)) dropped.push(`${language}: ${key} drops ${token}`);
    }
  }
  assert.deepEqual(dropped, []);
});

test('Claude settings reuse the existing reasoning terms and keep literal formats', () => {
  for (const language of OTHER_LANGUAGES) {
    assert.equal(ui.t('claude.effort', language), ui.t('options.reasoning', language), language);
    for (const level of ['Low','Medium','High']) {
      const value = ui.t('claude.effort' + level, language), word = ui.t('options.reasoning.' + level.toLowerCase(), language);
      assert.ok(value.startsWith(word + ' · '), `${language}: claude.effort${level} starts with ${word}`);
    }
  }
  for (const language of ui.SUPPORTED_LANGUAGES) {
    for (const key of ['claude.keyInvalid','claude.keyPlaceholder']) assert.match(ui.t(key, language), /sk-ant-/, `${language}: ${key}`);
    for (const key of ['claude.spend','claude.spendNoLimit']) assert.match(ui.catalog[language][key], /\$\{usd\}/, `${language}: ${key}`);
    assert.match(ui.catalog[language]['claude.spend'], /\$\{budget\}/, language);
    assert.match(ui.t('claude.cycleDayHelp', language), /Claude Console.*Billing → Promotional credits/, `${language}: Console path stays verbatim`);
  }
  assert.equal(ui.t('claude.spend', 'fr', {usd:'1.20', budget:'5.00', requests:3, start:'1 nov.', end:'30 nov.'}), 'Ce cycle : $1.20 sur $5.00 · 3 requêtes · 1 nov. – 30 nov.');
  assert.equal(ui.t('claude.budgetReached', 'de'), 'Das Ausgabenlimit für Claude in diesem Zeitraum ist erreicht. Erhöhe es in den Einstellungen oder warte auf den nächsten Zeitraum.');
});
