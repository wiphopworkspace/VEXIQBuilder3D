// Persistent per-pin-end seat-depth overrides (finalSeatAdjustment), set from the
// Properties panel's Snap Depth Calibration so a calibrated value becomes the
// default for every instance of that pin — no code edit needed. Keyed by
// `${pinProfileKey}:${endId}` (e.g. "pin1x2:pin-back-2"). Stored in localStorage,
// separate from project JSON. All storage access is try/caught so this module
// imports cleanly in Node (headless tests).

/**
 * v2 (2026-07-29). The key was bumped DELIBERATELY and old v1 values are
 * dropped, not migrated.
 *
 * Every v1 value was hand-calibrated against the OLD seat planes, which sat on
 * the collar MIDPLANE rather than the collar FACE (and on the part CENTRE for
 * standoffs). Now that each stopping surface is measured from the mesh, a
 * carried-over v1 value is wrong BY CONSTRUCTION — it re-applies a correction
 * for a defect that no longer exists, and because it REPLACES
 * `finalSeatAdjustment` it silently undoes the measured seating.
 *
 * A stale 0.0300 saved default is exactly the "flush by hand" state this
 * change removes the need for. Dropping v1 makes the app self-heal on first
 * load instead of requiring every user to find the Clear button.
 */
const STORAGE_KEY = 'vexiq.pinSeatOverrides.v2'
const LEGACY_STORAGE_KEYS = ['vexiq.pinSeatOverrides.v1']

/**
 * This is a USER fine adjustment, not a place to model geometry. Bounded to
 * the same range as `pinContactOffset` so it cannot stand in for a wrong
 * contact frame — a part needing more than half a millimetre has a metadata
 * bug to report, not a slider to drag.
 */
export const PIN_SEAT_OVERRIDE_LIMIT = 0.02

function clampOverride(value: number): number {
  return Math.max(-PIN_SEAT_OVERRIDE_LIMIT, Math.min(PIN_SEAT_OVERRIDE_LIMIT, value))
}

function load(): Record<string, number> {
  try {
    // Retire pre-measurement calibrations so they cannot fight the mesh.
    for (const legacy of LEGACY_STORAGE_KEYS) localStorage.removeItem(legacy)
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') {
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = clampOverride(v)
      }
      return out
    }
  } catch {
    // corrupt or unavailable storage — fall through to empty
  }
  return {}
}

const overrides = load()

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    // storage unavailable (private mode / Node) — keep in-memory only
  }
}

function keyOf(profileKey: string, endId: string): string {
  return `${profileKey}:${endId}`
}

export function getPinSeatOverride(
  profileKey: string,
  endId: string,
): number | undefined {
  return overrides[keyOf(profileKey, endId)]
}

export function setPinSeatOverride(
  profileKey: string,
  endId: string,
  value: number,
): void {
  overrides[keyOf(profileKey, endId)] = clampOverride(value)
  persist()
}

export function clearPinSeatOverride(profileKey: string, endId: string): void {
  delete overrides[keyOf(profileKey, endId)]
  persist()
}

/** Fast-path check so the resolver can skip override work when none are set. */
export function hasAnyPinSeatOverride(): boolean {
  for (const _k in overrides) return true
  return false
}
