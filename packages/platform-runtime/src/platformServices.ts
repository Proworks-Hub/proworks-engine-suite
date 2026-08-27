// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type {
  Artifact,
  ArtifactStore,
  Cache,
  FeatureFlag,
  FeatureFlags,
  Notification,
  Notifier,
  Span,
  SpanAttributes,
  SpanKind,
  SpanStatus,
  StartSpanOptions,
  Tracer,
} from "@proworks-hub/contracts";
import { featureFlagSchema } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// In-memory bindings for the shared platform services.
//
// Each is small on purpose. The value is the PORT — one cache, one flag
// evaluator, one artifact store across the ecosystem instead of five — and the
// implementation is whatever a host wants behind it.
// ─────────────────────────────────────────────────────────────────────────────

const randomId = (prefix: string): string => {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  return typeof g.crypto?.randomUUID === "function"
    ? `${prefix}_${g.crypto.randomUUID()}`
    : `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

// ── Cache ────────────────────────────────────────────────────────────────────

interface Entry {
  value: unknown;
  expiresAt?: number;
}

export interface InMemoryCache extends Cache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs?: number): void;
  delete(key: string): void;
  deleteByPrefix(prefix: string): number;
  size(): number;
  clear(): void;
  /** Hit rate, for deciding whether a cache is earning its keep. */
  stats(): { hits: number; misses: number };
}

export function createInMemoryCache(options: { now?: () => number } = {}): InMemoryCache {
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();
  let hits = 0;
  let misses = 0;

  const live = (entry: Entry): boolean => !entry.expiresAt || entry.expiresAt > now();

  return {
    get<T>(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry || !live(entry)) {
        // Expired entries are dropped on read rather than swept. A sweep needs
        // a timer, and a timer in a library is a handle a host cannot see.
        if (entry) entries.delete(key);
        misses += 1;
        return undefined;
      }
      hits += 1;
      return entry.value as T;
    },
    set<T>(key: string, value: T, ttlMs?: number): void {
      entries.set(key, { value, ...(ttlMs ? { expiresAt: now() + ttlMs } : {}) });
    },
    delete(key) {
      entries.delete(key);
    },
    deleteByPrefix(prefix) {
      let removed = 0;
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) {
          entries.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    size: () => entries.size,
    clear: () => entries.clear(),
    stats: () => ({ hits, misses }),
  };
}

// ── Feature flags ────────────────────────────────────────────────────────────

export interface InMemoryFeatureFlags extends FeatureFlags {
  isEnabled(key: string, tenant?: { organizationId: string }): boolean;
  list(): FeatureFlag[];
  set(flag: FeatureFlag): void;
  enableFor(key: string, organizationId: string): void;
  disableFor(key: string, organizationId: string): void;
}

export function createInMemoryFeatureFlags(initial: FeatureFlag[] = []): InMemoryFeatureFlags {
  const flags = new Map<string, FeatureFlag>(
    initial.map((f) => [f.key, featureFlagSchema.parse(f)]),
  );

  const ensure = (key: string): FeatureFlag => {
    const existing = flags.get(key);
    if (existing) return existing;
    const fresh = featureFlagSchema.parse({ key });
    flags.set(key, fresh);
    return fresh;
  };

  return {
    isEnabled(key, tenant) {
      const flag = flags.get(key);
      // An unknown flag is OFF. Defaulting on means a typo in a flag name
      // silently ships an unfinished capability.
      if (!flag) return false;
      if (!tenant) return flag.enabledByDefault;
      // An explicit disable wins over everything, including the default — it is
      // how you turn something off for one shop in a hurry.
      if (flag.disabledFor.includes(tenant.organizationId)) return false;
      if (flag.enabledFor.includes(tenant.organizationId)) return true;
      return flag.enabledByDefault;
    },
    list: () => [...flags.values()],
    set(flag) {
      flags.set(flag.key, featureFlagSchema.parse(flag));
    },
    enableFor(key, organizationId) {
      const flag = ensure(key);
      flags.set(key, {
        ...flag,
        enabledFor: [...new Set([...flag.enabledFor, organizationId])],
        disabledFor: flag.disabledFor.filter((o) => o !== organizationId),
      });
    },
    disableFor(key, organizationId) {
      const flag = ensure(key);
      flags.set(key, {
        ...flag,
        disabledFor: [...new Set([...flag.disabledFor, organizationId])],
        enabledFor: flag.enabledFor.filter((o) => o !== organizationId),
      });
    },
  };
}

// ── Artifacts ────────────────────────────────────────────────────────────────

export interface InMemoryArtifactStore extends ArtifactStore {
  put(input: Parameters<ArtifactStore["put"]>[0]): Artifact;
  get(artifactId: string): Artifact | null;
  read(artifactId: string): Uint8Array | null;
  delete(artifactId: string): void;
  listBySource(sourceEngine: string, sourceEntityId: string): Artifact[];
  size(): number;
  totalBytes(): number;
}

/**
 * A content hash that needs no crypto import.
 *
 * FNV-1a: not cryptographic, and not pretending to be. Its job here is
 * recognising that two uploads are the same bytes, so a re-uploaded receipt
 * does not become a second artifact. A host storing anything security-sensitive
 * binds a real store with a real digest.
 */
function checksumOf(data: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of data) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}-${data.length}`;
}

