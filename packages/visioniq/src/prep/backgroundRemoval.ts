// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten, host generated types replaced with the structurally identical ones
// in core/prepSettings.ts, and `ImageData` annotations swapped for PixelBuffer —
// which ImageData satisfies structurally, so a browser host passes its own
// objects straight in.

export type RemovalMode = "auto" | "logo" | "remove_white" | "remove_dark";

export interface BackgroundRemovalOptions {
  mode: RemovalMode;
  strength: number;
  feather: number;
  expandContract: number;
}

export interface BackgroundRemovalResult {
  success: boolean;
  message: string;
  usedFallback?: boolean;
}

function isUxpEnvironment(): boolean {
  return typeof (globalThis as any).require === "function";
}

function getPhotoshopModules() {
  const r = (globalThis as any).require as (module: string) => any;
  const app = r("photoshop").app;
  const { executeAsModal } = r("photoshop").core;
  const { batchPlay } = r("photoshop").action;
  return { app, executeAsModal, batchPlay };
}

async function checkSelectSubjectAvailable(app: any): Promise<boolean> {
  try {
    const version = app.version as string;
    const major = parseInt(version.split(".")[0], 10);
    return major >= 21;
  } catch {
    return false;
  }
}

async function runSelectSubject(batchPlay: any): Promise<void> {
  await batchPlay(
    [{ _obj: "selectSubject", _options: { dialogOptions: "dontDisplay" } }],
    { synchronousExecution: true }
  );
}

