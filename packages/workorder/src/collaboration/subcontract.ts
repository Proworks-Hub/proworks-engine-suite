// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type {
  CollaborationItem,
  CollaborationRequest,
  TraceContext,
} from "@proworks-hub/contracts";
import { validateCollaborationRequest } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Turning part of a work order into something another shop can be asked to do.
//
// The single design decision here: the request is built FIELD BY FIELD from an
// explicit selection, never derived by removing things from a work order.
//
// Subtractive filtering — take the record, delete the private bits — fails the
// same way every time. It is correct on the day it is written and wrong the
// first time somebody adds a field, because the new field is included by
// default and nobody remembers the filter exists. Additive construction fails
// the other way, which is the safe way: a newly added field simply does not
// cross until somebody decides it should.
// ─────────────────────────────────────────────────────────────────────────────

export interface SubcontractLineSelection {
  /** Which line of the work order is being sent out. */
  lineItemId: string;
  /**
   * How to describe it to the other shop.
   *
   * Written for them, not copied from the internal label. "DTF transfers,
   * 50x, left chest + full back" is useful; an internal SKU is not.
   */
  description: string;
  quantity: number;
  specifications?: Record<string, string>;
  /** Artifact references. The bytes travel separately. */
  fileRefs?: string[];
}

export interface SubcontractInput {
  collaborationId: string;
  from: { organizationId: string; displayName: string };
  toOrganizationId: string;
  /**
   * The originator's handle for this work. Opaque to the receiving shop, which
   * is the point: it correlates a reply without being a key into anything.
   */
  originatorRef: string;
  lines: readonly SubcontractLineSelection[];
  dueDate?: string;
  /** Instructions for the WORK. Shop notes are not instructions. */
  instructions?: string;
  trace: TraceContext;
  now?: () => Date;
}

/**
 * Builds a subcontract request.
 *
 * Takes a selection rather than a work order on purpose. Passing the work order
 * would put the whole record within reach of this function, and the next person
 * to edit it would have every private field one keystroke away.
 *
 * Validated before it is returned, so an unsafe request cannot be constructed
 * at all — not merely rejected later by whoever sends it.
 */
export function buildSubcontractRequest(input: SubcontractInput): CollaborationRequest {
  const now = input.now ?? (() => new Date());

  const items: CollaborationItem[] = input.lines.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    specifications: line.specifications ?? {},
    fileRefs: line.fileRefs ?? [],
  }));

  // Named field by field. Nothing here is spread from a larger object, and
  // that is deliberate — a spread is how a private field crosses without
  // anybody choosing to send it.
  return validateCollaborationRequest({
    requestVersion: 1,
    collaborationId: input.collaborationId,
    from: { organizationId: input.from.organizationId, displayName: input.from.displayName },
    to: { organizationId: input.toOrganizationId },
    originatorRef: input.originatorRef,
    items,
    ...(input.dueDate ? { dueDate: input.dueDate } : {}),
    ...(input.instructions ? { instructions: input.instructions } : {}),
    trace: input.trace,
    createdAt: now().toISOString(),
  });
}

/**
 * What the receiving shop is allowed to learn about the originator.
 *
 * Exists so a host rendering an inbox has one obvious thing to render, rather
 * than reaching into the request and deciding for itself what is safe.
 */
export interface SubcontractView {
  collaborationId: string;
  fromDisplayName: string;
  items: readonly CollaborationItem[];
  dueDate?: string;
  instructions?: string;
  receivedAt: string;
}

export function toSubcontractView(request: CollaborationRequest): SubcontractView {
  return {
    collaborationId: request.collaborationId,
    // A display name, never the organization id — the receiving shop has no
    // use for an identifier it cannot resolve, and giving it one invites
    // somebody to try.
    fromDisplayName: request.from.displayName,
    items: request.items,
    ...(request.dueDate ? { dueDate: request.dueDate } : {}),
    ...(request.instructions ? { instructions: request.instructions } : {}),
    receivedAt: request.createdAt,
  };
}
