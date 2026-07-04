// Persistent per-pin-end seat-depth overrides (finalSeatAdjustment), set from the
// Properties panel's Snap Depth Calibration so a calibrated value becomes the
// default for every instance of that pin — no code edit needed. Keyed by
// `${pinProfileKey}:${endId}` (e.g. "pin1x2:pin-back-2"). Stored in localStorage,
// separate from project JSON. All storage access is try/caught so this module
// imports cleanly in Node (headless tests).

const STORAGE_KEY = 'vexiq.pinSeatOverrides.v1'

function load(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') {
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
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
  overrides[keyOf(profileKey, endId)] = value
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
