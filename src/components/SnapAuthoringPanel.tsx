import { useAssemblyStore } from '../store/assemblyStore'
import { getPartDefinition } from '../data/parts'
import { getSnapPointResolution, snapMetadataLabel } from '../data/snapOverrides'
import { matchPinProfile } from '../data/pinProfiles'
import { SNAP_CALIBRATION } from '../data/snapCalibration'
import {
  authoredOverrideSnippet,
  getAuthoredSnapOverride,
  hasAuthoredSnapOverride,
  mirrorSnapPoint,
  roundCoord,
  stripResolutionFields,
  uniqueSnapId,
  withDerivedFrames,
} from '../data/authoredSnapOverrides'
import type {
  SnapPointDefinition,
  SnapPointType,
  Vec3,
} from '../types/assembly'

const SNAP_TYPES: SnapPointType[] = [
  'hole',
  'pin',
  'axle',
  'axleHole',
  'connector',
  'motorShaft',
  'wheelCenter',
  'gearCenter',
]

const ROLES: NonNullable<SnapPointDefinition['role']>[] = [
  'receive',
  'insert',
  'center',
  'surface',
  'shoulder',
]

const AXIS_PRESETS: { label: string; value: Vec3 }[] = [
  { label: '+X', value: [1, 0, 0] },
  { label: '-X', value: [-1, 0, 0] },
  { label: '+Y', value: [0, 1, 0] },
  { label: '-Y', value: [0, -1, 0] },
  { label: '+Z', value: [0, 0, 1] },
  { label: '-Z', value: [0, 0, -1] },
]

function axisPresetLabel(v: Vec3 | undefined): string {
  if (!v) return 'none'
  const preset = AXIS_PRESETS.find((a) =>
    a.value.every((n, i) => Math.abs(n - v[i]) < 1e-6),
  )
  return preset?.label ?? 'custom'
}

function formatVec(v: Vec3 | undefined): string {
  if (!v) return '—'
  return `[${v.map((n) => Number(n.toFixed(3))).join(', ')}]`
}

function Vec3Field({
  label,
  value,
  step,
  onChange,
}: {
  label: string
  value: Vec3
  step: number
  onChange: (next: Vec3) => void
}) {
  return (
    <label className="mate-field">
      <span>{label}</span>
      <div className="author-vec3">
        {([0, 1, 2] as const).map((i) => (
          <input
            key={i}
            type="number"
            step={step}
            value={Number(value[i].toFixed(4))}
            onChange={(e) => {
              const n = parseFloat(e.target.value)
              if (!Number.isFinite(n)) return
              const next: Vec3 = [...value]
              next[i] = n
              onChange(next)
            }}
          />
        ))}
      </div>
    </label>
  )
}

/**
 * Visual Snap Authoring Tool (Advanced Mode). Edits a browser-local snap-point
 * set for the selected part's DEFINITION (all instances). The set is served by
 * `getSnapPointResolution` above every other layer, so edits are immediately
 * live in Auto Snap / Joint Mode / Pin Mode — testing IS the preview. Export
 * produces a paste-ready SNAP_OVERRIDES entry for `snapOverrides.ts`.
 *
 * Pins are deliberately not authorable here: their calibration lives in
 * `pinProfiles.ts` + the Properties panel's pin-seat overrides.
 */
