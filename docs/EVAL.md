# Evaluating the fact check

`tools/eval.mjs` runs a set of posts through SuperX's real fact-check code and
scores the answers with fixed rules. Use it to see whether a prompt, model or
parsing change makes answers better or worse before it ships. It is developer
tooling: nothing here is part of the extension package, and extension users see
no change.

The harness calls the same functions the extension worker calls,
`GrokFirstAPI.run` for a fact check and `GrokFirstAPI.triage` for the Claude
pre-screen, with a substituted `fetch`. Prompts, request building, stream
parsing, the `VERDICT:` marker, completeness gaps and cost estimates are exactly
what users get. The parts that live only in the worker (queues, cache, history,
budget ledger) are not exercised.

## Quick start

```sh
npm run eval                                   # mock run, Claude Haiku 5.5, no network
node tools/eval.mjs --provider api             # mock run in the xAI stream shape
node tools/eval.mjs --stage triage             # mock run of the pre-screen

ANTHROPIC_API_KEY=... node tools/eval.mjs --live --model claude-sonnet-5-5
XAI_API_KEY=... node tools/eval.mjs --live --provider api --model grok-4.3
ANTHROPIC_API_KEY=... node tools/eval.mjs --live --stage triage

node tools/eval.mjs --compare artifacts/eval/A.json artifacts/eval/B.json
```

Each run prints a summary table and writes a Markdown report and a full JSON
report to `artifacts/eval/` (git-ignored). The file name holds the UTC start
time, mode, provider and model, for example
`2026-11-22T10-00-00-000Z-mock-claude-claude-haiku-5-5.md`.

## Mock and live runs

**Mock** is the default and the only mode CI uses; the normal test suite runs it
through `tests/eval-harness.test.js`. Each request is answered from the item's
own `mock` answer, in the Claude Messages or xAI Responses stream shape, with
the expected verdict marker in front. The global `fetch` is replaced for the
whole run by one that throws, so a mock run cannot reach the network. A mock
report is labelled *MOCK - pipeline check only, not model quality*: it proves
the pipeline and the scoring rules agree, nothing more.

**Live** needs `--live` and your own Key in an environment variable:
`ANTHROPIC_API_KEY` for `--provider claude`, `XAI_API_KEY` for `--provider api`.
Before the first request the harness prints one line naming the item count,
model, effort, search limit and spend cap. Live requests can reach only
`api.anthropic.com` or `api.x.ai`; any other host is refused.

Only these two connections run headless. Grok sign-in (`oauth`) needs the
browser device login and the worker's token store, and Grok Build (`build`)
needs a local Grok CLI, so the harness rejects both.

### Keys

- Keys are read only from the two environment variables. A Key-shaped
  command-line argument is refused with exit code 2, so a Key does not end up
  in shell history by accident.
- A Key is never printed. Provider errors are stored through the extension's
  own `publicError`, which keeps only a fixed message per error code.
- Before writing, the serialized JSON and Markdown are searched for the Key. If
  it appears anywhere, the run stops and writes nothing.

### Cost

Costs in the report are estimates from the extension's local price table
(`CLAUDE_MODELS` in `extension/feed-core.js`) or from xAI's `cost_in_usd_ticks`.
The Anthropic or xAI Console is the billing record. As a rough guide for the
24-item set, Claude Haiku 5.5 costs a few cents per item (well under $1 per run)
and Sonnet 5.5 several times more; the pre-screen stage costs a fraction of a
cent per item.

