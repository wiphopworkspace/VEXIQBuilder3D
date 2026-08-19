import { useMemo, useState } from 'react'
import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'
import { getSnapPoints } from '../data/snapOverrides'
import { stationSeriesFor } from '../utils/shaftSlide'
import { ridersForShaft } from '../utils/shaftCatalog'
import type { PartDefinition, PartInstanceData } from '../types/assembly'

/**
 * "Put something on this shaft" — the other half of the motor-drive flow.
 *
 * Fitting the shaft to the motor is only step one; the build is not a drive
 * until a gear or a wheel is on the shaft, and that step had the same problem
 * the socket had: the target is a marker a few pixels wide on a thin cylinder,
 * reachable only by dragging the part across the scene or by hunting for it in
 * Joint Mode. Choosing a part and a numbered position instead makes the whole
 * motor → shaft → gear chain three clicks, and it drops the new part exactly
 * where `ShaftPositionPanel` can then slide it.
 *
 * The station select is deliberately visible rather than automatic: the numbers
 * it shows are the same ones the slide control uses, so the first time a user
 * fits a gear they learn what "position 2 of 4" means.
 */
export default function ShaftBuildPanel({
  instance,
  definition,
}: {
  instance: PartInstanceData
  definition: PartDefinition
}) {
  const parts = useAssemblyStore((s) => s.parts)
  const connections = useAssemblyStore((s) => s.connections)
  const insertPartAtSnapPoint = useAssemblyStore((s) => s.insertPartAtSnapPoint)

  // Every station on this shaft, with whatever is already sitting on it.
  const stations = useMemo(() => {
    const first = getSnapPoints(definition).find((s) => s.type === 'axle')
    if (!first) return []
    const series = stationSeriesFor(definition, first.id)
    if (!series) return []
    const taken = new Map<string, string>()
    for (const c of connections) {
      if (c.aInstanceId === instance.instanceId) taken.set(c.aSnapId, c.bInstanceId)
      if (c.bInstanceId === instance.instanceId) taken.set(c.bSnapId, c.aInstanceId)
    }
    return series.stations.map((s) => {
      const occupiedBy = taken.get(s.snapId) ?? null
      const occupant = occupiedBy
        ? parts.find((p) => p.instanceId === occupiedBy)
        : undefined
      return {
        snapId: s.snapId,
        occupiedBy,
        occupantName: occupant
          ? (getPartDefinition(occupant.partId)?.name ?? 'another part')
          : null,
      }
    })
  }, [definition, connections, parts, instance.instanceId])

  const riders = useMemo(() => ridersForShaft(), [])
  const firstFree = stations.find((s) => !s.occupiedBy)
  const [pick, setPick] = useState<string>(() => riders[0]?.choices[0]?.partId ?? '')
  const [station, setStation] = useState<string>('')
  const chosenStation =
    stations.find((s) => s.snapId === station && !s.occupiedBy)?.snapId ??
    firstFree?.snapId ??
    ''

  if (stations.length === 0) return null

  const freeCount = stations.filter((s) => !s.occupiedBy).length

  return (
    <div className="prop-section">
      <div className="prop-row">
        <span className="label">Add to Shaft</span>
        <span className="value" style={{ color: 'var(--text-dim)' }}>
          {freeCount} of {stations.length} free
        </span>
      </div>

      {freeCount === 0 ? (
        <div className="prop-row">
          <span className="value" style={{ color: 'var(--text-dim)' }}>
            Every position on this shaft is taken.
          </span>
        </div>
      ) : (
        <>
          <select
            style={{ width: '100%', marginTop: 4 }}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            title="A part with a bore that fits this shaft"
          >
            {riders.map((group) => (
              <optgroup key={group.category} label={group.category}>
                {group.choices.map((c) => (
                  <option key={c.partId} value={c.partId}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <select
            style={{ width: '100%', marginTop: 4 }}
            value={chosenStation}
            onChange={(e) => setStation(e.target.value)}
            title="Which position along the shaft to drop it on"
          >
            {stations.map((s, i) => (
              <option key={s.snapId} value={s.snapId} disabled={!!s.occupiedBy}>
                {`Position ${i + 1} of ${stations.length}`}
                {s.occupantName ? ` — taken by ${s.occupantName}` : ''}
              </option>
            ))}
          </select>
          <button
            style={{ width: '100%', marginTop: 6 }}
            disabled={!pick || !chosenStation}
            onClick={() =>
              insertPartAtSnapPoint(
                instance.instanceId,
                chosenStation,
                pick,
                { label: 'Fit To Shaft' },
              )
            }
            title="Add the part and seat it at that position on the shaft"
          >
            Fit onto shaft
          </button>
          <div className="prop-row" style={{ marginTop: 6 }}>
            <span className="value" style={{ color: 'var(--text-dim)' }}>
              Select the fitted part to slide it along the shaft with [ and ].
            </span>
          </div>
        </>
      )}
    </div>
  )
}
