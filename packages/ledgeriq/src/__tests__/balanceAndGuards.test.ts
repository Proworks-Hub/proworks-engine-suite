// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { computeRollForward, produceTrialBalance } from "../kernel/balance.js";
import { PERIOD_TRANSITIONS, TERMINAL_PERIOD_STATES } from "../kernel/period.js";
import { periodStateSchema, type JournalEntry } from "../model/model.js";
import { validateProposal } from "../kernel/validation.js";
import type { LedgerSnapshot } from "../kernel/validation.js";
import {
  BOOK_USD,
  CALENDAR,
  CHART,
  CURRENCY_REGISTRY,
  DIMENSIONS,
  proposal,
  usd,
} from "./fixtures.js";

// ─────────────────────────────────────────────────────────────────────────────
// Balance properties, the state-machine property (P-11), and the architecture
// scope guards (§29.4). Each guard was proven to fail by injection during
// Wave 2 (violation added, guard observed red, violation reverted); the
// recorded injections are listed beside each guard.
// ─────────────────────────────────────────────────────────────────────────────

function post(p: unknown, overrides?: Partial<LedgerSnapshot>): JournalEntry {
  const outcome = validateProposal({
    proposal: p,
    recordedAt: "2026-08-15T10:00:00Z",
    snapshot: {
      book: BOOK_USD,
      chartVersions: [CHART],
      calendar: CALENDAR,
      dimensionSchema: DIMENSIONS,
      periodStates: { "2026-8": "open", "2026-12": "open" },
      currencyRegistry: CURRENCY_REGISTRY,
      fxRates: [],
      ...overrides,
    },
  });
  if (!outcome.ok || outcome.replay) throw new Error("fixture entry did not validate");
  return { ...outcome.entry, journalSequence: 1 };
}

describe("P-02 / P-14 — the trial balance foots, in any entry order", () => {
  const entries = [
    post(proposal()),
    post(
      proposal({
        proposalId: "p2",
        idempotencyKey: "k2",
        lines: [
          { lineNo: 1, accountCode: "1000", side: "debit", amount: usd("70.00") },
          { lineNo: 2, accountCode: "4000", side: "credit", amount: usd("70.00"), dimensions: { dept: "D1" } },
        ],
      }),
    ),
    post(
      proposal({
        proposalId: "p3",
        idempotencyKey: "k3",
        lines: [
          { lineNo: 1, accountCode: "5000", side: "debit", amount: usd("0.01") },
          { lineNo: 2, accountCode: "1000", side: "credit", amount: usd("0.01") },
        ],
      }),
    ),
  ];

  it("foots exactly, and identically under permutation", () => {
    const period = { fiscalYear: 2026, periodNumber: 8 };
    const forward = produceTrialBalance(entries, BOOK_USD, CHART, period);
    const reversed = produceTrialBalance([...entries].reverse(), BOOK_USD, CHART, period);
    expect(forward.foots).toBe(true);
    expect(forward.totalDebits.amount).toBe(forward.totalCredits.amount);
    expect(forward).toEqual(reversed);
  });
});

describe("LEDGER-OPENING-BALANCE — the roll-forward is journal entries, not magic", () => {
  it("closes P&L to retained earnings and restates balance-sheet accounts", () => {
    const entries = [
      // Revenue 70 (credit), expense 100.01 (debit), cash and AP movements.
      post(proposal()),
      post(
        proposal({
          proposalId: "p2",
          idempotencyKey: "k2",
          lines: [
            { lineNo: 1, accountCode: "1000", side: "debit", amount: usd("70.00") },
            { lineNo: 2, accountCode: "4000", side: "credit", amount: usd("70.00"), dimensions: { dept: "D1" } },
          ],
        }),
      ),
    ];
    const roll = computeRollForward(entries, BOOK_USD, CHART, { fiscalYear: 2026, periodNumber: 13 });
    // P&L: 5000 debit 100 → closes with a credit; 4000 credit 70 → closes with a debit.
    const close5000 = roll.closingLines.find((l) => l.accountCode === "5000");
    const close4000 = roll.closingLines.find((l) => l.accountCode === "4000");
    expect(close5000?.side).toBe("credit");
    expect(close5000?.amount.amount).toBe("100.00");
    expect(close4000?.side).toBe("debit");
    expect(close4000?.amount.amount).toBe("70.00");
    // Retained earnings receives the net loss of 30.00 as a debit.
    const re = roll.closingLines.find((l) => l.accountCode === "3000");
    expect(re?.side).toBe("debit");
    expect(re?.amount.amount).toBe("30.00");
    // Balance sheet: cash 70 debit − 0 credit… 1000 net +70; 2000 net −100.
    const cash = roll.openingLines.find((l) => l.accountCode === "1000");
    const ap = roll.openingLines.find((l) => l.accountCode === "2000");
    expect(cash?.side).toBe("debit");
    expect(cash?.amount.amount).toBe("70.00");
    expect(ap?.side).toBe("credit");
    expect(ap?.amount.amount).toBe("100.00");
    // And the closing entry itself balances: debits = credits.
    const net = roll.closingLines.reduce((acc, l) => {
      const units = BigInt(l.amount.amount.replace(".", ""));
      return acc + (l.side === "debit" ? units : -units);
    }, 0n);
    expect(net).toBe(0n);
  });

  it("refuses to close a year with no retained-earnings account — nothing defaults", () => {
    const bare = { ...BOOK_USD };
    delete (bare as Record<string, unknown>).retainedEarningsAccount;
    expect(() =>
      computeRollForward([], bare as typeof BOOK_USD, CHART, { fiscalYear: 2026, periodNumber: 13 }),
    ).toThrow(/retainedEarningsAccount/);
  });
});

