// Sliding a part ALONG a shaft.
//
// A shaft is the one feature in the VEX IQ system whose mate has a free
// translation left in it: a gear, a wheel, a lock beam or a bearing does not
// pick ONE place on a shaft the way a pin picks one hole — it sits wherever it
// was pushed, and moving it a hole over is an ordinary build step, not a
// rebuild.
//
// The app already modelled that freedom as discrete `axle` STATIONS on the
// shaft body (see `shaftProfiles.shaftStationPositions`), one every hole pitch,
// clamped away from caps and flanges. What was missing was any way to change
// which station a mate uses after the fact: the only route was to detach the
// part and hunt for a different marker in 3D. This module is the resolver
// behind that missing move — "which station is this mate on, which ones are
// free, and how far does the part travel to reach one".
//
// It is deliberately pure: no store writes. The store action `slideAlongShaft`
// is the only thing that commits, and `verify-shaft-slide.ts` drives these same
// functions headlessly.

import * as THREE from 'three'
import { getPartDefinition } from '../data/parts'
import { getSnapPoints } from '../data/snapOverrides'
import { connectedComponentOf, getWorldSnapPoints } from './snap'
import type {
  ConnectionMate,
  PartDefinition,
  PartInstanceData,
  SnapPointDefinition,
  Vec3,
} from '../types/assembly'

/** One seatable position along a shaft body. */
export type ShaftStation = {
  snapId: string
  /** Signed distance along the shaft axis from the shaft's local origin. */
  t: number
  /** Instance id of a part already mated here (via another mate), or null. */
  occupiedBy: string | null
}

export type ShaftSlideContext = {
  mateId: string
  /** The part carrying the `axle` stations. */
  shaftInstanceId: string
  shaftPartId: string
  /** Station snap id this mate currently uses. */
  shaftSnapId: string
  /** The part seated ON the shaft (bore / gear centre / wheel centre). */
  riderInstanceId: string
  riderPartId: string
  riderSnapId: string
  /** The part a slide MOVES — always the one the caller asked about. */
  moverInstanceId: string
  /**
   * True when the mover is the shaft itself: the shaft slides THROUGH the
   * rider's bore, which is how a shaft is positioned in a beam. The station
   * numbering runs along the shaft either way, so the sign of the travel flips
   * — see `slideTranslation`.
   */
  moverIsShaft: boolean
  /** Every part the slide carries, mover first (its body with this mate cut). */
  moverIds: string[]
  /** World unit vector pointing along ASCENDING station `t`. */
  axis: Vec3
  /** Every station on this shaft, ascending in `t`. */
  stations: ShaftStation[]
  /** Index into `stations` of the station this mate sits on. */
  index: number
  /**
   * Set when the mover and the other side are ALSO joined by some other chain
   * of mates, so translating one relative to the other would tear the assembly.
   * The context is still returned — the UI wants to explain why it is disabled.
   */
  looped: boolean
}

const AXIS_EPS = 1e-3

function localAxisOf(snap: SnapPointDefinition): THREE.Vector3 {
  const raw = snap.mateFrame?.axis ?? snap.axis ?? snap.normal ?? [0, 0, 1]
  const v = new THREE.Vector3(...raw)
  return v.lengthSq() > 1e-12 ? v.normalize() : new THREE.Vector3(0, 0, 1)
}

/**
 * Every `axle` station that lies on the SAME physical line as `stationSnapId` —
 * parallel axis, zero perpendicular offset — ordered along that axis.
 *
 * Collinearity is checked rather than assumed because `axle` stations are not
 * always on local Z: `makeXAxisAxleSnaps` puts them on X for the procedural
 * axles, and nothing stops a part carrying two separate shaft stubs. Stepping
 * between two stations that are not on one line would translate a part sideways
 * off its own shaft, which is the one thing this move must never do.
 */
export function stationSeriesFor(
  definition: PartDefinition,
  stationSnapId: string,
): { axis: THREE.Vector3; stations: { snapId: string; t: number }[] } | null {
  const snaps = getSnapPoints(definition)
  const current = snaps.find((s) => s.id === stationSnapId && s.type === 'axle')
  if (!current) return null
  const axis = localAxisOf(current)
  const origin = new THREE.Vector3(...current.position)
  const stations: { snapId: string; t: number }[] = []
  for (const snap of snaps) {
    if (snap.type !== 'axle') continue
    if (Math.abs(localAxisOf(snap).dot(axis)) < 1 - AXIS_EPS) continue
    const along = new THREE.Vector3(...snap.position).sub(origin)
    const perpendicular = along
      .clone()
      .sub(axis.clone().multiplyScalar(along.dot(axis)))
    if (perpendicular.length() > AXIS_EPS) continue
    stations.push({
      snapId: snap.id,
      t: new THREE.Vector3(...snap.position).dot(axis),
    })
  }
  if (stations.length === 0) return null
  stations.sort((a, b) => a.t - b.t)
  return { axis, stations }
}

function snapDefinitionFor(
  parts: PartInstanceData[],
  instanceId: string,
  snapId: string,
): { instance: PartInstanceData; snap: SnapPointDefinition } | null {
  const instance = parts.find((p) => p.instanceId === instanceId)
  const definition = instance ? getPartDefinition(instance.partId) : undefined
  if (!instance || !definition) return null
  const snap = getSnapPoints(definition).find((s) => s.id === snapId)
  return snap ? { instance, snap } : null
}

