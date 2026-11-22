'use strict';
// The provider registry must agree with every hand-written place that names
// a connection: settings, options.html, the manifest and the translations.
// Behaviour per provider is pinned by the golden tests.
const test=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const P=require('../extension/provider-registry.js');
const Core=require('../extension/feed-core.js');
const UI=require('../extension/ui-i18n.js');

const extension=file=>readFileSync(join(__dirname,'..','extension',file),'utf8');
const options=extension('options.html');
const unique=values=>new Set(values).size===values.length;

test('registry: Core exposes the same frozen descriptors in stored settings order',()=>{
  assert.equal(Core.providers,P);
  assert.deepEqual(P.ids,['api','oauth','build','claude']);
  assert.ok(Object.isFrozen(P.list)&&P.list.every(descriptor=>Object.isFrozen(descriptor)&&Object.isFrozen(descriptor.caps)&&Object.isFrozen(descriptor.errors.codes)));
  // Each connection's settings are one contiguous run, in definition order.
  const keys=Object.keys(Core.DEFAULT_SETTINGS),at=field=>keys.indexOf(field);
  const starts=P.list.map(descriptor=>at(descriptor.fields.model));
  assert.deepEqual([...starts].sort((a,b)=>a-b),starts);
  for(const descriptor of P.list)for(const field of Object.values(descriptor.fields))assert.ok(at(field)>=0,descriptor.id+' '+field);
});

test('registry: ids, focus targets, panels and code prefixes are unique',()=>{
  for(const field of ['id','settingsFocus','panelId','uiOrder','focusRank'])assert.ok(unique(P.list.map(descriptor=>descriptor[field])),field);
  assert.ok(unique(P.list.map(descriptor=>descriptor.errors.codePrefix).filter(Boolean)));
  for(const descriptor of P.list){
    assert.match(descriptor.id,/^[a-z]{2,20}$/);
    assert.ok(['metered','subscription','local'].includes(descriptor.billing),descriptor.id);
    assert.deepEqual(Object.keys(descriptor.caps),['remote','persistDiagnostics','accountLimits','xSearch','triage'],descriptor.id);
    assert.ok(Object.values(descriptor.caps).every(value=>typeof value==='boolean'),descriptor.id);
    assert.ok(descriptor.maxConcurrency===null||Number.isInteger(descriptor.maxConcurrency)&&descriptor.maxConcurrency>=1,descriptor.id);
    for(const code of Object.keys(descriptor.errors.codes))assert.ok(code.startsWith(descriptor.errors.codePrefix),code);
    for(const [,url] of descriptor.usageLinks)assert.match(url,/^https:\/\//);
    // Only an opt-in boolean may unlock automatic checks, and it starts off.
    const optIn=descriptor.triggers?.manualOnlyUnless;
    if(optIn)assert.equal(Core.DEFAULT_SETTINGS[optIn],false,descriptor.id);
  }
});

test('registry: lookups fall back the way stored settings do',()=>{
  assert.equal(P.resolve('nope'),P.get('api'));assert.equal(P.get('nope'),undefined);
  assert.equal(P.has('native'),false);assert.equal(P.isRetired('native'),true);
  assert.equal(P.codeOwner('OAUTH_X').id,'oauth');assert.equal(P.codeOwner('BUILD_X').id,'build');assert.equal(P.codeOwner('CLAUDE_BUDGET').id,'claude');
  assert.equal(P.codeOwner('API_ERROR'),undefined);assert.equal(P.codeOwner(undefined),undefined);
  assert.deepEqual(P.uiOrder().map(descriptor=>descriptor.id),['oauth','api','build','claude']);
});

test('registry: capability flags drive the shared rules',()=>{
  for(const descriptor of P.list){
    const settings=Core.normalizeSettings({provider:descriptor.id,xSearch:true,claudeAutoTrigger:true});
    assert.equal(Core.providerCanSearchX(settings),descriptor.caps.xSearch,descriptor.id);
    assert.equal(Core.triageApplies(settings,'automatic')!==null,descriptor.caps.triage,descriptor.id);
    assert.equal(Core.autoRetryDecision({provider:descriptor.id,code:'API_ERROR',verificationFailure:{code:'SERVER',httpStatus:503}}).reason==='oauth_no_replay',!descriptor.autoRetry,descriptor.id);
    // The opt-in was set above, so only its absence keeps a check manual.
    const optIn=descriptor.triggers?.manualOnlyUnless;
    assert.equal(Core.claudeManualOnly(settings),false,descriptor.id);
    if(optIn)assert.equal(Core.claudeManualOnly({...settings,[optIn]:false}),true,descriptor.id);
  }
  for(const key of P.list.flatMap(descriptor=>descriptor.usageIssueKeys))assert.equal(Core.isUsageIssue(key),true,key);
  assert.equal(Core.isUsageIssue('error.apiServer'),false);
});

test('registry: options.html lists every connection with its label, panel and model controls',()=>{
  const choices=[...options.match(/<select id="provider"[^>]*>([\s\S]*?)<\/select>/)[1].matchAll(/<option value="([^"]+)" data-i18n="([^"]+)"/g)].map(match=>[match[1],match[2]]);
  assert.deepEqual(choices,P.uiOrder().map(descriptor=>[descriptor.id,descriptor.labels.option]));
  for(const descriptor of P.list)for(const id of [descriptor.panelId,...Object.values(descriptor.controls)])assert.match(options,new RegExp(`id="${id}"`),descriptor.id+' '+id);
});

test('registry: every i18n key it names exists in all interface languages',()=>{
  const keys=P.list.flatMap(descriptor=>[...Object.values(descriptor.labels).filter(Boolean),...descriptor.usageLinks.map(([key])=>key),...descriptor.usageIssueKeys,
    ...Object.values(descriptor.errors.codes),descriptor.errors.fallback,...Object.values(descriptor.errors.apiOverrides||{})].filter(Boolean));
  for(const language of UI.SUPPORTED_LANGUAGES)for(const key of new Set(keys))assert.ok(UI.catalog[language][key]?.trim(),`${language}: ${key}`);
});

test('registry: the manifest grants every host a connection contacts',()=>{
  const manifest=JSON.parse(extension('manifest.json')),granted=[...manifest.host_permissions,...manifest.optional_host_permissions];
  for(const descriptor of P.list)for(const host of descriptor.hosts)assert.ok(granted.includes(host),descriptor.id+' '+host);
});