describe("P-11 — every period state has an exit or is declared terminal", () => {
  it("holds for the implemented table", () => {
    for (const state of periodStateSchema.options) {
      const hasExit = PERIOD_TRANSITIONS.some((t) => t.from === state);
      const declaredTerminal = TERMINAL_PERIOD_STATES.includes(state);
      // The structural avoidance of AWAITING_HUMAN_AUTHORIZATION-with-no-exit:
      // a state is either exitable or EXPLICITLY terminal. Never neither.
      expect(hasExit || declaredTerminal, state).toBe(true);
      expect(hasExit && declaredTerminal, state).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Architecture scope guards. Source scans over this package's own files.
// ─────────────────────────────────────────────────────────────────────────────

const SRC = join(process.cwd(), "packages/ledgeriq/src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = sourceFiles(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));
const kernelFiles = files.filter((f) => f.path.includes("kernel"));

describe("guards G-1..G-4 — imports stay inside the platform", () => {
  // Proven to fail by injection: `import "@proworks-hub/costiq"` added to
  // validation.ts → red; reverted. Same for finance-core and control-plane.
  // `(?:from|import)\s*` catches BOTH the named form and the bare
  // side-effect form — the first injection run proved the `from`-only regex
  // let `import "@proworks-hub/costiq";` straight through.
  const forbiddenImports = [
    /(?:from|import)\s+"@proworks-hub\/(?!contracts|core-kit)[a-z-]+/, // G-1: no specialist, G-2: no finance-core
    /(?:from|import)\s+"(@ksix|@makerops|@shared)\//, // G-3: no host
    /(?:from|import)\s+"@proworks-hub\/control-plane/, // G-4: console down ≠ engine down
  ];
  it("imports only contracts, core-kit and zod", () => {
    for (const f of files) {
      for (const pattern of forbiddenImports) {
        expect(pattern.test(f.text), `${f.path} matches ${pattern}`).toBe(false);
      }
    }
  });
});

describe("guard G-5 — kernel purity", () => {
  // Proven to fail by injection: `const now = Date.now()` added to
  // validation.ts → red; reverted.
  it("has no clock, randomness, network or filesystem in kernel/", () => {
    const impure = [
      /Date\.now\s*\(/,
      /new Date\s*\(\s*\)/, // a no-argument construction is a clock read
      /Math\.random/,
      /crypto\.randomUUID/,
      /from "node:fs|from "node:net|from "node:http/,
      /\bfetch\s*\(/,
      /from "@proworks-hub\/model-runtime|from "@proworks-hub\/intelligence-core/,
    ];
    for (const f of kernelFiles) {
      for (const pattern of impure) {
        expect(pattern.test(f.text), `${f.path} matches ${pattern}`).toBe(false);
      }
    }
  });
});

describe("guard G-7 — dependency direction: kernel imports nothing impure", () => {
  // Proven to fail by injection: `import ... from "../runtime/ledgerRuntime.js"`
  // added to balance.ts → red; reverted.
  it("kernel/ never imports runtime/, specialist/, memory/ or ports implementations", () => {
    for (const f of kernelFiles) {
      expect(/from "\.\.\/(runtime|specialist|memory)\//.test(f.text), f.path).toBe(false);
    }
  });
});

describe("guard G-8 — no bypass surface", () => {
  // Proven to fail by injection: `force?: boolean` added to LedgerRuntime.post
  // input → red; reverted.
  it("the public surface has no force/skipValidation/override/unsafe/admin identifier", () => {
    const publicFiles = files.filter(
      (f) => f.path.includes("runtime") || f.path.includes("ports") || f.path.includes("specialist"),
    );
    for (const f of publicFiles) {
      expect(/\b(force|skipValidation|override|unsafe|admin)\s*[?:]/.test(f.text), f.path).toBe(
        false,
      );
    }
  });
});

describe("guard G-11 — no IEEE-754 money, no receipt.ts money import", () => {
  // Proven to fail by injection: `Math.round(n * 100) / 100` added to
  // money-handling code → red; reverted.
  it("uses no float arithmetic on amounts and never imports the legacy moneySchema", () => {
    for (const f of files) {
      expect(/Math\.round|parseFloat|toFixed\(/.test(f.text), f.path).toBe(false);
      expect(/\bmoneySchema\b|\bmoneyFromDecimal\b|\bmoneyToDecimal\b/.test(f.text), f.path).toBe(
        false,
      );
    }
  });
});

describe("guard G-6/G-9 — no duplicate infrastructure, no store-writing event handler", () => {
  it("declares no retry loop, no private bus, and subscribes to nothing", () => {
    for (const f of files) {
      expect(/retryWithBackoff|setInterval|setTimeout\(/.test(f.text), f.path).toBe(false);
      expect(/\.subscribe\(/.test(f.text), f.path).toBe(false);
    }
  });
});

describe("the store port is structurally immutable", () => {
  it("exposes no update or delete for posted entries", () => {
    const port = files.find((f) => f.path.includes("ports.ts"));
    expect(port).toBeDefined();
    // Method DECLARATIONS, not prose — the port's own comment is allowed to
    // say "there is no updateEntry", and does.
    expect(/^\s*(updateEntry|deleteEntry|removeEntry|amendEntry)\s*\(/m.test(port?.text ?? "")).toBe(
      false,
    );
  });
});
