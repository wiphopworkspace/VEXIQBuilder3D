// Core domain types for the VEX IQ 3D Assembly Builder.

import type * as THREE from 'three'
import type {
  FastenedMateParams,
  MateConnectorProjectRef,
} from './mate'

export type SnapPointType =
  | 'hole'
  | 'pin'
  | 'axle'
  | 'axleHole'
  | 'connector'
  | 'motorShaft'
  | 'wheelCenter'
  | 'gearCenter'
  // Shaft-family semantics (2026-07-14). `axle` = a station point ON a shaft
  // body where a driven bore / support bore can seat. The rest:
  | 'shaftEnd' // usable end of a shaft — inserts into a motor drive socket
  | 'shaftSupportBore' // free-spinning round bore a shaft passes through

export type Vec3 = [number, number, number]

export type SnapMetadataSource =
  | 'curated'
  | 'partDefinition'
  | 'generatedFallback'
  | 'boundsInferred'

export type MateFrameDefinition = {
  position: Vec3
  axis: Vec3
  up?: Vec3
}

export type SnapPointDefinition = {
  id: string
  type: SnapPointType
  position: Vec3
  rotation?: Vec3
  // Local-space insertion/shaft axis used for mate orientation.
  axis?: Vec3
  // Local-space surface normal. Kept as a backward-compatible axis fallback.
  normal?: Vec3
  // Whether the source axis should align with, or opposite, the target axis.
  alignMode?: 'same' | 'opposite'
  role?: 'insert' | 'receive' | 'center' | 'surface' | 'shoulder'
  mateFrame?: MateFrameDefinition
  // Optional physical contact frame. For pins, this is the shoulder/cap plane
  // that seats against a receiving face; the mate frame can remain on the
  // insertion shaft/front cue.
  seatFrame?: MateFrameDefinition
  // Back-compatible shorthand for `seatFrame.position`.
  seatPosition?: Vec3
  // Optional receiving/contact face position. Beam holes use this when their
  // visual snap marker or hole center differs from the outside face.
  facePosition?: Vec3
  insertionDepth?: number
  seatOffset?: number
  // Small calibrated movement along the target insertion axis after the seat
  // frame is placed on the target face.
  finalSeatAdjustment?: number
  // Optional side-specific overrides. `sourceSideSeatAdjustment` is used when
  // this snap belongs to the moving source; `targetSideSeatAdjustment` is used
  // when this snap is the fixed target.
  sourceSideSeatAdjustment?: number
  targetSideSeatAdjustment?: number
  // Extra calibrated depth term for part-specific correction.
  insertionDepthCorrection?: number
  receivingDepth?: number
  // Shaft-family metadata (kept separate from the generic depth fields above —
  // see HANDOFF "Shaft system"). All optional; only shaft snaps carry them.
  //
  // Quantize the square-profile roll: after axis alignment the up-vector roll
  // is snapped to the nearest multiple of this step (degrees) instead of an
  // exact up match, so a square shaft keeps the user's preview orientation and
  // indexes in quarter turns. Omit for exact-up (pins) or free-spin (no up).
  rollStepDeg?: number
  // Motor socket: physical depth of the drive socket from its mouth. The
  // seated plane (`facePosition`) sits `seatedDepth` in from the mouth.
  socketDepth?: number
  // Shaft end: usable body length from this end to the first cap/flange stop.
  usableShaftLength?: number
  // Shaft end: how this end terminates. Capped/flanged sides emit no shaftEnd.
  shaftEndKind?: 'open' | 'flanged' | 'snap'
  // Shaft end: seat-plane offset beyond the end face (socket seated depth minus
  // this end's stop-limited insertion depth). 0 = seats at the socket floor.
  stopOffset?: number
  // Optional physical occupancy key shared by multiple selectable snap markers
  // on the same real feature. Beam/plate front and back hole faces use this so
  // a through-hole cannot be occupied twice from opposite sides.
  occupancyGroup?: string
  snapSource?: SnapMetadataSource
  pinProfileKey?: string
  pinProfileDisplayName?: string
  curatedNeedsReview?: boolean
  compatibleWith: SnapPointType[]
  radius?: number
  // Static hint only — live occupancy is derived from `connections`.
  occupied?: boolean
  approximate?: boolean
}

// A snap point resolved into world space for a specific instance.
export type RuntimeSnapPoint = SnapPointDefinition & {
  instanceId: string
  worldPosition: THREE.Vector3
  worldQuaternion: THREE.Quaternion
  worldAxis?: THREE.Vector3
  worldMatePosition: THREE.Vector3
  worldMateAxis?: THREE.Vector3
  worldMateUp?: THREE.Vector3
  worldSeatPosition: THREE.Vector3
  worldSeatAxis?: THREE.Vector3
  worldFacePosition?: THREE.Vector3
}

