import type { PartDefinition } from '../types/assembly'
import { HOLE_PITCH, makeBeamHoles } from './snapFactories'
import { generatedStepParts } from './generatedStepParts'
import { matchPinProfile, type PinProfile } from './pinProfiles'
import { parseRectPart } from './partFamilies'

export { HOLE_PITCH }

/**
 * Broad VEX IQ color palette offered for every part, on top of each part's own
 * `colorOptions`. Lets users recolor any part (built-in or generated) without
 * editing 478 generated entries — the properties panel unions this with the
 * part's defaults. Loosely matches real VEX IQ plastic colors.
 */
export const VEX_IQ_PALETTE = [
  '#1f6feb', // blue
  '#2f6f3e', // green
  '#c0392b', // red
  '#e67e22', // orange
  '#f1c40f', // yellow
  '#8e44ad', // purple
  '#16a085', // teal
  '#e84393', // pink
  '#c8cdd6', // light gray
  '#7d8794', // gray
  '#3a3f4b', // dark gray
  '#11151c', // black
  '#f5f7fa', // white
]

// Shared color palettes (loosely matching VEX IQ part colors).
const STRUCTURE_COLORS = ['#7d8794', '#3a3f4b', '#c8cdd6', '#1f6feb']
const PIN_COLORS = ['#2f6f3e', '#1f6feb', '#c0392b', '#e67e22']
const AXLE_COLORS = ['#444b57', '#2b2f38']
const GEAR_COLORS = ['#1f6feb', '#e67e22', '#2f6f3e']
const WHEEL_COLORS = ['#222831', '#3a3f4b']
const MOTOR_COLORS = ['#d8dde6', '#9aa3b2']
const CONNECTOR_COLORS = ['#e67e22', '#c0392b', '#7d8794']

const BUILT_IN_PARTS: PartDefinition[] = [
  {
    id: 'beam-2x6',
    name: 'Beam 2x6',
    category: 'Beams',
    colorOptions: STRUCTURE_COLORS,
    defaultColor: STRUCTURE_COLORS[0],
    procedural: 'beam',
    length: 6,
    snapPoints: makeBeamHoles(6),
  },
  {
    id: 'beam-2x10',
    name: 'Beam 2x10',
    category: 'Beams',
    colorOptions: STRUCTURE_COLORS,
    defaultColor: STRUCTURE_COLORS[0],
    procedural: 'beam',
    length: 10,
    snapPoints: makeBeamHoles(10),
  },
  {
    id: 'pin',
    name: 'Pin',
    category: 'Pins',
    colorOptions: PIN_COLORS,
    defaultColor: PIN_COLORS[0],
    procedural: 'pin',
    snapPoints: [
      {
        id: 'pin-tip',
        type: 'pin',
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        compatibleWith: ['hole'],
      },
    ],
  },
  {
    id: 'corner-connector',
    name: 'Corner Connector',
    category: 'Connectors',
    colorOptions: CONNECTOR_COLORS,
    defaultColor: CONNECTOR_COLORS[0],
    procedural: 'connector',
    snapPoints: [
      {
        id: 'connector-a',
        type: 'connector',
        position: [HOLE_PITCH / 2, 0, 0],
        rotation: [0, 0, 0],
        compatibleWith: ['hole'],
      },
      {
        id: 'connector-b',
        type: 'connector',
        position: [0, 0, HOLE_PITCH / 2],
        rotation: [0, 0, 0],
        compatibleWith: ['hole'],
      },
    ],
  },
  {
    id: 'axle-2',
    name: 'Axle 2',
    category: 'Axles',
    colorOptions: AXLE_COLORS,
    defaultColor: AXLE_COLORS[0],
    procedural: 'axle',
    length: 2,
    snapPoints: [
      {
        id: 'axle-a',
        type: 'axle',
        position: [-HOLE_PITCH / 2, 0, 0],
        rotation: [0, 0, 0],
        compatibleWith: ['hole', 'axleHole'],
      },
      {
        id: 'axle-b',
        type: 'axle',
        position: [HOLE_PITCH / 2, 0, 0],
        rotation: [0, 0, 0],
        compatibleWith: ['hole', 'axleHole'],
      },
    ],
  },
  {
    id: 'gear',
    name: 'Gear',
    category: 'Gears',
    colorOptions: GEAR_COLORS,
    defaultColor: GEAR_COLORS[0],
    procedural: 'gear',
    snapPoints: [
      {
        id: 'gear-bore',
        type: 'axleHole',
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        compatibleWith: ['axle'],
      },
    ],
  },
  {
    id: 'wheel',
    name: 'Wheel',
    category: 'Wheels',
    colorOptions: WHEEL_COLORS,
    defaultColor: WHEEL_COLORS[0],
    procedural: 'wheel',
    snapPoints: [
      {
        id: 'wheel-bore',
        type: 'axleHole',
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        compatibleWith: ['axle'],
      },
    ],
  },
  {
    id: 'motor-placeholder',
    name: 'Motor Placeholder',
    category: 'Electronics',
    colorOptions: MOTOR_COLORS,
    defaultColor: MOTOR_COLORS[0],
    procedural: 'motor',
    snapPoints: [
      {
        id: 'motor-shaft',
        type: 'axleHole',
        position: [0, 0, 0.4],
        rotation: [0, 0, 0],
        compatibleWith: ['axle'],
      },
    ],
  },
]

