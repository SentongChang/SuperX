'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/feed-core.js');
const claude = require('../extension/claude-transport.js');
const api = require('../extension/api-provider.js');

const encoder = new TextEncoder();
const KEY = 'sk-ant-api03-test-fixture-key';
const post = {id:'100',url:'https://x.com/author/status/100',text:'The Eiffel Tower is 330 metres tall.',language:'en',quotedContext:[],
  images:[{url:'https://pbs.twimg.com/media/fixture.jpg',alt:'tower'}],hasMedia:true};
const settings = {...core.DEFAULT_SETTINGS,provider:'claude',language:'en'};

function sse(events) {
  const text = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new ReadableStream({start(controller){controller.enqueue(encoder.encode(text));controller.close();}});
}
function response(events, status = 200) {
  return {ok:status>=200&&status<300,status,headers:new Map(),body:sse(events)};
}
function jsonResponse(status, value) {
  const body = new ReadableStream({start(controller){controller.enqueue(encoder.encode(JSON.stringify(value)));controller.close();}});
  return {ok:false,status,headers:new Map(),body};
}
function turn({model='claude-haiku-5-5',preface='',answer='',citations=[],search=true,stop='end_turn',usage={input_tokens:12000,cache_read_input_tokens:2000,output_tokens:400,server_tool_use:{web_search_requests:1}}}={}) {
  const events = [{type:'message_start',message:{model,usage:{input_tokens:usage.input_tokens,cache_read_input_tokens:usage.cache_read_input_tokens,output_tokens:1}}}];
  let index = 0;
  if (preface) {
    events.push({type:'content_block_start',index,content_block:{type:'text',text:''}},{type:'content_block_delta',index,delta:{type:'text_delta',text:preface}},{type:'content_block_stop',index});index++;
  }
  if (search) {
    events.push({type:'content_block_start',index,content_block:{type:'server_tool_use',id:'srvtoolu_1',name:'web_search',input:{}}},
      {type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:'{"query":"Eiffel Tower height"}'}},{type:'content_block_stop',index});index++;
    events.push({type:'content_block_start',index,content_block:{type:'web_search_tool_result',tool_use_id:'srvtoolu_1',content:[{type:'web_search_result',url:'https://www.toureiffel.paris/en',title:'Official site',encrypted_content:'x'}]}},{type:'content_block_stop',index});index++;
  }
  if (answer) {
    events.push({type:'content_block_start',index,content_block:{type:'text',text:''}},{type:'content_block_delta',index,delta:{type:'text_delta',text:answer}});
    for (const citation of citations) events.push({type:'content_block_delta',index,delta:{type:'citations_delta',citation}});
    events.push({type:'content_block_stop',index});
  }
  events.push({type:'message_delta',delta:{stop_reason:stop},usage},{type:'message_stop'});
  return events;
}

test('settings default to Haiku 5.5, manual triggers and a $100 cycle that resets on the 15th', () => {
  const value = core.normalizeSettings({provider:'claude'});
  assert.equal(value.provider,'claude');
  assert.equal(value.claudeModel,'claude-haiku-5-5');assert.equal(value.claudeEffort,'medium');
  assert.equal(value.claudeBudgetUsd,100);assert.equal(value.claudeCycleDay,15);assert.equal(value.claudeMaxSearches,3);
  assert.equal(value.claudeAutoTrigger,false);
  assert.equal(core.providerModel(value),'claude-haiku-5-5');assert.equal(core.providerEffort(value),'medium');
  const bounded = core.normalizeSettings({provider:'claude',claudeModel:'grok-4.3',claudeEffort:'max',claudeCycleDay:31,claudeMaxSearches:50,claudeBudgetUsd:-3});
  assert.equal(bounded.claudeModel,'claude-haiku-5-5');assert.equal(bounded.claudeEffort,'medium');
  assert.equal(bounded.claudeCycleDay,28);assert.equal(bounded.claudeMaxSearches,10);assert.equal(bounded.claudeBudgetUsd,0);
  // Other connections keep their settings and the new provider is accepted.
  assert.equal(core.normalizeSettings({provider:'api'}).provider,'api');
});

