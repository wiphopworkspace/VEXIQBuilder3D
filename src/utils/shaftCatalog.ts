// Which shafts can be dropped straight into a given socket.
//
// The Smart Motor's drive socket is the first joint most builds need and the
// hardest one to make by hand: it is a single 0.148 square opening on the
// motor's TOP face, sitting inside a grid of mounting holes that look identical
// at arm's length, and the shaft has to be brought to it in the right
// orientation with the right END leading. Picking a length from a list and
// letting `computeSnapTransform` do the rest removes the whole hunt.
//
// The list is derived, never hand-written: a shaft qualifies when one of its
// own authored snap points is compatible with the socket, which is the same
// question `insertPartAtSnapPoint` asks when it seats the part. So a shaft
// family that gains (or loses) an insertable end shows up here automatically,
// and a capped shaft — whose cap end can never enter a socket — is offered on
// the strength of its open end alone.

import { PARTS, getPartDefinition } from '../data/parts'
import { getSnapPoints } from '../data/snapOverrides'
import { SHAFT_SPECS_BY_PART_NUMBER } from '../data/shaftProfiles'
import { typesCompatible } from './snap'
import type { PartDefinition, SnapPointType } from '../types/assembly'

export type ShaftChoice = {
  partId: string
  name: string
  /** Nominal length in hole pitches, when the part is in the shaft spec table. */
  pitches: number | null
  /** Shaft family, for grouping in a picker. */
  kind: string | null
}

function shaftSpecFor(def: PartDefinition) {
  const partNumber =
    def.partNumber ?? `${def.id} ${def.name}`.match(/(\d{3}-\d{3,4}-\d+)/)?.[1]
  return partNumber ? SHAFT_SPECS_BY_PART_NUMBER[partNumber] : undefined
}

/**
 * Every catalog part with a snap point this socket type accepts, shortest
 * first. Ordered by nominal pitch so the picker reads like a parts drawer;
 * anything without a spec entry (procedural placeholders) sorts last by name.
 */
export function insertableShaftsFor(socketType: SnapPointType): ShaftChoice[] {
  const out: ShaftChoice[] = []
  for (const def of PARTS) {
    const fits = getSnapPoints(def).some(
      (s) => s.role !== 'receive' && typesCompatible(s.type, socketType),
    )
    if (!fits) continue
    const spec = shaftSpecFor(def)
    out.push({
      partId: def.id,
      name: def.name,
      pitches: spec?.pitches ?? null,
      kind: spec?.kind ?? null,
    })
  }
  return out.sort((a, b) => {
    if (a.pitches === null && b.pitches === null) return a.name.localeCompare(b.name)
    if (a.pitches === null) return 1
    if (b.pitches === null) return -1
    if (a.pitches !== b.pitches) return a.pitches - b.pitches
    return a.name.localeCompare(b.name)
  })
}

/**
 * A sensible default pick for a socket.
 *
 * For the motor socket that is a MOTOR SHAFT — the flanged family exists for
 * exactly this joint, and its flange is what stops the shaft at the socket
 * mouth instead of at the floor. 3x pitch is the length shipped in the kit and
 * long enough to carry a gear clear of the motor body. Everything else falls
 * back to the shortest shaft that can still hold a component.
 */
export function defaultShaftFor(socketType: SnapPointType): string | null {
  const choices = insertableShaftsFor(socketType)
  const longEnough = choices.filter((c) => c.pitches !== null && c.pitches >= 3)
  const purposeBuilt = longEnough.filter((c) => c.kind === 'motor')
  return (
    purposeBuilt[0]?.partId ?? longEnough[0]?.partId ?? choices[0]?.partId ?? null
  )
}

/** Display name for a part id, for status strings and pickers. */
export function partName(partId: string): string {
  return getPartDefinition(partId)?.name ?? partId
}

/**
 * Everything that can be seated ON a shaft station, grouped by part category.
 *
 * Three different bores answer to a station — a square driven bore that locks
 * to the shaft, a gear/wheel centre, and a free-spinning support bore — and a
 * builder does not think in those terms; they think "a gear", "a wheel", "a
 * beam to hold it". So the grouping is by the catalog category the parts panel
 * already uses, and the compatibility question stays where it belongs, in
 * `SNAP_COMPATIBILITY`.
 *
 * Gears and Wheels lead because a shaft that has just been fitted to a motor is
 * almost always waiting for one of them.
 */
const RIDER_CATEGORY_ORDER = [
  'Gears',
  'Wheels',
  'Beams',
  'Connectors',
  'Plates',
  'Misc',
]

export function ridersForShaft(): {
  category: string
  choices: ShaftChoice[]
}[] {
  const byCategory = new Map<string, ShaftChoice[]>()
  for (const def of PARTS) {
    const fits = getSnapPoints(def).some((s) => typesCompatible(s.type, 'axle'))
    if (!fits) continue
    const list = byCategory.get(def.category) ?? []
    list.push({ partId: def.id, name: def.name, pitches: null, kind: null })
    byCategory.set(def.category, list)
  }
  return [...byCategory.entries()]
    .map(([category, choices]) => ({
      category,
      choices: choices.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => {
      const ai = RIDER_CATEGORY_ORDER.indexOf(a.category)
      const bi = RIDER_CATEGORY_ORDER.indexOf(b.category)
      return (
        (ai === -1 ? RIDER_CATEGORY_ORDER.length : ai) -
          (bi === -1 ? RIDER_CATEGORY_ORDER.length : bi) ||
        a.category.localeCompare(b.category)
      )
    })
}
