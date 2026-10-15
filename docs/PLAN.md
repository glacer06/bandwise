# Bandwise: Plan

**Owner:** Nick Sims
**Date:** 2026-09-26
**Status:** Phase 0 is done. Phase 1 is merged with a green gate, and only its OpenRouter and Vercel fixtures still wait on keys. The dogfood track (phase D, ADR-020) is in progress: since 2026-10-05 the `internal` org runs on app.bandwise.dev, every dogfood set in `shadow` until Nick moves it. ADR-011 (OpenRouter route) is proposed, and ADR-013 (Vercel AI Gateway route) was accepted on 2026-09-27. TypeSafe made Jev 1.14 (`jev-1.14.0`) available on 2026-10-14 and has not moved `jev-latest` to it, so Bandwise treats it as a preview model. See Jev 1.14 below.

## Why this exists

TypeSafe's Jev is a new kind of model. It doesn't write. It decides. You hand it `state` and a few typed questions, and it returns typed answers with probabilities and a calibrated confidence number, in well under a second, for $0.042 per million input tokens (Jev 1.13 and Jev 1.14) with free output. That makes it cheap enough to put a judgment call at every decision point in software: routing, triage, guardrails, PR safety, which LLM to use, which context to keep.

Raw API calls leave a lot on the table. Nobody owns the questions. There's no versioning, no review loop for the uncertain cases, no way to change a threshold without a deploy, and no proof the thing is saving money. Bandwise is that missing layer, sold as a multi-tenant product and used by Nick across his own orgs (SGR, Personal, Dallas).

On 2026-09-26 Nick set the bar:

> This wrapper needs to be able to setup, manage and deploy the right Jev code for apps that want to use Jev effectively and improve its effectiveness. It should have a UI/UX but also be headless so an agent can manage it as well. This should work for Jev and also any new System One models that are released by TypeSafe.

That becomes four commitments:

- **Headless parity (ADR-007).** Everything the console does is an operation that the API, the `bandwise` CLI and the MCP server also expose, so an agent can run the product.
- **Any System One model (ADR-008).** Model facts are registry data and code names are neutral, so a new TypeSafe model is a registry row, not a rewrite.
- **App setup and deploy (ADR-009).** Bandwise finds decision points in an app, builds the set, and wires it in through generated typed code, with interface versions that fail loudly.
- **Effectiveness loop (ADR-010).** Apps report outcomes, audit samples keep precision honest, and thresholds, questions and models improve through proposals, experiments and human approval.

## What the product covers

| Nick's ask | Where it lives |
|---|---|
| Extension | Plugin SDK (Phase 5), Chrome extension with evaluate and action picker modes (Phase 6), MCP server (stdio in Phase 3, HTTP in Phase 7), Claude Code plugin (Phase 7) |
| Inputs | Input schema per set, input adapters, state builder with backtick path autocomplete, redaction, token preflight |
| Managed live | Channels and release pointers, rollout stage per channel pointer, publish, rollback, version pinning, cache with epoch invalidation, no redeploys |
| Managed questions | Question editor (form and JSON), versions and diffs, lints, template library, Definition Studio, eval gates |
| Goal | `goals` with an intent statement and a typed QualityTarget; every set belongs to one |
| Confidence levels | Per-question policies, three bands, band-to-action mapping, rollout stages per channel, calibration reports |
| Options | Choice options (up to 255 with a "none" nudge) and score levels (2 to 10), both API-wide rules; noul criteria, composites and weights |
| Full administration | Multi-tenant orgs, five roles, platform super-admin, audit log, keys, billing, retention, PII, reports, alerts |
| Wide flexibility | Structured instructions, multi-stage runs, composites, LLM escalation, pluggable transports, plugins, API, embed, MCP |
| Set up apps | App profile, opportunity finder (agent and console), pattern advisor, Definition Studio prefill, generated typed clients, app bindings (Phase 4b) |
| Deploy | Deploy targets managed, managed_typed, standalone (ADR-009); specs as code; `bandwise codegen` and `bandwise check`; interface versioning (Phases 3 and 4b) |
| Headless | Management API with console parity, agent tokens with approvals, `@bandwise/cli`, MCP server, event feed (Phases 2 and 3) |
| Improve effectiveness | App feedback, audit sampling, quality targets, threshold suggestions, set health, proposals, champion/challenger, improve mode (Phases 3 and 3b) |
| Any System One model | Model registry, limits and prices as data, new-model detection, try-on-model upgrades, contract watch (Phases 0, 1, 3, 3b) |

