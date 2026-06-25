// Identifies plain rectangular beams/plates (e.g. "1x4 Beam", "2x6 Plate") and
// groups same-width variants into a single selectable family for the Parts
// Library. This is the single source of truth for "is this a plain NxM
// beam/plate" — the snap-grid resolver (parsePlainRectGrid in snapOverrides)
// delegates here so the panel grouping and the staggered hole grid never drift.

import type { PartDefinition } from '../types/assembly'

export type RectKind = 'Beam' | 'Plate'
export type RectPart = {
  kind: RectKind
  width: number
  length: number
  // True only for a bare "WxL Beam"/"WxL Plate" name (no trailing descriptor).
  // The snap grid accepts trailing words (a "2x6 Beam with Chamferred Ends"
  // still has a 2x6 hole grid); the Parts Library only collapses exact names so
  // the family dropdown doesn't list the same size twice.
  exact: boolean
}

// Specialty descriptors that disqualify a part from being a plain rectangle even
// though it starts with an NxM dimension (e.g. "2x2 45 Degree Beam").
const SPECIAL_RE =
  /(gear|socket|ball|hook|lock|crank|fork|spider|truss|wedge|delta|tee|angle|corner|degree|triangle|diagonal|landing|ballista|linear|offset)/

/**
 * Returns the kind/width/length for a plain rectangular beam or plate, or null
 * for anything else (specialty shapes, non-rect parts, out-of-range dims).
 */
export function parseRectPart(def: PartDefinition): RectPart | null {
  if (def.category !== 'Beams' && def.category !== 'Plates') return null
  // The dimension must be immediately followed by "Beam"/"Plate"; specials like
  // "2x2 45 Degree Beam" or "1x3 Center Lock Beam" therefore won't match.
  const m = def.name.trim().match(/^(\d+)\s*x\s*(\d+)\s+(beam|plate)\b(.*)$/i)
  if (!m) return null
  if (SPECIAL_RE.test(m[4].toLowerCase())) return null
  const width = parseInt(m[1], 10)
  const length = parseInt(m[2], 10)
  if (width < 1 || length < 1 || width > 24 || length > 24) return null
  return {
    kind: m[3].toLowerCase() === 'plate' ? 'Plate' : 'Beam',
    width,
    length,
    exact: m[4].trim() === '',
  }
}

export type PartFamily = {
  key: string
  kind: RectKind
  width: number
  label: string // e.g. "1×_ Beam"
  variants: Array<{ length: number; def: PartDefinition }> // sorted by length
}

/**
 * Splits a list of parts into rectangular families (same kind + width, with 2+
 * lengths) and leftover single parts. A lone rectangular variant stays a single
 * card. Families are sorted by kind then width; singles by natural name order.
 */
export function groupRectFamilies(parts: PartDefinition[]): {
  families: PartFamily[]
  singles: PartDefinition[]
} {
  const famMap = new Map<string, PartFamily>()
  const singles: PartDefinition[] = []
  for (const def of parts) {
    const rect = parseRectPart(def)
    // Only collapse bare "WxL Beam" names; descriptive variants stay standalone.
    if (!rect || !rect.exact) {
      singles.push(def)
      continue
    }
    const key = `${rect.kind}-${rect.width}`
    let fam = famMap.get(key)
    if (!fam) {
      fam = {
        key,
        kind: rect.kind,
        width: rect.width,
        label: `${rect.width}×_ ${rect.kind}`,
        variants: [],
      }
      famMap.set(key, fam)
    }
    fam.variants.push({ length: rect.length, def })
  }

  const families: PartFamily[] = []
  for (const fam of famMap.values()) {
    fam.variants.sort((a, b) => a.length - b.length)
    if (fam.variants.length >= 2) families.push(fam)
    else singles.push(fam.variants[0].def) // a lone rect isn't worth a picker
  }

  families.sort((a, b) =>
    a.kind === b.kind ? a.width - b.width : a.kind < b.kind ? -1 : 1,
  )
  singles.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  )
  return { families, singles }
}
