(async function(){
  'use strict';
  // Three steps: connection, connect, usage style. Credentials and settings go
  // through the worker's existing messages; this page stores only its own
  // progress record.
  const UI=globalThis.GrokFirstUI,Core=globalThis.XGrokCore,$=id=>document.getElementById(id);
  const STEPS=['step-connect','step-auth','step-usage'],DONE=STEPS.length;
  const KEYS={
    api:{host:'api.x.ai',link:'https://grok.com/dashboard/api-keys',linkKey:'onboarding.getGrokKey',placeholder:'options.keyPlaceholder',required:'options.keyRequired',invalid:'errors.keyInvalid',valid:value=>value.length<=500&&!/[\r\n]/.test(value)},
    claude:{host:'api.anthropic.com',link:'https://console.anthropic.com/settings/keys',linkKey:'onboarding.getClaudeKey',placeholder:'claude.keyPlaceholder',required:'claude.keyRequired',invalid:'claude.keyInvalid',valid:value=>/^sk-ant-[A-Za-z0-9_-]{8,490}$/.test(value)}
  };
  const OAUTH_WAITING={authorizing:'oauth.authorizing',restoring:'oauth.restoring',refreshing:'oauth.refreshing'};
  let locale='en',settings=Core.normalizeSettings(Core.DEFAULT_SETTINGS),config={},oauth=oauthView();
  let loaded=false,busy=false,step=0,connect='oauth',keyKind='api',replacingKey=false,usage='',chosenModel='',status='',keyError='',pollTimer;
  const t=(key,vars)=>UI.t(key,locale,vars);

  async function send(message){
    const result=await chrome.runtime.sendMessage(message);
    if(!result?.ok)throw Object.assign(new Error('Request failed'),{key:result?.errorKey||'errors.noResponse'});
    return result;
  }
  function oauthView(raw){
    const state={starting:'authorizing',awaiting_authorization:'authorizing'}[raw?.state]||raw?.state||'idle',connected=raw?.connected===true;
    const code=raw?.device?.userCode,url=Core.officialOAuthURL(raw?.device?.verificationUriComplete);
    const models=connected&&Array.isArray(raw.catalogModels)?raw.catalogModels.flatMap(entry=>{const id=typeof entry==='string'?entry:entry?.id;return typeof id==='string'&&entry?.available!==false?[id]:[];}):[];
    return {state,connected,models,errorKey:raw?.errorCode?Core.oauthErrorKey(raw.errorCode):'',
      device:state==='authorizing'&&typeof code==='string'&&/^[A-Za-z0-9-]{3,32}$/.test(code)&&url?{code,url}:null};
  }
  function applyConfig(result){config=result;settings=Core.normalizeSettings(result.settings);oauth=oauthView(result.oauthStatus);}
  async function refreshConfig(){applyConfig(await send({type:'GET_CONFIG'}));}
  // Only an explicit choice is preselected; custom or paused triggers stay as
  // they are unless the user picks one of the two styles.
  function savedUsage(value){
    const mode=Core.triggerMode(value);
    if(mode==='paused')return '';
    if(Core.claudeManualOnly(value)||Core.clickOnlyTriggers(value))return 'click';
    return mode==='automatic'?'auto':'';
  }
  function keyConfigured(kind){return kind==='api'?config.keyState==='ready':config.claudeStatus?.configured===true;}
  // Never silently switch to another (possibly pricier) model: the saved one
  // is used when the account offers it, otherwise the user picks.
  function oauthModel(){return oauth.models.includes(settings.oauthModel)?settings.oauthModel:oauth.models.includes(chosenModel)?chosenModel:'';}
  function budgetValid(){const value=$('budget').value.trim(),number=Number(value);return value!==''&&Number.isFinite(number)&&number>=0&&number<=100000;}
  function stepReady(){
    if(step===1)return connect==='oauth'?oauth.connected&&Boolean(oauthModel()):keyConfigured(keyKind)&&!replacingKey||Boolean($('key').value.trim());
    if(step===2)return usage!=='auto'||settings.provider!=='claude'||budgetValid();
    return true;
  }

  function renderOAuth(){
    const waiting=OAUTH_WAITING[oauth.state];
    $('oauth-intro').hidden=oauth.connected||Boolean(oauth.device);
    $('oauth-login').hidden=oauth.connected||Boolean(waiting);$('oauth-login').disabled=busy;
    $('oauth-device').hidden=!oauth.device;$('oauth-code').textContent=oauth.device?.code||'';
    if(oauth.device)$('oauth-official').setAttribute('href',oauth.device.url);else $('oauth-official').removeAttribute('href');
    $('oauth-state').textContent=oauth.connected?'':waiting?t(waiting):oauth.errorKey?t(oauth.errorKey):'';
    $('oauth-connected').hidden=!oauth.connected;
    const unavailable=oauth.connected&&!oauth.models.includes(settings.oauthModel);
    $('oauth-model-field').hidden=!unavailable;
    if(unavailable){
      const select=$('oauth-model'),choices=Core.API_MODELS.filter(item=>oauth.models.includes(item.value));
      const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='—';placeholder.disabled=true;
      select.replaceChildren(placeholder,...choices.map(item=>{const option=document.createElement('option');option.value=item.value;option.textContent=item.label;return option;}));
      select.value=choices.some(item=>item.value===chosenModel)?chosenModel:'';
      $('oauth-model-help').textContent=t('oauth.modelUnavailable',{model:settings.oauthModel});
    }
  }
  function renderKey(){
    const kind=KEYS[keyKind],saved=keyConfigured(keyKind)&&!replacingKey;
    $('key-api').checked=keyKind==='api';$('key-claude').checked=keyKind==='claude';
    $('key-entry').hidden=saved;$('key-saved').hidden=!saved;
    $('key').placeholder=t(kind.placeholder);$('key').setAttribute('aria-label',t(kind.placeholder));
    $('key').setAttribute('aria-invalid',String(Boolean(keyError)));$('key-error').textContent=keyError?t(keyError):'';
    $('key-link').setAttribute('href',kind.link);$('key-link').textContent=t(kind.linkKey);
    $('key-privacy').textContent=t('onboarding.keyPrivacy',{host:kind.host});
  }
  function renderUsage(){
    $('usage-click').checked=usage==='click';$('usage-auto').checked=usage==='auto';
    const claude=settings.provider==='claude';
    $('usage-auto-body').textContent=t(claude?'onboarding.autoClaudeBody':'onboarding.autoBody');
    $('budget-field').hidden=!claude||usage!=='auto';
  }
  function render(){
    UI.apply(document,locale);document.title=`SuperX · ${t('onboarding.title')}`;
    STEPS.forEach((id,index)=>{$(id).hidden=index!==step;});
    $('skip').hidden=step===DONE;$('flow').hidden=step===DONE;$('done').hidden=step!==DONE;
    $('progress').textContent=t('onboarding.progress',{step:Math.min(step,DONE-1)+1});
    $('connect-oauth').checked=connect==='oauth';$('connect-key').checked=connect==='key';
    $('auth-oauth').hidden=connect!=='oauth';$('auth-key').hidden=connect!=='key';
    renderOAuth();renderKey();renderUsage();
    $('status').textContent=status?t(status):'';
    $('back').hidden=step===0;$('back').disabled=busy;
    $('next').textContent=t(step===DONE-1?'onboarding.finish':'onboarding.continue');
    $('next').disabled=busy||!loaded||!stepReady();
  }

  function schedulePoll(){
    clearTimeout(pollTimer);pollTimer=undefined;
    if(step===1&&connect==='oauth'&&OAUTH_WAITING[oauth.state])pollTimer=setTimeout(async()=>{
      pollTimer=undefined;
      try{oauth=oauthView((await send({type:'GET_OAUTH_STATUS'})).oauthStatus);}catch{/* The next status change or poll retries. */}
      render();schedulePoll();
    },1500);
  }
  async function oauthAction(type,values={}){
    if(busy)return;busy=true;status='';render();
    try{
      const result=await chrome.runtime.sendMessage({type,...values});
      if(result?.oauthStatus)oauth=oauthView(result.oauthStatus);
      if(!result?.ok)status=Core.oauthErrorKey(result?.errorCode||result?.oauthStatus?.errorCode);
    }catch{status='oauth.unavailable';}
    finally{busy=false;render();schedulePoll();}
  }
  function cancelPendingLogin(){if(oauth.state==='authorizing')void chrome.runtime.sendMessage({type:'OAUTH_CANCEL_LOGIN'}).catch(()=>{});}
  async function record(state){try{await chrome.storage.local.set({onboarding:{version:1,state,at:Date.now()}});}catch{/* Only the setup redirect depends on it. */}}

  // Switches the answer source without touching saved triggers.
  async function useProvider(provider,extra={}){
    const next={...settings,provider,...extra};
    if(Object.entries(next).some(([key,value])=>settings[key]!==value))await send({type:'SAVE_SETTINGS',settings:next,triggerPreferencesChanged:false});
  }
  async function saveKey(){
    const raw=$('key').value.trim(),kind=KEYS[keyKind];
    if(!raw){await useProvider(keyKind);return true;}
    if(!kind.valid(raw)){keyError=kind.invalid;return false;}
    const next={...settings,provider:keyKind};
    await send(keyKind==='api'?{type:'SAVE_KEY',apiKey:raw,remember:true,settings:next,triggerPreferencesChanged:false}:{type:'SAVE_CLAUDE_KEY',apiKey:raw,settings:next,triggerPreferencesChanged:false});
    $('key').value='';replacingKey=false;return true;
  }
  async function finish(){
    await refreshConfig();
    if(usage){
      const claude=settings.provider==='claude';
      const next=usage==='click'
        ?{...settings,triggerMode:'custom',enabled:true,customTriggers:{...settings.customTriggers,...Core.CLICK_ONLY_TRIGGERS},...(claude?{claudeAutoTrigger:false}:{})}
        :{...settings,triggerMode:'automatic',enabled:true,...(claude?{claudeAutoTrigger:true,claudeBudgetUsd:Number($('budget').value)}:{})};
      await send({type:'SAVE_SETTINGS',settings:next,triggerPreferencesChanged:true});
    }
    await record('done');
  }
  async function next(){
    if(busy||!loaded||!stepReady())return;
    if(step===0){step=1;status='';render();schedulePoll();return;}
    busy=true;status='';keyError='';render();
    try{
      if(step===1){
        if(connect==='oauth'){const model=oauthModel();await useProvider('oauth',{oauthModel:model,oauthReasoningEffort:model===settings.oauthModel?settings.oauthReasoningEffort:Core.reasoningEffort(model)});}
        else if(!await saveKey())return;
        await refreshConfig();
        if(!usage)usage=savedUsage(settings);
        $('budget').value=String(settings.claudeBudgetUsd);
      }else await finish();
      step++;
    }catch(error){if(step===1&&connect==='key')keyError=error.key||'errors.noResponse';else status=error.key||'errors.noResponse';}
    finally{busy=false;render();schedulePoll();}
  }

  $('flow').addEventListener('submit',event=>{event.preventDefault();void next();});
  $('back').addEventListener('click',()=>{if(busy||step===0)return;if(step===1)cancelPendingLogin();step--;status='';keyError='';render();schedulePoll();});
  for(const id of ['connect-oauth','connect-key'])$(id).addEventListener('change',()=>{if($(id).checked){connect=$(id).value;render();}});
  for(const id of ['key-api','key-claude'])$(id).addEventListener('change',()=>{if($(id).checked){keyKind=$(id).value;keyError='';render();}});
  for(const id of ['usage-click','usage-auto'])$(id).addEventListener('change',()=>{if($(id).checked){usage=$(id).value;render();}});
  $('key').addEventListener('input',()=>{keyError='';render();});
  $('budget').addEventListener('input',()=>render());
  $('oauth-model').addEventListener('change',()=>{chosenModel=$('oauth-model').value;render();});
  $('key-replace').addEventListener('click',()=>{replacingKey=true;render();$('key').focus();});
  $('oauth-login').addEventListener('click',()=>oauthAction('OAUTH_LOGIN',{remember:true}));
  $('oauth-cancel').addEventListener('click',()=>oauthAction('OAUTH_CANCEL_LOGIN'));
  $('oauth-copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(oauth.device?.code||'');status='';}catch{status='common.copyFailed';}render();});
  $('skip').addEventListener('click',async()=>{cancelPendingLogin();await record('dismissed');await chrome.runtime.openOptionsPage();});
  $('more-settings').addEventListener('click',()=>chrome.runtime.openOptionsPage());
  $('open-x').addEventListener('click',()=>location.assign('https://x.com/home'));
  globalThis.addEventListener('pagehide',cancelPendingLogin);
  chrome.runtime.onMessage.addListener(message=>{
    if(message?.type!=='OAUTH_STATUS_CHANGED')return;
    oauth=oauthView(message.oauthStatus);render();schedulePoll();
  });

  render();
  try{
    const [language,result]=await Promise.all([send({type:'GET_UI_LANGUAGE'}),send({type:'GET_CONFIG'})]);
    applyConfig(result);
    locale=UI.resolveLanguage(settings.interfaceLanguage,language.language||navigator.language);
    connect=['api','claude'].includes(settings.provider)?'key':'oauth';keyKind=settings.provider==='claude'?'claude':'api';usage=savedUsage(settings);
    loaded=true;
  }catch{status='errors.noResponse';}
  render();
})();