// Kind of joint behavior for a stored mate. `fastened` is rigid placement (the
// default for Auto Snap / Joint / Pin). `revolute` additionally allows the part
// to spin about the shared mate axis via the Angle control (one DOF).
export type JointKind = 'fastened' | 'revolute'

// A stored mate between two snap points on two instances.
export type ConnectionMate = {
  id: string
  aInstanceId: string
  aSnapId: string
  bInstanceId: string
  bSnapId: string
  type: 'snap'
  // Optional; absent = fastened. Only the Mate Editor creates revolute joints.
  jointKind?: JointKind
  // Advanced CAD-lite connector persistence. Legacy snap mates may omit these.
  aConnectorRef?: MateConnectorProjectRef
  bConnectorRef?: MateConnectorProjectRef
  mateParams?: FastenedMateParams
}

// Live preview of a candidate snap while dragging.
export type SnapPreview = {
  targetInstanceId: string
  targetSnapId: string
  draggedInstanceId: string
  draggedSnapId: string
  // Where the dragged part will seat if released now — drives the ghost preview.
  previewPosition?: Vec3
  previewRotation?: Vec3
}

export type PartCategory =
  | 'Beams'
  | 'Pins'
  | 'Connectors'
  | 'Axles'
  | 'Gears'
  | 'Wheels'
  | 'Electronics'
  | 'Plates'
  | 'Game Elements'
  | 'Misc'

// Which STEP source collection a generated part came from.
export type SourceCollection = 'control' | 'all-parts-2024-11-08'

// Procedural geometry hint used by the fallback renderer when no GLB exists.
export type ProceduralKind =
  | 'beam'
  | 'pin'
  | 'axle'
  | 'gear'
  | 'wheel'
  | 'motor'
  | 'brain'
  | 'connector'
  | 'plate'
  | 'box'

export type PartDefinition = {
  id: string
  name: string
  category: PartCategory
  colorOptions: string[]
  defaultColor: string
  // Web path to a converted GLB model (served from /public). Rendered only when
  // hasConvertedModel is true; otherwise a procedural placeholder is shown.
  modelPath?: string
  // Web path to the original STEP file this part was generated from. Kept for
  // metadata/traceability — never loaded in the browser.
  sourceStepPath?: string
  // Web path to a generated thumbnail PNG, if one exists.
  thumbnailPath?: string
  // True when a matching GLB exists in the corresponding GLB folder.
  hasConvertedModel?: boolean
  // Which STEP source collection this part was generated from.
  sourceCollection?: SourceCollection
  // VEX/LDCad part number extracted from file names such as 228-2500-060.
  partNumber?: string
  // Matching reference .dat from LDCadVEX, when known.
  ldcadVexFileName?: string
  procedural: ProceduralKind
  // Optional sizing hints for procedural models. Units are "VEX holes".
  length?: number // number of holes along the long axis (beams/axles)
  snapPoints: SnapPointDefinition[]
}

export type PartInstanceData = {
  instanceId: string
  partId: string
  position: Vec3
  rotation: Vec3
  scale: Vec3
  color: string
  // Optional per-instance mates (the global `connections` list is the source
  // of truth; this field exists for forward compatibility / grouping).
  connections?: ConnectionMate[]
}

export type EditorMode =
  | 'select'
  | 'move'
  | 'rotate'
  | 'joint'
  | 'pin'
  // Advanced (CAD-lite) Mate Connector Tool: pick source + target connectors.
  | 'mate'

// Manual Joint Mode selection: the first snap point the user picked, if any.
export type JointSource = {
  instanceId: string
  snapId: string
  type: SnapPointType
}

export type AssemblyState = {
  projectName: string
  parts: PartInstanceData[]
  connections: ConnectionMate[]
  selectedInstanceId: string | null
  selectedSnapPointId?: string | null
  snapPreview?: SnapPreview | null
  mode: EditorMode
  snapEnabled: boolean
}

// Shape of the saved project JSON file.
export type ProjectFile = {
  projectName: string
  version: number
  parts: PartInstanceData[]
  connections: ConnectionMate[]
}

export type AssemblySnapshot = {
  projectName: string
  parts: PartInstanceData[]
  connections: ConnectionMate[]
}

export type HistoryEntry = {
  label: string
  snapshot: AssemblySnapshot
}
