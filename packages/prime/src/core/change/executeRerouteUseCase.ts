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
 * PRIME Engine — executeReroute use case
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.6.
 *
 * Mid-flight reroute of an already-routed step to a different station.
 * Valid only while the step is in a "reroutable" state (ready / paused /
 * blocked). In-progress and completed steps require a rework cycle
 * (Task Flow §3.5 `log_rework`), not a reroute.
 *
 * The use case:
 *   1. Verifies the step is reroutable given its current task-flow state.
 *   2. Fetches the target station through the `StationRegistry` port (reuses
 *      the routing module's port so eligibility rules stay in one place).
 *   3. Validates the target station:
 *        - exists
 *        - matches workstation class
 *        - carries every `requiredSkillTag`
 *        - is not `down` or `maintenance`
 *   4. On failure: returns `{ ok: false, error }` and emits NO event.
 *   5. On success: emits exactly one `work_order.reroute.executed` event
 *      and returns a `RerouteResult` with from/to station ids.
 *
 * Stateless — the caller is responsible for updating the `RoutedStep`
 * record / schedule projection. The use case only validates + emits.
 */

import type {
  EventActor,
  WorkOrderStepId,
} from "../../models/events";
import type { EventLog } from "../logging/eventLog";
import type {
  StationId,
  StationRegistry,
} from "../routing/routingTypes";
import type {
  ChangeError,
  ExecuteRerouteInput,
  RerouteableStepState,
  RerouteExecutedPayload,
} from "./changeOrderTypes";

// ---------- Public surface ----------

export interface RerouteSuccess {
  readonly stepId: WorkOrderStepId;
  readonly fromStationId: StationId;
  readonly toStationId: StationId;
  readonly stepStateAtReroute: RerouteableStepState;
}

export type ExecuteRerouteResult =
  | { readonly ok: true; readonly reroute: RerouteSuccess }
  | { readonly ok: false; readonly error: ChangeError };

export interface ExecuteRerouteUseCaseDeps {
  readonly eventLog: EventLog;
  readonly stationRegistry: StationRegistry;
}

export interface ExecuteRerouteUseCase {
  execute(
    input: ExecuteRerouteInput,
    actor: EventActor
  ): Promise<ExecuteRerouteResult>;
}

// ---------- Factory ----------

const REROUTEABLE_STATES: ReadonlySet<RerouteableStepState> = new Set([
  "ready",
  "paused",
  "blocked",
]);

export function createExecuteRerouteUseCase(
  deps: ExecuteRerouteUseCaseDeps
): ExecuteRerouteUseCase {
  const { eventLog, stationRegistry } = deps;

  return {
    async execute(input, actor) {
      // ---- Field validation ----
      const fieldError = validateFields(input);
      if (fieldError) {
        return { ok: false, error: fieldError };
      }

      // ---- State machine guard ----
      if (!REROUTEABLE_STATES.has(input.currentStepState)) {
        return {
          ok: false,
          error: {
            code: "step_not_reroutable",
            message: `Step '${input.stepId}' is in state '${input.currentStepState}'; reroute requires ready | paused | blocked`,
          },
        };
      }

      // ---- Target station lookup & eligibility ----
      const target = await stationRegistry.getById(input.toStationId);
      if (!target) {
        return {
          ok: false,
          error: {
            code: "station_not_found",
            message: `Target station '${input.toStationId}' not found in registry`,
          },
        };
      }

      const eligibilityError = checkEligibility(target, input);
      if (eligibilityError) {
        return { ok: false, error: eligibilityError };
      }

      // ---- Emit event ----
      await eventLog.append<RerouteExecutedPayload>({
        workOrderId: input.workOrderId,
        stepId: input.stepId,
        type: "work_order.reroute.executed",
        actor,
        payload: {
          stepId: input.stepId,
          fromStationId: input.fromStationId,
          toStationId: input.toStationId,
          reason: input.reason,
          stepStateAtReroute: input.currentStepState,
        },
      });

      return {
        ok: true,
        reroute: Object.freeze({
          stepId: input.stepId,
          fromStationId: input.fromStationId,
          toStationId: input.toStationId,
          stepStateAtReroute: input.currentStepState,
        }),
      };
    },
  };
}

// ---------- Helpers ----------

function validateFields(input: ExecuteRerouteInput): ChangeError | null {
  if (!input.workOrderId || input.workOrderId.trim().length === 0) {
    return {
      code: "invalid_command",
      message: "reroute: workOrderId must be a non-empty string",
    };
  }
  if (!input.stepId || input.stepId.trim().length === 0) {
    return {
      code: "invalid_command",
      message: "reroute: stepId must be a non-empty string",
    };
  }
  if (!input.fromStationId || input.fromStationId.trim().length === 0) {
    return {
      code: "invalid_command",
      message: "reroute: fromStationId must be a non-empty string",
    };
  }
  if (!input.toStationId || input.toStationId.trim().length === 0) {
    return {
      code: "invalid_command",
      message: "reroute: toStationId must be a non-empty string",
    };
  }
  if (input.fromStationId === input.toStationId) {
    return {
      code: "invalid_command",
      message: "reroute: toStationId must differ from fromStationId",
    };
  }
  if (!input.reason || input.reason.trim().length === 0) {
    return {
      code: "invalid_command",
      message: "reroute: reason must be a non-empty string",
    };
  }
  if (!input.workstationClass || input.workstationClass.trim().length === 0) {
    return {
      code: "invalid_command",
      message: "reroute: workstationClass must be a non-empty string",
    };
  }
  return null;
}

function checkEligibility(
  target: {
    readonly workstationClass: string;
    readonly availableSkillTags: ReadonlyArray<string>;
    readonly status: string;
  },
  input: ExecuteRerouteInput
): ChangeError | null {
  if (target.workstationClass !== input.workstationClass) {
    return {
      code: "station_not_eligible",
      message: `Target station '${input.toStationId}' has class '${target.workstationClass}', expected '${input.workstationClass}'`,
    };
  }
  if (target.status === "down" || target.status === "maintenance") {
    return {
      code: "station_not_eligible",
      message: `Target station '${input.toStationId}' status is '${target.status}'`,
    };
  }
  for (const tag of input.requiredSkillTags) {
    if (!target.availableSkillTags.includes(tag)) {
      return {
        code: "station_not_eligible",
        message: `Target station '${input.toStationId}' is missing required skill '${tag}'`,
      };
    }
  }
  return null;
}
