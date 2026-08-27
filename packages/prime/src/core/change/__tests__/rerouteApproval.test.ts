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

/**
 * PRIME Engine — reroute approval use case tests
 *
 * Covers mode branching (supervisor_required vs operator_allowed), role-based
 * auto-approval, pending → approved | rejected transitions, double-decision
 * guard, and field-level validation.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryEventLog } from "../../logging/inMemoryEventLog";
import type { EventLog } from "../../logging/eventLog";
import type { EventActor } from "../../../models/events";
import {
  createRerouteApprovalUseCase,
  type RerouteApprovalUseCase,
} from "../rerouteApprovalUseCase";
import {
  createStaticRerouteApprovalPolicy,
  type RequestRerouteApprovalInput,
} from "../rerouteApprovalTypes";

const OPERATOR: EventActor = { kind: "user", userId: "u-op", role: "operator" };
const SUPERVISOR: EventActor = { kind: "user", userId: "u-sup", role: "supervisor" };
const ADMIN: EventActor = { kind: "user", userId: "u-admin", role: "admin" };

const BASE_INPUT: RequestRerouteApprovalInput = {
  workOrderId: "wo-1",
  stepId: "step-1",
  fromStationId: "station-a",
  toStationId: "station-b",
  reason: "machine down",
  currentStepState: "ready",
  workstationClass: "cnc",
  requiredSkillTags: ["cnc-op"],
  requestedBy: "u-op",
};

function mkSeq(): () => string {
  let n = 0;
  return () => `ap-${++n}`;
}

function mkClock(): () => Date {
  let n = 0;
  return () => new Date(Date.UTC(2026, 3, 22, 12, 0, n++));
}

describe("createRerouteApprovalUseCase — request()", () => {
  let log: EventLog;
  let useCase: RerouteApprovalUseCase;

  describe("under operator_allowed mode", () => {
    beforeEach(() => {
      log = createInMemoryEventLog({ idGenerator: mkSeq(), clock: mkClock() });
      useCase = createRerouteApprovalUseCase({
        eventLog: log,
        policy: createStaticRerouteApprovalPolicy("operator_allowed"),
        idGenerator: mkSeq(),
        clock: mkClock(),
      });
    });

    it("auto-approves any actor and emits approval_approved", async () => {
      const res = await useCase.request(BASE_INPUT, OPERATOR);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.approval.status).toBe("auto_approved");
      expect(res.approval.mode).toBe("operator_allowed");
      expect(res.approval.reviewer).toBe("u-op");

      const events = await log.listByWorkOrder("wo-1");
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("work_order.reroute.approval_approved");
      const payload = events[0]?.payload as { autoApproved?: boolean; approvalId?: string };
      expect(payload.autoApproved).toBe(true);
      expect(payload.approvalId).toBe(res.approval.id);
    });
  });

  describe("under supervisor_required mode", () => {
    beforeEach(() => {
      log = createInMemoryEventLog({ idGenerator: mkSeq(), clock: mkClock() });
      useCase = createRerouteApprovalUseCase({
        eventLog: log,
        policy: createStaticRerouteApprovalPolicy("supervisor_required"),
        idGenerator: mkSeq(),
        clock: mkClock(),
      });
    });

    it("creates a pending request for operator actors", async () => {
      const res = await useCase.request(BASE_INPUT, OPERATOR);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.approval.status).toBe("pending");
      expect(res.approval.reviewer).toBeUndefined();
      expect(res.approval.decisionAt).toBeUndefined();

      const events = await log.listByWorkOrder("wo-1");
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("work_order.reroute.approval_requested");
      const payload = events[0]?.payload as { mode?: string };
      expect(payload.mode).toBe("supervisor_required");
    });

    it("auto-approves supervisor actors", async () => {
      const res = await useCase.request(BASE_INPUT, SUPERVISOR);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.approval.status).toBe("auto_approved");

      const events = await log.listByWorkOrder("wo-1");
      expect(events[0]?.type).toBe("work_order.reroute.approval_approved");
    });

    it("auto-approves admin actors", async () => {
      const res = await useCase.request(BASE_INPUT, ADMIN);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.approval.status).toBe("auto_approved");
    });

    it("creates pending for system actors (no role)", async () => {
      const res = await useCase.request(BASE_INPUT, {
        kind: "system",
        source: "prime.routing",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.approval.status).toBe("pending");
    });
  });

  describe("field validation", () => {
    beforeEach(() => {
      log = createInMemoryEventLog();
      useCase = createRerouteApprovalUseCase({
        eventLog: log,
        policy: createStaticRerouteApprovalPolicy("operator_allowed"),
      });
    });

    it("rejects equal from/to stations", async () => {
      const res = await useCase.request(
        { ...BASE_INPUT, toStationId: "station-a" },
        OPERATOR
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("invalid_command");
      expect(await log.size()).toBe(0);
    });

    it("rejects empty reason", async () => {
      const res = await useCase.request({ ...BASE_INPUT, reason: "  " }, OPERATOR);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("invalid_command");
    });
  });
});

describe("createRerouteApprovalUseCase — approve() / reject()", () => {
  let log: EventLog;
  let useCase: RerouteApprovalUseCase;

  beforeEach(() => {
    log = createInMemoryEventLog({ idGenerator: mkSeq(), clock: mkClock() });
    useCase = createRerouteApprovalUseCase({
      eventLog: log,
      policy: createStaticRerouteApprovalPolicy("supervisor_required"),
      idGenerator: mkSeq(),
      clock: mkClock(),
    });
  });

  it("transitions pending → approved and emits approval_approved", async () => {
    const req = await useCase.request(BASE_INPUT, OPERATOR);
    if (!req.ok) throw new Error("setup failed");

    const res = await useCase.approve(
      {
        approval: req.approval,
        reviewer: "u-sup",
        decisionNote: "ok with priority",
      },
      SUPERVISOR
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.approval.status).toBe("approved");
    expect(res.approval.reviewer).toBe("u-sup");
    expect(res.approval.decisionNote).toBe("ok with priority");
    expect(res.approval.decisionAt).toBeInstanceOf(Date);

    const events = await log.listByWorkOrder("wo-1");
    expect(events.map((e) => e.type)).toEqual([
      "work_order.reroute.approval_requested",
      "work_order.reroute.approval_approved",
    ]);
    const approved = events[1]?.payload as { autoApproved?: boolean };
    expect(approved.autoApproved).toBe(false);
  });

  it("transitions pending → rejected and emits approval_rejected", async () => {
    const req = await useCase.request(BASE_INPUT, OPERATOR);
    if (!req.ok) throw new Error("setup failed");

    const res = await useCase.reject(
      {
        approval: req.approval,
        reviewer: "u-sup",
        rejectionReason: "target station down",
      },
      SUPERVISOR
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.approval.status).toBe("rejected");
    expect(res.approval.rejectionReason).toBe("target station down");

    const events = await log.listByWorkOrder("wo-1");
    expect(events[1]?.type).toBe("work_order.reroute.approval_rejected");
  });

  it("rejects approve() on already-decided request", async () => {
    const req = await useCase.request(BASE_INPUT, OPERATOR);
    if (!req.ok) throw new Error("setup failed");

    const first = await useCase.approve(
      { approval: req.approval, reviewer: "u-sup" },
      SUPERVISOR
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await useCase.approve(
      { approval: first.approval, reviewer: "u-sup" },
      SUPERVISOR
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("already_decided");
  });

  it("requires a non-empty rejectionReason", async () => {
    const req = await useCase.request(BASE_INPUT, OPERATOR);
    if (!req.ok) throw new Error("setup failed");

    const res = await useCase.reject(
      { approval: req.approval, reviewer: "u-sup", rejectionReason: "  " },
      SUPERVISOR
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("missing_rejection_reason");

    // Original approval stays pending since the reject failed.
    const events = await log.listByWorkOrder("wo-1");
    expect(events.map((e) => e.type)).toEqual([
      "work_order.reroute.approval_requested",
    ]);
  });
});
