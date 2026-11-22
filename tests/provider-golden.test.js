'use strict';
// Golden characterization of per-provider behaviour (WP7-P0).
// These values were recorded from the code before the provider registry
// exists. The registry refactor must keep every one of them unchanged; a
// deliberate change (such as the planned Claude cache-key bump) updates the
// golden value in the same commit and says why.
// Worker cache keys and focus live in background.test.js, rail error keys,
// titles and links in content-overlay.test.js, and popup labels in
// trigger-ui.test.js, next to the harness each one needs.
const test=require('node:test');
const assert=require('node:assert/strict');
const Core=require('../extension/feed-core.js');

const PROVIDERS=['api','oauth','build','claude'];
const SETTINGS_KEYS=['provider','enabled','triggerMode','customTriggers','analysisDefaultsVersion','dwellMs','maxPerSession','cooldownMs','language','interfaceLanguage',
  'apiModel','apiReasoningEffort',
  'oauthModel','oauthReasoningEffort','oauthRemember',
  'buildDefaultsVersion','buildTransport','buildPort','buildModel','buildReasoningEffort',
  'claudeModel','claudeEffort','claudeMaxSearches','claudeBudgetUsd','claudeCycleDay','claudeAutoTrigger',
  'apiConcurrency','apiVerification','webSearch','xSearch','explanationMode','verifyPrompt','postDraftPrompt','replyDraftPrompt','draftPrompt','commentsPrompt'];
const PROVIDER_FIELDS={apiModel:'grok-4.3',apiReasoningEffort:'none',
  oauthModel:'grok-4.3',oauthReasoningEffort:'none',oauthRemember:true,
  buildDefaultsVersion:1,buildTransport:'acp',buildPort:2419,buildModel:'grok-4.3',buildReasoningEffort:'none',
  claudeModel:'claude-haiku-5-5',claudeEffort:'medium',claudeMaxSearches:3,claudeBudgetUsd:100,claudeCycleDay:15,claudeAutoTrigger:false,
  apiConcurrency:3};
const providerFields=settings=>Object.fromEntries(Object.keys(PROVIDER_FIELDS).map(key=>[key,settings[key]]));

test('golden: default and normalized settings keep one key order with provider fields grouped api, oauth, build, claude',()=>{
  assert.deepEqual(Object.keys(Core.DEFAULT_SETTINGS),SETTINGS_KEYS);
  assert.deepEqual(Object.keys(Core.normalizeSettings({})),SETTINGS_KEYS);
  for(const provider of PROVIDERS)assert.deepEqual(Object.keys(Core.normalizeSettings({provider})),SETTINGS_KEYS,provider);
  // A retained dormant draft is the only optional key, always before verifyPrompt.
  const dormant=Object.keys(Core.normalizeSettings({provider:'claude',explainPrompt:'Kept draft'}));
  const at=SETTINGS_KEYS.indexOf('verifyPrompt');
  assert.deepEqual(dormant,[...SETTINGS_KEYS.slice(0,at),'explainPrompt',...SETTINGS_KEYS.slice(at)]);
  assert.deepEqual(providerFields(Core.DEFAULT_SETTINGS),PROVIDER_FIELDS);
});

test('golden: provider selection keeps the fresh-install, legacy and retired-provider defaults',()=>{
  assert.equal(Core.normalizeSettings({}).provider,'oauth');
  assert.equal(Core.normalizeSettings(undefined).provider,'oauth');
  assert.equal(Core.normalizeSettings({language:'ja'}).provider,'api','Nonempty legacy settings without a source keep the API default');
  for(const provider of ['native','nope','',null,'API'])assert.equal(Core.normalizeSettings({provider}).provider,'api',String(provider));
  for(const provider of PROVIDERS)assert.equal(Core.normalizeSettings({provider}).provider,provider);
});