test('Claude starts only from the post button unless automatic checks are explicitly enabled', () => {
  const manualOnly = core.normalizeSettings({provider:'claude',triggerMode:'automatic'});
  assert.equal(core.postTriggerAllowed(manualOnly,'automatic'),false);
  assert.equal(core.postTriggerAllowed(manualOnly,'post-hover'),false);
  assert.equal(core.postTriggerAllowed(manualOnly,'button-hover'),false);
  assert.equal(core.postTriggerAllowed(manualOnly,'manual'),true);
  assert.equal(core.postTriggerAllowed(manualOnly,'recheck'),true);
  assert.equal(core.postTriggerAllowed({...manualOnly,triggerMode:'paused'},'manual'),false);
  const effective = core.effectiveTriggerSettings(manualOnly);
  assert.equal(effective.triggerMode,'custom');assert.equal(effective.customTriggers.manual,true);assert.equal(effective.customTriggers.detailMain,false);
  // The user's saved Grok trigger preferences are not changed.
  assert.equal(manualOnly.triggerMode,'automatic');
  const automatic = {...manualOnly,claudeAutoTrigger:true};
  assert.equal(core.postTriggerAllowed(automatic,'automatic'),true);
  assert.equal(core.effectiveTriggerSettings(automatic),automatic);
  const grok = core.normalizeSettings({provider:'oauth'});
  assert.equal(core.postTriggerAllowed(grok,'automatic'),true);
});

test('billing cycles start on the configured local day', () => {
  const cycle = core.claudeCycle(new Date(2026,10,21,12).getTime(),15);
  assert.equal(cycle.start,new Date(2026,10,15).getTime());assert.equal(cycle.end,new Date(2026,11,15).getTime());
  const before = core.claudeCycle(new Date(2026,11,14,23).getTime(),15);
  assert.equal(before.start,new Date(2026,10,15).getTime());
  const january = core.claudeCycle(new Date(2027,0,3).getTime(),15);
  assert.equal(january.start,new Date(2026,11,15).getTime());assert.equal(january.end,new Date(2027,0,15).getTime());
});

test('fact-check requests use the Messages API with web search, effort, images and a cached system prompt', () => {
  const responses = api.buildRequest(post,{...settings,verifyPrompt:core.DEFAULT_PROMPTS.verify});
  assert.match(responses.instructions,/snapshot of that post as currently displayed/);
  assert.doesNotMatch(responses.instructions,/retrieve that exact original post and its full text/);
  const body = claude.messagesRequest(responses,settings,{now:new Date(2026,10,21).getTime()});
  assert.equal(body.model,'claude-haiku-5-5');assert.equal(body.stream,true);assert.equal(body.max_tokens,16000);
  assert.deepEqual(body.output_config,{effort:'medium'});
  assert.equal(body.thinking,undefined);assert.equal(body.temperature,undefined);
  assert.deepEqual(body.tools,[{type:'web_search_20250305',name:'web_search',max_uses:3}]);
  assert.deepEqual(body.system[0].cache_control,{type:'ephemeral'});
  assert.match(body.system[1].text,/The current date is 2026-11-21\./);
  assert.equal(body.fallbacks,undefined);
  const content = body.messages[0].content;
  assert.equal(body.messages.length,1);assert.equal(body.messages[0].role,'user');
  assert.equal(content[0].text,post.url);
  assert.ok(content.some(part=>part.type==='image'&&part.source.type==='url'&&part.source.url.startsWith('https://pbs.twimg.com/media/fixture.jpg')));
  const headers = claude.headers(KEY,body);
  assert.equal(headers['x-api-key'],KEY);assert.equal(headers['anthropic-version'],'2023-06-01');
  assert.equal(headers['anthropic-dangerous-direct-browser-access'],'true');assert.equal(headers['anthropic-beta'],undefined);
  const sonnet = claude.messagesRequest(responses,{...settings,claudeModel:'claude-sonnet-5-5',claudeEffort:'low',claudeMaxSearches:5});
  assert.equal(sonnet.tools[0].type,'web_search_20260209');assert.equal(sonnet.tools[0].max_uses,5);
  assert.equal(sonnet.fallbacks,'default');assert.equal(claude.headers(KEY,sonnet)['anthropic-beta'],'server-side-fallback-2026-07-01');
});

