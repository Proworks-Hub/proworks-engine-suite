import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ProductDefinition } from "../core/schemas/productDefinition";
import type { ProductConfiguration } from "../core/schemas/configuration";
import type { MachineProfileSpecs } from "../core/schemas/machineProfile";
import type { MaterialProfileSpecs } from "../core/schemas/materialProfile";
import type { PriceBreakdown } from "../core/pricing/pricingEngine";
import type { ValidationResult } from "../core/validation/types";
import {
  resolveMachineProfileId,
  resolveMaterialProfileId,
} from "../core/resolve";
import { productDefinitionSchema } from "../core/schemas/productDefinition";
import {
  fiqMachineProfiles,
  fiqMaterialProfiles,
  fiqOrganizations,
  fiqProductConfigurations,
  fiqProductDefinitions,
  type FiqProductDefinition,
} from "./schema";

// Any drizzle node-postgres database (host may have its own schema generics).
export type FiqDb = NodePgDatabase<Record<string, unknown>>;

export interface PricingProfiles {
  materials: Map<number, MaterialProfileSpecs>;
  machine: MachineProfileSpecs;
}

// Definitions are stored as jsonb and read back by cast, so rows written
// before a schema field existed come back missing it. Re-parsing on read
// applies the schema's defaults; a definition too old to parse is returned
// as-is rather than failing the order it belongs to.
function withSchemaDefaults<T extends { definition: ProductDefinition }>(row: T): T {
  const parsed = productDefinitionSchema.safeParse(row.definition);
  return parsed.success ? { ...row, definition: parsed.data } : row;
}

export class BuilderEngineStorage {
  constructor(private db: FiqDb) {}

  // ── Organizations ─────────────────────────────────────────────────────────
  async ensureOrganization(slug: string, name: string): Promise<number> {
    const existing = await this.db
      .select()
      .from(fiqOrganizations)
      .where(eq(fiqOrganizations.slug, slug));
    if (existing.length > 0) return existing[0].id;
    const [row] = await this.db
      .insert(fiqOrganizations)
      .values({ slug, name })
      .returning();
    return row.id;
  }

  // ── Machines ──────────────────────────────────────────────────────────────
  async listMachines(orgId: number) {
    return this.db
      .select()
      .from(fiqMachineProfiles)
      .where(eq(fiqMachineProfiles.orgId, orgId));
  }

  async getMachine(orgId: number, id: number) {
    const rows = await this.db
      .select()
      .from(fiqMachineProfiles)
      .where(and(eq(fiqMachineProfiles.id, id), eq(fiqMachineProfiles.orgId, orgId)));
    return rows[0];
  }

  async createMachine(orgId: number, name: string, specs: MachineProfileSpecs) {
    const [row] = await this.db
      .insert(fiqMachineProfiles)
      .values({ orgId, name, specs })
      .returning();
    return row;
  }