// Real VEX IQ plastic colors, matching the kit's printed inventory
// (228-7755-750). The generated manifest gives every part one grey default;
// this re-colors structural parts to their true color so a 30° angle beam shows
// orange, standoffs show black, the 1x1 connector pin shows blue, etc.
const VEX_BEAM_LIGHT = '#c2c8d0' // plain 1x beams (light silver)
const VEX_BEAM_GREY = '#9aa3b2' // plain 2x beams (grey)
const VEX_PLATE_DARK = '#2a2e36' // plates (dark charcoal)
const VEX_CONNECTOR_GREY = '#b9bec7' // corner / chassis connectors
const VEX_PIN_CHARCOAL = '#3a3f4b' // 1x2 / 2x2 / 0x2 / 0x3 connector pins
const VEX_STANDOFF_BLACK = '#1a1d23' // pitch standoffs + extenders
const VEX_BLUE = '#1f6feb' // right-angle/tee/lock/corner/45° beams, standoff connectors, 1x1 pin
const VEX_ORANGE = '#e8631f' // 30° angle beams, 1x1 idler pin
const VEX_GREEN = '#86bc25' // 60° angle beams, 0x2 idler pin

/** Returns the real VEX IQ color for a part, or null to keep its existing
 *  default (parts not in the printed inventory pages). */
function vexPartColor(def: PartDefinition): string | null {
  const n = def.name.toLowerCase()

  // ---- Pins, standoffs & standoff connectors (Pins / Connectors / Misc) ----
  // "standoff connector" must be tested before plain "standoff".
  if (n.includes('standoff connector')) return VEX_BLUE // mini / 90° / end / straight / 45° / truss
  if (/\bstandoff\b/.test(n)) return VEX_STANDOFF_BLACK // pitch standoffs, extender, flexible/weak
  if (n.includes('idler pin')) {
    if (/^1x1\b/.test(n)) return VEX_ORANGE
    if (/^0x2\b/.test(n)) return VEX_GREEN
    return null // other idlers have no reference color — keep grey
  }
  if (n.includes('connector pin')) {
    return /^1x1\b/.test(n) ? VEX_BLUE : VEX_PIN_CHARCOAL
  }

  // ---- Beams & Plates ----
  if (def.category === 'Beams' || def.category === 'Plates') {
    // Angle beams are color-coded by their angle (data has a "degreee" typo,
    // which still contains "degree" as a substring).
    if (n.includes('30 degree')) return VEX_ORANGE
    if (n.includes('60 degree')) return VEX_GREEN
    if (n.includes('45 degree')) return VEX_BLUE
    // Reinforcement / structural beams are blue.
    if (/right angle|(^| )tee |center lock|end lock|corner|gusset|\bwye\b/.test(n))
      return VEX_BLUE
    const rect = parseRectPart(def)
    if (rect) return rect.kind === 'Plate' ? VEX_PLATE_DARK : rect.width === 1 ? VEX_BEAM_LIGHT : VEX_BEAM_GREY
    // Non-rectangular plates (truss / 3-way / irregular) still take the plate color.
    if (def.category === 'Plates' && n.includes('plate')) return VEX_PLATE_DARK
    return null
  }

  // ---- Corner / chassis connectors → grey ----
  if (
    def.category === 'Connectors' &&
    /(corner connector|chassis|wing connector|pipe connector)/.test(n)
  ) {
    return VEX_CONNECTOR_GREY
  }

  return null
}

