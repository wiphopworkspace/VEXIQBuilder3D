# VEX IQ Models

This folder holds the local model assets. STEP files are scanned only to build
the parts library — they are **never** rendered directly in the browser. Convert
them to GLB to see real geometry.

```
VEX-IQ-All-Control-STEP/       source STEP files (control parts)
VEX-IQ-All-Control-GLB/        converted GLB for the control parts
VEX-IQ-All-Parts-2024-11-08/   source STEP files (full parts catalog)
VEX-IQ-All-Parts-GLB/          converted GLB for the full catalog
thumbnails/                    optional generated thumbnails (.png)
```

After adding STEP or GLB files, run `npm run generate:parts` to refresh
`src/data/generatedStepParts.ts`, then `npm run dev`.

See the project README section **"STEP Files and GLB Conversion"** for details.