## Sources

- TypeSafe docs, verified 2026-09-26: `https://docs.typesafe.ai/llms.txt`, `/api.md`, `/models.md`, `/confidence.md`, `/agent-skill.md`, `/sdk/javascript.md`, `/sdk/python/usage.md`, `/model-jaggedness/jev-1.13.md`, `/concepts/how-to-build-with-system-one.md`, `/patterns/fan-out.md`, `/cookbooks/consistency_choice_cookbook.md`
- TypeSafe OpenAPI spec: `https://api.typesafe.ai/openapi.json` (v0.2.0)
- TypeSafe docs, checked 2026-10-15 for Jev 1.14: `/models.md` (Jev 1.14 as `jev-1.14.0`, available from 2026-10-14; `jev-preview` points to it and `jev-latest` still points to `jev-1.13.0`; the `TypeSafe-Danger-Zone-Long-Context` header; rate limits set per organization), `/sdk/javascript/changelog.md` v0.7.0 and `/sdk/python/changelog.md` v0.7.5 (`box` questions, images behind `TypeSafe-Danger-Zone-Images`, zstd request bodies by default), and `/llms.txt`. `openapi.json` still says 0.2.0 but now carries `BoxQuestion`, `BoxAnswer`, `BoxCoordinates`, `Asset` and an optional `assets` request field. There is no 1.14 jaggedness page yet. TypeSafe's Jev 1.14 blog post (`typesafe.ai/blog/jev-1-14`) could not be read from the build environment on 2026-10-15, so nothing in this plan rests on it.
- Official agent skill: `https://github.com/typesafe-ai/skills`
- Every, "How to Get the Most Out of Jev" (2026-09-23): Definition Studio workflow, the 10-second rule, the email urgency checks, comparator prices
- Linas, "How to Use Jev AI" (2026-09-22): shadow mode to production path, reasoning-effort controller, gateway availability (OpenRouter and Vercel now documented by TypeSafe)
- The Code, "A developer's guide to start using Jev" (2026-09-26): setup path, context pruning (fast-jev-compaction), browser action picker (browser-use/jev-ultrafast), log-line pager, PR auto-merge and LLM routing use cases

## Architecture in one screen

```
                   +----------------------------- apps/console (Next.js) ------------------------------+
  browser  ----->  | tenant console | platform admin | /api/v1 + operations registry | webhooks | jobs |
                   +-----+----------------+----------------+----------------+--------------------------+
                         |                |                |                |
                   packages/tenancy  packages/billing  packages/db    packages/system-one-client --> System One (Jev)
                   (context, vault,  (plans, Stripe,   (Drizzle, RLS,  (SDK transport,
                    tokens, limits)   meters)           withTenant)     fixtures)
                         \                |                /
                          +------- packages/core (pure) --+
                            contracts, compiler, router, savings, lints

  host apps  --> @bandwise/client or generated client --> /api/v1   @bandwise/react (browser, no secrets)
  agents, CI --> bandwise CLI or MCP server --> sa_ agent token --> /api/v1
  Chrome ext --> device flow agent token --> /api/v1
```

Full detail is in `.claude/skills/bandwise-builder/references/architecture.md`.

## Key decisions

