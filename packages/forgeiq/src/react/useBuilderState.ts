import { useMemo, useReducer } from "react";
import type { ProductConfiguration, SurfaceElement } from "../core/schemas/configuration.js";
import type { ProductDefinition } from "../core/schemas/productDefinition.js";

export interface BuilderState {
  selections: Record<string, string>;
  surfaces: Record<string, SurfaceElement[]>;
  quantity: number;
  activeSurfaceId: string | null;
  selectedElementId: string | null;
}

export type BuilderAction =
  | { type: "SELECT_OPTION"; groupId: string; valueId: string }
  | { type: "SET_QUANTITY"; quantity: number }
  | { type: "SET_ACTIVE_SURFACE"; surfaceId: string }
  | { type: "SELECT_ELEMENT"; elementId: string | null }
  | { type: "ADD_ELEMENT"; surfaceId: string; element: SurfaceElement }
  | { type: "UPDATE_ELEMENT"; surfaceId: string; elementId: string; patch: Partial<SurfaceElement> }
  | { type: "REMOVE_ELEMENT"; surfaceId: string; elementId: string }
  // Wholesale replacement — used by automatic design repairs, which return a
  // whole configuration rather than a field-level patch.
  | { type: "REPLACE_CONFIG"; config: ProductConfiguration };

function reducer(state: BuilderState, action: BuilderAction): BuilderState {
  switch (action.type) {
    case "SELECT_OPTION":
      return {
        ...state,
        selections: { ...state.selections, [action.groupId]: action.valueId },
      };
    case "SET_QUANTITY":
      return { ...state, quantity: Math.max(1, Math.round(action.quantity)) };
    case "SET_ACTIVE_SURFACE":
      return { ...state, activeSurfaceId: action.surfaceId, selectedElementId: null };
    case "SELECT_ELEMENT":
      return { ...state, selectedElementId: action.elementId };
    case "ADD_ELEMENT":
      return {
        ...state,
        surfaces: {
          ...state.surfaces,
          [action.surfaceId]: [...(state.surfaces[action.surfaceId] ?? []), action.element],
        },
        selectedElementId: action.element.id,
      };
    case "UPDATE_ELEMENT":
      return {
        ...state,
        surfaces: {
          ...state.surfaces,
          [action.surfaceId]: (state.surfaces[action.surfaceId] ?? []).map((el) =>
            el.id === action.elementId ? ({ ...el, ...action.patch } as SurfaceElement) : el,
          ),
        },
      };
    case "REMOVE_ELEMENT":
      return {
        ...state,
        surfaces: {
          ...state.surfaces,
          [action.surfaceId]: (state.surfaces[action.surfaceId] ?? []).filter(
            (el) => el.id !== action.elementId,
          ),
        },
        selectedElementId:
          state.selectedElementId === action.elementId ? null : state.selectedElementId,
      };
    case "REPLACE_CONFIG":
      return {
        ...state,
        selections: action.config.selections,
        surfaces: action.config.surfaces,
        quantity: action.config.quantity,
      };
    default:
      return state;
  }
}

function initialState(definition: ProductDefinition): BuilderState {
  const selections: Record<string, string> = {};
  for (const group of definition.optionGroups) {
    const def = group.defaultValueId ?? group.values[0]?.id;
    if (def) selections[group.id] = def;
  }
  const firstEditable = definition.surfaces.find((s) => s.editable);
  return {
    selections,
    surfaces: {},
    quantity: 1,
    activeSurfaceId: firstEditable?.id ?? null,
    selectedElementId: null,
  };
}

export function useBuilderState(definition: ProductDefinition) {
  const [state, dispatch] = useReducer(reducer, definition, initialState);
  const config: ProductConfiguration = useMemo(
    () => ({
      selections: state.selections,
      surfaces: state.surfaces,
      quantity: state.quantity,
    }),
    [state.selections, state.surfaces, state.quantity],
  );
  return { state, dispatch, config };
}
