// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Whether anything is allowed to move.
//
// Two switches, kept separate because they mean different things and the scenes
// respond to them differently:
//
//   PAUSED is a deliberate act. Somebody is reading a number and wants the
//   movement to stop. The scene FREEZES where it is — nothing is redrawn,
//   nothing rearranges. Rebuilding the picture under someone's cursor is the
//   opposite of what they asked for.
//
//   REDUCED MOTION is a standing preference, and for some people motion is
//   nausea rather than distraction. The scene renders its STATIC form: no
//   rotation, no pulsing, no travelling particles — and the information those
//   conveyed is shown another way, never simply dropped. A console that goes
//   blank under `prefers-reduced-motion` has told that operator to use a
//   different tool.
// ─────────────────────────────────────────────────────────────────────────────

export interface MotionState {
  /** An operator pressed pause. */
  readonly paused: boolean;
  /** The system asked for reduced motion. */
  readonly reducedMotion: boolean;
  /** Convenience: neither is set, so animation may run. */
  readonly animate: boolean;
  setPaused(paused: boolean): void;
  togglePaused(): void;
}

const MotionContext = createContext<MotionState>({
  paused: false,
  reducedMotion: false,
  animate: true,
  setPaused: () => {},
  togglePaused: () => {},
});

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Reads the preference and keeps reading it.
 *
 * Live, not read-once: an operator who turns reduced motion on partway through
 * an incident should not have to reload the console to get it. Guarded for
 * environments with no `matchMedia` — the components are rendered in tests and
 * could be server-rendered, and neither has one.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(QUERY);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    setReduced(media.matches);

    // Safari below 14 has no addEventListener here. The console should work in
    // whatever browser is open during an incident.
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, []);

  return reduced;
}

export interface MotionProviderProps {
  children: ReactNode;
  /** Starts paused. Useful for a screenshot, or for a machine that struggles. */
  defaultPaused?: boolean;
  /** Overrides the media query. For tests, and for a per-user setting. */
  forceReducedMotion?: boolean;
}

export function MotionProvider({
  children,
  defaultPaused = false,
  forceReducedMotion,
}: MotionProviderProps) {
  const [paused, setPaused] = useState(defaultPaused);
  const systemReduced = usePrefersReducedMotion();
  const reducedMotion = forceReducedMotion ?? systemReduced;

  const togglePaused = useCallback(() => setPaused((previous) => !previous), []);

  const value = useMemo<MotionState>(
    () => ({
      paused,
      reducedMotion,
      animate: !paused && !reducedMotion,
      setPaused,
      togglePaused,
    }),
    [paused, reducedMotion, togglePaused],
  );

  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

export function useMotion(): MotionState {
  return useContext(MotionContext);
}

/**
 * The style every animated element gets.
 *
 * `animationPlayState: "paused"` freezes an animation mid-cycle rather than
 * resetting it, which is what pause should feel like — the picture stops, it
 * does not jump back to the beginning.
 *
 * Under reduced motion the animation is removed entirely rather than paused.
 * A paused animation still leaves the element wherever its keyframes had put
 * it, and "wherever it happened to be" is not a design.
 */
export function motionStyle(
  motion: MotionState,
  animation: string,
): { animation?: string; animationPlayState?: "paused" | "running" } {
  if (motion.reducedMotion) return {};
  return { animation, animationPlayState: motion.paused ? "paused" : "running" };
}