async function runColorRangeSelection(
  batchPlay: any,
  mode: "remove_white" | "remove_dark",
  strength: number
): Promise<void> {
  const fuzziness = Math.round((strength / 100) * 200);
  const sampledColor =
    mode === "remove_white"
      ? { _obj: "RGBColor", red: 255, grain: 255, blue: 255 }
      : { _obj: "RGBColor", red: 0, grain: 0, blue: 0 };

  await batchPlay(
    [
      {
        _obj: "colorRange",
        using: { _enum: "colorRangeType", _value: "sampled" },
        fuzziness,
        sampledColor,
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    { synchronousExecution: true }
  );
}

async function runToleranceSelection(batchPlay: any, strength: number): Promise<void> {
  const tolerance = Math.round((strength / 100) * 255);
  await batchPlay(
    [
      {
        _obj: "set",
        _target: [{ _ref: "channel", _property: "selection" }],
        to: {
          _obj: "colorRange",
          using: { _enum: "colorRangeType", _value: "sampled" },
          fuzziness: tolerance,
          sampledColor: { _obj: "RGBColor", red: 255, grain: 255, blue: 255 },
        },
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    { synchronousExecution: true }
  );
}

async function applyFeatherToSelection(batchPlay: any, featherPx: number): Promise<void> {
  if (featherPx <= 0) return;
  await batchPlay(
    [{ _obj: "feather", radius: featherPx, _options: { dialogOptions: "dontDisplay" } }],
    { synchronousExecution: true }
  );
}

async function applyExpandContract(batchPlay: any, amount: number): Promise<void> {
  if (amount === 0) return;
  if (amount > 0) {
    await batchPlay(
      [
        {
          _obj: "expand",
          by: amount,
          selectionModifyEffect: { _enum: "selectionModifyEffectType", _value: "roundcorners" },
          _options: { dialogOptions: "dontDisplay" },
        },
      ],
      { synchronousExecution: true }
    );
  } else {
    await batchPlay(
      [
        {
          _obj: "contract",
          by: Math.abs(amount),
          selectionModifyEffect: { _enum: "selectionModifyEffectType", _value: "roundcorners" },
          _options: { dialogOptions: "dontDisplay" },
        },
      ],
      { synchronousExecution: true }
    );
  }
}

async function invertSelection(batchPlay: any): Promise<void> {
  await batchPlay(
    [{ _obj: "inverse", _options: { dialogOptions: "dontDisplay" } }],
    { synchronousExecution: true }
  );
}

async function addLayerMaskFromSelection(batchPlay: any): Promise<void> {
  await batchPlay(
    [
      {
        _obj: "make",
        _target: [{ _ref: "channel" }],
        at: { _ref: "channel", _enum: "channel", _value: "mask" },
        using: { _enum: "userMaskEnabled", _value: "revealSelection" },
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    { synchronousExecution: true }
  );
}

async function deselect(batchPlay: any): Promise<void> {
  await batchPlay(
    [
      {
        _obj: "set",
        _target: [{ _ref: "channel", _property: "selection" }],
        to: { _enum: "ordinal", _value: "none" },
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    { synchronousExecution: true }
  );
}

export async function removeBackgroundInModal(
  options: BackgroundRemovalOptions,
  app: any,
  batchPlay: any
): Promise<BackgroundRemovalResult> {
  let usedFallback = false;
  try {
    const doc = app.activeDocument;
    if (!doc) return { success: false, message: "No active document." };
    const originalLayer = doc.activeLayers[0];
    if (!originalLayer) return { success: false, message: "No active layer selected." };

    await batchPlay(
      [
        {
          _obj: "duplicate",
          _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
          _options: { dialogOptions: "dontDisplay" },
        },
      ],
      { synchronousExecution: true }
    );

    const duplicateLayer = doc.activeLayers[0];

    await batchPlay(
      [
        {
          _obj: "hide",
          null: [{ _ref: "layer", _id: originalLayer.id }],
          _options: { dialogOptions: "dontDisplay" },
        },
      ],
      { synchronousExecution: true }
    );

    doc.activeLayers[0] = duplicateLayer;

    if (options.mode === "auto") {
      const canUseSelectSubject = await checkSelectSubjectAvailable(app);
      if (canUseSelectSubject) {
        try {
          await runSelectSubject(batchPlay);
        } catch {
          usedFallback = true;
          await runColorRangeSelection(batchPlay, "remove_white", options.strength);
        }
      } else {
        usedFallback = true;
        await runColorRangeSelection(batchPlay, "remove_white", options.strength);
      }
    } else if (options.mode === "remove_white" || options.mode === "remove_dark") {
      await runColorRangeSelection(batchPlay, options.mode, options.strength);
    } else if (options.mode === "logo") {
      await runToleranceSelection(batchPlay, options.strength);
    }

    await invertSelection(batchPlay);
    if (options.feather > 0) await applyFeatherToSelection(batchPlay, options.feather);
    if (options.expandContract !== 0) await applyExpandContract(batchPlay, options.expandContract);
    await addLayerMaskFromSelection(batchPlay);
    await deselect(batchPlay);

    const fallbackMsg = usedFallback ? " Select Subject unavailable — used color-range fallback." : "";
    return { success: true, message: "Background removed successfully." + fallbackMsg, usedFallback };
  } catch (err: any) {
    return { success: false, message: err?.message ?? "Unknown background removal error." };
  }
}

export async function removeBackground(options: BackgroundRemovalOptions): Promise<BackgroundRemovalResult> {
  if (!isUxpEnvironment()) {
    await new Promise((r) => setTimeout(r, 800));
    return {
      success: true,
      message: `[Dev preview] Background removal simulated — mode: ${options.mode}, strength: ${options.strength}%, feather: ${options.feather}px. Run inside Photoshop to apply.`,
    };
  }

  const { app, executeAsModal, batchPlay } = getPhotoshopModules();

  if (!app.activeDocument) {
    return { success: false, message: "No active document. Please open a file in Photoshop first." };
  }

  let usedFallback = false;

  try {
    await executeAsModal(
      async () => {
        const doc = app.activeDocument;
        const originalLayer = doc.activeLayers[0];
        if (!originalLayer) throw new Error("No active layer selected.");

        await batchPlay(
          [
            {
              _obj: "duplicate",
              _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
              _options: { dialogOptions: "dontDisplay" },
            },
          ],
          { synchronousExecution: true }
        );

        const duplicateLayer = doc.activeLayers[0];

        await batchPlay(
          [
            {
              _obj: "hide",
              null: [{ _ref: "layer", _id: originalLayer.id }],
              _options: { dialogOptions: "dontDisplay" },
            },
          ],
          { synchronousExecution: true }
        );

        doc.activeLayers[0] = duplicateLayer;

        if (options.mode === "auto") {
          const canUseSelectSubject = await checkSelectSubjectAvailable(app);
          if (canUseSelectSubject) {
            try {
              await runSelectSubject(batchPlay);
            } catch {
              usedFallback = true;
              await runColorRangeSelection(batchPlay, "remove_white", options.strength);
            }
          } else {
            usedFallback = true;
            await runColorRangeSelection(batchPlay, "remove_white", options.strength);
          }
        } else if (options.mode === "remove_white" || options.mode === "remove_dark") {
          await runColorRangeSelection(batchPlay, options.mode, options.strength);
        } else if (options.mode === "logo") {
          await runToleranceSelection(batchPlay, options.strength);
        }

        await invertSelection(batchPlay);
        if (options.feather > 0) await applyFeatherToSelection(batchPlay, options.feather);
        if (options.expandContract !== 0) await applyExpandContract(batchPlay, options.expandContract);
        await addLayerMaskFromSelection(batchPlay);
        await deselect(batchPlay);
      },
      { commandName: "KSix: Remove Background" }
    );

    const fallbackMsg = usedFallback
      ? " Select Subject was not available — used color-range fallback instead."
      : "";
    return { success: true, message: `Background removed successfully.${fallbackMsg}`, usedFallback };
  } catch (err: any) {
    return { success: false, message: err?.message || "An unknown error occurred while removing the background." };
  }
}