- **Tenancy from migration 0001.** `org_id` and RLS on every tenant table, plus a repository layer. Cross-tenant requests return 404.
- **One source of truth per set.** `QuestionSetSpec` holds questions, thresholds, composites, routes, and savings settings. Published versions never change. Rollout is not in the spec; it lives on each channel's release pointer.
- **Three bands, four actions, five rollout stages (inactive, shadow, controlled, full, paused).** Callers act on `effectiveAction`, which already accounts for the rollout stage.
- **Savings on every run.** Three kinds (decision counterfactual, escalation avoided, context pruned), labeled as estimates with their assumptions shown.
- **Keys stay on the server.** BYO keys (TypeSafe, and OpenRouter once ADR-011 is accepted) are envelope-encrypted per org and provider. Embeds use app tokens. The extension, the CLI and the MCP server never see a TypeSafe key.
- **Headless parity (ADR-007):** one operation registry behind console, API, CLI and MCP; agent tokens with role ceilings and human approvals.
- **Model registry (ADR-008):** model facts are curated data; names in code are neutral (`systemOne`).
- **Deploy targets and interface versioning (ADR-009).**
- **Rollout on pointers and the effectiveness loop (ADR-010).**

- OpenRouter docs, verified 2026-09-26: `openrouter.ai/docs/guides/community/typesafe-sdk.md`, `/guides/community/jev.md`, the System One API reference (`POST /api/v1/systemone`), and the Models API entries `typesafe/*` and `~typesafe/*`

ADRs are in `docs/adr/`: `002-auth-library.md` to `006-billing-model.md`, `007-headless-parity.md`, `008-system-one-model-registry.md`, `009-app-integration-and-deploy-targets.md`, `010-rollout-pointers-and-effectiveness-loop.md`, and `011-openrouter-route.md` (proposed).

## Phases

**Build order since 2026-09-28 (ADR-020):** 0, 1, then the dogfood track **D**, then the rest of 2, then 3 onward. Phase D makes Nick the first user: Claude Code sessions on this repo call Jev through Bandwise, local with his own key first, then hosted for the `internal` org, every set in `shadow` until he moves it. D pulls forward only the pieces of 2 and 3 that single-tenant use needs.

| Phase | What ships | Exit gate (short form) |
|---|---|---|
| 0 | Builder skill, plan, scaffold, frozen contracts (operation registry skeleton, error envelope v2, ModelProfile, SetInterface, agent actor), ADRs 002 to 010, CI | Scaffold passes lint, typecheck, test, build |
| 1 | Core engine with question-type modules and limits from model profiles, system-one-client, llm-client, model registry seed, schema with RLS, fixtures, local CLI | End-to-end run on fixtures; cross-tenant suite passes |
| D | Dogfood track (ADR-020): D0 prove Jev with a real key; D1 local live mode, receipts, `bandwise report`, the agent pack as Claude Code hooks; D2 hosted run endpoint and headless publish and rollback for the internal org; D3 minimal console (sign-in, editor, threshold sliders, runs, savings, review) | A week of real receipts; one set moved to controlled; a threshold changes live with no redeploy and rolls back |
| 2 | Auth, orgs, keys, app tokens, agent tokens and device flow, approvals, idempotency, rate limits with an eval bucket, Stripe foundation, platform admin | Three-org switch with no leak; Stripe reconciles within 0.1%; an agent token never exceeds its user's role |
| 3 | Console and management API with parity, `bandwise` CLI, MCP server (stdio), event feed, feedback API, audit sampling, rollout gates and auto-demote, model registry pages | Publish v2 and roll back from the console or the API with no app redeploy; an agent using only the CLI or MCP runs create to production, waiting for human approval |
| 3b | Effectiveness loop: threshold suggester and replay, set health, proposals, champion/challenger across versions and models, model upgrades, Studio improve mode | An agent tunes a set from labels and promotes a challenger after admin approval; injected drift auto-demotes |
| 4 | Embed kit: `@bandwise/client` (edge-safe, typed run, feedback), `@bandwise/react`, integration recipes, example app | No secrets in bundles; under 15 kB gzip |
| 4b | Integrate and deploy: opportunities, TypeScript codegen, app bindings, `bandwise init`, `codegen` and `check`, interface-breaking guard; Python and standalone behind ADR-009 | An agent wires a set into a sample Next.js repo with no console clicks |
| 5 | Plugin SDK, adapters (including the web page adapter), actions, eleven templates tagged by pattern, org event webhooks | Templates build working sets; actions idempotent |
| 6 | Chrome extension: evaluate page, action picker | No keys in extension; nothing sent before a click |
| 7 | MCP HTTP transport, Claude Code plugin with operator and integrate skills, marketplace | Install, then set up and run a set from a prompt |

