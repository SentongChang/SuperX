/* SuperX: what every surface needs to know about each answer source. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SuperXProviders = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // One descriptor per connection: data, plus a function only where data
  // cannot express the rule. No credentials and no chrome.* here, so content
  // scripts, pages and the worker all read the same file (as Core.providers).
  // Sign-in, Build's local connection and the xAI Key vault really differ and
  // stay in their own code; a descriptor only names what they have in common.
  //
  // Fields:
  // - uiOrder: position in the Settings <select>. focusRank: which connection
  //   wins when an OPEN_SETTINGS request and the selected source disagree.
  // - settingsFocus / panelId / controls: ids in options.html.
  // - labels: i18n keys. option = Settings choice, popup / rail = the mode
  //   line ({count}, {transport}), setup = the rail's "set me up" title,
  //   hint = the popup's automatic-mode hint (null: the connection writes its
  //   own, as Claude does with its spend line).
  // - billing: 'metered' (pay per token), 'subscription' or 'local'.
  // - caps.remote: calls a hosted API, so budget, capacity and request
  //   diagnostics apply. caps.persistDiagnostics: those diagnostics may be
  //   kept in session storage. caps.accountLimits: a 402 means the account's
  //   own spending limit. caps.xSearch: can read X posts directly.
  //   caps.triage: offers the paid pre-screen.
  // - maxConcurrency: a fixed limit, or null for the user's setting.
  // - autoRetry: false when a failed request must never be replayed.
  // - triggers.manualOnlyUnless: billed to the user's own credit, so only the
  //   post button checks until this boolean setting is true.
  // - errors: codePrefix marks codes this connection owns; codes maps them to
  //   i18n keys and fallback covers the rest. apiError (optional) answers an
  //   API_ERROR first; apiOverrides replaces the shared API_ERROR keys.
  // - cacheIdentity(settings, {task, postContext}): the part of an answer's
  //   cache key that names this connection's model and options. Changing it
  //   misses every saved answer, so golden tests pin the exact strings.
  // - hosts: every origin it contacts; each must be in the manifest.
  const API = {
    id: 'api', uiOrder: 20, focusRank: 99, settingsFocus: 'api-key', panelId: 'api-fields',
    labels: {option: 'options.providerKey', popup: 'popup.apiLabel', rail: 'tooltip.apiMode', setup: 'common.enterKey', hint: 'popup.apiHint'},
    fields: {model: 'apiModel', effort: 'apiReasoningEffort'},
    controls: {model: 'api-model', effort: 'api-reasoning-effort'},
    billing: 'metered',
    caps: {remote: true, persistDiagnostics: true, accountLimits: true, xSearch: true, triage: false},
    maxConcurrency: null, autoRetry: true,
    usageLinks: [['account.viewUsage', 'https://grok.com/dashboard/usage'], ['account.viewConsole', 'https://console.x.ai/']],
    usageIssueKeys: ['error.apiUsage'],
    errors: {codePrefix: null, codes: {}, fallback: ''},
    // The bare model string, not an array: existing keys depend on it.
    cacheIdentity: s => s.apiModel,
    hosts: ['https://api.x.ai/*']
  };
  const OAUTH = {
    id: 'oauth', uiOrder: 10, focusRank: 0, settingsFocus: 'oauth', panelId: 'oauth-fields',
    labels: {option: 'options.providerOAuth', popup: 'popup.oauthLabel', rail: 'oauth.modeLabel', setup: 'oauth.login', hint: 'popup.oauthHint'},
    fields: {model: 'oauthModel', effort: 'oauthReasoningEffort'},
    controls: {model: 'oauth-model', effort: 'oauth-reasoning-effort'},
    billing: 'subscription',
    caps: {remote: true, persistDiagnostics: true, accountLimits: false, xSearch: true, triage: false},
    maxConcurrency: null,
    // A signed-in request may already have used the subscription's quota.
    autoRetry: false,
    usageLinks: [['account.viewUsage', 'https://grok.com/dashboard/usage']],
    usageIssueKeys: ['oauth.usageError'],
    errors: {
      codePrefix: 'OAUTH_',
      codes: {
        OAUTH_LOGIN_REQUIRED: 'oauth.needsLogin', OAUTH_REAUTH_REQUIRED: 'oauth.reauthRequired', OAUTH_ACCOUNT_CHANGED: 'oauth.reauthRequired', OAUTH_REFRESH_UNCERTAIN: 'oauth.reauthRequired',
        OAUTH_ACCESS_DENIED: 'oauth.denied', OAUTH_DEVICE_EXPIRED: 'oauth.expired', OAUTH_CANCELLED: 'oauth.canceled',
        OAUTH_MODEL_UNAVAILABLE: 'oauth.modelUnavailable', OAUTH_STORAGE_ERROR: 'oauth.storageError', OAUTH_CATALOG_UNAVAILABLE: 'oauth.catalogUnavailable', OAUTH_AUTH_UNAVAILABLE: 'oauth.networkError'
      },
      fallback: 'oauth.unavailable',
      apiOverrides: {keyRejected: 'oauth.reauthRequired', usage: 'oauth.usageError', access: 'oauth.permissionError'}
    },
    cacheIdentity: s => [s.oauthCredentialId, s.oauthModel],
    hosts: ['https://auth.x.ai/*', 'https://api.x.ai/*']
  };
  const BUILD = {
    id: 'build', uiOrder: 30, focusRank: 1, settingsFocus: 'build', panelId: 'build-fields',
    labels: {option: 'options.providerBuild', popup: 'popup.buildLabel', rail: 'popup.buildLabel', setup: 'popup.setupBuild', hint: 'popup.buildHint'},
    fields: {model: 'buildModel', effort: 'buildReasoningEffort'},
    controls: {model: 'build-model', effort: 'build-reasoning-effort'},
    billing: 'local',
    caps: {remote: false, persistDiagnostics: false, accountLimits: false, xSearch: true, triage: false},
    // The local CLI serves one session at a time.
    maxConcurrency: 1, autoRetry: true,
    usageLinks: [['account.viewUsage', 'https://grok.com/dashboard/usage']],
    usageIssueKeys: [],
    errors: {
      codePrefix: 'BUILD_',
      codes: {
        BUILD_IMAGE_UNSUPPORTED: 'build.imageUnsupported', BUILD_IMAGE_UNAVAILABLE: 'build.imageUnavailable', BUILD_IMAGE_LIMIT: 'build.imageLimit',
        BUILD_LOGIN_REQUIRED: 'build.login', BUILD_CANCEL_UNCONFIRMED: 'build.cancelUnconfirmed', BUILD_CONNECTION_REQUIRED: 'build.codeRequired', BUILD_AUTH_FAILED: 'build.codeInvalid',
        BUILD_UNAVAILABLE: 'build.missing', BUILD_DISCONNECTED: 'build.missing', BUILD_NATIVE_MISSING: 'build.missing',
        BUILD_VERSION_UNSUPPORTED: 'build.unsupported', BUILD_MODEL_UNSUPPORTED: 'build.unsupported', BUILD_EFFORT_UNSUPPORTED: 'build.unsupported'
      },
      fallback: 'build.unavailable'
    },
    cacheIdentity: s => ['official-ws-v1', s.buildPort, s.buildModel],
    hosts: ['http://127.0.0.1/*']
  };
  const CLAUDE = {
    id: 'claude', uiOrder: 40, focusRank: 2, settingsFocus: 'claude', panelId: 'claude-fields',
    labels: {option: 'claude.provider', popup: 'claude.modeLabel', rail: 'claude.modeLabel', setup: 'common.enterKey', hint: null},
    fields: {model: 'claudeModel', effort: 'claudeEffort'},
    controls: {model: 'claude-model', effort: 'claude-effort'},
    billing: 'metered',
    // Anthropic's tools cannot open X, so post text and video stay unseen.
    caps: {remote: true, persistDiagnostics: false, accountLimits: false, xSearch: false, triage: true},
    maxConcurrency: null, autoRetry: true,
    triggers: {manualOnlyUnless: 'claudeAutoTrigger'},
    usageLinks: [['claude.billingLink', 'https://platform.claude.com/settings/billing']],
    usageIssueKeys: ['claude.budgetReached', 'claude.requestRejected'],
    errors: {
      codePrefix: 'CLAUDE_', codes: {CLAUDE_BUDGET: 'claude.budgetReached'}, fallback: '',
      apiError(http, providerCode, failure) {
        if (http === 401 || ['authentication_error', 'invalid_api_key'].includes(providerCode)) return 'claude.keyRejected';
        if (http >= 500 || failure?.code === 'SERVER') return 'claude.serverError';
        if (http === 400 || http === 402 || http === 403 || http === 404 || ['invalid_request_error', 'billing_error', 'permission_error', 'not_found_error'].includes(providerCode)) return 'claude.requestRejected';
        return '';
      }
    },
    // web_fetch reads the post's own links, so they belong to the answer.
    // Comments never fetch and keep their first key version.
    cacheIdentity: (s, {task, postContext}) => task === 'comments' ? ['claude-messages-v1', s.claudeModel, s.claudeMaxSearches] :
      ['claude-messages-v2', s.claudeModel, s.claudeMaxSearches, postContext],
    hosts: ['https://api.anthropic.com/*']
  };

  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const item of Object.values(value)) freeze(item);
    }
    return value;
  }
  // Definition order is the stored settings key order (api, oauth, build,
  // claude). Do not reorder; uiOrder decides what people see.
  const list = freeze([API, OAUTH, BUILD, CLAUDE]);
  const byId = new Map(list.map(descriptor => [descriptor.id, descriptor]));
  const RETIRED = freeze(['native']);
  const get = id => byId.get(id);
  // Unknown ids behave as the xAI Key, as normalizeSettings' legacy default.
  const resolve = id => byId.get(id) || API;

  return freeze({
    list, RETIRED, get, resolve,
    ids: freeze(list.map(descriptor => descriptor.id)),
    has: id => byId.has(id),
    isRetired: id => RETIRED.includes(id),
    uiOrder: () => [...list].sort((a, b) => a.uiOrder - b.uiOrder),
    codeOwner: code => typeof code === 'string' ? list.find(descriptor => descriptor.errors.codePrefix && code.startsWith(descriptor.errors.codePrefix)) : undefined,
    // The requested focus or the selected source, whichever ranks first.
    settingsFocus: (requested, provider) => [...list].sort((a, b) => a.focusRank - b.focusRank)
      .find(descriptor => descriptor.settingsFocus === requested || descriptor.id === provider)?.settingsFocus || API.settingsFocus,
    manualOnly(settings) {
      const field = get(settings?.provider)?.triggers?.manualOnlyUnless;
      return Boolean(field) && settings[field] !== true;
    }
  });
});