test('golden: per-provider normalization fixtures, including the one-time Build 4.7/low migration',()=>{
  const cases=[
    [{apiModel:' grok-4.7 ',apiReasoningEffort:'bogus'},{apiModel:'grok-4.7',apiReasoningEffort:'low'}],
    [{provider:'api',apiModel:'bad model!',apiReasoningEffort:'high'},{apiReasoningEffort:'high'}],
    [{provider:'api',apiModel:'custom-text',apiReasoningEffort:'high'},{apiModel:'custom-text',apiReasoningEffort:'auto'}],
    [{provider:'oauth',oauthModel:'',oauthReasoningEffort:'xhigh',oauthRemember:false},{oauthReasoningEffort:'xhigh',oauthRemember:false}],
    [{provider:'oauth',oauthModel:'grok-4.7',oauthReasoningEffort:'nope',oauthRemember:'yes'},{oauthModel:'grok-4.7'}],
    [{provider:'build',buildModel:'grok-4.7',buildReasoningEffort:'low'},{}],
    [{provider:'build',buildModel:'grok-4.7',buildReasoningEffort:'low',buildDefaultsVersion:1},{buildModel:'grok-4.7',buildReasoningEffort:'low'}],
    [{provider:'build',buildModel:'grok-4.7',buildReasoningEffort:'bogus',buildPort:80,buildTransport:'ws',buildDefaultsVersion:7},{buildModel:'grok-4.7',buildReasoningEffort:'low',buildPort:1024}],
    [{provider:'build',buildModel:'grok-4.3-latest',buildPort:'70000'},{buildModel:'grok-4.3-latest',buildPort:65535}],
    [{provider:'claude',claudeModel:'claude-opus-9',claudeEffort:'max',claudeMaxSearches:0,claudeBudgetUsd:-5,claudeCycleDay:31,claudeAutoTrigger:'true'},{claudeMaxSearches:1,claudeBudgetUsd:0,claudeCycleDay:28}],
    [{provider:'claude',claudeModel:'claude-sonnet-5-5',claudeEffort:'high',claudeMaxSearches:99,claudeBudgetUsd:200000,claudeCycleDay:0,claudeAutoTrigger:true},{claudeModel:'claude-sonnet-5-5',claudeEffort:'high',claudeMaxSearches:10,claudeBudgetUsd:100000,claudeCycleDay:1,claudeAutoTrigger:true}],
    [{provider:'claude',claudeModel:'claude-opus-5-5',claudeMaxSearches:'4.6',claudeBudgetUsd:'',claudeCycleDay:true,apiConcurrency:4},{claudeModel:'claude-opus-5-5',claudeMaxSearches:5}],
    [{provider:'api',apiConcurrency:4,analysisDefaultsVersion:1},{apiConcurrency:4}],
    [{provider:'api',apiConcurrency:'12'},{apiConcurrency:8}]
  ];
  for(const [input,changed] of cases)assert.deepEqual(providerFields(Core.normalizeSettings(input)),{...PROVIDER_FIELDS,...changed},JSON.stringify(input));
});

test('golden: providerModel and providerEffort for every provider with valid, invalid and missing fields',()=>{
  const cases=[
    [undefined,'grok-4.3','none'],
    [{},'grok-4.3','none'],
    [{provider:'nope',apiModel:'grok-4.7',apiReasoningEffort:'high'},'grok-4.7','high'],
    [{provider:'api'},'grok-4.3','none'],
    [{provider:'api',apiModel:'grok-4.7',apiReasoningEffort:'high'},'grok-4.7','high'],
    [{provider:'api',apiModel:'grok-4.7',apiReasoningEffort:'bogus'},'grok-4.7','low'],
    [{provider:'api',apiModel:'grok-4.3',apiReasoningEffort:'high'},'grok-4.3','high'],
    [{provider:'api',apiModel:'grok-4.3-latest',apiReasoningEffort:'none'},'grok-4.3-latest','none'],
    [{provider:'api',apiModel:'custom-text',apiReasoningEffort:'high'},'custom-text','auto'],
    [{provider:'oauth'},'grok-4.3','none'],
    [{provider:'oauth',oauthModel:'',apiModel:'grok-4.7'},'grok-4.3','none'],
    [{provider:'oauth',oauthModel:'grok-4.7',oauthReasoningEffort:'auto'},'grok-4.7','auto'],
    [{provider:'oauth',oauthModel:'custom',oauthReasoningEffort:'bogus'},'custom','none'],
    [{provider:'build'},'grok-4.3','none'],
    [{provider:'build',buildModel:'grok-4.7'},'grok-4.7','low'],
    [{provider:'build',buildModel:'grok-4.3-latest'},'grok-4.3-latest','none'],
    [{provider:'build',buildModel:'grok-4.7',buildReasoningEffort:'minimal'},'grok-4.7','minimal'],
    [{provider:'claude'},'claude-haiku-5-5','medium'],
    [{provider:'claude',claudeModel:'claude-opus-5-5',claudeEffort:'high'},'claude-opus-5-5','high'],
    [{provider:'claude',claudeModel:'claude-opus-9',claudeEffort:'max'},'claude-haiku-5-5','medium'],
    [{provider:'claude',claudeModel:'claude-sonnet-5-5',claudeEffort:'low',apiModel:'grok-4.7'},'claude-sonnet-5-5','low']
  ];
  for(const [settings,model,effort] of cases){
    assert.equal(Core.providerModel(settings),model,'model '+JSON.stringify(settings));
    assert.equal(Core.providerEffort(settings),effort,'effort '+JSON.stringify(settings));
  }
});

