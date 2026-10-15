// Seed rows for the System One model registry (`system_one_models`) and its price book rows.
// Source: references/system-one-models.md section 13 (seed table), section 14 (default model) and
// references/system-one-api-contract.md (Limits, Pricing). Facts checked against docs.typesafe.ai
// and openapi.json 0.2.0 on 2026-09-26. The jev-1.14.0 row, its price and the jev-preview target
// were checked against docs.typesafe.ai/models.md on 2026-10-15. The live docs win: when they
// change, update this file and the seed table in the same PR (system-one-models.md section 12).
//
// Tests and the table seed read these rows. Runtime code reads profiles through the ModelCatalog
// port, never from this file. Catalog data may say Jev; code identifiers stay neutral.

import {
  KNOWN_WEAKNESS_IDS,
  ModelProfile,
  type ModelProfileInput,
  ModelRoute,
  type ModelRouteInput,
} from "../contracts/models.js";
import type { ModelPrice } from "../contracts/ports.js";

const DOCS_URL = "https://docs.typesafe.ai/models.md";
const REVIEWED_2026_09_26 = "2026-09-26";
const REVIEWED_2026_10_15 = "2026-10-15";

/** jev-1.13.0: stable, the platform default, and jev-latest's target. */
const ROW_1_13_0: ModelProfileInput = {
  id: "jev-1.13.0",
  family: "jev",
  kind: "versioned",
  aliasTarget: null,
  status: "stable",
  // Stays null until the platform admin confirms it: GET /v1/models reports dates for aliases only.
  releaseDate: null,
  retireAt: null,
  questionTypes: ["noul", "choice", "score"],
  limits: {
    requestTokens: 64_000,
    statePlusLongestQuestionTokens: 32_000,
    // Published per model when checked on 2026-09-26. On 2026-10-15 models.md no longer lists them
    // (see ROW_1_14_0).
    rpm: 1_200,
    tokensPerSec: 250_000,
  },
  // English is the strongest language. Language strength is not a profile field; see the seed notes.
  inputModalities: ["text"],
  weaknesses: [...KNOWN_WEAKNESS_IDS],
  supersedes: [],
  docsUrl: DOCS_URL,
  jaggednessUrl: "https://docs.typesafe.ai/model-jaggedness/jev-1.13.md",
  lastReviewed: REVIEWED_2026_09_26,
};

/**
 * jev-1.14.0: available from 2026-10-14 (models.md on 2026-10-15). TypeSafe points jev-preview at it
 * and keeps jev-latest, "the most recent stable, official release", on jev-1.13.0. models.md lists
 * it under Current models as the newest Jev release and never calls it a preview build. Status
 * preview is our reading of the alias table; revisit it when TypeSafe moves jev-latest. Same price,
 * context limits and text input as jev-1.13.0.
 */
const ROW_1_14_0: ModelProfileInput = {
  id: "jev-1.14.0",
  family: "jev",
  kind: "versioned",
  aliasTarget: null,
  status: "preview",
  releaseDate: "2026-10-14",
  retireAt: null,
  // Box questions and image input are in the live openapi.json and SDK 0.7.0 but not adopted
  // (the question type list is closed, ADR-008 section 5), so the row lists the adopted types only.
  questionTypes: ["noul", "choice", "score"],
  limits: {
    requestTokens: 64_000,
    statePlusLongestQuestionTokens: 32_000,
    // models.md now sets rate limits per organization, in tokens and requests per second, and no
    // longer publishes them per model. These repeat jev-1.13.0's last published values because the
    // contract needs positive integers. How to store per-organization limits is not settled yet
    // (ADR-008).
    rpm: 1_200,
    tokensPerSec: 250_000,
  },
  inputModalities: ["text"],
  // No jaggedness page exists for 1.14 yet (model-jaggedness/jev-1.14.md is a 404 on 2026-10-15).
  // The jev-1.13 weakness ids stay listed so the weakness lints keep firing. An empty list would
  // claim 1.14 fixed them, and nobody knows that yet.
  weaknesses: [...KNOWN_WEAKNESS_IDS],
  supersedes: [],
  docsUrl: DOCS_URL,
  jaggednessUrl: null,
  lastReviewed: REVIEWED_2026_10_15,
};

/**
 * Alias rows copy the target's limits, question types, input modalities and weaknesses only to stay
 * valid rows with non-null limits. ModelCatalog never uses them for a moving name; it uses the
 * profile of the observed target.
 */
function aliasOf(id: string, status: "stable" | "preview", target: ModelProfileInput, lastReviewed: string = REVIEWED_2026_09_26): ModelProfileInput {
  return {
    id,
    family: target.family,
    kind: "alias",
    aliasTarget: target.id,
    status,
    releaseDate: null,
    retireAt: null,
    questionTypes: [...target.questionTypes],
    limits: target.limits === null ? null : { ...target.limits },
    inputModalities: [...target.inputModalities],
    weaknesses: [...target.weaknesses],
    supersedes: [],
    docsUrl: DOCS_URL,
    jaggednessUrl: null,
    lastReviewed,
  };
}

const SEED_INPUT: readonly ModelProfileInput[] = [
  ROW_1_13_0,
  aliasOf("jev-latest", "stable", ROW_1_13_0),
  // jev-preview moves ahead of jev-latest when a preview build exists. On 2026-10-15 models.md
  // points it at jev-1.14.0 while jev-latest stays on jev-1.13.0.
  aliasOf("jev-preview", "preview", ROW_1_14_0, REVIEWED_2026_10_15),
  // Appended, not inserted: tests read rows 0 and 1 as jev-1.13.0 and jev-latest.
  ROW_1_14_0,
];

