import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { productConfigurationSchema } from "../core/schemas/configuration.js";
import { productDefinitionSchema } from "../core/schemas/productDefinition.js";
import { machineProfileSpecsSchema } from "../core/schemas/machineProfile.js";
import { materialProfileSpecsSchema } from "../core/schemas/materialProfile.js";
import { computePrice, toPublicBreakdown } from "../core/pricing/pricingEngine.js";
import { runValidation } from "../core/validation/validationEngine.js";
import { generateConcepts } from "../core/ai/conceptService.js";
import { conceptBriefSchema, type AIProvider } from "../core/ai/types.js";
import { resolveMaterialProfileId } from "../core/resolve.js";
import { BuilderEngineStorage, type FiqDb } from "./storage.js";

export interface BuilderEngineRouterDeps {
  db: FiqDb;
  // Host-provided admin gate for the /admin/* surface — the engine has no
  // identity model of its own.
  adminMiddleware: RequestHandler;
  getOrgId: (req: Request) => number | Promise<number>;
  getUserId?: (req: Request) => number | null;
  // Optional AI provider for "Make it for me". Without one, the concepts
  // endpoint reports the feature as unconfigured rather than guessing.
  aiProvider?: AIProvider;
}

const priceRequestSchema = z.object({
  productDefinitionId: z.number().int().positive(),
  config: productConfigurationSchema,
});

const machineBodySchema = z.object({
  name: z.string().min(1),
  specs: machineProfileSpecsSchema,
});

const materialBodySchema = z.object({
  name: z.string().min(1),
  specs: materialProfileSpecsSchema,
});

