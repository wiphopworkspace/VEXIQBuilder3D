import { useMemo, useState } from 'react'
import { CATEGORIES, PARTS } from '../data/parts'
import type { PartDefinition } from '../types/assembly'
import { groupRectFamilies, type PartFamily } from '../data/partFamilies'
import { useAssemblyStore } from '../store/assemblyStore'
import { usePartThumbnail } from '../hooks/usePartThumbnail'

/** dataTransfer key used to drag a part from the library into the viewport. */
export const PART_DND_MIME = 'application/x-vex-part'

// Thumbnail for a part card. Prefers a rendered GLB preview (generated lazily in
// the browser when the card scrolls into view); falls back to a pre-baked PNG if
// one exists, then to a category-colored glyph while/if neither is available.
function PartThumb({ def }: { def: PartDefinition }) {
  const canRender = def.hasConvertedModel === true && !!def.modelPath
  const { ref, src: rendered } = usePartThumbnail(
    def.modelPath,
    canRender,
    def.defaultColor,
  )
  const [bakedOk, setBakedOk] = useState(!!def.thumbnailPath)

  const shape = (() => {
    switch (def.procedural) {
      case 'beam':
        return <rect x="3" y="9" width="18" height="6" rx="1" />
      case 'pin':
        return <rect x="8" y="6" width="8" height="12" rx="3" />
      case 'axle':
        return <rect x="4" y="10" width="16" height="4" />
      case 'gear':
        return <circle cx="12" cy="12" r="7" />
      case 'wheel':
        return <circle cx="12" cy="12" r="8" />
      case 'motor':
        return <rect x="5" y="6" width="14" height="12" rx="1" />
      case 'connector':
        return <path d="M6 6 h6 v6 h6 v6 h-12 z" />
      default:
        return <rect x="6" y="6" width="12" height="12" />
    }
  })()

  const imgSrc =
    rendered ?? (def.thumbnailPath && bakedOk ? encodeURI(def.thumbnailPath) : null)

  return (
    <div ref={ref} className="part-thumb" style={{ background: '#0c0e12' }}>
      {imgSrc ? (
        <img
          src={imgSrc}
          alt={def.name}
          width={32}
          height={32}
          style={{ width: 32, height: 32, objectFit: 'contain' }}
          onError={() => setBakedOk(false)}
        />
      ) : (
        <svg width="24" height="24" viewBox="0 0 24 24" fill={def.defaultColor}>
          {shape}
        </svg>
      )}
    </div>
  )
}

