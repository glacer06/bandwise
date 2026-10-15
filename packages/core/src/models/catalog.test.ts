import { describe, expect, it } from "vitest";

import { KNOWN_WEAKNESS_IDS, ModelProfile, classifyModelName } from "../contracts/models.js";
import { ModelPrice } from "../contracts/ports.js";
import {
  SEED_COMPARATOR_PRICES,
  SEED_DEFAULT_COMPARATOR_MODEL,
  SEED_MODEL_PROFILES,
  SEED_PLATFORM_DEFAULT_MODEL,
  SEED_SYSTEM_ONE_PRICES,
} from "./catalog.js";

function row(id: string): ModelProfile {
  const found = SEED_MODEL_PROFILES.find((p) => p.id === id);
  if (found === undefined) throw new Error(`missing seed row ${id}`);
  return found;
}

describe("seed catalog", () => {
  it("has exactly jev-1.13.0, jev-latest, jev-preview and jev-1.14.0, the new row appended", () => {
    expect(SEED_MODEL_PROFILES.map((p) => p.id)).toEqual(["jev-1.13.0", "jev-latest", "jev-preview", "jev-1.14.0"]);
  });

  it.each(SEED_MODEL_PROFILES.map((p) => [p.id, p] as const))("%s parses as ModelProfile", (_id, profile) => {
    expect(ModelProfile.parse(profile)).toEqual(profile);
  });

  it("classifies jev-1.13.0 and jev-1.14.0 as pinned and the aliases as moving", () => {
    expect(classifyModelName("jev-1.13.0", SEED_MODEL_PROFILES)).toBe("pinned");
    expect(classifyModelName("jev-1.14.0", SEED_MODEL_PROFILES)).toBe("pinned");
    expect(classifyModelName("jev-latest", SEED_MODEL_PROFILES)).toBe("moving");
    expect(classifyModelName("jev-preview", SEED_MODEL_PROFILES)).toBe("moving");
    // Partial ids are not seeded, so they stay moving.
    expect(classifyModelName("jev", SEED_MODEL_PROFILES)).toBe("moving");
    expect(classifyModelName("jev-1.13", SEED_MODEL_PROFILES)).toBe("moving");
    expect(classifyModelName("jev-1.14", SEED_MODEL_PROFILES)).toBe("moving");
  });

  it("matches the jev-1.13.0 seed table row", () => {
    const pinned = row("jev-1.13.0");
    expect(pinned).toMatchObject({
      family: "jev",
      kind: "versioned",
      status: "stable",
      aliasTarget: null,
      releaseDate: null,
      retireAt: null,
      questionTypes: ["noul", "choice", "score"],
      limits: { requestTokens: 64_000, statePlusLongestQuestionTokens: 32_000, rpm: 1_200, tokensPerSec: 250_000 },
      inputModalities: ["text"],
      supersedes: [],
      docsUrl: "https://docs.typesafe.ai/models.md",
      jaggednessUrl: "https://docs.typesafe.ai/model-jaggedness/jev-1.13.md",
      lastReviewed: "2026-09-26",
    });
    expect(pinned.weaknesses).toEqual([...KNOWN_WEAKNESS_IDS]);
  });

  it("matches the jev-1.14.0 row: preview, with the context limits of jev-1.13.0 (models.md, 2026-10-15)", () => {
    const next = row("jev-1.14.0");
    expect(next).toMatchObject({
      family: "jev",
      kind: "versioned",
      status: "preview",
      aliasTarget: null,
      releaseDate: "2026-10-14",
      retireAt: null,
      questionTypes: ["noul", "choice", "score"],
      // rpm and tokensPerSec repeat jev-1.13.0's last published values until the ADR-008 amendment.
      limits: { requestTokens: 64_000, statePlusLongestQuestionTokens: 32_000, rpm: 1_200, tokensPerSec: 250_000 },
      inputModalities: ["text"],
      supersedes: [],
      docsUrl: "https://docs.typesafe.ai/models.md",
      // No jev-1.14 jaggedness page yet, so the jev-1.13 weakness ids stay listed.
      jaggednessUrl: null,
      lastReviewed: "2026-10-15",
    });
    expect(next.weaknesses).toEqual([...KNOWN_WEAKNESS_IDS]);
  });

  it("gives the aliases the documented status and target, copying the target's facts", () => {
    for (const [id, status, target, lastReviewed] of [
      ["jev-latest", "stable", "jev-1.13.0", "2026-09-26"],
      ["jev-preview", "preview", "jev-1.14.0", "2026-10-15"],
    ] as const) {
      const a = row(id);
      const t = row(target);
      expect(a).toMatchObject({
        family: "jev",
        kind: "alias",
        status,
        aliasTarget: target,
        releaseDate: null,
        retireAt: null,
        jaggednessUrl: null,
        supersedes: [],
        docsUrl: "https://docs.typesafe.ai/models.md",
        lastReviewed,
      });
      expect(a.limits).toEqual(t.limits);
      expect(a.questionTypes).toEqual(t.questionTypes);
      expect(a.inputModalities).toEqual(t.inputModalities);
      expect(a.weaknesses).toEqual(t.weaknesses);
    }
  });

  it("points every alias at a versioned seed row", () => {
    for (const p of SEED_MODEL_PROFILES.filter((r) => r.kind === "alias")) {
      expect(p.aliasTarget).not.toBeNull();
      expect(classifyModelName(p.aliasTarget ?? "", SEED_MODEL_PROFILES)).toBe("pinned");
    }
  });

  it("seeds the platform default as a stable versioned row, jev-latest's target", () => {
    const d = row(SEED_PLATFORM_DEFAULT_MODEL);
    expect(d.kind).toBe("versioned");
    expect(d.status).toBe("stable");
    // jev-1.14.0 is preview, so the default stays on jev-1.13.0 (system-one-models.md section 14).
    expect(SEED_PLATFORM_DEFAULT_MODEL).toBe("jev-1.13.0");
    expect(row("jev-latest").aliasTarget).toBe(SEED_PLATFORM_DEFAULT_MODEL);
  });
});

