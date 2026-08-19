import { useMemo } from 'react'
import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'
import {
  findShaftSlide,
  slideStepDistance,
  type ShaftSlideContext,
} from '../utils/shaftSlide'

/**
 * "Where on the shaft does this sit?" — the control the shaft system was
 * missing.
 *
 * Every other mate in the builder is a placement: a pin picks a hole and that
 * is the end of it. A shaft mate is a placement PLUS a slide, because a real
 * gear is pushed up and down its axle until the mesh is right. The app already
 * knew the legal positions (`axle` stations, one per hole pitch) and the only
 * way to change which one a part used was to pull the part off and re-aim at a
 * different marker in 3D — a two-step teardown for what is one push in the
 * hand.
 *
 * So this is a stepper, not a slider: the positions are discrete and the
 * readout says which one of how many, the same way the physical part clicks
 * onto the next hole pitch. The station strip is there because "third from the
 * motor" is how a build is actually described, and jumping straight to it beats
 * pressing an arrow four times.
 */

function useShaftSlide(instanceId: string | null): ShaftSlideContext | null {
  const parts = useAssemblyStore((s) => s.parts)
  const connections = useAssemblyStore((s) => s.connections)
  const activeMateId = useAssemblyStore((s) => s.activeMateId)
  return useMemo(() => {
    if (!instanceId) return null
    return findShaftSlide(
      instanceId,
      parts,
      connections,
      activeMateId[instanceId],
    )
  }, [instanceId, parts, connections, activeMateId])
}

function nameOfInstance(instanceId: string): string {
  const inst = useAssemblyStore
    .getState()
    .parts.find((p) => p.instanceId === instanceId)
  const def = inst ? getPartDefinition(inst.partId) : undefined
  return def?.name ?? instanceId
}

export default function ShaftPositionPanel() {
  const selectedId = useAssemblyStore((s) => s.selectedInstanceId)
  const slideAlongShaft = useAssemblyStore((s) => s.slideAlongShaft)
  const slideToShaftStation = useAssemblyStore((s) => s.slideToShaftStation)
  const context = useShaftSlide(selectedId)

  if (!selectedId || !context) return null

  const total = context.stations.length
  const moverName = nameOfInstance(context.moverInstanceId)
  const shaftName = getPartDefinition(context.shaftPartId)?.name ?? 'shaft'
  const backStep = slideStepDistance(context, -1)
  const forwardStep = slideStepDistance(context, 1)
  const carried = context.moverIds.length

  // A 24x Pitch Shaft has 24 stations. At finger size that is a strip taller
  // than the rest of the panel, so past a dozen the cells shrink — measured on
  // a 24x shaft: 24 cells wrap to 171px in a 279px desktop panel, and would
  // have been ~480px at the 40px coarse-pointer size.
  const compact = context.stations.length > 12

  // The strip is numbered along the SHAFT, so "position 1" is always the same
  // end of the physical part no matter which side is doing the moving.
  const stationButtons = context.stations.map((station, i) => {
    const current = i === context.index
    const blocked = !!station.occupiedBy
    return (
      <button
        key={station.snapId}
        className={`shaft-station${current ? ' current' : ''}${
          blocked ? ' blocked' : ''
        }${compact ? ' compact' : ''}`}
        disabled={context.looped || (blocked && !current)}
        title={
          current
            ? `${moverName} is here (position ${i + 1} of ${total})`
            : blocked
              ? `Taken by ${nameOfInstance(station.occupiedBy!)}`
              : `Move ${moverName} to position ${i + 1} of ${total}`
        }
        onClick={() => slideToShaftStation(selectedId, i)}
      >
        {i + 1}
      </button>
    )
  })

  return (
    <div className="prop-section">
      <div className="prop-row">
        <span className="label">Shaft Position</span>
        <span className="value" style={{ color: 'var(--green)' }}>
          {context.index + 1} / {total}
        </span>
      </div>
      <div className="prop-row">
        <span className="value" style={{ color: 'var(--text-dim)' }}>
          {context.moverIsShaft
            ? `Sliding the ${shaftName} through ${nameOfInstance(
                context.riderInstanceId,
              )}`
            : `${moverName} on the ${shaftName}`}
        </span>
      </div>

      {context.looped ? (
        <div className="warn-box" style={{ marginTop: 6 }}>
          Held by a second joint as well — detach one of them before sliding
          along the shaft.
        </div>
      ) : (
        <>
          <div className="shaft-slide-row">
            <button
              className="shaft-slide-btn"
              disabled={backStep === 0}
              title={
                backStep === 0
                  ? 'Already at the end of the shaft'
                  : `Slide ${moverName} back ${backStep.toFixed(2)} along the shaft ( [ )`
              }
              onClick={() => slideAlongShaft(selectedId, -1)}
            >
              ◀ {backStep > 0 ? backStep.toFixed(2) : '—'}
            </button>
            <div className="shaft-station-strip">{stationButtons}</div>
            <button
              className="shaft-slide-btn"
              disabled={forwardStep === 0}
              title={
                forwardStep === 0
                  ? 'Already at the end of the shaft'
                  : `Slide ${moverName} forward ${forwardStep.toFixed(2)} along the shaft ( ] )`
              }
              onClick={() => slideAlongShaft(selectedId, 1)}
            >
              {forwardStep > 0 ? forwardStep.toFixed(2) : '—'} ▶
            </button>
          </div>
          <div className="prop-row">
            <span className="value" style={{ color: 'var(--text-dim)' }}>
              One step = one hole pitch. Keyboard: [ and ]
              {carried > 1 ? ` · moves ${carried} parts together` : ''}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
