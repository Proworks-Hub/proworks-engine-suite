import type { AIProvider } from "./types.js";

// Deterministic stand-in for a real model. It exists so the concept flow can
// be developed, demoed, and tested without credentials — and so tests assert
// engine behaviour rather than model behaviour. It reads the brief for a name
// and a year and lays out simple, manufacturable text concepts.
//
// It is NOT a fallback for production: hosts should surface a clear error
// when no real provider is configured rather than quietly shipping these.

const STOP_WORDS = new Set([
  "the", "and", "for", "his", "her", "their", "with", "from", "that", "this",
  "last", "name", "is", "a", "an", "of", "my", "our", "dad", "mom", "he", "she",
  "retired", "navy", "army", "marine", "air", "force", "veteran",
]);

// The user prompt arrives as "Label: value" lines; only the values carry the
// customer's words, so strip the labels before scanning.
function briefValues(user: string): string {
  return user
    .split("\n")
    .map((line) => {
      const colon = line.indexOf(":");
      return colon === -1 ? line : line.slice(colon + 1);
    })
    .join(" ");
}

function pickName(text: string): string | undefined {
  // Prefer an explicitly capitalised surname, else the longest plain word.
  const capitalised = text.match(/\b[A-Z][a-z]{2,}\b/g) ?? [];
  const candidate = capitalised.find((w) => !STOP_WORDS.has(w.toLowerCase()));
  if (candidate) return candidate.toUpperCase();
  const words = (text.match(/\b[a-zA-Z]{3,}\b/g) ?? []).filter(
    (w) => !STOP_WORDS.has(w.toLowerCase()),
  );
  const longest = words.sort((a, b) => b.length - a.length)[0];
  return longest?.toUpperCase();
}

function pickYear(text: string): string | undefined {
  return text.match(/\b(1[89]\d{2}|20\d{2})\b/)?.[0];
}

export function createMockAIProvider(): AIProvider {
  return {
    name: "mock",
    async generate({ user }) {
      const values = briefValues(user);
      const name = pickName(values) ?? "FAMILY";
      const year = pickYear(values);
      const est = year ? `EST. ${year}` : "GATHER";

      // Three genuinely different treatments, all comfortably inside a
      // 24x18 panel's safe area with text well above minimum cut height.
      const concepts = [
        {
          name: "Nameplate",
          rationale: `Bold ${name} across the front with the other panels left clean.`,
          selections: {},
          surfaces: {
            front: [{ text: name, xIn: 2, yIn: 6, heightIn: 4 }],
          },
        },
        {
          name: "Established",
          rationale: `${name} on the front with ${est} facing the seats opposite.`,
          selections: {},
          surfaces: {
            front: [{ text: name, xIn: 2, yIn: 5, heightIn: 3.5 }],
            back: [{ text: est, xIn: 3, yIn: 6, heightIn: 2.5 }],
          },
        },
        {
          name: "All Around",
          rationale: `${name} front and back with short accents on the side panels.`,
          selections: {},
          surfaces: {
            front: [{ text: name, xIn: 2, yIn: 6, heightIn: 3 }],
            back: [{ text: est, xIn: 3, yIn: 6, heightIn: 2.5 }],
            left: [{ text: "GATHER", xIn: 2, yIn: 7, heightIn: 2 }],
            right: [{ text: "HERE", xIn: 5, yIn: 7, heightIn: 2 }],
          },
        },
      ];
      return JSON.stringify({ concepts });
    },
  };
}
