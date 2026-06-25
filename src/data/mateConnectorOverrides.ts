import type { PartDefinition } from '../types/assembly'
import type { MateConnectorDefinition } from '../types/mate'

/**
 * Curated CAD-lite Mate Connector overrides.
 *
 * These are PART-LOCAL connector frames for special VEX IQ parts whose useful
 * mating frames cannot be generated confidently from a simple beam/plate/pin
 * pattern. They are intentionally separate from `snapOverrides.ts`: snap points
 * remain the source for Auto Snap / Joint Mode / Pin Mode, while these
 * connector frames feed the Advanced Mate Connector workflow.
 *
 * Do not copy geometry from LDCadVEX or STEP. Store only lightweight connector
 * metadata measured/verified in the app's center-origin GLB frame.
 */
export const MATE_CONNECTOR_OVERRIDES: Record<
  string,
  MateConnectorDefinition[]
> = {
  // Add verified special-part connector frames here as they are measured.
  // Example shape:
  // 'special-part-id': [
  //   {
  //     id: 'mount-hole-a',
  //     origin: [0, 0, 0.12],
  //     axisZ: [0, 0, 1],
  //     axisY: [0, 1, 0],
  //     type: 'hole',
  //     compatibleWith: ['pin', 'manual', 'surface'],
  //     quality: 'verified',
  //     source: 'curated',
  //     snapId: 'hole-a',
  //   },
  // ],
}

const PART_NUMBER_RE = /(\d{3}-\d{3,4}-\d+)/

function partNumberOf(def: PartDefinition): string | undefined {
  return def.partNumber ?? `${def.id} ${def.name}`.match(PART_NUMBER_RE)?.[1]
}

export function getMateConnectorOverrideDefinitions(
  def: PartDefinition,
): MateConnectorDefinition[] {
  const partNumber = partNumberOf(def)
  return [
    ...(MATE_CONNECTOR_OVERRIDES[def.id] ?? []),
    ...(partNumber ? (MATE_CONNECTOR_OVERRIDES[partNumber] ?? []) : []),
  ]
}