export function createInMemoryArtifactStore(options: { now?: () => Date } = {}): InMemoryArtifactStore {
  const now = options.now ?? (() => new Date());
  const meta = new Map<string, Artifact>();
  const bytes = new Map<string, Uint8Array>();

  return {
    put(input) {
      const checksum = checksumOf(input.data);
      // Identical bytes from the same source are the same artifact. Storing a
      // second copy is how a receipt scanned twice doubles a shop's storage.
      const existing = [...meta.values()].find(
        (a) => a.checksum === checksum && a.sourceEntityId === input.sourceEntityId,
      );
      if (existing) return existing;

      const artifactId = randomId("art");
      const artifact: Artifact = {
        artifactId,
        ...(input.tenant ? { tenant: input.tenant } : {}),
        artifactType: input.artifactType,
        contentType: input.contentType,
        sizeBytes: input.data.length,
        checksum,
        storageLocation: `memory://${artifactId}`,
        ...(input.sourceEngine ? { sourceEngine: input.sourceEngine } : {}),
        ...(input.sourceEntityId ? { sourceEntityId: input.sourceEntityId } : {}),
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
        createdAt: now().toISOString(),
      };
      meta.set(artifactId, artifact);
      bytes.set(artifactId, input.data.slice());
      return artifact;
    },

    get: (artifactId) => meta.get(artifactId) ?? null,
    read: (artifactId) => bytes.get(artifactId) ?? null,
    delete(artifactId) {
      meta.delete(artifactId);
      bytes.delete(artifactId);
    },
    listBySource: (sourceEngine, sourceEntityId) =>
      [...meta.values()].filter(
        (a) => a.sourceEngine === sourceEngine && a.sourceEntityId === sourceEntityId,
      ),

    size: () => meta.size,
    totalBytes: () => [...bytes.values()].reduce((sum, b) => sum + b.length, 0),
  };
}

// ── Notifications ────────────────────────────────────────────────────────────

export interface InMemoryNotifier extends Notifier {
  notify(notification: Omit<Notification, "notificationId" | "createdAt">): Notification;
  all(): Notification[];
  forTenant(organizationId: string): Notification[];
  clear(): void;
}

export function createInMemoryNotifier(options: { now?: () => Date } = {}): InMemoryNotifier {
  const now = options.now ?? (() => new Date());
  const sent: Notification[] = [];

  return {
    notify(input) {
      const notification: Notification = {
        ...input,
        notificationId: randomId("ntf"),
        createdAt: now().toISOString(),
      };
      sent.push(notification);
      return notification;
    },
    all: () => [...sent],
    // Scoped by tenant on the way out. A notifier that can return another
    // organization's messages is a leak wearing a helpful interface.
    forTenant: (organizationId) => sent.filter((n) => n.tenant.organizationId === organizationId),
    clear: () => {
      sent.length = 0;
    },
  };
}

// ── Tracing ──────────────────────────────────────────────────────────────────

export interface RecordedSpan {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  attributes: SpanAttributes;
  events: Array<{ name: string; attributes?: SpanAttributes; at: number }>;
  status: SpanStatus;
  statusMessage?: string;
  exception?: { name: string; message: string };
  startedAt: number;
  endedAt?: number;
}

export interface InMemoryTracer extends Tracer {
  spans(): RecordedSpan[];
  /** Every span in one trace, oldest first — the shape a waterfall is drawn from. */
  trace(traceId: string): RecordedSpan[];
  clear(): void;
}

const hex = (length: number): string =>
  Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("");

export function createInMemoryTracer(options: { now?: () => number } = {}): InMemoryTracer {
  const now = options.now ?? (() => Date.now());
  const recorded: RecordedSpan[] = [];

  return {
    startSpan(name: string, spanOptions: StartSpanOptions = {}): Span {
      const traceId = spanOptions.parent?.traceId ?? hex(32);
      const spanId = hex(16);
      const record: RecordedSpan = {
        spanId,
        traceId,
        ...(spanOptions.parent?.spanId ? { parentSpanId: spanOptions.parent.spanId } : {}),
        name,
        kind: spanOptions.kind ?? "internal",
        attributes: { ...spanOptions.attributes },
        events: [],
        status: "unset",
        startedAt: now(),
      };
      recorded.push(record);

      const correlationId = spanOptions.parent?.correlationId ?? traceId;

      return {
        spanId,
        traceId,
        ...(record.parentSpanId ? { parentSpanId: record.parentSpanId } : {}),
        name,
        kind: record.kind,
        setAttribute: (key, value) => {
          record.attributes[key] = value;
        },
        addEvent: (eventName, attributes) => {
          record.events.push({ name: eventName, ...(attributes ? { attributes } : {}), at: now() });
        },
        setStatus: (status, message) => {
          record.status = status;
          if (message) record.statusMessage = message;
        },
        recordException: (error) => {
          record.exception = { name: error.name, message: error.message };
        },
        end: () => {
          // Idempotent: withSpan ends in a finally, and a caller who also ends
          // explicitly should not corrupt the duration.
          record.endedAt ??= now();
        },
        context: () => ({ correlationId, traceId, spanId }),
      };
    },

    spans: () => [...recorded],
    trace: (traceId) => recorded.filter((s) => s.traceId === traceId).sort((a, b) => a.startedAt - b.startedAt),
    clear: () => {
      recorded.length = 0;
    },
  };
}