/** Seed ModelProfile rows, parsed at load so a bad edit fails loudly. */
export const SEED_MODEL_PROFILES: readonly ModelProfile[] = Object.freeze(
  SEED_INPUT.map((row) => ModelProfile.parse(row)),
);

/**
 * OpenRouter route rows (`system_one_model_routes`, ADR-011). Facts from OpenRouter's Jev pages and
 * Models API on 2026-09-26: `typesafe/jev-1.13` and `~typesafe/jev-latest`, a 32,000 token context
 * for state plus questions, and responses from the dated build `typesafe/jev-1.13-20260917`.
 * OpenRouter publishes no per-model rpm or tokens-per-second, so those stay null.
 *
 * Neither row is pinned. `typesafe/jev-1.13` answers with dated builds, and whether OpenRouter
 * accepts a dated id as a request model is not confirmed. Sets on OpenRouter stay in inactive or
 * shadow until it is (ADR-011, open question).
 */
const OPENROUTER_LIMITS = {
  requestTokens: 32_000,
  statePlusLongestQuestionTokens: 32_000,
  rpm: null,
  tokensPerSec: null,
} as const;

const SEED_ROUTE_INPUT: readonly ModelRouteInput[] = [
  {
    modelId: "jev-1.13.0",
    provider: "openrouter",
    providerModelId: "typesafe/jev-1.13",
    pinned: false,
    resolvedIds: ["typesafe/jev-1.13-20260917"],
    limits: { ...OPENROUTER_LIMITS },
    docsUrl: "https://openrouter.ai/typesafe/jev-1.13",
    lastReviewed: REVIEWED_2026_09_26,
  },
  {
    modelId: "jev-latest",
    provider: "openrouter",
    providerModelId: "~typesafe/jev-latest",
    pinned: false,
    // An alias: its observed target is tracked in model_alias_observations, not here.
    resolvedIds: [],
    limits: { ...OPENROUTER_LIMITS },
    docsUrl: "https://openrouter.ai/typesafe",
    lastReviewed: REVIEWED_2026_09_26,
  },
  // Vercel AI Gateway (ADR-013), checked on 2026-09-27 against Vercel's "TypeSafe API with AI
  // Gateway" page. It documents one id, `typesafe-ai/jev`, and no versioned id, so jev-1.13.0 has
  // no Vercel row and this row is not pinned. Sets on Vercel stay in inactive or shadow until a
  // versioned id is confirmed. Vercel publishes no limits of its own, so the profile's apply.
  {
    modelId: "jev-latest",
    provider: "vercel",
    providerModelId: "typesafe-ai/jev",
    pinned: false,
    resolvedIds: [],
    limits: { requestTokens: null, statePlusLongestQuestionTokens: null, rpm: null, tokensPerSec: null },
    docsUrl: "https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe",
    lastReviewed: "2026-09-27",
  },
];

/** Seed ModelRoute rows, parsed at load so a bad edit fails loudly. */
export const SEED_MODEL_ROUTES: readonly ModelRoute[] = Object.freeze(
  SEED_ROUTE_INPUT.map((row) => ModelRoute.parse(row)),
);

/** Seed value of the platform setting `defaultModel`: a stable versioned id (section 14). */
export const SEED_PLATFORM_DEFAULT_MODEL = "jev-1.13.0";

/** A platform `price_books` row (org_id null), keyed by exact model id. */
export interface SeedModelPrice extends ModelPrice {
  model: string;
}

/**
 * Platform price rows. Prices are not part of a ModelProfile (ADR-008 section 6). jev-1.13.0 costs
 * $0.042 per million input tokens (42,000 micro-USD) and output is currently free; the zero is
 * data, not an assumption. jev-1.14.0 has the same price (models.md on 2026-10-15: $42 per Btok,
 * output free).
 */
export const SEED_SYSTEM_ONE_PRICES: readonly SeedModelPrice[] = Object.freeze([
  { model: "jev-1.13.0", inputPerMtokMicroUsd: 42_000, outputPerMtokMicroUsd: 0 },
  { model: "jev-1.14.0", inputPerMtokMicroUsd: 42_000, outputPerMtokMicroUsd: 0 },
]);

/**
 * Platform comparator price rows (savings-model.md, Price book): the provider's exact model ids.
 * Haiku 4.5 is the seeded default comparator and the one the example spec names. Prices are from
 * the savings-model.md seed table (Every newsletter, 2026-09-23); confirm them against the vendors'
 * pricing pages before the first customer report. The Gemini row waits for Google's exact id.
 */
export const SEED_COMPARATOR_PRICES: readonly SeedModelPrice[] = Object.freeze([
  { model: "claude-haiku-4-5", inputPerMtokMicroUsd: 1_000_000, outputPerMtokMicroUsd: 5_000_000 },
  { model: "claude-fable-5-1", inputPerMtokMicroUsd: 10_000_000, outputPerMtokMicroUsd: 50_000_000 },
]);

/** Seed value of the org default comparator (savings-model.md: Haiku 4.5 unless changed). */
export const SEED_DEFAULT_COMPARATOR_MODEL = "claude-haiku-4-5";
