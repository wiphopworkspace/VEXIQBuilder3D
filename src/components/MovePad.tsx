import { useEffect, useMemo, useRef, useState } from 'react'
import { useAssemblyStore } from '../store/assemblyStore'
import { moveStepLabel } from '../utils/gridSnap'
import type { Vec3 } from '../types/assembly'

/**
 * On-canvas nudge pad: one press = one move step along a WORLD axis, or one
 * quarter turn about one, for the selected part or for its whole assembly.
 *
 * It exists because the keyboard was the only way to reach three things:
 *
 *   - the Y axis. A Basic-Mode drag runs on a plane, so height needed
 *     Shift+↑/↓ — and a tablet has no Shift and no arrow keys, which left no
 *     way at all to stack a layer. (The Height drag axis toggle is the
 *     gesture-shaped answer; this is the exact-step one.)
 *   - a group move without a modifier. Alt+arrows exist on a keyboard; a
 *     finger has no Alt, so the scope is a visible toggle instead.
 *   - TURNING an assembly. `rotateConnectedGroup` was reachable from Alt+Q/E/F
 *     and from two toolbar buttons that only turn about Y — so on a tablet an
 *     assembly could be moved by finger but not flipped at all, and turning it
 *     meant leaving the model to hunt along the toolbar. The turn row answers
 *     the same "part or assembly?" question the move buttons already answer,
 *     from the same thumb position.
 *
 * World axes, not camera-relative: these buttons write the same numbers the
 * Properties panel shows and the same axes the origin gizmo draws, so what a
 * press does never depends on where the camera happens to be. Press-and-hold
 * repeats on the MOVE buttons, because placing a part eight holes over should
 * not be eight taps — the turn buttons deliberately do not repeat, since a held
 * quarter turn is just a part spinning past where you wanted it.
 */

// Hold-to-repeat, matching a text cursor's feel: a pause to prove intent, then
// steady steps. Fast enough to cross the grid, slow enough to stop on a hole.
const REPEAT_DELAY_MS = 420
const REPEAT_INTERVAL_MS = 110

type Axis = { key: string; label: string; title: string; delta: (n: number) => Vec3 }

const HALF_PI = Math.PI / 2

/**
 * Quarter turns, matching Q / E / F exactly. A part in a joint turns ON that
 * joint (and refuses if two joints hold it); an assembly turns as one body with
 * every internal joint kept exact. Flip is the odd one out: on a single part it
 * means "onto its side" (or a half turn on the joint), and on an assembly it is
 * the same 90° about X that Alt+F applies.
 */
type Turn = {
  key: string
  label: string
  axis: Vec3
  radians: number
  partTitle: string
  groupTitle: (n: number) => string
}

const TURNS: Turn[] = [
  {
    key: 'ccw',
    label: '⟲',
    axis: [0, 1, 0],
    radians: -HALF_PI,
    partTitle: 'Turn 90° left (Q). A part in a joint turns on that joint.',
    groupTitle: (n) =>
      `Turn all ${n} connected parts 90° left as one body (Alt+Q). Every joint inside keeps its exact fit.`,
  },
  {
    key: 'cw',
    label: '⟳',
    axis: [0, 1, 0],
    radians: HALF_PI,
    partTitle: 'Turn 90° right (E). A part in a joint turns on that joint.',
    groupTitle: (n) =>
      `Turn all ${n} connected parts 90° right as one body (Alt+E). Every joint inside keeps its exact fit.`,
  },
  {
    key: 'flip',
    label: '⤵',
    axis: [1, 0, 0],
    radians: HALF_PI,
    partTitle:
      'Flip 90° onto its side (F). A part in a joint does a half turn on that joint instead — the only flip a pin allows.',
    groupTitle: (n) =>
      `Tip all ${n} connected parts 90° onto their side as one body (Alt+F).`,
  },
]

