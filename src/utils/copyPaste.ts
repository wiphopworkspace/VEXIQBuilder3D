/**
 * Internal copy/paste clipboard for part instances and their mates.
 *
 * Design notes (see HANDOFF "Copy / Paste"):
 *
 * - The clipboard is an APPLICATION-LEVEL buffer, not the OS clipboard. It
 *   holds a deep snapshot taken at Copy time, so mutating or deleting the
 *   originals afterwards cannot change what a later Paste produces.
 * - Mates are stored by ARRAY INDEX into the clipboard's own `parts`, never by
 *   instance id. A stored instance id could collide with, or dangle against,
 *   the live scene; indices are self-contained and are remapped to freshly
 *   minted ids at paste time. This is what makes "paste never reconnects to
 *   the original" true by construction rather than by filtering.
 * - Only INTERNAL mates are captured: a mate is copied only when BOTH of its
 *   endpoints are in the copied selection. A mate to a part outside the
 *   selection is dropped from the clipboard entirely — it is never copied,
 *   never recreated, and (because copying does not touch the scene) never
 *   pruned from the original either.
 * - These functions are pure. Id minting is injected so the store owns id
 *   generation and tests can pin deterministic ids.
 */
import type {
  ConnectionMate,
  JointKind,
  PartInstanceData,
  Vec3,
} from '../types/assembly'
import type { FastenedMateParams, MateConnectorProjectRef } from '../types/mate'
import { SNAP_CALIBRATION } from '../data/snapCalibration'

/**
 * Offset applied to each successive paste, in world units.
 *
 * One VEX IQ hole pitch (`SNAP_CALIBRATION.beamHolePitch` = 0.5 world units =
 * 12.7 mm) along +X and +Z. Deliberately a whole pitch on both horizontal
 * axes, for two reasons:
 *
 *  - it keeps pasted parts ON the shared 0.5 hole lattice, so a pasted
 *    assembly's holes still line up with the originals' and remain
 *    pin-connectable (see HANDOFF "grid quantization is HOLE-registered");
 *  - a diagonal step separates the copy visibly whatever the part's long axis
 *    is — a pure +X step would leave a beam lying along X almost entirely
 *    overlapping its original.
 *
 * Y is untouched so a paste never floats a part off the build plane.
 */
export const PASTE_OFFSET_STEP: Vec3 = [
  SNAP_CALIBRATION.beamHolePitch,
  0,
  SNAP_CALIBRATION.beamHolePitch,
]

/** A mate between two clipboard parts, addressed by index into `parts`. */
export type ClipboardMate = {
  aIndex: number
  aSnapId: string
  bIndex: number
  bSnapId: string
  jointKind?: JointKind
  aConnectorRef?: MateConnectorProjectRef
  bConnectorRef?: MateConnectorProjectRef
  mateParams?: FastenedMateParams
}

export type AssemblyClipboard = {
  /** Deep copies of the copied instances, with their ORIGINAL transforms. */
  parts: PartInstanceData[]
  /** Internal mates only (both endpoints were in the copied selection). */
  mates: ClipboardMate[]
}

export type PasteResult = {
  parts: PartInstanceData[]
  connections: ConnectionMate[]
}

function clonePart(part: PartInstanceData): PartInstanceData {
  return {
    instanceId: part.instanceId,
    partId: part.partId,
    position: [...part.position] as Vec3,
    rotation: [...part.rotation] as Vec3,
    scale: [...part.scale] as Vec3,
    color: part.color,
    // The global `connections` list is the source of truth; the optional
    // per-instance field is never carried into a copy (same rule as duplicate).
    connections: undefined,
  }
}

/**
 * Snapshot the selected instances and the mates that are wholly inside the
 * selection. Returns null when nothing usable is selected, so the caller can
 * report "Nothing selected to copy." without mutating anything.
 *
 * Order follows `parts` (scene order), not selection order, so a clipboard is
 * stable regardless of how the user built up the selection.
 */
export function buildClipboard(
  parts: PartInstanceData[],
  connections: ConnectionMate[],
  selectedIds: Iterable<string>,
): AssemblyClipboard | null {
  const wanted = new Set(selectedIds)
  if (wanted.size === 0) return null

  const picked = parts.filter((p) => wanted.has(p.instanceId))
  if (picked.length === 0) return null

  const indexById = new Map(picked.map((p, i) => [p.instanceId, i]))

  const mates: ClipboardMate[] = []
  for (const c of connections) {
    const aIndex = indexById.get(c.aInstanceId)
    const bIndex = indexById.get(c.bInstanceId)
    // BOTH endpoints must be copied. A mate with one endpoint outside the
    // selection is intentionally dropped — the pasted part must not reconnect
    // to the original assembly.
    if (aIndex === undefined || bIndex === undefined) continue
    mates.push({
      aIndex,
      aSnapId: c.aSnapId,
      bIndex,
      bSnapId: c.bSnapId,
      jointKind: c.jointKind,
      aConnectorRef: c.aConnectorRef,
      bConnectorRef: c.bConnectorRef,
      mateParams: c.mateParams,
    })
  }

  return { parts: picked.map(clonePart), mates }
}

/** Re-point a stored connector ref at the pasted instance. */
function remapConnectorRef(
  ref: MateConnectorProjectRef | undefined,
  newInstanceId: string,
): MateConnectorProjectRef | undefined {
  if (!ref) return undefined
  return { ...ref, partInstanceId: newInstanceId }
}

/**
 * Instantiate the clipboard as brand-new parts and mates.
 *
 * `pasteIndex` is 1-based: the first paste after a copy shifts by one offset
 * step, the second by two, and so on, so repeated pastes stack visibly instead
 * of burying each other. The caller resets the counter on every Copy.
 *
 * Every returned part and mate carries a freshly minted id; nothing in the
 * result references an original instance id or mate id. Transforms are the
 * copied ones plus a single shared translation, so the set's internal geometry
 * — relative positions AND rotations — is exactly preserved.
 */
export function instantiateClipboard(
  clipboard: AssemblyClipboard,
  pasteIndex: number,
  makeInstanceId: (partId: string) => string,
  makeMateId: () => string,
): PasteResult {
  const n = Math.max(1, Math.floor(pasteIndex))
  const dx = PASTE_OFFSET_STEP[0] * n
  const dy = PASTE_OFFSET_STEP[1] * n
  const dz = PASTE_OFFSET_STEP[2] * n

  const newIds = clipboard.parts.map((p) => makeInstanceId(p.partId))

  const parts: PartInstanceData[] = clipboard.parts.map((p, i) => ({
    ...clonePart(p),
    instanceId: newIds[i],
    position: [p.position[0] + dx, p.position[1] + dy, p.position[2] + dz],
  }))

  const connections: ConnectionMate[] = clipboard.mates.map((m) => ({
    id: makeMateId(),
    aInstanceId: newIds[m.aIndex],
    aSnapId: m.aSnapId,
    bInstanceId: newIds[m.bIndex],
    bSnapId: m.bSnapId,
    type: 'snap',
    jointKind: m.jointKind,
    aConnectorRef: remapConnectorRef(m.aConnectorRef, newIds[m.aIndex]),
    bConnectorRef: remapConnectorRef(m.bConnectorRef, newIds[m.bIndex]),
    mateParams: m.mateParams,
  }))

  return { parts, connections }
}
