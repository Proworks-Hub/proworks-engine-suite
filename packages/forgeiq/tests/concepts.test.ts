import { describe, expect, it } from "vitest";
import {
  extractJsonObject,
  generateConcepts,
} from "../src/core/ai/conceptService";
import { createMockAIProvider } from "../src/core/ai/mockProvider";
import { buildConceptSystemPrompt, buildConceptUserPrompt } from "../src/core/ai/conceptPrompt";
import type { AIProvider } from "../src/core/ai/types";
import { runValidation } from "../src/core/validation/validationEngine";
import { definition, machine, materials } from "./helpers";

const brief = {
  what: "a fire pit for my dad",
  who: "retired Navy, last name Thompson",
  occasion: "his 70th birthday",
  style: "rustic and outdoorsy",
  mustInclude: "his name and Est. 1974",
};

const run = (provider: AIProvider, count = 3) =>
  generateConcepts({ definition, materials, machine, brief, provider, count });

describe("concept prompt", () => {
  const system = buildConceptSystemPrompt({ definition, count: 3 });

  it("tells the model the shop's real constraints", () => {
    expect(system).toContain('at least 0.375" tall');
    expect(system).toContain('"front" (Front): 24" x 18"');
    expect(system).toContain('usable area 22.50" x 16.50"');
    expect(system).toContain('"size_24"');
    expect(system).toContain("Return exactly 3 concepts");
  });

  it("passes the brief through as labelled fields", () => {
    const user = buildConceptUserPrompt(brief);
    expect(user).toContain("Who it is for: retired Navy, last name Thompson");
    expect(user).toContain("Must include: his name and Est. 1974");
    expect(buildConceptUserPrompt({})).toContain("no details");
  });
});

describe("generateConcepts", () => {
  it("returns validated, priced concepts from the mock provider", async () => {
    const result = await run(createMockAIProvider());
    expect(result.provider).toBe("mock");
    expect(result.concepts).toHaveLength(3);
    expect(result.rejected).toEqual([]);

    for (const concept of result.concepts) {
      expect(concept.validation.valid).toBe(true);
      expect(concept.price.customerPrice).toBeGreaterThan(0);
      // Every concept must survive a fresh validation pass, not just the
      // one taken during generation.
      expect(
        runValidation({
          definition,
          configuration: concept.configuration,
          materials,
          machine,
        }).valid,
      ).toBe(true);
    }
    // The brief's surname reaches the design.
    expect(JSON.stringify(result.concepts)).toContain("THOMPSON");
  });

  it("fills option selections the model omitted with definition defaults", async () => {
    const result = await run(createMockAIProvider());
    for (const concept of result.concepts) {
      expect(concept.configuration.selections.size).toBe("size_24");
      expect(concept.configuration.selections.material).toBe("mat_corten");
    }
  });

  it("ignores invented option ids", async () => {
    const provider: AIProvider = {
      name: "test",
      generate: async () =>
        JSON.stringify({
          concepts: [
            {
              name: "Bogus options",
              rationale: "x",
              selections: { size: "size_titanic", material: "unobtanium" },
              surfaces: { front: [{ text: "SMITH", xIn: 2, yIn: 6, heightIn: 3 }] },
            },
          ],
        }),
    };
    const result = await run(provider, 1);
    expect(result.concepts[0].configuration.selections.size).toBe("size_24");
    expect(result.concepts[0].configuration.selections.material).toBe("mat_corten");
  });

  it("repairs a near-miss draft instead of discarding it", async () => {
    const provider: AIProvider = {
      name: "test",
      generate: async () =>
        JSON.stringify({
          concepts: [
            {
              name: "Too small",
              rationale: "text below the cut minimum",
              selections: {},
              // 0.1" tall is under the 0.375" minimum — repairable.
              surfaces: { front: [{ text: "SMITH", xIn: 2, yIn: 6, heightIn: 0.1 }] },
            },
          ],
        }),
    };
    const result = await run(provider, 1);
    expect(result.concepts).toHaveLength(1);
    expect(result.concepts[0].repairsApplied).toContain("Enlarge text");
    const el = result.concepts[0].configuration.surfaces.front[0];
    expect(el.type === "text" && el.heightIn).toBe(0.375);
    expect(result.concepts[0].validation.valid).toBe(true);
  });

  it("rejects a draft that cannot be made manufacturable", async () => {
    const provider: AIProvider = {
      name: "test",
      generate: async () =>
        JSON.stringify({
          concepts: [
            {
              name: "Unbuildable",
              rationale: "text far longer than any panel",
              selections: {},
              surfaces: {
                front: [
                  { text: "THIS SENTENCE IS FAR TOO LONG TO CUT", xIn: 2, yIn: 6, heightIn: 6 },
                ],
              },
            },
          ],
        }),
    };
    const result = await run(provider, 1);
    // Either repaired to fit or rejected — never returned unbuildable.
    if (result.concepts.length > 0) {
      expect(result.concepts[0].validation.valid).toBe(true);
    } else {
      expect(result.rejected[0].name).toBe("Unbuildable");
    }
  });

  it("surfaces a clear error when the model returns unusable output", async () => {
    const provider: AIProvider = { name: "test", generate: async () => "I'm afraid I can't do that." };
    await expect(run(provider)).rejects.toThrow(/unusable|JSON/i);
  });
});

describe("extractJsonObject", () => {
  it("parses plain JSON", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips markdown fences", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("finds an object buried in prose", () => {
    expect(extractJsonObject('Sure! Here you go:\n{"a":{"b":2}}\nHope that helps.')).toEqual({
      a: { b: 2 },
    });
  });

  it("is not fooled by braces inside strings", () => {
    expect(extractJsonObject('{"text":"a } brace"}')).toEqual({ text: "a } brace" });
  });

  it("throws on output with no JSON at all", () => {
    expect(() => extractJsonObject("no json here")).toThrow();
  });
});
