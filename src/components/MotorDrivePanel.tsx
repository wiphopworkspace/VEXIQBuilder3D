import { useMemo, useState } from 'react'
import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'
import { getSnapPoints } from '../data/snapOverrides'
import { defaultShaftFor, insertableShaftsFor } from '../utils/shaftCatalog'
import type { PartDefinition, PartInstanceData } from '../types/assembly'

/**
 * The Smart Motor's drive socket, given its own control.
 *
 * A motor with a shaft in it is the first thing almost every VEX IQ build
 * needs, and it was the hardest joint in the app to make: the socket is one
 * 0.148 square opening on the motor's TOP face, surrounded by eleven mounting
 * holes that look the same from any normal camera distance, and reaching it
 * meant switching to Joint Mode, finding that marker, then finding the right
 * END of a shaft that had to be dragged in from somewhere else first. Users
 * could build an idea; they could not build a drivetrain without a lesson.
 *
 * Picking a length from a list is the whole interaction now. The seat itself is
 * unchanged — `insertPartAtSnapPoint` runs the same `computeSnapTransform` that
 * Joint Mode and Auto Snap run, so a shaft placed from here lands exactly where
 * a hand-made joint would put it (locked by `verify:slide` section 9).
 */
export default function MotorDrivePanel({
  instance,
  definition,
}: {
  instance: PartInstanceData
  definition: PartDefinition
}) {
  const connections = useAssemblyStore((s) => s.connections)
  const parts = useAssemblyStore((s) => s.parts)
  const insertPartAtSnapPoint = useAssemblyStore((s) => s.insertPartAtSnapPoint)
  const selectPart = useAssemblyStore((s) => s.selectPart)

  const socket = useMemo(
    () => getSnapPoints(definition).find((s) => s.type === 'motorShaft'),
    [definition],
  )
  const choices = useMemo(
    () => (socket ? insertableShaftsFor(socket.type) : []),
    [socket],
  )
  const [pick, setPick] = useState<string>(
    () => (socket ? defaultShaftFor(socket.type) : null) ?? '',
  )

  const seated = useMemo(() => {
    if (!socket) return null
    const mate = connections.find(
      (c) =>
        (c.aInstanceId === instance.instanceId && c.aSnapId === socket.id) ||
        (c.bInstanceId === instance.instanceId && c.bSnapId === socket.id),
    )
    if (!mate) return null
    const otherId =
      mate.aInstanceId === instance.instanceId
        ? mate.bInstanceId
        : mate.aInstanceId
    const other = parts.find((p) => p.instanceId === otherId)
    return other
      ? { instanceId: otherId, name: getPartDefinition(other.partId)?.name ?? otherId }
      : null
  }, [socket, connections, parts, instance.instanceId])

  if (!socket) return null

  return (
    <div className="prop-section">
      <div className="prop-row">
        <span className="label">Motor Drive</span>
        <span
          className="value"
          style={{ color: seated ? 'var(--green)' : 'var(--text-dim)' }}
        >
          {seated ? 'shaft fitted' : 'socket empty'}
        </span>
      </div>

      {seated ? (
        <>
          <div className="prop-row">
            <span className="value">{seated.name}</span>
          </div>
          <button
            style={{ width: '100%', marginTop: 6 }}
            onClick={() => selectPart(seated.instanceId)}
            title="Select the shaft to slide gears and wheels along it"
          >
            Select the shaft
          </button>
          <div className="prop-row" style={{ marginTop: 6 }}>
            <span className="value" style={{ color: 'var(--text-dim)' }}>
              Snap a gear or wheel onto the shaft, then use Shaft Position to
              slide it up and down.
            </span>
          </div>
        </>
      ) : (
        <>
          <select
            style={{ width: '100%', marginTop: 4 }}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            title="Shaft length, in hole pitches"
          >
            {choices.map((c) => (
              <option key={c.partId} value={c.partId}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            style={{ width: '100%', marginTop: 6 }}
            disabled={!pick}
            onClick={() =>
              insertPartAtSnapPoint(instance.instanceId, socket.id, pick, {
                label: 'Fit Motor Shaft',
                status: `Shaft fitted into ${definition.name} — it is seated and ready to drive.`,
              })
            }
            title="Add the shaft and seat it in the motor's drive socket"
          >
            Fit shaft into motor
          </button>
        </>
      )}
    </div>
  )
}
