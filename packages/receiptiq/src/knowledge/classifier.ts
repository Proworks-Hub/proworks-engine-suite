// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { CONFIDENCE } from "@proworks/contracts";
import { normalizeName } from "../normalize/keys.js";

// ─────────────────────────────────────────────────────────────────────────────
// Item classification.
//
// Family Table's classifier worked well and could not be lifted as it stood,
// because its categories are household BUDGET lines — Housing, Utilities,
// Food, Insurance, Transportation, Child Support. Those are how a family files
// a purchase, and they are meaningless to a fabrication shop, which files the
// same steel bar under a job or an expense account.
//
// So the mechanism moves and the taxonomy does not. A host supplies its own
// categories and its own lexicon; ReceiptIQ supplies the three-tier resolution
// that made it work:
//
//   1. What a human taught, for this exact normalized name  → 0.95
//   2. What a lexicon pattern recognizes                     → 0.70
//   3. Unknown                                               → 0.30
//
// Below 0.5 a host should ask rather than act. That threshold is what feeds
// the review queue, and it is why the confidence number exists at all: the
// point was never to score the classifier, it was to know when to stop.
// ─────────────────────────────────────────────────────────────────────────────

export interface LexiconRule<TCategory extends string = string> {
  readonly category: TCategory;
  readonly pattern: RegExp;
}

export interface ClassificationResult<TCategory extends string = string> {
  readonly category: TCategory | null;
  readonly confidence: number;
  readonly source: "learned" | "lexicon" | "unknown";
}

export interface ClassifierOptions<TCategory extends string = string> {
  /** The host's own taxonomy. Ordered; the first pattern to match wins. */
  readonly lexicon: readonly LexiconRule<TCategory>[];
  /**
   * Corrections a human has made, keyed by normalized item name. Supplied by
   * the host from an ItemKnowledgeRepository so learning survives restarts.
   */
  readonly learned?: Readonly<Record<string, TCategory>>;
  /** Restricts results to a known set. A category outside it is ignored. */
  readonly allowed?: readonly TCategory[];
}

/**
 * Classifies an item name within the host's taxonomy.
 *
 * Returns `null` with low confidence rather than guessing a category. A wrong
 * category that arrives with high confidence is worse than no category,
 * because nothing downstream will ever question it.
 */
export function classifyItem<TCategory extends string = string>(
  name: string | null | undefined,
  options: ClassifierOptions<TCategory>,
): ClassificationResult<TCategory> {
  const key = normalizeName(name);
  if (!key) return { category: null, confidence: CONFIDENCE.unknown, source: "unknown" };

  const allowed = options.allowed ? new Set<string>(options.allowed) : null;
  const permitted = (category: TCategory): boolean => !allowed || allowed.has(category);

  const learned = options.learned?.[key];
  if (learned && permitted(learned)) {
    return { category: learned, confidence: CONFIDENCE.corrected, source: "learned" };
  }

  for (const rule of options.lexicon) {
    if (rule.pattern.test(key) && permitted(rule.category)) {
      return { category: rule.category, confidence: CONFIDENCE.recognized, source: "lexicon" };
    }
  }

  return { category: null, confidence: CONFIDENCE.unknown, source: "unknown" };
}

/** True when a classification is confident enough to act on without asking. */
export function isConfident(result: ClassificationResult): boolean {
  return result.confidence >= CONFIDENCE.reviewThreshold;
}

/**
 * Everything a host should put in front of a human, worst first.
 *
 * The ordering matters more than it looks: correcting the least certain item
 * teaches the most, and a queue sorted the other way trains the classifier on
 * things it already knew.
 */
export function reviewQueue<T extends { confidence: number }>(items: readonly T[]): T[] {
  return items
    .filter((item) => item.confidence < CONFIDENCE.reviewThreshold)
    .slice()
    .sort((a, b) => a.confidence - b.confidence);
}
