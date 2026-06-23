import { useMemo } from 'react'
import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'

export default function BillOfMaterials() {
  const parts = useAssemblyStore((s) => s.parts)

  const rows = useMemo(() => {
    // Count by partId, tracking name + collection for disambiguation.
    const counts = new Map<
      string,
      { name: string; collection?: string; count: number }
    >()
    for (const p of parts) {
      const def = getPartDefinition(p.partId)
      const name = def?.name ?? p.partId
      const existing = counts.get(p.partId)
      if (existing) existing.count += 1
      else counts.set(p.partId, { name, collection: def?.sourceCollection, count: 1 })
    }
    // Find names shared by more than one distinct part id.
    const nameFreq = new Map<string, number>()
    for (const r of counts.values()) {
      nameFreq.set(r.name, (nameFreq.get(r.name) ?? 0) + 1)
    }
    return Array.from(counts.values())
      .map((r) => ({
        // Append the collection only when the name alone is ambiguous.
        label:
          (nameFreq.get(r.name) ?? 0) > 1 && r.collection
            ? `${r.name} (${r.collection})`
            : r.name,
        count: r.count,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [parts])

  return (
    <div>
      <div className="panel-header">Bill of Materials</div>
      {rows.length === 0 ? (
        <div className="empty-hint">No parts in scene yet.</div>
      ) : (
        <>
          {rows.map((r) => (
            <div key={r.label} className="bom-row">
              <span>{r.label}</span>
              <span className="bom-count">{r.count}</span>
            </div>
          ))}
          <div className="bom-total">
            <span>Total parts</span>
            <span>{parts.length}</span>
          </div>
        </>
      )}
    </div>
  )
}
