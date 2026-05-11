# Roof measurement — product checklist

Aligned with manual-first Solar usage and phasing out misleading auto-geometry.  
Last updated: 2026-05-10

Related: [RoofIQ — geometry, accuracy, and integrations plan](./GEOMETRY_AND_ACCURACY_PLAN.md) · [Architecture](./ARCHITECTURE.md)

---

## Done

- [x] **Remove / hide “Auto-import roof segments”** — bbox-derived rectangles were misleading on flat/complex roofs. **Removed** from `AnalysisPage.tsx` (no facet import / no `importSolarSegments`).

---

## Manual first (default)

- [x] **Primary UX:** user traces roof sections on the map; no one-click polygon import from Solar facets. *(Shipped: import path removed.)*
- [x] **Solar banner:** show **imagery quality**, segment count, and **optional compare** — Solar facet sum (API) vs user drawn plan area when sections exist; when none, “Solar reports ~X … reference only”; copy states API total is **not footprint truth**.
- [x] **Pitch / structure:** when the user has **drawn** sections, **Roof structure** uses **traced footprints** and nearest Solar facet for **pitch/azimuth** hints (`analyzeDrawnRoofSections`). With **no** drawn sections, behavior remains Solar-facet schematic (`analyzeSolarSegments`).

---

## “Assist” not “import” (next)

- [ ] Optional: faint **segment center markers** or guidelines from `usableSolarSegments` centers — user still draws polygons. *(Previously had a sidebar toggle; removed to reduce Solar clutter.)*
- [x] No auto-rectangles on the map unless behind an explicit **experimental** flag. *(Shipped: `VITE_EXPERIMENTAL_SOLAR_OUTLINE=true` enables a single Solar `boundingBox` outline button.)*

---

## One outline only (optional automation)

- [x] If we reintroduce automation: **single** building-level polygon (e.g. Solar `boundingBox` or merged hull), user edits **one** outline — document limits vs multi-facet import. *(Experimental env flag + button on `AnalysisPage`; replaces all sections.)*

---

## Later / heavier (true footprint)

- [ ] **DSM segmentation**, **ML roof masks** (e.g. SAM + scale), or **paid aerial** — required for trustworthy auto-footprint; not a tweak to `segmentToBoundingPolygon` alone.
- [ ] **Drone path:** OpenDroneMap / WebODM tier for survey-grade when user uploads imagery.

---

## Engineering follow-ups

- [x] Remove unused imports from `AnalysisPage.tsx` after deleting `importSolarSegments` (`computeDominantAzimuth`, `segmentToBoundingPolygon`, `pitchDegreesToOption`, `Zap`).
- [x] Link this file from `docs/ARCHITECTURE.md` and `docs/GEOMETRY_AND_ACCURACY_PLAN.md` (both directions in doc headers).

---

## Appendix — structure panel & diagram (parallel)

- [x] **Expectations in UI** (`RoofStructurePanel`): title *Schematic from Solar facets (not as-built linework)*; numeric rollups separated from indicative diagram trust.
- [x] **Edge drawing:** SVG layer order (fills under edges) + full-length facet-side strokes so legend matches the drawing.
- [x] **Drive structure from user traces** — build facets/adjacency from drawn polygons; Solar for pitch/azimuth hints only. *(Shipped: `analyzeDrawnRoofSections` in `roofStructure.ts` + `AnalysisPage` preview / modal.)*
- [ ] **“Actual” path:** DSM / ML linework / wizard fusion (see [geometry & integrations plan](./GEOMETRY_AND_ACCURACY_PLAN.md)).
- [x] **UI deduplication:** Multi-Angle block removed from `AnalysisPage`; wizard owns multi-angle.
- [x] **Review** `RoofStructurePanel` “Auto Map Viewpoint Analysis” vs wizard. *(Collapsed under “Static-map viewpoint cues (advanced)” `<details>` with wizard cross-reference.)*