`--max-usd` (default 3.00) caps a run. The total is checked after each item, so
up to `--concurrency` items already in flight can still finish past the cap.
When the cap stops a run, the partial report is written, marked as stopped at
the spend cap, and the command exits with code 3.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--mock` / `--live` | mock | Replay or paid run |
| `--provider claude\|api` | claude | Connection |
| `--stage verify\|triage` | verify | Fact check, or the Claude pre-screen |
| `--model ID` | extension default | Claude model id, or any xAI text model |
| `--effort LEVEL` | extension default | Rejected if the model does not offer it |
| `--max-searches 1..10` | 3 | Claude web searches per check |
| `--language auto\|TAG` | auto | Answer language; an item's own `settings.language` wins |
| `--prompt FILE` | preset | Custom fact-check task; the report records its sha256 |
| `--dataset FILE` | committed set | `.mjs` exporting `items`, or `.json` (an array or `{items}`) |
| `--only ID,ID` | all | Item ids |
| `--tag T,T` | all | Every tag must match an item tag, language, difficulty or expected verdict |
| `--limit N` | all | First N selected items |
| `--repeat N` | 1 | Run each item N times; adds verdict agreement |
| `--concurrency N` | 2 live, 8 mock | Items in flight |
| `--max-usd X` | 3.00 | Spend cap |
| `--out DIR` | artifacts/eval | Report folder |
| `--min-verdict-accuracy X` | none | Exit 1 below this accuracy (0 to 1) |

Exit codes: 0 success; 1 a `--min-verdict-accuracy` gate failed; 2 a usage or
configuration error (including a missing Key or a Key found in the report);
3 stopped at the spend cap.

## What the report measures

Fact check (`--stage verify`):

| Metric | Rule |
| --- | --- |
| Verdict accuracy | Returned verdict equals the expected one; errors count as wrong |
| Verdict missing (marker miss) | Share of answers with no parseable `VERDICT:` line |
| Severe verdict errors | Accurate and inaccurate swapped, or an inaccurate claim called NONE |
| Key-fact recall | Share of an item's facts whose patterns appear in the answer |
| Forbidden-claim hits | A `forbid` pattern matched, for example an injected instruction obeyed |
| Citations on required items | At least one source where `citations` is `required` |
| Official, academic or news source | At least one source in those tiers, using the extension's own source labels |
| Language compliance | The answer is written in the expected writing system |
| Search used, search matched expectation | `searched` on the result, and against `expect.searched` |
| Incomplete | The provider returned a partial answer |
| Gap disclosed in answer | A `disclose` pattern matched where the post had an unreadable part |
| Errors | By public error code |
| Latency and first text | p50 and p90, nearest rank |
| Estimated cost | Total, per item and per correct verdict |

An item passes when it has no error, the verdict is right, no forbidden pattern
matched, the language is right, required citations exist, at least half of its
facts are present and any required disclosure is present. The report adds a
verdict confusion matrix, breakdowns by language, difficulty, expected verdict
and tag, and each failing item with the first 600 characters of its answer.

Pre-screen (`--stage triage`, Claude only): the free local pre-screen runs
first, as in the worker, and only the remaining posts get the paid screen.

| Metric | Rule |
| --- | --- |
| False skips | A checkable post screened as having no claim; the costly mistake |
| No-claim posts skipped | Posts without a claim that the screen dropped |
| Skipped by the free local pre-screen | Posts that never reached the paid screen |
| Auto route agrees with difficulty | For checkable posts, Auto picks Sonnet exactly when the item is labelled hard |

`--compare A.json B.json` prints and writes a table of metric deltas (B minus
A) and the items whose pass or fail result flipped. Both reports must be of the
same stage.

## The dataset

`tools/fixtures/eval-posts.mjs` holds 24 synthetic items: posts in English,
Simplified Chinese, Japanese and Spanish, plus one Arabic (right-to-left) and
one Russian (Cyrillic) post. Expected verdicts: 5 accurate, 5 inaccurate,
5 mixed, 4 unproven, 5 none. Tags mark the special cases: two prompt
injections, two posts with unreadable media, two quote posts, a truncated post,
two explicit answer-language overrides and one post short enough for the free
local pre-screen.

Each item looks like this:

```js
{
  id: 'en-everest-height', tags: [], difficulty: 'simple', checkable: true,
  post: {id, url, text, language, author, timestamp, hasMedia, images, quotedContext},
  settings: {language: 'ja'},              // optional answer-language override
  expect: {verdict, language, citations: 'required'|'optional'|'none', searched,
           facts: [{id, any: [pattern, ...]}], forbid: [pattern], disclose: [pattern]},
  mock: {answer, sources: [{url, title}], limits: ['media']},
  reference: ['https://...'], note: '...'
}
```

Only `post`, after a deep copy, reaches a provider. Labels, mock answers and
references never do; a test checks this on every request.

### Rules for new items

- Write the post yourself under the fictional account "SuperX Eval"
  (`https://x.com/superx_eval/status/<id>`, ids from 1900000000000000 to
  1900000000009999). No real posts, real handles or images.
- Use stable facts: physical constants, geography, dated history, and
  statistics phrased with their year from an official body. Keep a reference
  URL so a reviewer can re-check the fact, and re-check items each release.
- "Unproven" items are private events about fictional people. Never make a
  false claim about a real living person.
- Patterns are regular expression sources compiled with the flags `iu` against
  the NFKC form of the answer, in the language the item expects. Give each fact
  two to four alternatives (number formats, units, synonyms).
- `difficulty` uses the pre-screen's own values, `simple` or `hard`; `hard`
  means several claims, a numeric comparison, an outdated statistic or a
  contested framing. `checkable` is false only for posts with no claim.
- The mock answer must pass its own item. The self-consistency test enforces
  this, so a pattern and its answer cannot drift apart.

### Private datasets

To test real public posts, keep a dataset in `eval-local/` (git-ignored) and
pass it with `--dataset`. A private dataset uses the same schema, but the
fictional-account rules apply only to the committed set.

## Known limits

- Synthetic posts cannot be found by X search. The Grok prompts ask the model
  to retrieve the original post first, so live `--provider api` runs report
  retrieval gaps on this set, and Grok-versus-Claude comparisons on it are
  biased. Use a private set of real public posts to measure retrieval.
- The language check detects only a change of writing system, so it cannot
  tell Spanish from French or German.
- Pattern scoring is brittle across paraphrase. Read the failure list in the
  report rather than only counting failures.
- v1 covers the post fact check and the pre-screen. Comment drafts and the
  draft composer are not evaluated, and there is no model-graded scoring.