const AXES: Axis[] = [
  { key: '-x', label: '−X', title: 'Move −X', delta: (n) => [-n, 0, 0] },
  { key: '+x', label: '+X', title: 'Move +X', delta: (n) => [n, 0, 0] },
  { key: '-z', label: '−Z', title: 'Move −Z', delta: (n) => [0, 0, -n] },
  { key: '+z', label: '+Z', title: 'Move +Z', delta: (n) => [0, 0, n] },
  { key: '+y', label: '▲ Y', title: 'Raise (+Y)', delta: (n) => [0, n, 0] },
  { key: '-y', label: '▼ Y', title: 'Lower (−Y)', delta: (n) => [0, -n, 0] },
]

export default function MovePad() {
  const selectedId = useAssemblyStore((s) => s.selectedInstanceId)
  const moveStep = useAssemblyStore((s) => s.moveStep)
  const moveParts = useAssemblyStore((s) => s.moveParts)
  const nudgeSelected = useAssemblyStore((s) => s.nudgeSelected)
  const moveGroupIdsFor = useAssemblyStore((s) => s.moveGroupIdsFor)
  const rotateSelected = useAssemblyStore((s) => s.rotateSelected)
  const flipSelected = useAssemblyStore((s) => s.flipSelected)
  const rotateConnectedGroup = useAssemblyStore((s) => s.rotateConnectedGroup)
  const basicDragAxis = useAssemblyStore((s) => s.basicDragAxis)
  const setBasicDragAxis = useAssemblyStore((s) => s.setBasicDragAxis)
  const easyMode = useAssemblyStore((s) => s.easyMode)
  // Subscribed as DATA, not read through the action alone, so the scope row
  // follows a part being joined, detached, or added to the selection while the
  // pad is open — they are the inputs moveGroupIdsFor answers from.
  const parts = useAssemblyStore((s) => s.parts)
  const connections = useAssemblyStore((s) => s.connections)
  const multiSelectIds = useAssemblyStore((s) => s.multiSelectIds)
  const jointPositionUnlocked = useAssemblyStore((s) => s.jointPositionUnlocked)
  const [groupScope, setGroupScope] = useState(true)
  const [collapsed, setCollapsed] = useState(false)
  const repeatRef = useRef<{ timeout?: number; interval?: number }>({})

  const groupIds = useMemo(
    () => (selectedId ? moveGroupIdsFor(selectedId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      selectedId,
      moveGroupIdsFor,
      parts,
      connections,
      multiSelectIds,
      jointPositionUnlocked,
    ],
  )
  const groupSize = groupIds.length
  const canGroup = groupSize > 1
  const asGroup = canGroup && groupScope

  const stopRepeat = () => {
    if (repeatRef.current.timeout) window.clearTimeout(repeatRef.current.timeout)
    if (repeatRef.current.interval)
      window.clearInterval(repeatRef.current.interval)
    repeatRef.current = {}
  }

  // A pointer released outside the button (or the component unmounting mid-hold)
  // must not leave a timer stepping the part forever.
  useEffect(() => stopRepeat, [])

  if (!selectedId) return null

  const step = moveStep > 0 ? moveStep : 0.25

  const apply = (axis: Axis) => {
    const delta = axis.delta(step)
    if (asGroup) moveParts(groupIds, delta, 'Move Assembly')
    else nudgeSelected(delta)
  }

  const startRepeat = (axis: Axis) => {
    stopRepeat()
    apply(axis)
    repeatRef.current.timeout = window.setTimeout(() => {
      repeatRef.current.interval = window.setInterval(
        () => apply(axis),
        REPEAT_INTERVAL_MS,
      )
    }, REPEAT_DELAY_MS)
  }

  const applyTurn = (turn: Turn) => {
    if (asGroup) rotateConnectedGroup(selectedId, turn.axis, turn.radians)
    else if (turn.key === 'flip') flipSelected()
    else rotateSelected(turn.axis, turn.radians)
  }

  const turnButton = (turn: Turn) => (
    <button
      key={turn.key}
      className={`movepad-btn movepad-turn-${turn.key}`}
      title={asGroup ? turn.groupTitle(groupSize) : turn.partTitle}
      onClick={() => applyTurn(turn)}
    >
      {turn.label}
    </button>
  )

  const button = (axis: Axis) => (
    <button
      key={axis.key}
      className={`movepad-btn movepad-${axis.key.replace('+', 'p').replace('-', 'm')}`}
      title={`${axis.title} by ${step} (${moveStepLabel(moveStep)})`}
      onPointerDown={(e) => {
        e.preventDefault()
        // Capture keeps the hold alive when a finger slides off the button.
        // It throws NotFoundError for a pointer the browser no longer
        // considers active (a cancelled touch, a synthesized event) — the
        // press works fine without it, so never let that abort the handler.
        // Same hazard, same guard as the part drag in ScenePart.
        try {
          e.currentTarget.setPointerCapture?.(e.pointerId)
        } catch {
          /* ignore */
        }
        startRepeat(axis)
      }}
      onPointerUp={stopRepeat}
      onPointerCancel={stopRepeat}
      onPointerLeave={stopRepeat}
    >
      {axis.label}
    </button>
  )

  const byKey = (key: string) => button(AXES.find((a) => a.key === key)!)

  if (collapsed) {
    return (
      <button
        className="movepad-reopen"
        onClick={() => setCollapsed(false)}
        title="Show the move pad"
      >
        ✥ Move
      </button>
    )
  }

  return (
    <div className="movepad">
      <div className="movepad-head">
        <span className="movepad-title">Move · Turn</span>
        <span className="movepad-step">{moveStepLabel(moveStep)}</span>
        <button
          className="movepad-collapse"
          onClick={() => setCollapsed(true)}
          title="Hide the move pad"
        >
          ×
        </button>
      </div>

      <div className="movepad-grid">
        <span className="movepad-axis-label">X / Z</span>
        <div className="movepad-dpad">
          <div />
          {byKey('-z')}
          <div />
          {byKey('-x')}
          <div className="movepad-hub" aria-hidden>
            ✥
          </div>
          {byKey('+x')}
          <div />
          {byKey('+z')}
          <div />
        </div>
        <span className="movepad-axis-label">Height Y</span>
        <div className="movepad-ycol">
          {byKey('+y')}
          {byKey('-y')}
        </div>
        <span className="movepad-axis-label">Turn</span>
        <div className="movepad-turnrow">{TURNS.map(turnButton)}</div>
      </div>

      {canGroup && (
        <div className="movepad-scope">
          <button
            className={`movepad-scope-btn${asGroup ? '' : ' active'}`}
            onClick={() => setGroupScope(false)}
            title="Move only the selected part. A part held by a joint must be unlocked first."
          >
            Part
          </button>
          <button
            className={`movepad-scope-btn${asGroup ? ' active' : ''}`}
            onClick={() => setGroupScope(true)}
            title={`Move all ${groupSize} parts together, keeping every joint between them exact`}
          >
            Assembly ({groupSize})
          </button>
        </div>
      )}

      {easyMode && (
        <div className="movepad-scope" title="Which way a part drag runs">
          <button
            className={`movepad-scope-btn${
              basicDragAxis === 'ground' ? ' active' : ''
            }`}
            onClick={() => setBasicDragAxis('ground')}
            title="Dragging a part slides it across the grid (X/Z)"
          >
            Drag: Ground
          </button>
          <button
            className={`movepad-scope-btn${
              basicDragAxis === 'height' ? ' active' : ''
            }`}
            onClick={() => setBasicDragAxis('height')}
            title="Dragging a part raises and lowers it (Y)"
          >
            Drag: Height
          </button>
        </div>
      )}
    </div>
  )
}
