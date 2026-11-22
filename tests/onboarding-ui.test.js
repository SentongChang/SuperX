'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Core=require('../extension/feed-core.js'),UI=require('../extension/ui-i18n.js');

class Element{
  constructor(attrs={}){this.attrs={...attrs};this.value=attrs.value||'';this.textContent='';this.children=[];this.listeners={};this.dataset={};this.hidden='hidden' in attrs;this.disabled=false;this.checked=false;}
  getAttribute(key){return this.attrs[key]??null;}setAttribute(key,value){this.attrs[key]=String(value);}removeAttribute(key){delete this.attrs[key];}
  matches(){return ['data-i18n','data-i18n-aria','data-i18n-placeholder','data-i18n-title'].some(key=>key in this.attrs);}
  querySelectorAll(){return [];}replaceChildren(...nodes){this.children=nodes;}focus(){this.focused=true;}
  addEventListener(type,fn){this.listeners[type]=fn;}
}
const clone=value=>structuredClone(value),settle=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
const connected=models=>({state:'connected',connected:true,remember:true,credentialId:'11111111-1111-4111-8111-111111111111',catalogModels:models.map(id=>({id}))});

function fixture({settings:saved={},keyState='missing',claudeConfigured=false,oauthStatus={state:'idle',connected:false,remember:true,catalogModels:[]},override}={}){
  const html=fs.readFileSync(path.join(__dirname,'../extension/onboarding.html'),'utf8'),nodes=[],ids=new Map();
  for(const tag of html.matchAll(/<[A-Za-z][\w-]*\b([^>]*)>/g)){
    const attrs={};for(const item of tag[1].matchAll(/([A-Za-z][\w-]*)(?:=(["'])(.*?)\2)?/g))attrs[item[1]]=item[3]??'';
    const node=new Element(attrs);nodes.push(node);if(attrs.id)ids.set(attrs.id,node);
  }
  let settings=Core.normalizeSettings(saved),status=clone(oauthStatus);
  const messages=[],runtimeListeners=[],timers=new Map(),local={},opened=[],navigations=[],pageListeners={};let timerSequence=0;
  const config=()=>({ok:true,settings:clone(settings),ready:false,keyState,oauthStatus:clone(status),...(settings.provider==='claude'?{claudeStatus:{configured:claudeConfigured,usd:0,requests:0,budgetUsd:settings.claudeBudgetUsd}}:{})});
  const chrome={
    runtime:{onMessage:{addListener:fn=>runtimeListeners.push(fn)},async openOptionsPage(){opened.push('options');},
      async sendMessage(message){
        messages.push(clone(message));const intercepted=override?.(message);if(intercepted)return intercepted;
        if(message.type==='GET_UI_LANGUAGE')return {ok:true,language:'en'};
        if(message.type==='GET_CONFIG')return config();
        if(message.type==='GET_OAUTH_STATUS')return {ok:true,oauthStatus:clone(status)};
        if(message.type==='OAUTH_LOGIN'){status={state:'awaiting_authorization',connected:false,remember:true,device:{userCode:'DEMO-1234',verificationUriComplete:'https://accounts.x.ai/oauth2/device?user_code=DEMO-1234',device_code:'PRIVATE_DEVICE_CANARY'}};return {ok:true,oauthStatus:clone(status)};}
        if(message.type==='OAUTH_CANCEL_LOGIN'){status={state:'idle',connected:false,remember:true};return {ok:true,oauthStatus:clone(status)};}
        if(message.type==='SAVE_KEY'){keyState='ready';settings=Core.normalizeSettings(message.settings);return {ok:true};}
        if(message.type==='SAVE_CLAUDE_KEY'){claudeConfigured=true;settings=Core.normalizeSettings(message.settings);return {ok:true};}
        if(message.type==='SAVE_SETTINGS'){
          const next=Core.normalizeSettings(message.settings);
          settings=message.triggerPreferencesChanged===false?{...next,triggerMode:settings.triggerMode,customTriggers:settings.customTriggers}:next;
          return {ok:true};
        }
        throw Error('Unexpected message '+message.type);
      }},
    storage:{local:{async set(values){Object.assign(local,clone(values));}}}
  };
  const document={documentElement:{},title:'',getElementById:id=>ids.get(id),createElement:()=>new Element(),querySelectorAll:()=>nodes.filter(node=>node.matches())};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/onboarding.js'),'utf8'),{document,chrome,XGrokCore:Core,GrokFirstUI:UI,
    navigator:{language:'en',clipboard:{async writeText(){}}},location:{assign:url=>navigations.push(url)},addEventListener:(type,fn)=>{pageListeners[type]=fn;},
    setTimeout(fn,delay){const id=++timerSequence;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);}});
  const $=id=>ids.get(id);
  return {$,ids,messages,local,opened,navigations,timers,pageListeners,settings:()=>settings,
    sent:type=>messages.filter(message=>message.type===type),
    setStatus(next){status=clone(next);runtimeListeners.forEach(fn=>fn({type:'OAUTH_STATUS_CHANGED',oauthStatus:clone(next)}));},
    async runTimers(){for(const [id,timer] of [...timers]){timers.delete(id);await timer.fn();}await settle();},
    choose(id){$(id).checked=true;$(id).listeners.change();},
    async next(){await $('flow').listeners.submit({preventDefault(){}});await settle();},
    visible:()=>['step-connect','step-auth','step-usage','done'].find(id=>!$(id).hidden)};
}

test('the guide loads with two messages and preselects the connection from saved settings',async()=>{
  const f=fixture();await settle();
  assert.deepEqual(f.messages.map(message=>message.type).sort(),['GET_CONFIG','GET_UI_LANGUAGE']);
  assert.equal(f.visible(),'step-connect');assert.equal(f.$('connect-oauth').checked,true);assert.equal(f.$('connect-key').checked,false);
  assert.equal(f.$('progress').textContent,'Step 1 of 3');assert.equal(f.$('back').hidden,true);
  assert.equal(f.$('next').textContent,'Continue');assert.equal(f.$('next').disabled,false);
  assert.equal(f.$('skip').textContent,UI.t('onboarding.skip','en'));
  for(const provider of ['api','claude']){
    const keyed=fixture({settings:{provider}});await settle();
    assert.equal(keyed.$('connect-key').checked,true,provider);
    await keyed.next();assert.equal(keyed.$('key-claude').checked,provider==='claude');assert.equal(keyed.$('auth-oauth').hidden,true);
  }
});

test('signing in with Grok sends the existing OAuth messages and enables Continue only once connected',async()=>{
  const f=fixture({settings:{provider:'oauth'}});await settle();await f.next();
  assert.equal(f.visible(),'step-auth');assert.equal(f.$('progress').textContent,'Step 2 of 3');assert.equal(f.$('next').disabled,true);
  await f.$('oauth-login').listeners.click();await settle();
  assert.deepEqual(f.sent('OAUTH_LOGIN'),[{type:'OAUTH_LOGIN'}],'the worker keeps the saved "remember sign-in" choice');
  assert.equal(f.$('oauth-device').hidden,false);assert.equal(f.$('oauth-code').textContent,'DEMO-1234');
  assert.equal(f.$('oauth-official').getAttribute('href'),'https://accounts.x.ai/oauth2/device?user_code=DEMO-1234');
  assert.equal(f.$('oauth-state').textContent,UI.t('oauth.authorizing','en'));assert.equal(f.$('oauth-login').hidden,true);
  assert.deepEqual([...f.timers.values()].map(timer=>timer.delay),[1500]);
  await f.runTimers();assert.equal(f.sent('GET_OAUTH_STATUS').length,1);assert.equal(f.timers.size,1,'polling continues while authorizing');
  assert.equal(f.$('next').disabled,true);
  f.setStatus(connected(['grok-4.3','grok-4.7']));await settle();
  assert.equal(f.$('oauth-connected').hidden,false);assert.equal(f.$('oauth-device').hidden,true);assert.equal(f.$('oauth-model-field').hidden,true);
  assert.equal(f.$('next').disabled,false);assert.equal(f.timers.size,0);
  await f.next();
  assert.equal(f.sent('SAVE_SETTINGS').length,0,'nothing to save when the provider and model are already right');
  assert.equal(f.visible(),'step-usage');
});

test('Back during sign-in cancels it, and an unavailable model is never replaced silently',async()=>{
  const f=fixture();await settle();await f.next();
  await f.$('oauth-login').listeners.click();await settle();
  f.$('back').listeners.click();await settle();
  assert.equal(f.sent('OAUTH_CANCEL_LOGIN').length,1);assert.equal(f.visible(),'step-connect');assert.equal(f.timers.size,0);
  const g=fixture({settings:{provider:'api'},oauthStatus:connected(['grok-4.7'])});await settle();
  g.choose('connect-oauth');await g.next();
  assert.equal(g.$('oauth-model-field').hidden,false);assert.equal(g.$('oauth-model').value,'');
  assert.deepEqual(g.$('oauth-model').children.map(option=>option.value),['','grok-4.7']);
  assert.equal(g.$('oauth-model-help').textContent,UI.t('oauth.modelUnavailable','en',{model:'grok-4.3'}));
  assert.equal(g.$('next').disabled,true);
  g.$('oauth-model').value='grok-4.7';g.$('oauth-model').listeners.change();
  assert.equal(g.$('next').disabled,false);
  await g.next();
  const [saved]=g.sent('SAVE_SETTINGS');
  assert.equal(saved.settings.provider,'oauth');assert.equal(saved.settings.oauthModel,'grok-4.7');assert.equal(saved.settings.oauthReasoningEffort,'low');
  assert.equal(saved.triggerPreferencesChanged,false);assert.equal(g.visible(),'step-usage');
});

test('a pasted Key goes through SAVE_KEY or SAVE_CLAUDE_KEY and invalid input sends nothing',async()=>{
  const f=fixture();await settle();f.choose('connect-key');await f.next();
  assert.equal(f.$('key-api').checked,true);assert.equal(f.$('key').placeholder,UI.t('options.keyPlaceholder','en'));
  assert.equal(f.$('key-privacy').textContent,'Encrypted on this device and sent only to api.x.ai.');
  assert.equal(f.$('key-link').getAttribute('href'),'https://grok.com/dashboard/api-keys');
  assert.equal(f.$('next').disabled,true);
  f.$('key').value='  xai-fixture-key  ';f.$('key').listeners.input();await f.next();
  const [grok]=f.sent('SAVE_KEY');
  assert.equal(grok.apiKey,'xai-fixture-key');assert.equal(Object.hasOwn(grok,'remember'),false,'the worker keeps the saved "remember Key" choice');assert.equal(grok.settings.provider,'api');assert.equal(grok.triggerPreferencesChanged,false);
  assert.equal(f.$('key').value,'');assert.equal(f.visible(),'step-usage');
  f.$('back').listeners.click();await settle();
  assert.equal(f.$('key-saved').hidden,false);assert.equal(f.$('key-entry').hidden,true);assert.equal(f.$('next').disabled,false);
  f.$('key-replace').listeners.click();assert.equal(f.$('key-entry').hidden,false);assert.equal(f.$('next').disabled,true);

  f.choose('key-claude');assert.equal(f.$('key-privacy').textContent,'Encrypted on this device and sent only to api.anthropic.com.');
  assert.equal(f.$('key-link').getAttribute('href'),'https://console.anthropic.com/settings/keys');
  f.$('key').value='not-a-claude-key';f.$('key').listeners.input();await f.next();
  assert.equal(f.$('key-error').textContent,UI.t('claude.keyInvalid','en'));assert.equal(f.sent('SAVE_CLAUDE_KEY').length,0);assert.equal(f.visible(),'step-auth');
  f.$('key').value='sk-ant-'+'c'.repeat(24);f.$('key').listeners.input();assert.equal(f.$('key-error').textContent,'');
  await f.next();
  const [claude]=f.sent('SAVE_CLAUDE_KEY');
  assert.equal(claude.settings.provider,'claude');assert.equal(claude.triggerPreferencesChanged,false);assert.equal(f.visible(),'step-usage');
  assert.equal(f.$('usage-auto-body').textContent,UI.t('onboarding.autoClaudeBody','en'));
});

test('worker errors stay inline and never echo provider text',async()=>{
  const f=fixture({override:message=>message.type==='SAVE_KEY'?{ok:false,errorKey:'errors.keyStorage',error:'PRIVATE_PROVIDER_TEXT'}:null});await settle();
  f.choose('connect-key');await f.next();f.$('key').value='xai-fixture-key';f.$('key').listeners.input();await f.next();
  assert.equal(f.$('key-error').textContent,UI.t('errors.keyStorage','en'));assert.equal(f.visible(),'step-auth');
  assert.doesNotMatch(f.ids.get('key-error').textContent+f.$('status').textContent,/PRIVATE/);
});

test('Finish saves the chosen style and records completion; without a choice triggers stay untouched',async()=>{
  const fresh={provider:'oauth',triggerMode:'custom',customTriggers:{...Core.DEFAULT_CUSTOM_TRIGGERS,...Core.CLICK_ONLY_TRIGGERS}};
  const f=fixture({settings:fresh,oauthStatus:connected(['grok-4.3'])});await settle();await f.next();await f.next();
  assert.equal(f.$('usage-click').checked,true);assert.equal(f.$('budget-field').hidden,true);assert.equal(f.$('next').textContent,'Finish');
  f.choose('usage-auto');await f.next();
  const [auto]=f.sent('SAVE_SETTINGS');
  assert.equal(auto.triggerPreferencesChanged,true);assert.equal(auto.settings.triggerMode,'automatic');assert.equal(auto.settings.enabled,true);
  assert.equal(auto.settings.claudeAutoTrigger,false,'Grok settings keep the Claude opt-in off');
  assert.equal(f.local.onboarding.state,'done');assert.equal(f.local.onboarding.version,1);assert.equal(f.visible(),'done');
  assert.equal(f.$('skip').hidden,true,'nothing left to skip');
  await f.$('open-x').listeners.click();assert.deepEqual(f.navigations,['https://x.com/home']);
  await f.$('more-settings').listeners.click();assert.deepEqual(f.opened,['options']);

  const c=fixture({settings:{provider:'claude'},claudeConfigured:true});await settle();await c.next();await c.next();
  assert.equal(c.$('usage-click').checked,true,'Claude without automatic checks is click-only');
  c.choose('usage-auto');assert.equal(c.$('budget-field').hidden,false);
  assert.equal(c.$('budget').value,String(Core.DEFAULT_SETTINGS.claudeBudgetUsd),'the existing default budget, not a second value');
  c.$('budget').value='';c.$('budget').listeners.input();assert.equal(c.$('next').disabled,true);
  c.$('budget').value='35';c.$('budget').listeners.input();await c.next();
  const [claude]=c.sent('SAVE_SETTINGS');
  assert.equal(claude.settings.claudeAutoTrigger,true);assert.equal(claude.settings.claudeBudgetUsd,35);assert.equal(claude.settings.triggerMode,'automatic');

  const k=fixture({settings:{provider:'claude',claudeAutoTrigger:true,triggerMode:'automatic'},claudeConfigured:true});await settle();await k.next();await k.next();
  k.choose('usage-click');await k.next();
  const [click]=k.sent('SAVE_SETTINGS');
  assert.equal(click.settings.claudeAutoTrigger,false);assert.equal(Core.clickOnlyTriggers(click.settings),true);

  const customTriggers={...Core.DEFAULT_CUSTOM_TRIGGERS,detailReplies:true};
  const custom=fixture({settings:{provider:'oauth',triggerMode:'custom',customTriggers},oauthStatus:connected(['grok-4.3'])});await settle();await custom.next();await custom.next();
  assert.equal(custom.$('usage-click').checked,false);assert.equal(custom.$('usage-auto').checked,false);assert.equal(custom.$('next').disabled,false);
  await custom.next();
  assert.equal(custom.sent('SAVE_SETTINGS').length,0);assert.deepEqual(custom.settings().customTriggers,customTriggers);assert.equal(custom.local.onboarding.state,'done');
});

test('Skip records the dismissal and opens Settings; leaving mid sign-in cancels it',async()=>{
  const f=fixture();await settle();
  await f.$('skip').listeners.click();await settle();
  assert.equal(f.local.onboarding.state,'dismissed');assert.deepEqual(f.opened,['options']);
  assert.equal(f.sent('SAVE_SETTINGS').length,0);
  const g=fixture();await settle();await g.next();await g.$('oauth-login').listeners.click();await settle();
  g.pageListeners.pagehide();await settle();assert.equal(g.sent('OAUTH_CANCEL_LOGIN').length,1);
});

test('pressing through a re-opened guide never rewrites saved triggers, even when click-only is preselected',async()=>{
  const saved={provider:'claude',triggerMode:'automatic',claudeAutoTrigger:false};
  const f=fixture({settings:saved,claudeConfigured:true});await settle();
  assert.equal(f.$('usage-click').checked,true,'Claude without automatic checks shows as click-only');
  await f.next();await f.next();assert.equal(f.visible(),'step-usage');
  await f.next();
  assert.equal(f.sent('SAVE_SETTINGS').length,0);assert.equal(f.settings().triggerMode,'automatic');assert.equal(f.local.onboarding.state,'done');
  const g=fixture({settings:saved,claudeConfigured:true});await settle();await g.next();await g.next();
  g.choose('usage-click');await g.next();
  const [click]=g.sent('SAVE_SETTINGS');
  assert.equal(click.triggerPreferencesChanged,true);assert.equal(Core.clickOnlyTriggers(click.settings),true,'an explicit pick is still saved');
});

test('a connected sign-in with no model list offers a refresh instead of an empty picker',async()=>{
  let refreshed=0;
  const f=fixture({settings:{provider:'oauth'},oauthStatus:{...connected([]),catalogErrorCode:'OAUTH_CATALOG_UNAVAILABLE'},
    override:message=>message.type==='OAUTH_REFRESH_CATALOG'?(refreshed++,{ok:true,oauthStatus:connected(['grok-4.3'])}):null});
  await settle();await f.next();
  assert.equal(f.$('oauth-model-field').hidden,true,'no empty model select');
  assert.equal(f.$('oauth-catalog').hidden,false);assert.equal(f.$('oauth-catalog-state').textContent,UI.t('oauth.catalogConnected','en'));
  assert.notEqual(f.$('oauth-model-help').textContent,UI.t('oauth.modelUnavailable','en',{model:'grok-4.3'}));
  assert.equal(f.$('next').disabled,true);
  await f.$('oauth-refresh-models').listeners.click();await settle();
  assert.equal(refreshed,1);assert.equal(f.$('oauth-catalog').hidden,true);assert.equal(f.$('next').disabled,false);
  const loading=fixture({settings:{provider:'oauth'},oauthStatus:connected([])});await settle();await loading.next();
  assert.equal(loading.$('oauth-catalog').hidden,false);assert.equal(loading.$('oauth-catalog-state').textContent,'','still loading: no error shown');
  assert.equal(loading.$('oauth-model-field').hidden,true);
});