Phases 3b and 4b start when Phase 3 lands and run in parallel with Phase 4.

Checklists: `.claude/skills/bandwise-builder/references/phases/`.

## Jev 1.14

**What shipped.** TypeSafe made Jev 1.14 available on 2026-10-14 as the versioned id `jev-1.14.0`. On 2026-10-15 `models.md` gives it the same price, context limits and input as `jev-1.13.0`: $0.042 per million input tokens with free output, 64k tokens per request and 32k for the state plus one question, text only. TypeSafe points `jev-preview` at `jev-1.14.0` and keeps `jev-latest` on `jev-1.13.0`. The same docs check found three other changes. `models.md` no longer publishes per-model rate limits, which are now set per organization and measured per second. It documents a long-context header for both 1.13 and 1.14. And the SDKs (JavaScript 0.7.0, Python 0.7.5) added `box` questions and image inputs, while `openapi.json` gained `box` and a request `assets` field without a version bump.

**How Bandwise classifies it.** A versioned registry row, so pinned, with status `preview`. `models.md` lists Jev 1.14 under Current models and never calls it a preview. The status is our reading of TypeSafe's alias table: `jev-latest` is "the most recent stable, official release" and still points to `jev-1.13.0`, while `jev-preview` "moves ahead of `jev-latest` when a preview build is available". When TypeSafe moves `jev-latest`, the platform admin reviews the row for `stable`. While it is `preview`, the publish lint `model.not_available_to_org` refuses it for any org without the preview opt-in, and today the hosted server gives no org that opt-in, `internal` included. The platform default stays `jev-1.13.0`, because a default must be a `stable` versioned row.

Thresholds belong to one model. Every dogfood set, the kit templates and the `bandwise-gate` plugin sets pin `jev-1.13.0`, and every threshold in them was set on 1.13 answers. 1.14 earns its place the way a new question does: it is measured beside the current model first, then Nick moves sets to it one at a time.

**What lands now (2026-10-15).** Data only, which ADR-008 allows without an ADR:

- A `jev-1.14.0` row: versioned, `preview`, `releaseDate` 2026-10-14, the 1.13 context limits, noul, choice and score, text input, and all twelve 1.13 weakness ids until TypeSafe publishes a 1.14 jaggedness page. Its `rpm` and `tokensPerSec` repeat 1.13's last published values, with a comment, because the contract requires positive integers.
- Its price row: 42,000 micro-USD per million input tokens, output 0.
- `jev-preview`'s seed target moves to `jev-1.14.0`. `jev-latest` and the platform default stay on `jev-1.13.0`.
- The `models.md` and `llms.txt` contract snapshots are refreshed. The `openapi.json` snapshot is held (see Not adopted below).

Without the row, `pnpm smoke` fails on `jev-preview`, because the build that answers it has no registry row and no price. That comes from reading the code, not from a live run. The hosted console reads the seed from code, so the next Vercel deploy prices `jev-1.14.0` on app.bandwise.dev and resolves `jev-preview` to it, still not publishable. The Supabase rows change only on a manual `db-migrate` run, and the seed never overwrites an existing row, so the stored `jev-preview` target stays `jev-1.13.0` until an audited one-off update or the Phase 2 registry jobs.

**The path, in order.**