test('draft images become base64 image blocks', () => {
  const png = 'data:image/png;base64,'+Buffer.from('\x89PNG\r\n\x1a\nfixture','binary').toString('base64');
  const content = claude.userContent([{role:'user',content:[{type:'input_text',text:'label'},{type:'input_image',image_url:png}]}]);
  assert.deepEqual(content[1],{type:'image',source:{type:'base64',media_type:'image/png',data:png.split(',')[1]}});
});

test('cost estimates include cache reads, cache writes, long prompts and web searches', () => {
  const haiku = claude.costUSD({input_tokens:50_000,output_tokens:50_000},'claude-haiku-5-5');
  assert.ok(Math.abs(haiku-0.03)<1e-9);
  const long = claude.costUSD({input_tokens:200_000,output_tokens:0},'claude-haiku-5-5');
  assert.ok(Math.abs(long-0.1)<1e-9);
  const cached = claude.costUSD({input_tokens:0,cache_creation_input_tokens:1_000_000,cache_read_input_tokens:1_000_000,output_tokens:0},'claude-sonnet-5-5');
  assert.ok(Math.abs(cached-(2.5+0.1))<1e-9);
  assert.ok(Math.abs(claude.costUSD({web_search_requests:3},'claude-opus-5-5')-0.03)<1e-9);
});