export default function SnapAuthoringPanel() {
  const snapAuthoring = useAssemblyStore((s) => s.snapAuthoring)
  const easyMode = useAssemblyStore((s) => s.easyMode)
  const selectedId = useAssemblyStore((s) => s.selectedInstanceId)
  const parts = useAssemblyStore((s) => s.parts)
  const selectedSnapId = useAssemblyStore((s) => s.authoringSelectedSnapId)
  const setSelectedSnapId = useAssemblyStore(
    (s) => s.setAuthoringSelectedSnapId,
  )
  const surfacePick = useAssemblyStore((s) => s.authoringSurfacePick)
  const setSurfacePick = useAssemblyStore((s) => s.setAuthoringSurfacePick)
  const setAuthored = useAssemblyStore((s) => s.setAuthoredSnapPointsForPart)
  const clearAuthored = useAssemblyStore(
    (s) => s.clearAuthoredSnapPointsForPart,
  )
  const setStatus = useAssemblyStore((s) => s.setStatus)
  useAssemblyStore((s) => s.snapAuthoringVersion)

  if (!snapAuthoring || easyMode) return null

  const instance = parts.find((p) => p.instanceId === selectedId) ?? null
  const def = instance ? getPartDefinition(instance.partId) : null

  if (!instance || !def) {
    return (
      <div className="snap-author">
        <div className="mate-editor-header">Snap Authoring</div>
        <div className="snap-author-body">
          <div className="mate-hint">
            Select a part in the viewport (or drop one in from the Parts
            Library) to view and edit its snap points. Edits apply to every
            instance of the part and are saved in this browser; export the JSON
            to make them permanent in <code>snapOverrides.ts</code>.
          </div>
        </div>
      </div>
    )
  }

  const pinProfile = matchPinProfile(def)
  if (pinProfile) {
    return (
      <div className="snap-author">
        <div className="mate-editor-header">Snap Authoring — {def.name}</div>
        <div className="snap-author-body">
          <div className="mate-hint">
            This part matches the pin profile “{pinProfile.displayName}”. Pins
            are calibrated through the pin-profile system and the Properties
            panel's Snap Depth Calibration (“Save as pin default”) — not the
            authoring tool. Select a beam, connector, or specialty part instead.
          </div>
        </div>
      </div>
    )
  }

  const resolution = getSnapPointResolution(def)
  const authored = hasAuthoredSnapOverride(def.id)
  const snaps = authored
    ? getAuthoredSnapOverride(def.id) ?? []
    : resolution.snapPoints
  const selectedIndex = snaps.findIndex((sp) => sp.id === selectedSnapId)
  const selected = selectedIndex >= 0 ? snaps[selectedIndex] : null

  const startEditing = () => {
    setAuthored(
      def.id,
      stripResolutionFields(resolution.snapPoints),
      `Editing a copy of ${def.name}'s ${snapMetadataLabel(
        resolution.source,
      ).toLowerCase()} snap points — changes are live for all its instances`,
    )
  }

  const save = (next: SnapPointDefinition[], status?: string) =>
    setAuthored(def.id, next, status)

  const patchSelected = (
    patch: Partial<SnapPointDefinition>,
    derive = true,
  ) => {
    if (!selected) return
    const merged = { ...selected, ...patch }
    const next = [...snaps]
    next[selectedIndex] = derive ? withDerivedFrames(merged) : merged
    save(next)
  }

  const renameSelected = (id: string) => {
    if (!selected) return
    const trimmed = id.trim()
    if (!trimmed || trimmed === selected.id) return
    if (snaps.some((sp, i) => i !== selectedIndex && sp.id === trimmed)) {
      setStatus(`A snap point named "${trimmed}" already exists on this part`)
      return
    }
    patchSelected({ id: trimmed }, false)
    setSelectedSnapId(trimmed)
  }

  const setAxisPreset = (label: string) => {
    if (!selected) return
    const preset = AXIS_PRESETS.find((a) => a.label === label)
    if (!preset) return
    const axis = preset.value
    // Receiving points face outward against the insertion axis; everything
    // else points the way it inserts (the beam-grid / pin conventions).
    const normal: Vec3 =
      selected.role === 'receive'
        ? [-axis[0], -axis[1], -axis[2]]
        : axis
    patchSelected({ axis, normal })
  }

  const addAtOrigin = () => {
    const id = uniqueSnapId('auth-point', snaps)
    const point = withDerivedFrames({
      id,
      type: 'hole',
      role: 'receive',
      position: [0, 0, 0],
      axis: [0, 0, -1],
      normal: [0, 0, 1],
      receivingDepth: SNAP_CALIBRATION.defaultBeamHoleDepth,
      occupancyGroup: id,
      compatibleWith: ['pin', 'connector'],
    })
    save([...snaps, point], `Added "${id}" at the part origin`)
    setSelectedSnapId(id)
  }

  const duplicateSelected = () => {
    if (!selected) return
    const id = uniqueSnapId(selected.id, snaps)
    const copy = withDerivedFrames({
      ...selected,
      id,
      position: [
        roundCoord(selected.position[0] + 0.25),
        selected.position[1],
        selected.position[2],
      ],
      occupancyGroup: id,
    })
    save([...snaps, copy], `Duplicated "${selected.id}" → "${id}" (offset +0.25 X)`)
    setSelectedSnapId(id)
  }

  const mirrorSelected = () => {
    if (!selected) return
    const mirrored = mirrorSnapPoint(selected, snaps)
    if (!mirrored) {
      setStatus('This point has no axis/normal to mirror across')
      return
    }
    // The pair shares one occupancy group so the two faces behave as a single
    // physical through-hole.
    const next = [...snaps]
    next[selectedIndex] = {
      ...selected,
      occupancyGroup: selected.occupancyGroup ?? selected.id,
    }
    next.push(mirrored)
    save(
      next,
      `Mirrored "${selected.id}" → "${mirrored.id}" (shared occupancy group)`,
    )
    setSelectedSnapId(mirrored.id)
  }

  const deleteSelected = () => {
    if (!selected) return
    const next = snaps.filter((_, i) => i !== selectedIndex)
    save(next, `Deleted snap point "${selected.id}"`)
    setSelectedSnapId(null)
  }

  const snapToGrid = () => {
    if (!selected) return
    const grid = (n: number) => Math.round(n / 0.25) * 0.25
    patchSelected({
      position: [
        grid(selected.position[0]),
        grid(selected.position[1]),
        grid(selected.position[2]),
      ],
    })
  }

  const copySnippet = async () => {
    const snippet = authoredOverrideSnippet(def.id)
    if (!snippet) {
      setStatus('Nothing authored to export yet — click "Edit a copy" first')
      return
    }
    try {
      await navigator.clipboard.writeText(snippet)
      setStatus(
        `Copied a SNAP_OVERRIDES entry for "${def.id}" — paste it into snapOverrides.ts`,
      )
    } catch {
      setStatus('Clipboard unavailable — use Download JSON instead')
    }
  }

  const downloadJson = () => {
    const data = getAuthoredSnapOverride(def.id)
    if (!data) return
    const blob = new Blob(
      [JSON.stringify(stripResolutionFields(data), null, 2)],
      { type: 'application/json' },
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${def.id}.snapPoints.json`
    a.click()
    URL.revokeObjectURL(url)
    setStatus(`Downloaded ${def.id}.snapPoints.json`)
  }

  const revert = () => {
    if (
      window.confirm(
        `Discard the authored snap points for "${def.name}" and go back to the built-in metadata?`,
      )
    ) {
      clearAuthored(def.id)
    }
  }

  return (
    <div className="snap-author">
      <div className="mate-editor-header">Snap Authoring — {def.name}</div>
      <div className="snap-author-body">
        <div className="mate-endpoints">
          <div>
            <span className="label">Part</span>
            <span className="value">
              {def.name}
              {def.partNumber ? ` (${def.partNumber})` : ''}
            </span>
          </div>
          <div>
            <span className="label">Metadata</span>
            <span className="value">
              {snapMetadataLabel(resolution.source)}
              {authored ? ' · authored in this browser' : ''} ·{' '}
              {snaps.length} point{snaps.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        {!authored ? (
          <>
            <div className="mate-hint">
              You're viewing the built-in snap points. “Edit a copy” makes a
              browser-local working set (served to Auto Snap, Joint Mode, and
              Pin Mode instantly), which you can then export as JSON for{' '}
              <code>snapOverrides.ts</code>.
            </div>
            <div className="mate-actions">
              <button className="primary" onClick={startEditing}>
                Edit a copy
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="snap-author-list">
              {snaps.map((sp) => (
                <button
                  key={sp.id}
                  className={`snap-author-row${
                    sp.id === selectedSnapId ? ' active' : ''
                  }`}
                  onClick={() =>
                    setSelectedSnapId(sp.id === selectedSnapId ? null : sp.id)
                  }
                  title={`${sp.type}${sp.role ? ` · ${sp.role}` : ''} at ${formatVec(sp.position)}`}
                >
                  <span className="snap-author-row-id">{sp.id}</span>
                  <span className="snap-author-row-meta">
                    {sp.type} {formatVec(sp.position)}
                  </span>
                </button>
              ))}
              {snaps.length === 0 && (
                <div className="mate-hint">
                  No snap points yet — add one below or pick on the surface.
                </div>
              )}
            </div>

            <div className="mate-actions">
              <button onClick={addAtOrigin}>+ At origin</button>
              <button
                className={surfacePick ? 'primary' : undefined}
                onClick={() => setSurfacePick(!surfacePick)}
                title="Arm, then click the selected part's surface to place a snap point at the hit position (Esc cancels)"
              >
                {surfacePick ? 'Click the part…' : '+ Pick on surface'}
              </button>
            </div>

            {selected && (
              <div className="snap-author-editor">
                <div className="mate-editor-subhead">
                  Edit “{selected.id}”
                </div>
                <div className="mate-grid">
                  <label className="mate-field">
                    <span>Id</span>
                    <input
                      type="text"
                      defaultValue={selected.id}
                      key={selected.id}
                      onBlur={(e) => renameSelected(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          renameSelected((e.target as HTMLInputElement).value)
                        }
                      }}
                    />
                  </label>
                  <label className="mate-field">
                    <span>Type</span>
                    <select
                      value={selected.type}
                      onChange={(e) =>
                        patchSelected({ type: e.target.value as SnapPointType })
                      }
                    >
                      {SNAP_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="mate-field">
                    <span>Role</span>
                    <select
                      value={selected.role ?? 'receive'}
                      onChange={(e) =>
                        patchSelected({
                          role: e.target
                            .value as SnapPointDefinition['role'],
                        })
                      }
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="mate-field">
                    <span>Axis (insertion)</span>
                    <select
                      value={axisPresetLabel(selected.axis)}
                      onChange={(e) => setAxisPreset(e.target.value)}
                    >
                      {AXIS_PRESETS.map((a) => (
                        <option key={a.label} value={a.label}>
                          {a.label}
                        </option>
                      ))}
                      {axisPresetLabel(selected.axis) === 'custom' && (
                        <option value="custom" disabled>
                          custom {formatVec(selected.axis)}
                        </option>
                      )}
                      {axisPresetLabel(selected.axis) === 'none' && (
                        <option value="none" disabled>
                          none
                        </option>
                      )}
                    </select>
                  </label>
                </div>

                <Vec3Field
                  label="Position (local)"
                  value={selected.position}
                  step={0.05}
                  onChange={(position) =>
                    patchSelected({
                      position: [
                        roundCoord(position[0]),
                        roundCoord(position[1]),
                        roundCoord(position[2]),
                      ],
                    })
                  }
                />

                <div className="mate-grid">
                  <label className="mate-field">
                    <span>Receiving depth</span>
                    <input
                      type="number"
                      step={0.01}
                      value={selected.receivingDepth ?? ''}
                      onChange={(e) => {
                        const n = parseFloat(e.target.value)
                        patchSelected(
                          {
                            receivingDepth: Number.isFinite(n) ? n : undefined,
                          },
                          false,
                        )
                      }}
                    />
                  </label>
                  <label className="mate-field">
                    <span>Occupancy group</span>
                    <input
                      type="text"
                      value={selected.occupancyGroup ?? ''}
                      onChange={(e) =>
                        patchSelected(
                          {
                            occupancyGroup: e.target.value || undefined,
                          },
                          false,
                        )
                      }
                    />
                  </label>
                </div>

                <div className="mate-field">
                  <span>Compatible with</span>
                  <div className="snap-author-compat">
                    {SNAP_TYPES.map((t) => (
                      <label key={t}>
                        <input
                          type="checkbox"
                          checked={selected.compatibleWith.includes(t)}
                          onChange={(e) => {
                            const compatibleWith = e.target.checked
                              ? [...selected.compatibleWith, t]
                              : selected.compatibleWith.filter((c) => c !== t)
                            patchSelected({ compatibleWith }, false)
                          }}
                        />
                        {t}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="mate-toggles">
                  <label>
                    <input
                      type="checkbox"
                      checked={!!selected.curatedNeedsReview}
                      onChange={(e) =>
                        patchSelected(
                          { curatedNeedsReview: e.target.checked || undefined },
                          false,
                        )
                      }
                    />
                    Needs visual review
                  </label>
                </div>

                <div className="mate-actions">
                  <button onClick={snapToGrid} title="Round the position to the 0.25 half-pitch grid">
                    Snap to grid
                  </button>
                  <button onClick={duplicateSelected}>Duplicate</button>
                  <button
                    onClick={mirrorSelected}
                    title="Add the matching point on the opposite face (shared occupancy group)"
                  >
                    Mirror face
                  </button>
                  <button onClick={deleteSelected}>Delete</button>
                </div>
              </div>
            )}

            <div className="mate-hint">
              Edits are live — test with Auto Snap, Joint Mode, or Pin Mode
              right away. Mate frames follow position + axis automatically.
              Authored sets are saved in this browser only (not in project
              files, not in undo history) until exported.
            </div>

            <div className="mate-actions">
              <button className="primary" onClick={copySnippet}>
                Copy JSON
              </button>
              <button onClick={downloadJson}>Download JSON</button>
              <button onClick={revert}>Revert to built-in</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
