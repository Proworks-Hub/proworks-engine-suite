import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import type { ProductDefinition } from "../core/schemas/productDefinition";
import type { ProductConfiguration } from "../core/schemas/configuration";
import type { MachineProfileSpecs } from "../core/schemas/machineProfile";
import type { MaterialProfileSpecs } from "../core/schemas/materialProfile";
import type { PriceBreakdown } from "../core/pricing/pricingEngine";
import type { ValidationResult } from "../core/validation/types";

// ForgeIQ Engine tables. All rows belong to an organization (tenant); the
// host app is one org. Identity/filter fields are real columns; everything
// the engines consume is zod-validated jsonb.

export const fiqOrganizations = pgTable("fiq_organizations", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  name: text("name").notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const fiqMachineProfiles = pgTable("fiq_machine_profiles", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id")
    .notNull()
    .references(() => fiqOrganizations.id),
  name: text("name").notNull(),
  specs: jsonb("specs").$type<MachineProfileSpecs>().notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const fiqMaterialProfiles = pgTable("fiq_material_profiles", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id")
    .notNull()
    .references(() => fiqOrganizations.id),
  name: text("name").notNull(),
  specs: jsonb("specs").$type<MaterialProfileSpecs>().notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Product definitions are immutable per version: an edit inserts version+1 as
// "active" and retires the old row. Configurations pin the exact versioned row.
export const fiqProductDefinitions = pgTable(
  "fiq_product_definitions",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => fiqOrganizations.id),
    slug: varchar("slug", { length: 64 }).notNull(),
    version: integer("version").notNull().default(1),
    // "draft" | "active" | "retired" — at most one active row per (org, slug)
    status: varchar("status", { length: 16 }).notNull().default("active"),
    definition: jsonb("definition").$type<ProductDefinition>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("fiq_product_def_org_slug_version").on(t.orgId, t.slug, t.version)],
);

export const fiqProductConfigurations = pgTable("fiq_product_configurations", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id")
    .notNull()
    .references(() => fiqOrganizations.id),
  productDefinitionId: integer("product_definition_id")
    .notNull()
    .references(() => fiqProductDefinitions.id),
  productVersion: integer("product_version").notNull(), // denormalized for queries
  status: varchar("status", { length: 16 }).notNull().default("draft"), // draft | ordered
  config: jsonb("config").$type<ProductConfiguration>().notNull(),
  // Full breakdown including internal cost — public reads must strip it.
  priceSnapshot: jsonb("price_snapshot").$type<PriceBreakdown>(),
  validationSnapshot: jsonb("validation_snapshot").$type<ValidationResult>(),
  // Host-app user id, plain int by design — no FK into host tables.
  userId: integer("user_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type FiqOrganization = typeof fiqOrganizations.$inferSelect;
export type FiqMachineProfile = typeof fiqMachineProfiles.$inferSelect;
export type FiqMaterialProfile = typeof fiqMaterialProfiles.$inferSelect;
export type FiqProductDefinition = typeof fiqProductDefinitions.$inferSelect;
export type FiqProductConfiguration = typeof fiqProductConfigurations.$inferSelect;
