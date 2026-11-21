/* SuperX: Claude (Anthropic Messages API) request and stream translation.
 * The shared fact-check prompts are built by api-provider.js in the Responses
 * shape. This module converts them to a Messages API request, parses the
 * Claude server-sent events and estimates the cost charged to the user's own
 * API credit. Credentials are passed in by the worker and never stored here. */
(function (root) {
  'use strict';
  const Core = root.XGrokCore || (typeof require === 'function' ? require('./feed-core.js') : null);
  const ENDPOINT = 'https://api.anthropic.com/v1/messages';
  const API_VERSION = '2023-06-01';
  const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
  // One USD is 10^10 ticks, the same unit the xAI usage field uses, so the
  // shared usage merge/history code can carry Claude cost estimates as well.
  const USD_TICKS = 1e10;
  // Adaptive thinking shares max_tokens with the visible answer. Leave room
  // so a normal fact check is not cut off; the prompt keeps answers concise.
  const MAX_TOKENS = Object.freeze({verify: 16000, comments: 4000});
  const MAX_CONTINUATIONS = 2;
  const COMMENTS_SCHEMA = Object.freeze({type: 'object', properties: {comments: {type: 'array', items: {type: 'string'}}}, required: ['comments'], additionalProperties: false});
  const SEARCH_GUIDANCE = 'Your training data ends well before today\'s date. Records, office holders, prices, versions, rules and anything "latest" may have changed since then, so search for those before you answer, even when you feel sure. Facts that can\'t change need no search.';

  function profile(model) {
    return Core.claudeModelProfile(model) || Core.claudeModelProfile(Core.DEFAULT_SETTINGS.claudeModel);
  }
  function validKey(value) {
    return typeof value === 'string' && /^sk-ant-[A-Za-z0-9_-]{8,490}$/.test(value.trim());
  }
  function dataImage(url) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    return match ? {type: 'base64', media_type: match[1], data: match[2]} : null;
  }
  function contentPart(part) {
    if (typeof part === 'string') return part.trim() ? {type: 'text', text: part} : null;
    if (part?.type === 'input_text') return typeof part.text === 'string' && part.text.trim() ? {type: 'text', text: part.text} : null;
    if (part?.type === 'input_image' && typeof part.image_url === 'string') {
      const data = dataImage(part.image_url);
      if (data) return {type: 'image', source: data};
      if (/^https:\/\//i.test(part.image_url)) return {type: 'image', source: {type: 'url', url: part.image_url}};
    }
    return null;
  }
  function userContent(input) {
    const content = [];
    for (const item of Array.isArray(input) ? input : []) {
      if (item?.role && item.role !== 'user') continue;
      const parts = typeof item?.content === 'string' ? [item.content] : Array.isArray(item?.content) ? item.content : [];
      for (const part of parts) { const converted = contentPart(part); if (converted) content.push(converted); }
    }
    return content;
  }
  function wantsSearch(tools) {
    return (Array.isArray(tools) ? tools : []).some(tool => ['web_search', 'x_search'].includes(tool?.type));
  }
  function localDate(now) {
    const date = new Date(now);
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }
  // `request` is the Responses-shaped request from GrokFirstAPI.buildRequest.
  function messagesRequest(request, settings, {stage = 'verify', now = Date.now()} = {}) {
    const model = profile(settings?.claudeModel);
    const comments = stage === 'comments';
    const body = {
      model: model.value,
      max_tokens: MAX_TOKENS[comments ? 'comments' : 'verify'],
      // The stable instructions carry the cache breakpoint; the date follows
      // it so a new day does not invalidate the cached prefix.
      system: [
        {type: 'text', text: String(request?.instructions || ''), cache_control: {type: 'ephemeral'}},
        {type: 'text', text: 'The current date is ' + localDate(now) + '.' + (comments ? '' : ' ' + SEARCH_GUIDANCE)}
      ],
      messages: [{role: 'user', content: userContent(request?.input)}],
      output_config: {effort: Core.claudeEffort(settings?.claudeEffort)},
      stream: true
    };
    if (!body.messages[0].content.length) body.messages[0].content.push({type: 'text', text: 'No content was supplied.'});
    if (!comments && wantsSearch(request?.tools)) {
      const maxUses = Math.min(10, Math.max(1, Math.trunc(Number(settings?.claudeMaxSearches)) || Core.DEFAULT_SETTINGS.claudeMaxSearches));
      body.tools = [{type: model.webSearchTool, name: 'web_search', max_uses: maxUses}];
    }
    if (comments) body.output_config.format = {type: 'json_schema', schema: COMMENTS_SCHEMA};
    // Server-side refusal fallback is offered on Sonnet/Opus; Haiku has none.
    if (model.fallbacks) body.fallbacks = 'default';
    return body;
  }
  function headers(apiKey, body) {
    const result = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      // Required for CORS requests made directly from an extension page.
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    if (body?.fallbacks) result['anthropic-beta'] = FALLBACK_BETA;
    return result;
  }
  function whole(value) { return Number.isFinite(value) && value >= 0 ? value : 0; }
  // Estimated USD for one Messages API response's usage.
  function costUSD(raw, model) {
    const price = profile(model);
    const input = whole(raw?.input_tokens), write = whole(raw?.cache_creation_input_tokens), read = whole(raw?.cache_read_input_tokens), output = whole(raw?.output_tokens);
    const long = Boolean(price.longThreshold) && input + write + read > price.longThreshold;
    const inputPrice = long ? price.longInput : price.input, outputPrice = long ? price.longOutput : price.output, readPrice = long ? price.longCacheRead : price.cacheRead;
    return (input * inputPrice + write * inputPrice * 1.25 + read * readPrice + output * outputPrice) / 1e6 +
      whole(raw?.web_search_requests) * Core.CLAUDE_WEB_SEARCH_USD;
  }
  function commentsText(text) {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.comments)) return JSON.stringify(value.comments);
    } catch { /* The shared validator reports invalid comment output. */ }
    return text;
  }
  function safeUrl(value) {
    if (typeof value !== 'string') return null;
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
  }

  // Accumulates the content blocks of one assistant turn, including turns
  // resumed after `pause_turn`, so the request can be continued unchanged.
  function createStream() {
    const blocks = [], usages = [];
    let offset = 0, lastTool = -1, model = '', stopReason = null, searched = false, error = null, done = false, usage = null;
    function begin() { offset = blocks.length; usage = {}; usages.push(usage); done = false; stopReason = null; error = null; }
    function mergeUsage(value) {
      if (!value || typeof value !== 'object' || !usage) return;
      for (const key of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
        if (Number.isFinite(value[key]) && value[key] >= 0) usage[key] = value[key];
      }
      const searches = value.server_tool_use?.web_search_requests;
      if (Number.isFinite(searches) && searches >= 0) usage.web_search_requests = searches;
    }
    function ingest(event) {
      if (!event || typeof event !== 'object') return;
      const index = Number.isSafeInteger(event.index) ? offset + event.index : -1;
      switch (event.type) {
        case 'message_start':
          if (typeof event.message?.model === 'string') model = event.message.model;
          mergeUsage(event.message?.usage);
          return;
        case 'content_block_start': {
          const source = event.content_block;
          if (index < 0 || !source || typeof source !== 'object') return;
          const block = JSON.parse(JSON.stringify(source));
          if (block.type === 'text') { block.text = typeof block.text === 'string' ? block.text : ''; block.citations = Array.isArray(block.citations) ? block.citations : []; }
          if (['server_tool_use', 'tool_use'].includes(block.type)) {
            block.partialJson = '';
            if (block.name === 'web_search') searched = true;
          }
          if (['server_tool_use', 'tool_use'].includes(block.type) || /_tool_result$/.test(block.type || '')) lastTool = Math.max(lastTool, index);
          blocks[index] = block;
          return;
        }
        case 'content_block_delta': {
          const block = blocks[index], delta = event.delta || {};
          if (!block) return;
          if (delta.type === 'text_delta' && typeof delta.text === 'string') block.text = (block.text || '') + delta.text;
          else if (delta.type === 'citations_delta' && delta.citation && typeof delta.citation === 'object') (block.citations ||= []).push(delta.citation);
          else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') block.partialJson = (block.partialJson || '') + delta.partial_json;
          else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') block.thinking = (block.thinking || '') + delta.thinking;
          else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') block.signature = delta.signature;
          return;
        }
        case 'content_block_stop': {
          const block = blocks[index];
          if (block && Object.hasOwn(block, 'partialJson')) {
            if (block.partialJson) { try { block.input = JSON.parse(block.partialJson); } catch { /* Keep the start input. */ } }
            delete block.partialJson;
          }
          return;
        }
        case 'message_delta':
          if (typeof event.delta?.stop_reason === 'string') stopReason = event.delta.stop_reason;
          mergeUsage(event.usage);
          return;
        case 'message_stop':
          done = true;
          return;
        case 'error':
          error = event.error && typeof event.error === 'object' ? event.error : {type: 'api_error'};
      }
    }
    // Text written before the last tool call is narration ("I'll search…");
    // the reader-facing answer is the text after the final tool result.
    function finalBlocks() { return blocks.filter((block, index) => block && index > lastTool && block.type === 'text'); }
    function text() { return finalBlocks().map(block => block.text || '').join(''); }
    function sources() {
      const found = new Map();
      for (const block of finalBlocks()) for (const citation of block.citations || []) {
        const url = safeUrl(citation?.url);
        if (url && !found.has(url)) found.set(url, {url, title: String(citation.title || url).slice(0, 200)});
      }
      return [...found.values()].slice(0, 20);
    }
    function assistantContent() {
      return blocks.filter(Boolean).map(block => {
        const copy = {...block};
        delete copy.partialJson;
        if (copy.type === 'text' && !copy.citations?.length) delete copy.citations;
        return copy;
      });
    }
    function rawUsage() {
      const total = {};
      for (const entry of usages) for (const [key, value] of Object.entries(entry)) total[key] = (total[key] || 0) + value;
      return total;
    }
    function sharedUsage(fallbackModel) {
      const raw = rawUsage(), priced = model || fallbackModel;
      const ticks = Math.round(usages.reduce((sum, entry) => sum + costUSD(entry, priced), 0) * USD_TICKS);
      const input = whole(raw.input_tokens) + whole(raw.cache_creation_input_tokens) + whole(raw.cache_read_input_tokens), output = whole(raw.output_tokens);
      const result = {input_tokens: input, output_tokens: output, total_tokens: input + output, cost_in_usd_ticks: ticks};
      if (raw.cache_read_input_tokens) result.input_tokens_details = {cached_tokens: raw.cache_read_input_tokens};
      if (raw.web_search_requests) result.server_side_tool_usage_details = {web_search_calls: raw.web_search_requests};
      return result;
    }
    function usageComplete() {
      return usages.length > 0 && usages.every(entry => Number.isFinite(entry.input_tokens) && Number.isFinite(entry.output_tokens)) && done;
    }
    return Object.freeze({begin, ingest, text, sources, assistantContent, rawUsage, usage: sharedUsage, usageComplete,
      model: () => model, stopReason: () => stopReason, searched: () => searched, error: () => error, done: () => done});
  }
  function ticksToUSD(ticks) { return Number.isFinite(ticks) && ticks > 0 ? ticks / USD_TICKS : 0; }

  const api = Object.freeze({ENDPOINT, API_VERSION, USD_TICKS, MAX_TOKENS, MAX_CONTINUATIONS, COMMENTS_SCHEMA,
    validKey, messagesRequest, headers, costUSD, commentsText, createStream, ticksToUSD, userContent});
  root.SuperXClaude = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