test('a streamed fact check returns only the final answer with cited sources and estimated cost', async () => {
  const sent=[],updates=[];
  const citation={type:'web_search_result_location',url:'https://www.toureiffel.paris/en',title:'Official site',cited_text:'330 m'};
  const result = await api.run(post,settings,KEY,{onUpdate:update=>updates.push(update),fetchImpl:async(url,request)=>{
    sent.push({url,request});
    return response(turn({preface:'I will search for this.',answer:'The tower is about 330 metres tall including antennas.',citations:[citation]}));
  }});
  assert.equal(sent.length,1);assert.equal(sent[0].url,'https://api.anthropic.com/v1/messages');
  assert.equal(sent[0].request.headers['x-api-key'],KEY);assert.equal(sent[0].request.credentials,'omit');
  assert.equal(result.provider,'claude');
  assert.equal(result.text,'The tower is about 330 metres tall including antennas.');
  assert.doesNotMatch(result.text,/I will search/);
  assert.deepEqual(result.sources,[{url:'https://www.toureiffel.paris/en',title:'Official site'}]);
  assert.equal(result.searched,true);assert.equal(result.verificationStatus,'completed');
  assert.equal(result.model,'claude-haiku-5-5');assert.equal(result.usageComplete,true);
  assert.equal(result.usage.input_tokens,14000);assert.equal(result.usage.output_tokens,400);
  assert.equal(result.usage.server_side_tool_usage_details.web_search_calls,1);
  const expected = claude.costUSD({input_tokens:12000,cache_read_input_tokens:2000,output_tokens:400,web_search_requests:1},'claude-haiku-5-5');
  assert.equal(result.usage.cost_in_usd_ticks,Math.round(expected*claude.USD_TICKS));
  assert.ok(updates.some(update=>update.text==='I will search for this.'));
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('pause_turn resumes the same assistant turn and sums usage across requests', async () => {
  const bodies=[];
  const result = await api.run(post,settings,KEY,{fetchImpl:async(url,request)=>{
    bodies.push(JSON.parse(request.body));
    return response(bodies.length===1?turn({stop:'pause_turn'}):turn({search:false,answer:'Correct: about 330 m.'}));
  }});
  assert.equal(bodies.length,2);
  assert.equal(bodies[1].messages.length,2);assert.equal(bodies[1].messages[1].role,'assistant');
  assert.deepEqual(bodies[1].messages[1].content.map(block=>block.type),['server_tool_use','web_search_tool_result']);
  assert.deepEqual(bodies[1].messages[1].content[0].input,{query:'Eiffel Tower height'});
  assert.equal(result.text,'Correct: about 330 m.');
  assert.equal(result.usage.output_tokens,800);assert.equal(result.usage.server_side_tool_usage_details.web_search_calls,2);
});

test('HTTP and stream failures map to shared, non-leaking error codes', async () => {
  await assert.rejects(api.run(post,settings,KEY,{fetchImpl:async()=>jsonResponse(401,{type:'error',error:{type:'authentication_error',message:'invalid x-api-key '+KEY}})}),error=>{
    assert.equal(error.code,'API_ERROR');assert.match(error.message,/Claude API Key/);
    assert.equal(error.verificationFailure.httpStatus,401);assert.equal(error.verificationFailure.providerCode,'authentication_error');
    assert.equal(core.autoRetryDecision(error).retryable,false);
    assert.ok(!JSON.stringify({...error,message:error.message}).includes(KEY));
    return true;
  });
  await assert.rejects(api.run(post,settings,KEY,{fetchImpl:async()=>jsonResponse(529,{type:'error',error:{type:'overloaded_error',message:'Overloaded'}})}),error=>{
    assert.equal(error.code,'API_CAPACITY');assert.equal(core.autoRetryDecision(error).retryable,true);return true;
  });
  await assert.rejects(api.run(post,settings,KEY,{fetchImpl:async()=>jsonResponse(400,{type:'error',error:{type:'invalid_request_error',message:'Your credit balance is too low'}})}),error=>{
    assert.equal(error.code,'API_ERROR');assert.match(error.message,/额度/);assert.equal(core.autoRetryDecision(error).retryable,false);return true;
  });
  const partial = await api.run(post,settings,KEY,{fetchImpl:async()=>response([...turn({answer:'Partial finding about the height.'}).slice(0,-2),{type:'error',error:{type:'overloaded_error',message:'Overloaded'}}])}).catch(error=>error);
  assert.equal(partial.code,'API_CAPACITY');assert.equal(partial.partialResult.text,'Partial finding about the height.');
  const limited = await api.run(post,settings,KEY,{fetchImpl:async()=>response(turn({answer:'Cut off',stop:'max_tokens'}))});
  assert.equal(limited.verificationStatus,'incomplete');assert.equal(limited.verificationFailure.code,'OUTPUT_LIMIT');
  await assert.rejects(api.run(post,settings,'',{fetchImpl:async()=>assert.fail('no request without a key')}),error=>error.code==='NEEDS_KEY');
});

test('comment drafts use structured JSON output and the shared validator', async () => {
  let body;
  const result = await api.generateComments(post,settings,KEY,{analysis:{text:'Checked'},fetchImpl:async(url,request)=>{
    body=JSON.parse(request.body);
    return response(turn({search:false,answer:JSON.stringify({comments:['First distinct thought.','A second, different angle?','Third separate remark.']})}));
  }});
  assert.equal(body.tools,undefined);assert.equal(body.max_tokens,4000);
  assert.deepEqual(body.output_config.format,{type:'json_schema',schema:claude.COMMENTS_SCHEMA});
  assert.deepEqual(result.comments,['First distinct thought.','A second, different angle?','Third separate remark.']);
  assert.equal(result.provider,'claude');
});

test('Claude keys are recognised by prefix', () => {
  assert.equal(claude.validKey(KEY),true);
  assert.equal(claude.validKey('xai-abcdefghijklmnop'),false);
  assert.equal(claude.validKey('sk-ant-short'),false);
  assert.equal(claude.ticksToUSD(25_000_000_0),0.025);
});
