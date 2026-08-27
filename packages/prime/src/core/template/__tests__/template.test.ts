/*
 * Copyright © 2026 Steven. All Rights Reserved.
 *
 * This file was created under the sole direction and vision of Steven.
 * All product decisions, business logic, workflows, and architecture
 * were defined by Steven. AI tools (Cursor, Perplexity, ChatGPT)
 * were used strictly as a coding assistant, similar to working with
 * a hired developer.
 *
 * Owner: Steven
 * Project: MakerOps / ProWorks Hub
 * Created: 2026
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { EventActor } from "../../../models/events";
import { createInMemoryEventLog } from "../../logging/inMemoryEventLog";
import type { EventLog } from "../../logging/eventLog";
import type {
  IntakeLineItem,
  PrimeWorkOrderDraft,
} from "../../intake/intakeTypes";
import type {
  ProcessTemplate,
  TemplateResolvedPayload,
} from "../templateTypes";
import { createInMemoryTemplateLibrary } from "../inMemoryTemplateLibrary";
import { createResolveTemplateUseCase } from "../resolveTemplateUseCase";

// ---------- Fixtures ----------

const SUPERVISOR: EventActor = {
  kind: "user",
  userId: "u-supervisor-1",
  role: "supervisor",
};

const ACRYLIC_SIGN_TEMPLATE: ProcessTemplate = {
  id: "mat-acrylic-3mm",
  name: "Acrylic sign — laser cut + finish + QC",
  kind: "template",
  steps: [
    {
      id: "cut",
      label: "Laser cut blank",
      workstationClass: "laser",
      requiredSkillTags: ["laser-certified"],
      estimatedDurationMinutes: 20,
    },
    {
      id: "finish",
      label: "Flame polish edges",
      workstationClass: "hand_finish",
      requiredSkillTags: [],
      estimatedDurationMinutes: 10,
      dependsOn: ["cut"],
    },
    {
      id: "qc",
      label: "Final QC",
      workstationClass: "quality_check",
      requiredSkillTags: ["quality-inspector"],
      estimatedDurationMinutes: 5,
      dependsOn: ["finish"],
      optional: true,
    },
  ],
};

const DTF_TEE_TEMPLATE: ProcessTemplate = {
  id: "mat-dtf-tee",
  name: "DTF tee",
  kind: "recipe",
  steps: [
    {
      id: "print",
      label: "DTF print transfer",
      workstationClass: "dtf_print",
      requiredSkillTags: [],
      estimatedDurationMinutes: 8,
    },
    {
      id: "press",
      label: "Heat press onto garment",
      workstationClass: "hand_assembly",
      requiredSkillTags: [],
      estimatedDurationMinutes: 3,
      dependsOn: ["print"],
    },
  ],
};

function draftWith(
  lineItems: ReadonlyArray<IntakeLineItem>,
  workOrderId = "wo-1"
): PrimeWorkOrderDraft {
  return {
    workOrderId,
    status: "draft",
    customerId: "cust-1",
    customerName: "Acme Signs",
    source: "manual",
    priority: "high",
    lineItems,
    dueDate: "2026-05-01",
    attachments: [],
    discounts: [],
    surcharges: [],
    createdAt: "2026-04-20T12:00:00.000Z",
  };
}

// ============================================================
//  InMemoryTemplateLibrary
// ============================================================

describe("createInMemoryTemplateLibrary", () => {
  it("returns null when no template matches the line item", async () => {
    const lib = createInMemoryTemplateLibrary({
      templates: [ACRYLIC_SIGN_TEMPLATE],
    });
    const result = await lib.findForLineItem({
      id: "li-1",
      label: "Mystery item",
      quantity: 1,
      materialId: "mat-unknown",
    });
    expect(result).toBeNull();
  });

  it("returns the template whose id matches the line item's materialId (default matcher)", async () => {
    const lib = createInMemoryTemplateLibrary({
      templates: [ACRYLIC_SIGN_TEMPLATE, DTF_TEE_TEMPLATE],
    });
    const result = await lib.findForLineItem({
      id: "li-1",
      label: "Acrylic sign 24x36",
      quantity: 2,
      materialId: "mat-acrylic-3mm",
    });
    expect(result?.id).toBe("mat-acrylic-3mm");
  });

  it("returns null when line item has no materialId", async () => {
    const lib = createInMemoryTemplateLibrary({
      templates: [ACRYLIC_SIGN_TEMPLATE],
    });
    const result = await lib.findForLineItem({
      id: "li-1",
      label: "Just a label, no material",
      quantity: 1,
    });
    expect(result).toBeNull();
  });

  it("honors a custom matcher", async () => {
    const lib = createInMemoryTemplateLibrary({
      templates: [ACRYLIC_SIGN_TEMPLATE],
      matcher: (item, templates) => {
        // Label-based matching for demo.
        if (/acrylic/i.test(item.label)) {
          return templates.get("mat-acrylic-3mm") ?? null;
        }
        return null;
      },
    });
    const hit = await lib.findForLineItem({
      id: "li-1",
      label: "Giant ACRYLIC sign",
      quantity: 1,
    });
    expect(hit?.id).toBe("mat-acrylic-3mm");
  });
});

// ============================================================
//  resolveTemplateUseCase
// ============================================================

describe("resolveTemplateUseCase", () => {
  let log: EventLog;
  let nextStepId: number;

  const library = () =>
    createInMemoryTemplateLibrary({
      templates: [ACRYLIC_SIGN_TEMPLATE, DTF_TEE_TEMPLATE],
    });

  beforeEach(() => {
    log = createInMemoryEventLog();
    nextStepId = 0;
  });

  const useCase = (lib = library()) =>
    createResolveTemplateUseCase({
      eventLog: log,
      library: lib,
      stepIdGenerator: () => `s-${++nextStepId}`,
    });

  it("fans a single line item through its template (happy path)", async () => {
    const draft = draftWith([
      {
        id: "li-1",
        label: "Acrylic sign",
        quantity: 1,
        materialId: "mat-acrylic-3mm",
      },
    ]);

    const result = await useCase().execute(draft, SUPERVISOR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.tentativeSteps).toHaveLength(3);
    const labels = result.tentativeSteps.map((s) => s.label);
    expect(labels).toEqual([
      "Laser cut blank",
      "Flame polish edges",
      "Final QC",
    ]);
  });

  it("remaps dependsOn from templateStepId to tentative-step id", async () => {
    const draft = draftWith([
      {
        id: "li-1",
        label: "Acrylic sign",
        quantity: 1,
        materialId: "mat-acrylic-3mm",
      },
    ]);

    const result = await useCase().execute(draft, SUPERVISOR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [cut, finish, qc] = result.tentativeSteps;
    expect(cut.dependsOn).toEqual([]);
    expect(finish.dependsOn).toEqual([cut.id]);
    expect(qc.dependsOn).toEqual([finish.id]);
  });

  it("carries optional flag from template onto tentative step", async () => {
    const draft = draftWith([
      {
        id: "li-1",
        label: "Acrylic sign",
        quantity: 1,
        materialId: "mat-acrylic-3mm",
      },
    ]);

    const result = await useCase().execute(draft, SUPERVISOR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.tentativeSteps[0].optional).toBe(false); // cut
    expect(result.tentativeSteps[2].optional).toBe(true); // qc
  });

  it("fans two line items on the same template into independent step chains", async () => {
    const draft = draftWith([
      {
        id: "li-a",
        label: "Sign A",
        quantity: 1,
        materialId: "mat-acrylic-3mm",
      },
      {
        id: "li-b",
        label: "Sign B",
        quantity: 1,
        materialId: "mat-acrylic-3mm",
      },
    ]);

    const result = await useCase().execute(draft, SUPERVISOR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.tentativeSteps).toHaveLength(6); // 2 items × 3 steps

    const aSteps = result.tentativeSteps.filter((s) => s.lineItemId === "li-a");
    const bSteps = result.tentativeSteps.filter((s) => s.lineItemId === "li-b");
    expect(aSteps).toHaveLength(3);
    expect(bSteps).toHaveLength(3);

    // Ids are disjoint between the two line item chains.
    const aIds = new Set(aSteps.map((s) => s.id));
    const bIds = new Set(bSteps.map((s) => s.id));
    for (const id of bIds) {
      expect(aIds.has(id)).toBe(false);
    }

    // Each chain's `finish` step depends on ITS OWN `cut`, not the other chain's.
    const aFinish = aSteps.find((s) => s.templateStepId === "finish")!;
    const aCut = aSteps.find((s) => s.templateStepId === "cut")!;
    expect(aFinish.dependsOn).toEqual([aCut.id]);
  });

  it("handles mixed templates across line items", async () => {
    const draft = draftWith([
      {
        id: "li-a",
        label: "Acrylic sign",
        quantity: 1,
        materialId: "mat-acrylic-3mm",
      },
      {
        id: "li-b",
        label: "DTF tee",
        quantity: 3,
        materialId: "mat-dtf-tee",
      },
    ]);

    const result = await useCase().execute(draft, SUPERVISOR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.tentativeSteps).toHaveLength(3 + 2);

    const events = await log.listByWorkOrder("wo-1");
    expect(events).toHaveLength(1);
    const payload = events[0].payload as TemplateResolvedPayload;
    expect(payload.stepCount).toBe(5);
    expect(payload.lineItemCount).toBe(2);
    expect([...payload.templateIds].sort()).toEqual([
      "mat-acrylic-3mm",
      "mat-dtf-tee",
    ]);
  });

  it("emits exactly one work_order.template.resolved event", async () => {
    const draft = draftWith([
      {
        id: "li-1",
        label: "Acrylic sign",
        quantity: 1,
        materialId: "mat-acrylic-3mm",
      },
    ]);

    await useCase().execute(draft, SUPERVISOR);
    const events = await log.listByType("work_order.template.resolved");
    expect(events).toHaveLength(1);
    expect(events[0].workOrderId).toBe("wo-1");
    expect(events[0].actor).toEqual(SUPERVISOR);
  });

  it("returns ok:false and does NOT emit when a line item has no matching template", async () => {
    const draft = draftWith([
      {
        id: "li-1",
        label: "Acrylic sign",
        quantity: 1,
        materialId: "mat-acrylic-3mm",
      },
      {
        id: "li-2",
        label: "Unknown thing",
        quantity: 1,
        materialId: "mat-nope",
      },
    ]);

    const result = await useCase().execute(draft, SUPERVISOR);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("template_not_found");
    expect(result.errors[0].lineItemId).toBe("li-2");

    const events = await log.listSince(0);
    expect(events).toHaveLength(0);
  });

  it("returns template_empty when a matched template has no steps", async () => {
    const lib = createInMemoryTemplateLibrary({
      templates: [
        {
          id: "mat-empty",
          name: "Empty",
          kind: "template",
          steps: [],
        },
      ],
    });
    const draft = draftWith([
      {
        id: "li-1",
        label: "Empty job",
        quantity: 1,
        materialId: "mat-empty",
      },
    ]);

    const result = await useCase(lib).execute(draft, SUPERVISOR);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors[0].code).toBe("template_empty");
    expect(await log.size()).toBe(0);
  });

  it("produces frozen tentative steps", async () => {
    const draft = draftWith([
      {
        id: "li-1",
        label: "Acrylic sign",
        quantity: 1,
        materialId: "mat-acrylic-3mm",
      },
    ]);

    const result = await useCase().execute(draft, SUPERVISOR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const step of result.tentativeSteps) {
      expect(Object.isFrozen(step)).toBe(true);
    }
    expect(() => {
      (result.tentativeSteps[0] as any).label = "mutated";
    }).toThrow();
  });
});
