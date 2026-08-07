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
  '#1a7fd4', // blue
  '#8cc63f', // green
  '#c0392b', // red
  '#e8641c', // orange
  '#f1c40f', // yellow
  '#8e44ad', // purple
  '#16a085', // teal
  '#e84393', // pink
  '#c9ccd2', // light gray
  '#95999f', // gray
  '#3b3f45', // dark gray
  '#1e2024', // black
  '#f5f7fa', // white
]

// Shared color palettes (loosely matching VEX IQ part colors).
const STRUCTURE_COLORS = ['#95999f', '#3b3f45', '#c9ccd2', '#1a7fd4']
const PIN_COLORS = ['#1a7fd4', '#8cc63f', '#c0392b', '#e8641c']
const AXLE_COLORS = ['#cfd3d8', '#33373d']
const GEAR_COLORS = ['#1a7fd4', '#e8641c', '#8cc63f']
const WHEEL_COLORS = ['#1e2024', '#3b3f45']
const MOTOR_COLORS = ['#d8dde6', '#95999f']
const CONNECTOR_COLORS = ['#cbccc8', '#e8641c', '#95999f']

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
      // Procedural sample part. Both arms carry an explicit insertion axis and
      // shoulder seat frame so they describe a real mechanical contact rather
      // than defaulting to +Z and seating on the visual marker.
      {
        id: 'connector-a',
        type: 'connector',
        role: 'insert',
        position: [HOLE_PITCH / 2, 0, 0],
        rotation: [0, 0, 0],
        axis: [1, 0, 0],
        normal: [1, 0, 0],
        mateFrame: { position: [HOLE_PITCH / 2, 0, 0], axis: [1, 0, 0], up: [0, 1, 0] },
        seatFrame: { position: [HOLE_PITCH / 2, 0, 0], axis: [1, 0, 0], up: [0, 1, 0] },
        alignMode: 'same',
        compatibleWith: ['hole'],
      },
      {
        id: 'connector-b',
        type: 'connector',
        role: 'insert',
        position: [0, 0, HOLE_PITCH / 2],
        rotation: [0, 0, 0],
        axis: [0, 0, 1],
        normal: [0, 0, 1],
        mateFrame: { position: [0, 0, HOLE_PITCH / 2], axis: [0, 0, 1], up: [0, 1, 0] },
        seatFrame: { position: [0, 0, HOLE_PITCH / 2], axis: [0, 0, 1], up: [0, 1, 0] },
        alignMode: 'same',
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

// Real VEX IQ plastic colors, sampled from the kit's printed inventory pages
// (228-7755-750 and the Super Kit / Competition Kit sheets). The generated
// manifest gives every part one grey default; this re-colors each family to its
// true color so a 30° angle beam shows orange, standoffs show black, gears show
// blue, sprockets show orange, the 1x1 connector pin shows blue, etc.
const VEX_BEAM_LIGHT = '#c9ccd2' // plain 1x-wide beams (light silver)
const VEX_BEAM_GREY = '#95999f' // plain 2x-wide beams, corner beams, washers
const VEX_PLATE_DARK = '#3b3f45' // plates, wedges, chain/tread links, intake flaps
const VEX_CONNECTOR_GREY = '#cbccc8' // corner / chassis connectors (light warm grey)
const VEX_PIN_CHARCOAL = '#4c515a' // 1x2 / 2x2 / 0x2 / 0x3 connector pins, sheet pins
const VEX_STANDOFF_BLACK = '#24272c' // pitch standoffs + extenders
const VEX_RUBBER_BLACK = '#1e2024' // tires, shaft collars, spacers, cables
const VEX_SHAFT_STEEL = '#cfd3d8' // steel shafts (bare metal)
const VEX_PLASTIC_SHAFT = '#33373d' // capped plastic shafts
const VEX_SHEET_WHITE = '#e6e9ee' // clear PET sheets
const VEX_BLUE = '#1a7fd4' // structural/45° beams, gears, standoff connectors, 1x1 pin
const VEX_ORANGE = '#e8641c' // 30° beams, sprockets, spools, bands, 1x1 idler pin
const VEX_GREEN = '#8cc63f' // 60° beams, wye beam, ratchets/pawls, 0x2 idler pin

/** Returns the real VEX IQ color for a part, or null to keep its existing
 *  default (parts not shown on the printed inventory pages). */
function vexPartColor(def: PartDefinition): string | null {
  const n = def.name.toLowerCase()

  // ---- Rubber & soft goods (span several categories) ----
  // An "anchor" is the rigid plastic part a band or cable is tied to, not the
  // band or cable itself — it keeps its own color.
  const anchor = n.includes('anchor')
  if (!anchor && /(rubber band|rubber belt|silicone band|silicone belt)/.test(n))
    return VEX_ORANGE
  if (!anchor && /(shaft collar|pitch spacer|\bcable\b)/.test(n))
    return VEX_RUBBER_BLACK
  if (n.includes('plastic sheet')) return VEX_SHEET_WHITE
  if (/\bwasher\b/.test(n)) return VEX_BEAM_GREY

  // ---- Shafts (Axles) ----
  // Steel shafts are bare metal, plastic shafts are charcoal, and the plastic
  // MOTOR shafts are color-keyed by pitch on the sheet: 1–2x orange, 3x blue,
  // 4x green. Matched on "<n>x Pitch … Shaft" so a "Shaft Bushing" or a
  // "Rubber Shaft Collar" never reads as a shaft.
  if (/\bpitch\b.*\bshaft\b/.test(n)) {
    if (n.includes('plastic motor')) {
      if (/^4(\.\d+)?x\b/.test(n)) return VEX_GREEN
      if (/^3(\.\d+)?x\b/.test(n)) return VEX_BLUE
      return VEX_ORANGE
    }
    if (n.includes('plastic')) return VEX_PLASTIC_SHAFT
    return VEX_SHAFT_STEEL
  }

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
  if (n.includes('sheet pin')) return VEX_PIN_CHARCOAL
  if (n.includes('ball pin bushing')) return VEX_ORANGE
  if (n.includes('idler pulley')) return VEX_BLUE

  // ---- Drivetrain: gears blue, sprockets orange, rack/links dark ----
  if (/\bratchet\b|\bpawl\b/.test(n)) return VEX_GREEN
  if (/(chain link|traction link|attachment link|intake flap)/.test(n))
    return VEX_PLATE_DARK
  if (/\bspool\b/.test(n)) return VEX_ORANGE
  if (n.includes('shock absorber')) return VEX_PLATE_DARK
  if (def.category === 'Gears') {
    if (n.includes('sprocket')) return VEX_ORANGE
    // "2x7 Landing Gear Panel" is a body panel, not a gear.
    if (n.includes('panel')) return null
    if (/(rack gear|linear slide|tiebar)/.test(n)) return VEX_PLATE_DARK
    if (n.includes('gear')) return VEX_BLUE
    return null
  }

  // ---- Wheels: rubber tires black, hubs grey ----
  if (def.category === 'Wheels') {
    if (/\btire\b|\btread\b/.test(n)) return VEX_RUBBER_BLACK
    if (/\bhub\b/.test(n)) return VEX_BEAM_GREY
    return null
  }

  // ---- Beams & Plates ----
  if (def.category === 'Beams' || def.category === 'Plates') {
    // Angle beams are color-coded by their angle (data has a "degreee" typo,
    // which still contains "degree" as a substring). The 2x-wide 3x3 60° beam
    // is the sheet's one exception to the green rule — it prints blue.
    if (n.includes('60 degree') && n.includes('2x wide')) return VEX_BLUE
    if (n.includes('30 degree')) return VEX_ORANGE
    if (n.includes('60 degree')) return VEX_GREEN
    if (n.includes('45 degree')) return VEX_BLUE
    if (n.includes('delta tee')) return VEX_ORANGE
    if (/\bwye\b/.test(n)) return VEX_GREEN
    // Corner BEAMS are plain grey stock — only the corner CONNECTOR mouldings
    // below are the light-grey family, and neither is part of the blue
    // reinforcement family that the `corner` keyword otherwise sweeps up.
    if (n.includes('corner beam')) return VEX_BEAM_GREY
    // Reinforcement / structural beams are blue.
    if (/right angle|(^| )tee |lock beam|corner|gusset|truss beam/.test(n))
      return VEX_BLUE
    const rect = parseRectPart(def)
    if (rect) return rect.kind === 'Plate' ? VEX_PLATE_DARK : rect.width === 1 ? VEX_BEAM_LIGHT : VEX_BEAM_GREY
    // Non-rectangular plates (truss / 3-way / irregular) and the flat wedge /
    // trapezoid stock still take the plate color.
    if (/plate|wedge beam|trapezoid/.test(n)) return VEX_PLATE_DARK
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