describe("seed prices", () => {
  it("prices jev-1.13.0 and jev-1.14.0 at $0.042 per million input tokens with free output", () => {
    expect(SEED_SYSTEM_ONE_PRICES).toEqual([
      { model: "jev-1.13.0", inputPerMtokMicroUsd: 42_000, outputPerMtokMicroUsd: 0 },
      { model: "jev-1.14.0", inputPerMtokMicroUsd: 42_000, outputPerMtokMicroUsd: 0 },
    ]);
  });

  it("prices every alias's seed target, so the platform-key price check on an alias finds a row", () => {
    const priced = new Set(SEED_SYSTEM_ONE_PRICES.map((p) => p.model));
    for (const p of SEED_MODEL_PROFILES.filter((r) => r.kind === "alias")) {
      expect(priced.has(p.aliasTarget ?? "")).toBe(true);
    }
  });

  it("keys every price row by a versioned id, never an alias", () => {
    for (const { model, ...price } of SEED_SYSTEM_ONE_PRICES) {
      expect(ModelPrice.safeParse(price).success).toBe(true);
      expect(classifyModelName(model, SEED_MODEL_PROFILES)).toBe("pinned");
    }
  });

  it("keeps prices out of the profiles", () => {
    for (const p of SEED_MODEL_PROFILES) {
      expect(Object.keys(p).some((k) => k.toLowerCase().includes("price"))).toBe(false);
    }
  });
});

describe("seed comparator prices", () => {
  it("matches the savings-model.md seed rows in micro-USD per million tokens", () => {
    expect(SEED_COMPARATOR_PRICES).toEqual([
      { model: "claude-haiku-4-5", inputPerMtokMicroUsd: 1_000_000, outputPerMtokMicroUsd: 5_000_000 },
      { model: "claude-fable-5-1", inputPerMtokMicroUsd: 10_000_000, outputPerMtokMicroUsd: 50_000_000 },
    ]);
    for (const { model: _model, ...price } of SEED_COMPARATOR_PRICES) {
      expect(ModelPrice.parse(price)).toEqual(price);
    }
  });

  it("prices the default comparator and never a System One model", () => {
    expect(SEED_COMPARATOR_PRICES.map((p) => p.model)).toContain(SEED_DEFAULT_COMPARATOR_MODEL);
    const systemOneIds = new Set(SEED_MODEL_PROFILES.map((p) => p.id));
    for (const p of SEED_COMPARATOR_PRICES) expect(systemOneIds.has(p.model)).toBe(false);
  });
});