test('golden: API post identity buckets every unknown provider with the API connection',()=>{
  const post={id:'1',url:'https://x.com/a/status/1?s=20',text:'Hello',language:'en'};
  const identity=bucket=>JSON.stringify(['post-input-v4-source-full-url',bucket,'https://x.com/a/status/1','en']);
  for(const provider of ['oauth','build','claude'])assert.equal(Core.apiPostIdentity(post,{provider,language:'auto'}),identity(provider));
  for(const provider of ['api','native','nope',undefined])assert.equal(Core.apiPostIdentity(post,{provider,language:'auto'}),identity('api'),String(provider));
  assert.equal(Core.apiPostIdentity(post,{provider:'oauth',language:'auto',task:'comments'}),JSON.stringify([JSON.stringify(['1','https://x.com/a/status/1','Hello','','']),[]]));
});

test('golden: only Claude without its opt-in narrows triggers to the post button',()=>{
  const custom={...Core.DEFAULT_SETTINGS,triggerMode:'automatic'};
  for(const provider of ['api','oauth','build']){
    assert.equal(Core.claudeManualOnly({...custom,provider}),false,provider);
    assert.equal(Core.effectiveTriggerSettings({...custom,provider}).triggerMode,'automatic',provider);
  }
  assert.equal(Core.claudeManualOnly({...custom,provider:'claude'}),true);
  assert.equal(Core.claudeManualOnly({...custom,provider:'claude',claudeAutoTrigger:'true'}),true);
  assert.equal(Core.claudeManualOnly({...custom,provider:'claude',claudeAutoTrigger:true}),false);
  const effective=Core.effectiveTriggerSettings({...custom,provider:'claude'});
  assert.equal(effective.triggerMode,'custom');
  assert.deepEqual({...effective.customTriggers},{...Core.DEFAULT_CUSTOM_TRIGGERS,manual:true,postHover:false,buttonHover:false,detailMain:false,detailReplies:false});
  assert.equal(Core.effectiveTriggerSettings({...custom,provider:'claude',triggerMode:'paused'}).triggerMode,'paused');
});

test('golden: automatic retry never replays a sign-in request, by provider or by OAUTH_ code',()=>{
  const server={code:'API_ERROR',verificationFailure:{httpStatus:503}};
  assert.deepEqual(Core.autoRetryDecision({provider:'oauth',...server}),{retryable:false,reason:'oauth_no_replay'});
  assert.deepEqual(Core.autoRetryDecision({provider:'oauth',code:'RATE_LIMIT'}),{retryable:false,reason:'oauth_no_replay'});
  assert.deepEqual(Core.autoRetryDecision({code:'OAUTH_AUTH_UNAVAILABLE'}),{retryable:false,reason:'oauth_no_replay'});
  for(const provider of ['api','claude'])assert.deepEqual(Core.autoRetryDecision({provider,...server}),{retryable:true,reason:'server'},provider);
  assert.deepEqual(Core.autoRetryDecision({provider:'build',code:'BUILD_BUSY'}),{retryable:true,reason:'rate_limit'});
  // Earlier, non-provider rules still decide first.
  assert.deepEqual(Core.autoRetryDecision({provider:'oauth',code:'CANCELLED'}),{retryable:false,reason:'cancelled'});
  assert.deepEqual(Core.autoRetryDecision({provider:'oauth',code:'API_ERROR',verificationFailure:{httpStatus:401}}),{retryable:false,reason:'request_rejected'});
  assert.deepEqual(Core.autoRetryDecision({provider:'claude',code:'CLAUDE_BUDGET'}),{retryable:false,reason:'setup_required'});
});