function PartCard({ def }: { def: PartDefinition }) {
  const addPart = useAssemblyStore((s) => s.addPart)
  return (
    <div
      className="part-card"
      draggable
      onClick={() => addPart(def.id)}
      onDragStart={(e) => {
        e.dataTransfer.setData(PART_DND_MIME, def.id)
        e.dataTransfer.setData('text/plain', def.name)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      title={`Click to add, or drag ${def.name} into the scene`}
    >
      <PartThumb def={def} />
      <div className="meta">
        <span className="name">{def.name}</span>
        <span className="cat">
          {def.partNumber ? def.partNumber : def.category}
        </span>
      </div>
      <span className="drag-grip" aria-hidden>
        ⋮⋮
      </span>
    </div>
  )
}

// A single card standing in for a whole family of plain rectangular beams/plates
// of the same width (e.g. all "1x_ Beam" lengths). A length picker selects which
// variant the card adds; click adds it and drag places it, just like PartCard.
function FamilyCard({ family }: { family: PartFamily }) {
  const addPart = useAssemblyStore((s) => s.addPart)
  const [length, setLength] = useState(family.variants[0].length)
  const variant =
    family.variants.find((v) => v.length === length) ?? family.variants[0]
  const def = variant.def
  return (
    <div
      className="part-card family-card"
      draggable
      onClick={() => addPart(def.id)}
      onDragStart={(e) => {
        e.dataTransfer.setData(PART_DND_MIME, def.id)
        e.dataTransfer.setData('text/plain', def.name)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      title={`Click to add ${def.name}, or drag it into the scene`}
    >
      <PartThumb def={def} />
      <div className="meta">
        <span className="name">{family.label}</span>
        <span className="cat">{family.variants.length} sizes</span>
      </div>
      <select
        className="family-size"
        value={length}
        // Keep the dropdown from triggering the card's add-on-click / drag.
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => setLength(Number(e.target.value))}
        title="Choose length"
      >
        {family.variants.map((v) => (
          <option key={v.length} value={v.length}>
            {family.width}×{v.length}
          </option>
        ))}
      </select>
    </div>
  )
}

export default function PartsPanel() {
  const [search, setSearch] = useState('')
  const [activeCat, setActiveCat] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const q = search.trim().toLowerCase()
  const filtered = useMemo(() => {
    return PARTS.filter(
      (p) =>
        q === '' ||
        p.name.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.partNumber?.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q),
    )
  }, [q])

  const byCategory = useMemo(() => {
    const map = new Map<string, PartDefinition[]>()
    for (const cat of CATEGORIES) map.set(cat, [])
    for (const part of filtered) map.get(part.category)?.push(part)
    return map
  }, [filtered])

  // Rectangular-family grouping, computed once per filtered result (not per
  // render). Only categories that actually yield families (Beams/Plates) are
  // regrouped; the rest keep their original order.
  const groupedByCategory = useMemo(() => {
    const map = new Map<string, ReturnType<typeof groupRectFamilies>>()
    for (const cat of CATEGORIES) {
      map.set(cat, groupRectFamilies(byCategory.get(cat) ?? []))
    }
    return map
  }, [byCategory])

  // Categories that actually have results, honoring the active-category filter.
  const visibleCats = CATEGORIES.filter(
    (cat) =>
      (byCategory.get(cat)?.length ?? 0) > 0 &&
      (activeCat === null || activeCat === cat),
  )

  // While searching, auto-expand so matches are visible.
  const isOpen = (cat: string) => (q !== '' ? true : !collapsed[cat])
  const toggle = (cat: string) =>
    setCollapsed((c) => ({ ...c, [cat]: !c[cat] }))

  const totalShown = filtered.length

  return (
    <div className="panel">
      <div className="panel-header">Parts Library</div>

      <div className="parts-search">
        <input
          type="search"
          placeholder={`Search ${PARTS.length} parts…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Category quick-filter chips. */}
      <div className="cat-chips">
        <button
          className={`cat-chip${activeCat === null ? ' active' : ''}`}
          onClick={() => setActiveCat(null)}
        >
          All
        </button>
        {CATEGORIES.map((cat) => {
          const n = byCategory.get(cat)?.length ?? 0
          if (n === 0) return null
          return (
            <button
              key={cat}
              className={`cat-chip${activeCat === cat ? ' active' : ''}`}
              onClick={() => setActiveCat(activeCat === cat ? null : cat)}
              title={`${n} ${cat}`}
            >
              {cat} <span className="chip-count">{n}</span>
            </button>
          )
        })}
      </div>

      <div className="parts-hint">Click to add · drag into the scene to place</div>

      <div className="panel-scroll">
        {visibleCats.map((cat) => {
          const parts = byCategory.get(cat) ?? []
          const open = isOpen(cat)
          return (
            <div key={cat} className="cat-section">
              <button
                className="category-label cat-toggle"
                onClick={() => toggle(cat)}
                aria-expanded={open}
              >
                <span className={`caret${open ? ' open' : ''}`}>▶</span>
                {cat}
                <span className="cat-count">{parts.length}</span>
              </button>
              {open &&
                (() => {
                  const grouped = groupedByCategory.get(cat)
                  // Browsing a category with rectangular families: collapse them
                  // into width family cards, then the remaining singles.
                  if (q === '' && grouped && grouped.families.length > 0) {
                    return (
                      <>
                        {grouped.families.map((fam) => (
                          <FamilyCard key={fam.key} family={fam} />
                        ))}
                        {grouped.singles.map((def) => (
                          <PartCard key={def.id} def={def} />
                        ))}
                      </>
                    )
                  }
                  // No families (other categories) or searching: original order,
                  // every match shown individually so an exact size is visible.
                  return parts.map((def) => <PartCard key={def.id} def={def} />)
                })()}
            </div>
          )
        })}
        {totalShown === 0 && (
          <div className="empty-hint">No parts match “{search}”.</div>
        )}
      </div>
    </div>
  )
}
