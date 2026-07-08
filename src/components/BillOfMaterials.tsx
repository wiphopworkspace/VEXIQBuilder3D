import { useMemo } from 'react'
import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'

const csvField = (value: string) => `"${value.replace(/"/g, '""')}"`

export default function BillOfMaterials() {
  const parts = useAssemblyStore((s) => s.parts)
  const projectName = useAssemblyStore((s) => s.projectName)

  const rows = useMemo(() => {
    // Count by partId, tracking name + collection for disambiguation.
    const counts = new Map<
      string,
      { name: string; collection?: string; partNumber?: string; count: number }
    >()
    for (const p of parts) {
      const def = getPartDefinition(p.partId)
      const name = def?.name ?? p.partId
      const existing = counts.get(p.partId)
      if (existing) existing.count += 1
      else
        counts.set(p.partId, {
          name,
          collection: def?.sourceCollection,
          partNumber: def?.partNumber,
          count: 1,
        })
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
        partNumber: r.partNumber,
        count: r.count,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [parts])

  // CSV parts list so a digital build maps back to a real VEX IQ kit
  // (same classroom purpose as RoboStem CAD's BOM export).
  const exportCsv = () => {
    const lines = [
      'Part,Part Number,Count',
      ...rows.map(
        (r) => `${csvField(r.label)},${csvField(r.partNumber ?? '')},${r.count}`,
      ),
    ]
    const blob = new Blob([lines.join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${projectName || 'assembly'}-parts.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <div className="panel-header bom-header">
        <span>Bill of Materials</span>
        {rows.length > 0 && (
          <button
            className="bom-export"
            onClick={exportCsv}
            title="Download the parts list as a CSV spreadsheet"
          >
            Export CSV
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="empty-hint">No parts in scene yet.</div>
      ) : (
        <>
          {rows.map((r) => (
            <div key={r.label} className="bom-row">
              <span>
                {r.label}
                {r.partNumber && <span className="bom-pn"> {r.partNumber}</span>}
              </span>
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