/**
 * The shaft mate `instanceId` can be slid on, or null when it is not on one.
 *
 * When the part is in several shaft mates at once (a shaft through two beams),
 * `preferredMateId` — the Properties panel's active mate — decides which one;
 * otherwise the first is used, matching `activeJointFrameForInstance`.
 */
export function findShaftSlide(
  instanceId: string,
  parts: PartInstanceData[],
  connections: ConnectionMate[],
  preferredMateId?: string,
): ShaftSlideContext | null {
  const own = connections.filter(
    (c) => c.aInstanceId === instanceId || c.bInstanceId === instanceId,
  )
  const ordered =
    preferredMateId && own.some((c) => c.id === preferredMateId)
      ? [
          own.find((c) => c.id === preferredMateId)!,
          ...own.filter((c) => c.id !== preferredMateId),
        ]
      : own

  for (const mate of ordered) {
    const ownSide = mate.aInstanceId === instanceId ? 'a' : 'b'
    const ownSnapId = ownSide === 'a' ? mate.aSnapId : mate.bSnapId
    const otherInstanceId =
      ownSide === 'a' ? mate.bInstanceId : mate.aInstanceId
    const otherSnapId = ownSide === 'a' ? mate.bSnapId : mate.aSnapId
    const mine = snapDefinitionFor(parts, instanceId, ownSnapId)
    const other = snapDefinitionFor(parts, otherInstanceId, otherSnapId)
    if (!mine || !other) continue

    const moverIsShaft = mine.snap.type === 'axle'
    if (!moverIsShaft && other.snap.type !== 'axle') continue
    const shaft = moverIsShaft ? mine : other
    const rider = moverIsShaft ? other : mine
    const shaftInstanceId = moverIsShaft ? instanceId : otherInstanceId
    const riderInstanceId = moverIsShaft ? otherInstanceId : instanceId
    const shaftSnapId = moverIsShaft ? ownSnapId : otherSnapId
    const riderSnapId = moverIsShaft ? otherSnapId : ownSnapId

    const shaftDef = getPartDefinition(shaft.instance.partId)
    if (!shaftDef) continue
    const series = stationSeriesFor(shaftDef, shaftSnapId)
    if (!series || series.stations.length < 2) continue

    const worldStation = getWorldSnapPoints(shaft.instance, shaftDef).find(
      (s) => s.id === shaftSnapId,
    )
    const worldAxis = worldStation?.worldMateAxis ?? worldStation?.worldAxis
    if (!worldAxis || worldAxis.lengthSq() < 1e-12) continue

    // A station is occupied by whatever OTHER mate references it. Only one
    // component can sit at one place on a shaft, so those are the stations this
    // slide may not land on.
    const occupancy = new Map<string, string>()
    for (const c of connections) {
      if (c.id === mate.id) continue
      if (c.aInstanceId === shaftInstanceId) occupancy.set(c.aSnapId, c.bInstanceId)
      if (c.bInstanceId === shaftInstanceId) occupancy.set(c.bSnapId, c.aInstanceId)
    }

    const moverIds = connectedComponentOf(
      instanceId,
      parts,
      connections.filter((c) => c.id !== mate.id),
    )

    return {
      mateId: mate.id,
      shaftInstanceId,
      shaftPartId: shaft.instance.partId,
      shaftSnapId,
      riderInstanceId,
      riderPartId: rider.instance.partId,
      riderSnapId,
      moverInstanceId: instanceId,
      moverIsShaft,
      moverIds,
      axis: worldAxis.clone().normalize().toArray() as Vec3,
      stations: series.stations.map((s) => ({
        snapId: s.snapId,
        t: s.t,
        occupiedBy: occupancy.get(s.snapId) ?? null,
      })),
      index: series.stations.findIndex((s) => s.snapId === shaftSnapId),
      looped: moverIds.includes(
        moverIsShaft ? riderInstanceId : shaftInstanceId,
      ),
    }
  }
  return null
}

/**
 * Station index reached by `steps` presses, where +1 always means "the SELECTED
 * part travels one station along +axis". When the mover is the shaft the two
 * run opposite: pushing a shaft toward +axis puts the bore on a station with a
 * LOWER `t`, which is why this is a function and not an addition at the call
 * sites.
 */
export function stationIndexAfterSteps(
  context: ShaftSlideContext,
  steps: number,
): number {
  const raw = context.index + (context.moverIsShaft ? -steps : steps)
  return Math.max(0, Math.min(context.stations.length - 1, raw))
}

/** World translation that moves the mover from its station to `targetIndex`. */
export function slideTranslation(
  context: ShaftSlideContext,
  targetIndex: number,
): Vec3 {
  const dt = context.stations[targetIndex].t - context.stations[context.index].t
  const travel = context.moverIsShaft ? -dt : dt
  return [
    context.axis[0] * travel,
    context.axis[1] * travel,
    context.axis[2] * travel,
  ]
}

/** Distance the mover travels for one press in `direction` (0 when blocked). */
export function slideStepDistance(
  context: ShaftSlideContext,
  direction: 1 | -1,
): number {
  const next = stationIndexAfterSteps(context, direction)
  if (next === context.index) return 0
  return Math.abs(context.stations[next].t - context.stations[context.index].t)
}
