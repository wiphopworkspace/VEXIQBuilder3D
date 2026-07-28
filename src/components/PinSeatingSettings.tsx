import { useMemo, useState } from 'react'
import { useAssemblyStore } from '../store/assemblyStore'
import {
  PIN_SEATING_LIMITS,
  SHIPPED_PIN_SEATING_CALIBRATION,
  calibrationDiff,
  calibrationOrigins,
  worldToMm,
  worldToPitches,
  type CalibrationOrigin,
  type PinSeatingCalibration,
} from '../data/seatingCalibration'

type NumericKey = keyof typeof PIN_SEATING_LIMITS

const FIELDS: Array<{
  key: NumericKey
  label: string
  hint: string
  /** Degrees are shown as-is; world-unit fields also show mm + pitches. */
  unit: 'world' | 'deg'
}> = [
  {
    key: 'pinContactOffset',
    label: 'Pin contact offset',
    hint: 'Uniform fine adjustment along the insertion axis, applied after the mechanical contact planes meet. Part metadata stays the source of accuracy.',
    unit: 'world',
  },
  {
    key: 'snapSearchDistance',
    label: 'Snap search distance',
    hint: 'How far Auto Snap may reach for a candidate. Search only — this never decides whether a stored joint is still sound.',
    unit: 'world',
  },
  {
    key: 'axialGapTolerance',
    label: 'Final axial gap tolerance',
    hint: 'Largest gap between the two contact planes that still counts as seated.',
    unit: 'world',
  },
  {
    key: 'radialTolerance',
    label: 'Radial alignment tolerance',
    hint: 'Largest sideways offset between the two insertion axes.',
    unit: 'world',
  },
  {
    key: 'angularToleranceDeg',
    label: 'Angular alignment tolerance',
    hint: 'Largest angle between the two insertion axes.',
    unit: 'deg',
  },
  {
    key: 'penetrationTolerance',
    label: 'Penetration tolerance',
    hint: 'How far the contact planes may pre-load into each other.',
    unit: 'world',
  },
  {
    key: 'mateBreakTolerance',
    label: 'Mate break tolerance',
    hint: 'Beyond this contact-frame error a stored mate is treated as come apart. Independent of the search distance by design.',
    unit: 'world',
  },
  {
    key: 'simulatedMoveTolerance',
    label: 'Joint Mode safety tolerance',
    hint: 'Most a Joint Mode pick may disturb a mate it has to preserve. Strict on purpose.',
    unit: 'world',
  },
]

const ORIGIN_LABEL: Record<CalibrationOrigin, string> = {
  shipped: 'shipped default',
  user: 'your default',
  project: 'project override',
}

function formatWorld(value: number): string {
  return `${worldToMm(value).toFixed(2)} mm · ${worldToPitches(value).toFixed(3)} pitch`
}

/**
 * Settings → Snap & Joint Calibration → Pin Seating.
 *
 * Surfaces the seven separate tolerance concepts (see
 * `data/seatingCalibration.ts`) with their provenance, so a user can see at a
 * glance whether a value came from the shipped defaults, their own saved
 * default, or the open project.
 */
export default function PinSeatingSettings() {
  const [open, setOpen] = useState(false)
  const pinSeating = useAssemblyStore((s) => s.pinSeating)
  const userDefaults = useAssemblyStore((s) => s.pinSeatingUserDefaults)
  const projectOverrides = useAssemblyStore((s) => s.pinSeatingProjectOverrides)
  const setPinSeating = useAssemblyStore((s) => s.setPinSeating)
  const saveAsDefault = useAssemblyStore((s) => s.savePinSeatingAsUserDefault)
  const resetToShipped = useAssemblyStore((s) => s.resetPinSeatingToShipped)
  const setProjectOverride = useAssemblyStore(
    (s) => s.setPinSeatingProjectOverride,
  )

  const origins = useMemo(
    () => calibrationOrigins(userDefaults, projectOverrides),
    [userDefaults, projectOverrides],
  )
  const dirty = useMemo(
    () => Object.keys(calibrationDiff(pinSeating)).length > 0,
    [pinSeating],
  )

  return (
    <div className="prop-section pin-seating-settings">
      <button
        type="button"
        className="pin-seating-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="label">Snap &amp; Joint Calibration — Pin Seating</span>
        <span className="value">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <>
          <p className="pin-seating-note">
            Connector-family metadata is the source of mechanical accuracy.
            These are fine adjustments on top of it.
          </p>

          {FIELDS.map((field) => {
            const limits = PIN_SEATING_LIMITS[field.key]
            const value = pinSeating[field.key]
            const origin = origins[field.key]
            return (
              <div className="setting-slider" key={field.key}>
                <div className="prop-row">
                  <span className="label" title={field.hint}>
                    {field.label}
                  </span>
                  <span className="value">
                    {field.unit === 'deg'
                      ? `${value.toFixed(1)}°`
                      : value.toFixed(3)}
                  </span>
                </div>
                <input
                  type="range"
                  min={limits.min}
                  max={limits.max}
                  step={limits.step}
                  value={value}
                  onChange={(e) =>
                    setPinSeating({ [field.key]: parseFloat(e.target.value) })
                  }
                />
                <div className="pin-seating-meta">
                  <span className={`origin origin-${origin}`}>
                    {ORIGIN_LABEL[origin]}
                  </span>
                  {field.unit === 'world' && (
                    <span className="converted">{formatWorld(value)}</span>
                  )}
                </div>
              </div>
            )
          })}

          <label className="setting-row">
            <input
              type="checkbox"
              checked={pinSeating.showContactFrames}
              onChange={(e) =>
                setPinSeating({ showContactFrames: e.target.checked })
              }
            />
            <span>Show contact frames (developer overlay)</span>
          </label>

          <div className="pin-seating-actions">
            <button type="button" onClick={saveAsDefault} disabled={!dirty}>
              Save as My Default
            </button>
            <button
              type="button"
              onClick={() => setProjectOverride(calibrationDiff(pinSeating))}
              disabled={!dirty}
            >
              Save with Project
            </button>
            <button type="button" onClick={resetToShipped}>
              Reset to Shipped Defaults
            </button>
          </div>
          <p className="pin-seating-note">
            Shipped defaults: gap ≤{' '}
            {SHIPPED_PIN_SEATING_CALIBRATION.axialGapTolerance}, radial ≤{' '}
            {SHIPPED_PIN_SEATING_CALIBRATION.radialTolerance}, break at{' '}
            {SHIPPED_PIN_SEATING_CALIBRATION.mateBreakTolerance}.
          </p>
        </>
      )}
    </div>
  )
}

export type { PinSeatingCalibration }