  async updateMachine(
    orgId: number,
    id: number,
    patch: Partial<{ name: string; specs: MachineProfileSpecs; active: boolean }>,
  ) {
    const [row] = await this.db
      .update(fiqMachineProfiles)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(fiqMachineProfiles.id, id), eq(fiqMachineProfiles.orgId, orgId)))
      .returning();
    return row;
  }

  // ── Materials ─────────────────────────────────────────────────────────────
  async listMaterials(orgId: number) {
    return this.db
      .select()
      .from(fiqMaterialProfiles)
      .where(eq(fiqMaterialProfiles.orgId, orgId));
  }

  async getMaterial(orgId: number, id: number) {
    const rows = await this.db
      .select()
      .from(fiqMaterialProfiles)
      .where(and(eq(fiqMaterialProfiles.id, id), eq(fiqMaterialProfiles.orgId, orgId)));
    return rows[0];
  }

  async createMaterial(orgId: number, name: string, specs: MaterialProfileSpecs) {
    const [row] = await this.db
      .insert(fiqMaterialProfiles)
      .values({ orgId, name, specs })
      .returning();
    return row;
  }

  async updateMaterial(
    orgId: number,
    id: number,
    patch: Partial<{ name: string; specs: MaterialProfileSpecs; active: boolean }>,
  ) {
    const [row] = await this.db
      .update(fiqMaterialProfiles)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(fiqMaterialProfiles.id, id), eq(fiqMaterialProfiles.orgId, orgId)))
      .returning();
    return row;
  }

  // ── Product definitions ───────────────────────────────────────────────────
  async listProducts(orgId: number) {
    return this.db
      .select()
      .from(fiqProductDefinitions)
      .where(eq(fiqProductDefinitions.orgId, orgId));
  }

  async getActiveProduct(orgId: number, slug: string) {
    const rows = await this.db
      .select()
      .from(fiqProductDefinitions)
      .where(
        and(
          eq(fiqProductDefinitions.orgId, orgId),
          eq(fiqProductDefinitions.slug, slug),
          eq(fiqProductDefinitions.status, "active"),
        ),
      );
    return rows[0] ? withSchemaDefaults(rows[0]) : rows[0];
  }

  async getProductById(orgId: number, id: number) {
    const rows = await this.db
      .select()
      .from(fiqProductDefinitions)
      .where(and(eq(fiqProductDefinitions.id, id), eq(fiqProductDefinitions.orgId, orgId)));
    return rows[0] ? withSchemaDefaults(rows[0]) : rows[0];
  }

  // Insert a new version and retire the previously active one.
  async publishProduct(orgId: number, definition: ProductDefinition) {
    const current = await this.getActiveProduct(orgId, definition.slug);
    const version = current ? current.version + 1 : 1;
    if (current) {
      await this.db
        .update(fiqProductDefinitions)
        .set({ status: "retired", updatedAt: new Date() })
        .where(eq(fiqProductDefinitions.id, current.id));
    }
    const [row] = await this.db
      .insert(fiqProductDefinitions)
      .values({ orgId, slug: definition.slug, version, status: "active", definition })
      .returning();
    return row;
  }

  async setProductStatus(orgId: number, id: number, status: "draft" | "active" | "retired") {
    const [row] = await this.db
      .update(fiqProductDefinitions)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(fiqProductDefinitions.id, id), eq(fiqProductDefinitions.orgId, orgId)))
      .returning();
    return row;
  }

  // ── Profile resolution for pricing/validation ─────────────────────────────
  // Loads every material referenced by the definition plus the machine the
  // configuration resolves to. Throws if the machine is missing.
  async getPricingProfiles(
    orgId: number,
    definition: ProductDefinition,
    configuration: ProductConfiguration,
  ): Promise<PricingProfiles> {
    const materialIds = new Set<number>(definition.allowedMaterialProfileIds);
    const selected = resolveMaterialProfileId(definition, configuration);
    if (selected !== undefined) materialIds.add(selected);

    const materials = new Map<number, MaterialProfileSpecs>();
    for (const id of materialIds) {
      const row = await this.getMaterial(orgId, id);
      if (row) materials.set(id, row.specs);
    }

    const machineId = resolveMachineProfileId(definition, configuration);
    const machineRow = await this.getMachine(orgId, machineId);
    if (!machineRow) {
      throw new Error(`Machine profile ${machineId} not found for organization ${orgId}`);
    }
    return { materials, machine: machineRow.specs };
  }

  // ── Configurations ────────────────────────────────────────────────────────
  async saveConfiguration(input: {
    orgId: number;
    product: FiqProductDefinition;
    config: ProductConfiguration;
    priceSnapshot: PriceBreakdown;
    validationSnapshot: ValidationResult;
    userId: number | null;
  }) {
    const [row] = await this.db
      .insert(fiqProductConfigurations)
      .values({
        orgId: input.orgId,
        productDefinitionId: input.product.id,
        productVersion: input.product.version,
        status: "draft",
        config: input.config,
        priceSnapshot: input.priceSnapshot,
        validationSnapshot: input.validationSnapshot,
        userId: input.userId,
      })
      .returning();
    return row;
  }

  // Host-trusted lookups (no org filter) — for server-side flows like
  // checkout verification where the host, not a request, is the caller.
  // Never expose these through request-scoped endpoints.
  async getConfigurationById(id: number) {
    const rows = await this.db
      .select()
      .from(fiqProductConfigurations)
      .where(eq(fiqProductConfigurations.id, id));
    return rows[0];
  }

  async setConfigurationStatusById(id: number, status: "draft" | "ordered") {
    const [row] = await this.db
      .update(fiqProductConfigurations)
      .set({ status, updatedAt: new Date() })
      .where(eq(fiqProductConfigurations.id, id))
      .returning();
    return row;
  }

  async getConfiguration(orgId: number, id: number) {
    const rows = await this.db
      .select()
      .from(fiqProductConfigurations)
      .where(
        and(eq(fiqProductConfigurations.id, id), eq(fiqProductConfigurations.orgId, orgId)),
      );
    return rows[0];
  }

  async setConfigurationStatus(orgId: number, id: number, status: "draft" | "ordered") {
    const [row] = await this.db
      .update(fiqProductConfigurations)
      .set({ status, updatedAt: new Date() })
      .where(
        and(eq(fiqProductConfigurations.id, id), eq(fiqProductConfigurations.orgId, orgId)),
      )
      .returning();
    return row;
  }
}
