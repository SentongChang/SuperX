# Adding a connection (provider)

SuperX has four connections: Grok sign-in (`oauth`), Grok API Key (`api`),
local Grok Build (`build`) and Claude API Key (`claude`). This page describes
honestly what a fifth one takes today.

In short: **a descriptor plus a transport, plus copy and a settings panel**,
and, until the worker's per-provider branches are extracted, a handful of
explicit branches in `background.js`. The list below names each of them.

## What the registry covers

`extension/provider-registry.js` holds one descriptor per connection. It is
pure data with a few small functions, no credentials and no `chrome.*`, so the
content script, every extension page and the worker load the same file. Every
surface reads it as `XGrokCore.providers` (`Core.providers`). The comment at
the top of the file documents each field.

A descriptor answers these questions in one place:

| Question | Field | Read by |
| --- | --- | --- |
| Which ids are valid? | `id`, `RETIRED` | `normalizeSettings`, worker message guards, startup fault check |
| What is it called? | `labels.option/popup/rail/setup/hint` | options.html (by test), popup, rail |
| Where does Settings open? | `settingsFocus`, `focusRank` | `OPEN_SETTINGS` in the worker, rail, popup |
| Which settings hold its model? | `fields`, `controls`, `panelId` | options.js, options.html (by test) |
| Where can people check usage? | `usageLinks`, `usageIssueKeys` | usage links in the rail and draft composer; `Core.isUsageIssue` decides when the rail shows them |
| How do its errors read? | `errors` | `Core.providerErrorKey` |
| How is it billed? | `billing` | saved-answer reuse savings (USD only for `metered`) |
| What can it do? | `caps.remote/persistDiagnostics/accountLimits/xSearch/triage` | request diagnostics, budget and capacity handling, account-limit notes, completeness gaps, the paid pre-screen |
| How many checks at once? | `maxConcurrency` | worker queue |
| May a failure be replayed? | `autoRetry` | `Core.autoRetryDecision` |
| Does it bill the user's own credit? | `triggers.manualOnlyUnless` | effective trigger settings (post button only until the opt-in is on) |
| What identifies a saved answer? | `cacheIdentity` | worker cache keys |
| Which hosts does it contact? | `hosts` | manifest (by test) |

The worker drops one connection's saved answers with
`dropProviderCache(id, keep)`, where `keep` receives the entry's
`cacheIdentity` value.

Changing an existing `cacheIdentity` makes every saved answer for that
connection miss once and be paid for again. The golden tests in
`tests/background.test.js` pin the exact key strings; change them only on
purpose and say why in the commit.

## Steps for a new connection `example`

1. **Descriptor.** Add a block to `provider-registry.js` and append it to the
   list. Definition order is the stored settings key order, so append at the
   end and give it a `uiOrder` of 50 or more and a `focusRank` of 10 or more.
   A connection that bills the user's own credit per request should name an
   opt-in boolean in `triggers.manualOnlyUnless` that defaults to `false`.
2. **Settings.** Add its fields to `DEFAULT_SETTINGS` and `normalizeSettings`
   in `feed-core.js`, after Claude's, and teach `providerModel` /
   `providerEffort` its model rule. These are not generated from the
   descriptor.
3. **Transport.** Write `extension/example-transport.js` for the worker only.
   Add it to `importScripts` in `background.js` and to `PRODUCTION_FILES` in
   `tools/package-extension.mjs`. Its results must have the shape the
   existing transports return (`text`, `sources`, `searched`, `usage`,
   `model`, `verificationStatus`, plus `verdict` / `gaps` from
   `Core.verdictFields`), and its errors must carry a shared code or one with
   the descriptor's `codePrefix`. Provider prose goes through the existing
   `publicError` sanitizers and never reaches a page.
4. **Credential.** Store a Key the way Claude does: a `KeyStore` envelope in
   `chrome.storage.local`, a `SAVE_<ID>_KEY` / `CLEAR_<ID>_KEY` /
   `GET_<ID>_STATUS` message set, and `dropProviderCache(id)` whenever the Key
   changes. This is not generic yet; copy `saveClaudeKey` deliberately.
5. **Worker branches.** These still name each connection explicitly and need a
   new case: `providerAllowsCalls` (is it ready?), `runAPI` (call the
   transport), the admission checks in the feed port's `ANALYZE` /
   `ANALYZE_DRAFT` / `GENERATE_COMMENTS` handler (credential generation and
   the "not ready" message), and `publicError` selection. `historyScope` already works for any id that is
   not `oauth`.
6. **History.** Add the id to `SCOPES` in `history-store.js`, or its answers
   are stored without an owner and read as the xAI Key's.
7. **Manifest.** Add its hosts. New connections should use
   `optional_host_permissions` and request access when the user saves.
8. **Copy.** Add every key the descriptor names, plus the settings panel's
   strings, to `ui-i18n.js` in all twelve interface languages, translated
   (no English fallback).
9. **Settings panel.** Add an `<option>` to `#provider` and a hand-written
   `<div id="example-fields">` panel in `options.html`; wire its controls in
   `options.js`. The bespoke panels (budgets, catalogs, ports) are
   deliberately not generated.
10. **Tests.** `tests/provider-registry.test.js` fails until the descriptor
    agrees with options.html, the manifest, the history store, the settings
    and the translations. Add golden rows for the new connection next to the
    existing ones, and a transport test.

## What stays bespoke

These differ per connection and are not abstracted: the Grok device sign-in
and model catalog (`oauth-provider.js`), Build's local connection, secret and
loopback permission (`build-*.js`), the xAI Key session, remember and vault
handling, and Claude's billing-cycle spend estimate. `api-provider.js` also
dispatches Claude's stages internally. The popup's and rail's "not ready"
reasons keep their sign-in and Build cases; every other connection shows
`status.needsKey`, whose copy today names the Grok API Key (Claude shares
it), so a new connection should add its own reason.
