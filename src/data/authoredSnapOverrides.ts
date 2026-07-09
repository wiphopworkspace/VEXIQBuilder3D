// Visual Snap Authoring Tool storage: per-part snap-point sets authored in the
// browser. An authored set is the highest-priority layer in
// `getSnapPointResolution` (above SNAP_OVERRIDES), so edits are live in Auto
// Snap / Joint Mode / Pin Mode immediately — the existing snap pipeline is the
// preview. Stored in localStorage, separate from project JSON, like
// `pinSeatOverrides.ts`. All storage access is try/caught so this module
// imports cleanly in Node (verify:pins and headless tests see no overrides).
//
// The end goal of an authoring session is exporting the set as a snippet to
// paste into SNAP_OVERRIDES in `snapOverrides.ts`, making it a real curated
// override for everyone.

import type { SnapPointDefinition, Vec3 } from '../types/assembly'

const STORAGE_KEY = 'vexiq.authoredSnapOverrides.v1'

function load(): Record<string, SnapPointDefinition[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') {
      const out: Record<string, SnapPointDefinition[]> = {}
      for (const [partId, snaps] of Object.entries(parsed)) {
        if (Array.isArray(snaps) && snaps.length > 0) {
          out[partId] = snaps as SnapPointDefinition[]
        }
      }
      return out
    }
  } catch {
    // corrupt or unavailable storage — fall through to empty
  }
  return {}
}

const authored = load()

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(authored))
  } catch {
    // storage unavailable (private mode / Node) — keep in-memory only
  }
}

export function getAuthoredSnapOverride(
  partId: string,
): SnapPointDefinition[] | undefined {
  return authored[partId]
}

export function hasAuthoredSnapOverride(partId: string): boolean {
  return partId in authored
}

export function setAuthoredSnapOverride(
  partId: string,
  snaps: SnapPointDefinition[],
): void {
  if (snaps.length === 0) {
    delete authored[partId]
  } else {
    authored[partId] = snaps
  }
  persist()
}

export function clearAuthoredSnapOverride(partId: string): void {
  delete authored[partId]
  persist()
}

export function listAuthoredPartIds(): string[] {
  return Object.keys(authored)
}

/**
 * Strip resolution-time fields so a set seeded from `getSnapPoints(def)` (which
 * clones with `snapSource` stamped) round-trips cleanly: the resolver re-stamps
 * the source when it serves the authored layer, and exported snippets should
 * not carry it either.
 */
export function stripResolutionFields(
  snaps: SnapPointDefinition[],
): SnapPointDefinition[] {
  return snaps.map((snap) => {
    const { snapSource: _snapSource, ...rest } = snap
    return rest
  })
}

/**
 * A paste-ready `SNAP_OVERRIDES` entry for `snapOverrides.ts`. JSON is valid TS
 * object-literal syntax, so the snippet drops straight into the map.
 */
export function authoredOverrideSnippet(partId: string): string | null {
  const snaps = authored[partId]
  if (!snaps || snaps.length === 0) return null
  const body = JSON.stringify(stripResolutionFields(snaps), null, 2)
  return `'${partId}': ${body},`
}

// ---------------------------------------------------------------------------
// Authoring helpers (pure functions; the panel and store share them)
// ---------------------------------------------------------------------------

/** Round to 3 decimals — enough for VEX world units (pitch 0.5). */
export function roundCoord(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** The dominant-axis unit vector for a direction, e.g. (0.1,0.2,0.9) → +Z. */
export function dominantAxis(v: Vec3): Vec3 {
  const ax = Math.abs(v[0])
  const ay = Math.abs(v[1])
  const az = Math.abs(v[2])
  if (ax >= ay && ax >= az) return [Math.sign(v[0]) || 1, 0, 0]
  if (ay >= az) return [0, Math.sign(v[1]) || 1, 0]
  return [0, 0, Math.sign(v[2]) || 1]
}

/** A stable up vector perpendicular to the axis (matches curated conventions). */
export function upForAxis(axis: Vec3): Vec3 {
  return Math.abs(axis[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0]
}

/**
 * Re-derive the frames the snap math consumes from the editable fields. The
 * mate frame always follows position + axis; receiving points also expose their
 * position as the contact face (the `makeBeamGridOverrides` convention). Points
 * with an explicit seatFrame (pin-style metadata) are left untouched — the
 * authoring tool is for holes/connector points, not pin seat calibration.
 */
export function withDerivedFrames(
  snap: SnapPointDefinition,
): SnapPointDefinition {
  if (snap.seatFrame || snap.seatPosition) return snap
  const axis = snap.axis ?? snap.normal
  if (!axis) return snap
  const next: SnapPointDefinition = {
    ...snap,
    mateFrame: { position: snap.position, axis, up: upForAxis(axis) },
  }
  if (snap.role === 'receive' || snap.type === 'hole') {
    next.facePosition = snap.position
  }
  return next
}

/** A point id not already used in the set: `base`, `base-2`, `base-3`, … */
export function uniqueSnapId(
  base: string,
  snaps: SnapPointDefinition[],
): string {
  const used = new Set(snaps.map((s) => s.id))
  if (!used.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!used.has(candidate)) return candidate
  }
}

/**
 * Mirror a point to the opposite face: reflect its position across the plane
 * through the part origin perpendicular to its dominant axis, flip axis and
 * normal, and share the source point's occupancy group so the two faces behave
 * as one physical through-hole (the beam-grid front/back convention).
 */
export function mirrorSnapPoint(
  snap: SnapPointDefinition,
  snaps: SnapPointDefinition[],
): SnapPointDefinition | null {
  const direction = snap.axis ?? snap.normal
  if (!direction) return null
  const axis = dominantAxis(direction)
  const dot =
    snap.position[0] * axis[0] +
    snap.position[1] * axis[1] +
    snap.position[2] * axis[2]
  const position: Vec3 = [
    roundCoord(snap.position[0] - 2 * dot * axis[0]),
    roundCoord(snap.position[1] - 2 * dot * axis[1]),
    roundCoord(snap.position[2] - 2 * dot * axis[2]),
  ]
  const flip = (v: Vec3 | undefined): Vec3 | undefined =>
    v ? [-v[0], -v[1], -v[2]] : undefined
  const mirrored: SnapPointDefinition = withDerivedFrames({
    ...snap,
    id: uniqueSnapId(
      snap.id.endsWith('-back') ? snap.id.slice(0, -5) : `${snap.id}-back`,
      snaps,
    ),
    position,
    axis: flip(snap.axis),
    normal: flip(snap.normal),
    occupancyGroup: snap.occupancyGroup ?? snap.id,
  })
  return mirrored
}
