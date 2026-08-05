/**
 * Is the primary pointer a fingertip rather than a cursor?
 *
 * Read once at module load: a device does not grow a mouse mid-session, and a
 * value that can change would have to invalidate every raycast-sized control
 * that reads it. Guarded for non-browser callers — the verify scripts import
 * store code that reaches components, and `window` is not defined there.
 *
 * Used only to SIZE things that are picked by ray or by finger (the transform
 * gizmo, hit proxies). Anything that can be expressed in CSS belongs in a
 * `@media (pointer: coarse)` block instead, where the browser re-evaluates it
 * for free when a keyboard is attached or detached.
 */
export const COARSE_POINTER =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches
