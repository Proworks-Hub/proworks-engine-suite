// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  CAPABILITIES,
  CapabilityError,
  acceptCommand,
  rejectCommand,
  requireCapability,
  type CapabilityResolver,
  type CommandEnvelope,
  type CommandResult,
} from "@proworks-hub/contracts";

import type { EventActor } from "../models/events.js";

// ─────────────────────────────────────────────────────────────────────────────
// The one door into WorkOrderIQ's mutations.
//
// Every use case in this engine already has the same shape —
// `execute(input, actor)` returning ok/error — so the dispatcher does not need
// to know what any of them do. It enforces what must be true of every
// mutation and delegates. That is the entire job, and keeping it that small is
// what stops it becoming a second place where domain logic lives.
//
// WHAT IT DOES NOT DO: validate payloads. Each use case already validates its
// own input against rules only it knows, and a dispatcher that re-validated
// would be a second copy of those rules, drifting.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every mutation this engine accepts.
 *
 * Named for the intent rather than the use case, because the caller is stating
 * what it wants, not selecting an implementation.
 */
export const WORK_ORDER_COMMANDS = [
  "work_order.create",
  "work_order.resolve_template",
  "work_order.route_steps",
  "work_order.assign_priority",
  "work_order.advance_step",
  "work_order.advance_milestone",
  "work_order.request_change",
  "work_order.approve_reroute",
  "work_order.execute_reroute",
  "work_order.terminate",
] as const;

export type WorkOrderCommandType = (typeof WORK_ORDER_COMMANDS)[number];

/**
 * What a consumer must hold to issue each command.
 *
 * This is §49's basic-versus-advanced split made real on the write side, and
 * the tiers are not arbitrary. A shop with `workorder.basic` can create a work
 * order, resolve a template, and mark it done — the whole of a small shop's
 * needs, and exactly what MakerOps is meant to get without ProWorks. Routing,
 * scheduling and floor operations each require the capability named after
 * them, so the entitlement a customer bought is the entitlement enforced.
 */
export const COMMAND_CAPABILITY: Readonly<Record<WorkOrderCommandType, string>> =
  Object.freeze({
    "work_order.create": CAPABILITIES.workOrder.basic,
    "work_order.resolve_template": CAPABILITIES.workOrder.basic,
    "work_order.terminate": CAPABILITIES.workOrder.basic,
    "work_order.request_change": CAPABILITIES.workOrder.digital,
    "work_order.advance_step": CAPABILITIES.workOrder.productionTracking,
    "work_order.advance_milestone": CAPABILITIES.workOrder.productionTracking,
    "work_order.route_steps": CAPABILITIES.workOrder.routing,
    "work_order.approve_reroute": CAPABILITIES.workOrder.routing,
    "work_order.execute_reroute": CAPABILITIES.workOrder.routing,
    "work_order.assign_priority": CAPABILITIES.workOrder.scheduling,
  });

/** The shape every use case in this engine already has. */
export interface CommandHandler {
  execute(input: never, actor: EventActor): Promise<unknown>;
}

/**
 * What a deployment has wired.
 *
 * Partial on purpose. A host that has not built rerouting has not wired the
 * reroute handlers, and the dispatcher refuses those commands as
 * `unsupported` — which is honest, and different from refusing them as
 * `not_entitled`. Conflating the two makes a missing feature look like a
 * billing problem.
 */
export type WorkOrderCommandHandlers = Partial<
  Record<WorkOrderCommandType, CommandHandler>
>;

export interface WorkOrderCommandDispatcherDeps {
  readonly handlers: WorkOrderCommandHandlers;
  /**
   * Absent, EVERY command is refused as `not_entitled`.
   *
   * Fails closed. The alternative — allowing everything when no resolver is
   * configured — means a deployment that forgot to wire entitlements is a
   * deployment with no entitlements, and nothing about its behaviour would
   * reveal that.
   */
  readonly capabilities?: CapabilityResolver;
  /**
   * The consuming application, for the capability lookup.
   *
   * REQUIRED, deliberately. It defaulted to "proworks", which meant a MakerOps
   * host that forgot to pass it had its entitlements looked up under a product
   * it does not run — refused silently, or matched against a grant belonging to
   * a different application. A default that names one host is the coupling this
   * architecture exists to avoid; an omission should fail loudly instead.
   */
  readonly application: string;
  /** Observed for every command, accepted or refused. */
  readonly onDispatch?: (record: DispatchRecord) => void;
}

export interface DispatchRecord {
  readonly commandId: string;
  readonly type: WorkOrderCommandType;
  readonly organizationId: string;
  readonly correlationId: string;
  readonly outcome: "accepted" | "refused";
  readonly refusal?: string;
}

export interface WorkOrderCommandDispatcher {
  dispatch(
    command: CommandEnvelope<WorkOrderCommandType, unknown>,
    actor: EventActor,
  ): Promise<CommandResult<unknown>>;
}

export function createWorkOrderCommandDispatcher(
  deps: WorkOrderCommandDispatcherDeps,
): WorkOrderCommandDispatcher {
  const application = deps.application;

  const record = (
    command: CommandEnvelope<WorkOrderCommandType, unknown>,
    outcome: "accepted" | "refused",
    refusal?: string,
  ): void =>
    deps.onDispatch?.({
      commandId: command.commandId,
      type: command.type,
      organizationId: command.organizationId,
      correlationId: command.trace.correlationId,
      outcome,
      ...(refusal ? { refusal } : {}),
    });

  return {
    async dispatch(command, actor) {
      const capability = COMMAND_CAPABILITY[command.type];
      if (!capability) {
        record(command, "refused", "unsupported");
        return rejectCommand("unsupported", `unknown command "${command.type}"`);
      }

      if (!deps.capabilities) {
        record(command, "refused", "not_entitled");
        return rejectCommand(
          "not_entitled",
          "no capability resolver is configured; every command is refused",
        );
      }

      try {
        await requireCapability(
          deps.capabilities,
          command.organizationId,
          application,
          capability,
        );
      } catch (error) {
        record(command, "refused", "not_entitled");
        return rejectCommand(
          "not_entitled",
          error instanceof CapabilityError
            ? error.message
            : `"${command.type}" requires ${capability}`,
          { capability },
        );
      }

      const handler = deps.handlers[command.type];
      if (!handler) {
        // Distinct from not_entitled on purpose: this deployment does not
        // implement the command, which is not the caller's fault or bill.
        record(command, "refused", "unsupported");
        return rejectCommand(
          "unsupported",
          `"${command.type}" is not wired in this deployment`,
        );
      }

      const result = (await handler.execute(command.payload as never, actor)) as
        | { ok: true }
        | { ok: false; error?: unknown };

      // The use cases already speak ok/error. Their failures are domain
      // outcomes — a step that cannot advance from where it is — so they map
      // to `conflict` rather than being raised.
      if (result && typeof result === "object" && "ok" in result && result.ok === false) {
        record(command, "refused", "conflict");
        return rejectCommand(
          "conflict",
          `"${command.type}" was rejected by the domain`,
          (result as { error?: unknown }).error,
        );
      }

      record(command, "accepted");
      return acceptCommand(result);
    },
  };
}

/** True when `type` is a command this engine knows, for narrowing at a boundary. */
export function isWorkOrderCommandType(type: string): type is WorkOrderCommandType {
  return (WORK_ORDER_COMMANDS as ReadonlyArray<string>).includes(type);
}
