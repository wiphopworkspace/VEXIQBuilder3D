/**
 * Resolve a manifest web path (e.g. "/models/…/part.glb") against Vite's
 * BASE_URL so GLB fetches work when the app is served from a subpath
 * (GitHub Pages serves at /VEXIQBuilder3D/). In dev BASE_URL is "/" and the
 * result is identical to the old encodeURI(path) behavior.
 *
 * All GLB loader call sites (ScenePart, SnapGhost, thumbnailRenderer) must go
 * through this helper so useGLTF's cache keys stay consistent — in particular
 * useGLTF.clear() must receive the same string as useGLTF().
 */
export function assetUrl(webPath: string): string {
  const base = import.meta.env.BASE_URL || '/'
  const joined = webPath.startsWith('/')
    ? (base.endsWith('/') ? base.slice(0, -1) : base) + webPath
    : (base.endsWith('/') ? base : `${base}/`) + webPath
  return encodeURI(joined)
}