1. **Registry data.** The row, the price and the `jev-preview` target above. They go first, because smoke cannot pass on an id with no row or price.
2. **Fixtures and smoke.** Done on 2026-10-15 from a cloud session, through the TypeSafe credential its environment injects: `pnpm smoke` passed all 48 checks with `jev-preview` answered by `jev-1.14.0`, and `pnpm fixtures:record --model jev-1.14.0` wrote seven fixtures. On those seven requests 1.14 answered like 1.13, within 0.02 on every probability and with the same input token counts. That is a sanity check, not an eval. Cost is in the dogfood runbook. The stand-in registry fixtures still need a live re-record.
3. **Same-snapshot evals.** For each of the four dogfood sets (`done-check`, `action-risk-gate`, `model-tier`, `launch-profile`), `pnpm eval --transport sdk --repeats 3` on `jev-1.13.0`, then again on the same snapshot with `--snapshot <id> --model jev-1.14.0 --repeats 3`. The datasets are example states and real states that Nick labels. They stay outside the repo, in `~/.bandwise/evals`, because real states hold his prompts. 1.14 passes a set when its high-band precision lower bound is at least 1.13's and its coverage and review load stay within the regression gate's margins. With 50 or so labeled cases per set the intervals are wide, so a result that is only directional, or `insufficient_data`, is read as exactly that. Any local `bandwise run --live` on a 1.14 copy passes `--rollout shadow`, because the command defaults to `full` and its receipts would record a full stage on a preview model.
4. **Threshold re-check.** Read each question's reliability table and band mix on the 1.14 answers. Thresholds tuned on 1.13 are not assumed to carry over. A threshold that needs to move changes only in the 1.14 copy of the spec, never in the version the hooks run.
5. **Hosted shadow challenger, optional.** `<set>-challenger` copies on `jev-1.14.0`, published at `shadow` in `internal` and called for a week by a second hook entry with `--remote-set`. Not before an ADR-008 amendment adds a rule that keeps a `preview` model out of `controlled` and `full`, in both the publish lints and `planRollout`. Today `planRollout` checks only that the model is pinned, and `jev-1.14.0` is, so the preview opt-in alone would let a preview set reach `controlled`. After the amendment: the server reads `organizations.settings.allowPreviewModels` instead of `false`, `internal` opts in with an audit row, the run-only hook token is re-minted to cover the challenger sets (PJ's audit check), and Nick approves the new `.claude/settings.json` entries. `launch-profile` has no hook, so its comparison is the eval only.
6. **Repin.** Only after `jev-latest` points to `jev-1.14.0` and steps 2 to 4 pass. Until then the four dogfood sets stay on `jev-1.13.0`, and no set, challenger copies included, runs `jev-1.14.0` past `shadow`. One set at a time, the sets still in `shadow` first and `model-tier` last. A repin is a new published version and a commit to `.bandwise/sets/`, and the set's week of receipts starts again.
7. **Everything else, together.** After the repins, one PR moves the kit templates, the `bandwise-gate` plugin sets, the docs examples and the platform default to `jev-1.14.0`. `jev-1.13.0` becomes `deprecated` once TypeSafe names a retire date.

**`model-tier` to `controlled` is separate.** It makes that move on `jev-1.13.0`, when Nick moves it, and does not wait for 1.14. Its receipts and thresholds are 1.13 evidence. Changing the model and the stage together would leave no way to tell which change caused a miss.

**Not adopted, and where each is decided.**

- **`box` questions and image inputs** (the `TypeSafe-Danger-Zone-Images` header and the request `assets` field). Each changes the closed question type union or the request shape, so each needs an ADR, or a short ADR note that v1 does not adopt them. Until then the committed `openapi.json` snapshot stays as it is. Refreshing it would fail the fixture contract test, which is the tripwire for `box`.
- **The long-context header** (`TypeSafe-Danger-Zone-Long-Context: true`, 262k tokens per request and per question, slower and less accurate by TypeSafe's own docs). It needs its limits as registry data, a request option, preflight and provider handling, so it belongs in the ADR-008 amendment with per-organization rate limits. The recommendation is not to adopt it now.
- **zstd request compression.** SDK 0.7.0 itself landed on 2026-10-15 (the `state` typing fix, Node 22, live smoke and a fixture re-record), with compression off on every provider through `SDK_COMPRESSION` in `sdk-transport.ts`, so the wire is what it was on 0.6. Turning zstd on is a per-provider decision: a live smoke on that provider first, and for OpenRouter or Vercel an amendment to ADR-011 or ADR-013. Images and `box` stay with the ADR above.

**What the unread post could change.** TypeSafe's Jev 1.14 blog post could not be read from the build environment on 2026-10-15, and there is no 1.14 jaggedness page yet. Everything above comes from `models.md`, `openapi.json` and the SDK changelogs. The post may say when `jev-latest` moves, which step 6 waits on. It may report accuracy or calibration changes against 1.13. A calibration shift would move thresholds in step 4, and any ADR-014 calibration map starts again at identity for a new model. It may say which 1.13 weaknesses are fixed, which would trim the row's weakness list. It may give 1.13 a retire date. And it may say whether a preview build can still change under its versioned id. If it can, `jev-1.14.0` should count as moving, not pinned, until it is official. Nothing on www or in the docs says 1.14 is better until our own evals show it.

The checklist is D5 in `.claude/skills/bandwise-builder/references/phases/phase-d.md`. The commands are in `docs/runbooks/dogfood.md`, Jev 1.14 (D5).

## Spinning up the team

Each role runs as its own Claude Code session (or subagent) on its own branch and worktree. Every session starts by loading the builder skill. Suggested kickoff prompts:

**Architect / Lead (Phase 0 part two)**
> Load the bandwise-builder skill. Complete Phase 0 part two from `references/phases/phase-0.md`: scaffold the pnpm and turborepo workspace, write the zod contracts in `packages/core/src/contracts` (including OperationDef, the error envelope v2, ModelProfile, SetInterface and the agent actor) and the operation registry skeleton, generate `openapi.json`, add boundary lint rules and CI, and draft ADRs 002 through 010. Open a draft PR per logical chunk.

**Core Engine (Phase 1)**
> Load the bandwise-builder skill. Build the Core Engine items in `references/phases/phase-1.md`. Start with the confidence router and its table-driven tests, then the compiler, stages, savings math, preflight, and lints. Use the fixture transport only. Don't touch `packages/db`.

**Platform / Tenancy (Phase 1)**
> Load the bandwise-builder skill. Build the Platform items in `references/phases/phase-1.md`: the full Drizzle schema from `references/data-model.md` with RLS in migration 0001, `withTenant`, repositories, the immutability trigger, and a two-org seed. Pair with QA on the cross-tenant suite.

**QA / Evals (Phase 1)**
> Load the bandwise-builder skill. Build the QA items in `references/phases/phase-1.md`: the fixture minimum set from `references/testing.md`, the fixture contract test, the cross-tenant suite generator, and `pnpm smoke`.

**Integrations (Phase 3)**
> Load the bandwise-builder skill. Build the `@bandwise/cli` management commands and the MCP stdio server from `references/headless-and-agents.md` against the Phase 3 operations. Stay in `packages/cli` and `packages/mcp-server`.

**Quality / Learning (Phase 3)**
> Load the bandwise-builder skill. Build the gate evaluator, auto-demote job and audit sampler from `references/effectiveness-loop.md` in `packages/core/src/learning` and `apps/console/src/jobs/learning`.

Later phases follow the same pattern: load the skill, open the phase file, stay in your lane, hand off through the protocol in `references/team-playbook.md`.

## Before the first paying customer

- ADR-002 (auth library) decided: Better Auth, 2026-09-26. Done.
- ADRs 003 to 010 accepted, 2026-09-26. Done. The ADR-009 Python and Standalone sections still need their own acceptance.
- ADR-011 (OpenRouter route) decided.
- Default `agentApprovals` setting reviewed with the Security reviewer.
- Stripe, Linear (project Bandwise, `P-NSI-36`, in the NSIMS team), and Sentry connectors authorized in claude.ai so agents can use them.
- DPA lists TypeSafe (and Anthropic, if Studio drafting is on) as subprocessors, plus OpenRouter for any org that uses the OpenRouter route.
- TypeSafe rate limits confirmed for the expected load. On 2026-10-15 `models.md` no longer publishes the per-model 1,200 RPM and 250k tokens/sec. TypeSafe now sets limits per organization, in tokens per second and requests per second, and shows them in its developer console. Whatever the platform key gets is shared across every tenant on it. How the registry stores them is part of the ADR-008 amendment in Open items.

## Open items

- **OpenRouter route (ADR-011, proposed):** confirmed 2026-09-25. OpenRouter serves TypeSafe's System One API at `POST https://openrouter.ai/api/v1/systemone`, and the official SDK works with `baseURL: "https://openrouter.ai/api"` and an OpenRouter key. This lets Nick run Jev today with an OpenRouter key and no TypeSafe account. Open question: whether OpenRouter accepts a dated id such as `typesafe/jev-1.13-20260917` as a request model, which a set on OpenRouter needs before it can pass shadow.
- **Jev 1.14 (`jev-1.14.0`, available since 2026-10-14):** the path is in Jev 1.14 above, and the checklist is D5 in phase-d.md. Waiting on TypeSafe: when `jev-latest` moves, whether a preview build stays fixed under its versioned id, and a 1.14 jaggedness page. Still to read: the 1.14 blog post, for what it says about calibration.
- **Jev 1.14 decisions for Nick:**
  - An ADR-008 amendment covering per-organization rate limits (`rpm` and `tokensPerSec` are required fields, and both versioned Jev rows now carry 1.13's last published values), the long-context header, and a rule that keeps a `preview` model out of `controlled` and `full` in the publish lints and `planRollout`. The rule comes before any org opts in to preview models.
  - An ADR, or a short "not adopted in v1" note, for `box` questions and images, before the `openapi.json` snapshot is refreshed.
  - PJ's Security review of the SDK 0.7 change to `sdk-transport.ts`, the module that carries the key (PR #36). Nick chose on 2026-10-15 to merge it without waiting for that review, so anything PJ finds lands as a follow-up.
  - Decided 2026-10-15, with Nick's go on the release plan: kit and `@bandwise/cli` 0.4.0 ship the `jev-1.14.0` preview row. Customers can run it with their own key in local live mode, where publish lints do not apply; the row says `preview`.
  - How the Phase 3b candidates job orders `jev-1.13.0` before `jev-1.14.0` without reading versions out of ids. `jev-1.13.0` has `releaseDate` null, so the registry has nothing to order by yet.
  - An ADR-010 clarification of whether a deliberate repin counts as "the resolved model changes" for auto-demote, before the Phase 3 job is built.
- **Other gateways:** Vercel AI Gateway is the third provider since ADR-013 (accepted 2026-09-27). Its page documents one id, `typesafe-ai/jev`, and no versioned id, so a set on Vercel stays in `inactive` or `shadow`. Cloudflare Workers AI is still unverified and out of scope. Adding it is another provider value and route rows, through an ADR like ADR-011 and ADR-013.
- **`typesafe/jev-router`:** a free OpenRouter chat model (2026-09-25) that uses Jev to pick an LLM and reasoning effort per request. ADR-011 proposes it as an optional escalation route in `llm-client`, reported as LLM spend.
- **Hosted GitHub App** that opens PRs in customer repos: needs an ADR and Security reviewer sign-off.
- **Dev channel and per-environment plugin configs:** not until a customer asks.
- **ConfidencePolicy.measure** (top_probability, margin): later ADR.
- **TypeSafe v1 migration guide:** linked by the official skill, returns 404 today; the contract watch job will flag it.
- **Compaction plugin:** `tamaratran/fast-jev-compaction` reportedly needs `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Optional for long agent sessions, not required.
- **Comparator prices:** the defaults in the savings ledger come from Every's 2026-09-23 newsletter. Confirm against vendor pricing pages before the first customer report.
- **Auth library:** decided in ADR-002 (accepted 2026-09-26): Better Auth with its organization, admin and two-factor plugins.