export function createBuilderEngineRouter(deps: BuilderEngineRouterDeps): Router {
  const router = Router();
  const storage = new BuilderEngineStorage(deps.db);

  // Parse-or-400 helper. Returns undefined after responding on failure.
  // Generic over the schema (not the output) so .default()/.partial() schemas
  // with differing input/output types are accepted.
  function parse<S extends z.ZodTypeAny>(
    schema: S,
    body: unknown,
    res: { status: Function },
  ): z.output<S> | undefined {
    const result = schema.safeParse(body);
    if (!result.success) {
      (res as any).status(400).json({
        message: "Invalid request body",
        issues: result.error.flatten(),
      });
      return undefined;
    }
    return result.data;
  }

  // Loads the definition row + profiles for a price/validate/save request.
  async function loadContext(req: Request, res: any) {
    const body = parse(priceRequestSchema, req.body, res);
    if (!body) return undefined;
    const orgId = await deps.getOrgId(req);
    const product = await storage.getProductById(orgId, body.productDefinitionId);
    if (!product) {
      res.status(404).json({ message: "Product not found" });
      return undefined;
    }
    const profiles = await storage.getPricingProfiles(orgId, product.definition, body.config);
    return { orgId, product, config: body.config, ...profiles };
  }

  // ── Public ────────────────────────────────────────────────────────────────

  router.get("/products/:slug", async (req, res) => {
    const orgId = await deps.getOrgId(req);
    const product = await storage.getActiveProduct(orgId, req.params.slug);
    if (!product) return res.status(404).json({ message: "Product not found" });
    res.json({
      id: product.id,
      slug: product.slug,
      version: product.version,
      definition: product.definition,
    });
  });

  router.post("/price", async (req, res) => {
    const ctx = await loadContext(req, res);
    if (!ctx) return;
    const breakdown = computePrice({
      definition: ctx.product.definition,
      configuration: ctx.config,
      materials: ctx.materials,
      machine: ctx.machine,
    });
    res.json(toPublicBreakdown(breakdown));
  });

  router.post("/validate", async (req, res) => {
    const ctx = await loadContext(req, res);
    if (!ctx) return;
    res.json(
      runValidation({
        definition: ctx.product.definition,
        configuration: ctx.config,
        materials: ctx.materials,
        machine: ctx.machine,
        machines: ctx.machines,
      }),
    );
  });

  router.post("/configurations", async (req, res) => {
    const ctx = await loadContext(req, res);
    if (!ctx) return;
    const engineInput = {
      definition: ctx.product.definition,
      configuration: ctx.config,
      materials: ctx.materials,
      machine: ctx.machine,
    };
    const validation = runValidation({ ...engineInput, machines: ctx.machines });
    if (!validation.valid) {
      return res.status(422).json({
        message: "Configuration failed manufacturing validation",
        validation,
      });
    }
    const priceSnapshot = computePrice(engineInput);
    const row = await storage.saveConfiguration({
      orgId: ctx.orgId,
      product: ctx.product,
      config: ctx.config,
      priceSnapshot,
      validationSnapshot: validation,
      userId: deps.getUserId?.(req) ?? null,
    });
    res.status(201).json({
      id: row.id,
      customerPrice: priceSnapshot.customerPrice,
      price: toPublicBreakdown(priceSnapshot),
      validation,
    });
  });

  router.get("/configurations/:id", async (req, res) => {
    const orgId = await deps.getOrgId(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await storage.getConfiguration(orgId, id);
    if (!row) return res.status(404).json({ message: "Configuration not found" });
    res.json({
      id: row.id,
      productDefinitionId: row.productDefinitionId,
      productVersion: row.productVersion,
      status: row.status,
      config: row.config,
      price: row.priceSnapshot ? toPublicBreakdown(row.priceSnapshot) : null,
      validation: row.validationSnapshot,
    });
  });

  // "Make it for me" — a brief in, manufacturable priced concepts out.
  router.post("/concepts", async (req, res) => {
    if (!deps.aiProvider) {
      return res.status(503).json({
        message: "Automatic design generation is not configured for this shop.",
      });
    }
    const body = parse(
      z.object({
        productDefinitionId: z.number().int().positive(),
        brief: conceptBriefSchema,
        count: z.number().int().min(1).max(4).optional(),
      }),
      req.body,
      res,
    );
    if (!body) return;

    const orgId = await deps.getOrgId(req);
    const product = await storage.getProductById(orgId, body.productDefinitionId);
    if (!product) return res.status(404).json({ message: "Product not found" });

    // Profiles for the definition's defaults — concepts choose their own
    // options, but the prompt needs a representative material and machine.
    const seed = { selections: {}, surfaces: {}, quantity: 1 };
    const profiles = await storage.getPricingProfiles(orgId, product.definition, seed);
    const materialId = resolveMaterialProfileId(product.definition, seed);

    try {
      const result = await generateConcepts({
        definition: product.definition,
        materials: profiles.materials,
        machine: profiles.machine,
        material: materialId !== undefined ? profiles.materials.get(materialId) : undefined,
        brief: body.brief,
        provider: deps.aiProvider,
        count: body.count ?? 3,
      });
      res.json({
        provider: result.provider,
        productDefinitionId: product.id,
        concepts: result.concepts.map((c) => ({
          id: c.id,
          name: c.name,
          rationale: c.rationale,
          configuration: c.configuration,
          price: toPublicBreakdown(c.price),
          validation: c.validation,
          repairsApplied: c.repairsApplied,
        })),
        rejected: result.rejected,
      });
    } catch (err) {
      console.error("ForgeIQ concept generation failed:", err);
      res.status(502).json({
        message: "The design assistant could not produce concepts. Please try again.",
      });
    }
  });

  // ── Admin ─────────────────────────────────────────────────────────────────
  const admin = deps.adminMiddleware;

  router.get("/admin/machines", admin, async (req, res) => {
    res.json(await storage.listMachines(await deps.getOrgId(req)));
  });

  router.post("/admin/machines", admin, async (req, res) => {
    const body = parse(machineBodySchema, req.body, res);
    if (!body) return;
    res.status(201).json(
      await storage.createMachine(await deps.getOrgId(req), body.name, body.specs),
    );
  });

  router.patch("/admin/machines/:id", admin, async (req, res) => {
    const body = parse(machineBodySchema.partial().extend({ active: z.boolean().optional() }), req.body, res);
    if (!body) return;
    const row = await storage.updateMachine(await deps.getOrgId(req), Number(req.params.id), body);
    if (!row) return res.status(404).json({ message: "Machine not found" });
    res.json(row);
  });

  router.get("/admin/materials", admin, async (req, res) => {
    res.json(await storage.listMaterials(await deps.getOrgId(req)));
  });

  router.post("/admin/materials", admin, async (req, res) => {
    const body = parse(materialBodySchema, req.body, res);
    if (!body) return;
    res.status(201).json(
      await storage.createMaterial(await deps.getOrgId(req), body.name, body.specs),
    );
  });

  router.patch("/admin/materials/:id", admin, async (req, res) => {
    const body = parse(materialBodySchema.partial().extend({ active: z.boolean().optional() }), req.body, res);
    if (!body) return;
    const row = await storage.updateMaterial(await deps.getOrgId(req), Number(req.params.id), body);
    if (!row) return res.status(404).json({ message: "Material not found" });
    res.json(row);
  });

  router.get("/admin/products", admin, async (req, res) => {
    res.json(await storage.listProducts(await deps.getOrgId(req)));
  });

  // Publishing an existing slug auto-bumps the version and retires the old row.
  router.post("/admin/products", admin, async (req, res) => {
    const body = parse(productDefinitionSchema, req.body, res);
    if (!body) return;
    res.status(201).json(await storage.publishProduct(await deps.getOrgId(req), body));
  });

  router.patch("/admin/products/:id/status", admin, async (req, res) => {
    const body = parse(z.object({ status: z.enum(["draft", "active", "retired"]) }), req.body, res);
    if (!body) return;
    const row = await storage.setProductStatus(
      await deps.getOrgId(req),
      Number(req.params.id),
      body.status,
    );
    if (!row) return res.status(404).json({ message: "Product not found" });
    res.json(row);
  });

  // Full price snapshot including internal cost — admin only.
  router.get("/admin/configurations/:id/cost", admin, async (req, res) => {
    const row = await storage.getConfiguration(await deps.getOrgId(req), Number(req.params.id));
    if (!row) return res.status(404).json({ message: "Configuration not found" });
    res.json({ id: row.id, price: row.priceSnapshot, validation: row.validationSnapshot });
  });

  return router;
}