/** Applies the VEX color as the part's default and offers it in the per-part
 *  color swatches. */
function withVexColor(def: PartDefinition): PartDefinition {
  const color = vexPartColor(def)
  if (!color || color === def.defaultColor) return def
  const colorOptions = def.colorOptions?.includes(color)
    ? def.colorOptions
    : [color, ...(def.colorOptions ?? [])]
  return { ...def, defaultColor: color, colorOptions }
}

// All selectable parts: hand-authored sample parts plus parts generated from
// the local STEP folder (see `npm run generate:parts`), recolored to match the
// real VEX IQ color scheme.
export const PARTS: PartDefinition[] = [
  ...BUILT_IN_PARTS,
  ...generatedStepParts,
].map(withVexColor)

// The canonical VEX IQ pin used for Pin Mode insertion. It has curated snap
// metadata (see snapOverrides) so it seats centered and correctly oriented.
const DEFAULT_PIN_ID = '1x1-connector-pin-228-2500-060'

/**
 * The part id to use when inserting a pin: the 1x1 Connector Pin if present,
 * else any generated Pin, else the built-in sample pin.
 */
export function getDefaultPinPartId(): string {
  if (generatedStepParts.some((p) => p.id === DEFAULT_PIN_ID)) {
    return DEFAULT_PIN_ID
  }
  const generatedPin = generatedStepParts.find((p) => p.category === 'Pins')
  return generatedPin?.id ?? 'pin'
}

export type PinPartOption = {
  part: PartDefinition
  profile: PinProfile | null
}

export function getPinPartOptions(): PinPartOption[] {
  const preferredOrder = ['pin1x1', 'pin1x2', 'pin0x2', 'pin0x3']
  return PARTS
    .map((part) => ({ part, profile: matchPinProfile(part) }))
    .filter(
      (option) =>
        option.profile ||
        option.part.category === 'Pins' ||
        option.part.procedural === 'pin',
    )
    .sort((a, b) => {
      const ai = a.profile ? preferredOrder.indexOf(a.profile.key) : 99
      const bi = b.profile ? preferredOrder.indexOf(b.profile.key) : 99
      if (ai !== bi) return ai - bi
      return a.part.name.localeCompare(b.part.name)
    })
}

// Fast lookup table by part id.
export const PARTS_BY_ID: Record<string, PartDefinition> = PARTS.reduce(
  (acc, part) => {
    acc[part.id] = part
    return acc
  },
  {} as Record<string, PartDefinition>,
)

export function getPartDefinition(partId: string): PartDefinition | undefined {
  return PARTS_BY_ID[partId]
}

export const CATEGORIES = [
  'Beams',
  'Pins',
  'Connectors',
  'Axles',
  'Gears',
  'Wheels',
  'Electronics',
  'Plates',
  'Game Elements',
  'Misc',
] as const
