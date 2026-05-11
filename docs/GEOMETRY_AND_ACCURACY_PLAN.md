# RoofIQ — geometry, accuracy, and integrations plan

Living document: roadmap, evaluated tools/repos, and **what to improve where** in this codebase.  
Last updated: 2026-05-10

Related: [Roof measurement — product checklist](./ROOF_MEASUREMENT_PRODUCT_CHECKLIST.md) · [Architecture](./ARCHITECTURE.md)

---

## 1. Product principle

**Credibility** comes from transparent inputs, explicit uncertainty, and tiered accuracy—not from pretending map-only flows are survey-grade everywhere.

| Tier | Inputs | Expectation |
|------|--------|-------------|
| A — Map + Solar | Address, Solar segments, user outline | Strong where Solar coverage/quality is good; show confidence |
| B — Augmented | + DSM, multi-angle depth, vision cues | Higher confidence where we invest in fusion |
| C — Survey | Drone (GCP/RTK), LiDAR, pro aerial | Inch-credible when capture and control points are right |

---

## 2. Geometry / 3D roadmap (future work)

### Phase A — Per-image geometry (sidecar service)

- [ ] Monocular **metric depth + normals** (e.g. Metric3D v2 or equivalent) on **oblique/street** captures; treat **nadir satellite** as low-trust for depth.
- [ ] API: `POST` image (+ optional focal/FOV) → depth + normal + confidence.
- [ ] **Aggregation** across the ~6 wizard slots: consistency checks, outlier down-weighting; optional blend with structural cues.
- [ ] **Infra**: Python/GPU or ONNX; never block core UI on inference.

**Repos / refs:** [Metric3D](https://github.com/yvanyin/metric3d)

### Phase B — True multi-view fusion (higher lift)

- [ ] Evaluate **DUSt3R-class** (or successors) for pairwise/multi-image alignment without full classic SfM.
- [ ] Optional: **COLMAP** / photogrammetry when user provides **overlapping drone** imagery + EXIF.
- [ ] Success criterion: coarse registered point cloud or mesh in a **building-centric** frame.

### Phase C — Data sources & ML assist

- [ ] Compare **paid geospatial roof** products (regional) vs Solar-only for quote-grade markets.
- [ ] **SAM / SAM2** (or deployable variants) for faster roof masks on aerial/oblique.

**Repos / refs:** [RoofMapNet](https://github.com/CVEO/RoofMapNet), [RoofSense](https://github.com/DimitrisMantas/RoofSense), [proj-rooftops](https://github.com/swiss-territorial-data-lab/proj-rooftops)

### Phase D — Survey-grade path

- [ ] **[OpenDroneMap / WebODM](https://github.com/OpenDroneMap/WebODM)** — drone → dense cloud, DSM, ortho, mesh.
- [ ] **DSM → roof planes:** [building-roof-pipeline](https://github.com/ignfab/building-roof-pipeline), [PolyFit](https://github.com/LiangliangNan/PolyFit), [3DBAG/roofer](https://github.com/3DBAG/roofer)

### Phase E — Pro export (optional)

- [ ] Export mesh/point cloud for power users after we own a mesh pipeline.

### Explicit non-goals (for now)

- [ ] **SlicerMorph** ([repo](https://github.com/SlicerMorph/SlicerMorph)) — desktop research stack; not core web path.
- [ ] **3D-Sketch-Map-Analysis** ([repo](https://github.com/Rajasirpi/3D-Sketch-Map-Analysis)) — Rhino sketch research; concepts only.

### Visualization reference (not measurement)

- [ ] **[streets-gl](https://github.com/StrandedKitty/streets-gl)** — OSM 3D WebGL; UX inspiration only.

---

## 3. GitHub / tools summary

| Resource | Role | Fit |
|----------|------|-----|
| Google Solar API | Segments, pitch, area | **Core** — improve integration (§4) |
| [building-roof-pipeline](https://github.com/ignfab/building-roof-pipeline) | DSM → roof reconstruction | When DSM/LiDAR exists |
| [OpenDroneMap/WebODM](https://github.com/OpenDroneMap/WebODM) | Drone photogrammetry | Tier C |
| [RoofMapNet](https://github.com/CVEO/RoofMapNet) | Roof structure from HR imagery | Assist / research |
| [proj-rooftops](https://github.com/swiss-territorial-data-lab/proj-rooftops) | Rooftop + LiDAR workflows | Regional / methodology |
| [RoofSense](https://github.com/DimitrisMantas/RoofSense) | Material multimodal | Materials |
| [drone-images-surface-area-calculator](https://github.com/Rishikesh0523/drone-images-surface-area-calculator) | Reference-scale polygon area | Trust pattern |
| Metric3D | Depth/normals per image | Phase A sidecar |
| streets-gl | OSM 3D viz | Inspiration |

---

## 4. Google Solar API — issues & **what to improve where**

### Failure modes (“random” / nonsensical)

1. **`findClosest`** returns **nearest** building to `(lat,lng)` — wrong pin → wrong building.
2. **`filterUsableRoofSegments`** — heuristics change which facets appear vs satellite.
3. **`segmentToBoundingPolygon`** — **synthetic** quads; not true outlines → map misleading while API areas may be OK.
4. **Cloud / key** — Solar API enabled, billing, key restrictions; proxy vs direct differs dev vs prod.
5. **`requiredQuality=LOW`** — noisier segments possible.
6. **Solar `useEffect`** omits **`apiKey`** from deps — stale key may skip refetch. *(Addressed: `apiKey` included in Solar auto-fetch deps in `AnalysisPage.tsx`.)*

### Improvements (prioritized)

| Priority | Improvement | Where |
|----------|-------------|--------|
| P0 | Validate response (segments non-empty, center near request); optional dev raw JSON | `validateSolarBuildingInsights` + dev JSON toggle — **done** (reject far center; warnings; DEV raw JSON) |
| P0 | Ensure **map pin / geocode** matches Solar query | Same validation vs request lat/lng — **done** (distance checks) |
| P1 | Multi-building **disambiguation** (future) | New module + `AnalysisPage.tsx` |
| P1 | Tune/expose filter or **“raw Solar”** debug toggle | Sidebar copy removed; still available via code / future UI — **not in sidebar** |
| P1 | **Quantities from `stats.areaMeters2`**; label overlay **approximate** | User-trace structure uses drawn areas; panel copy — **partial** |
| P2 | Configurable **`requiredQuality`** | `fetchBuildingInsights` / `fetchDataLayers` options + `VITE_SOLAR_REQUIRED_QUALITY` — **done** |
| P2 | Add **`apiKey`** to Solar fetch deps | `AnalysisPage.tsx` (Solar auto-fetch `useEffect`) — **done** |
| P2 | Document/deploy **proxy-solar** | `api/proxy-solar.ts` module doc — **partial** (see file header) |
| P3 | DSM sanity vs planes | `heightModel.ts`, `fetchDataLayers` usage |

### Code anchors

- `src/utils/solar.ts` — fetch, normalize, filter, `segmentToBoundingPolygon`
- `src/components/AnalysisPage.tsx` — Solar auto-fetch effect
- `api/proxy-solar.ts` — production CORS proxy

---

## 5. Cross-cutting credibility

- [ ] Show **imagery date**, **quality**, **filter summary** (kept/dropped) in UI. *(Solar sidebar banner stripped for clarity; data still loaded for structure.)*
- [ ] Clear path when LOW quality / 0 segments: manual / drone / visit. *(Validation still rejects bad building match; inline copy removed.)*
- [ ] Optional: persist **Solar summary** in DB for audit.

---

## 6. Review cadence

Update after: Solar hardening (§4), wizard fusion milestones (§2), or new data tier (drone/DSM).

---

## 7. What shipped in this repo (vs roadmap §2)

Phases **A–E** (Metric3D sidecar, DUSt3R, SAM, WebODM, mesh export) require **separate services or contracts** — they are not runnable inside this Vite app alone. In-app work completed toward §4 / §5 / product checklist:

- **User-drawn structure:** `analyzeDrawnRoofSections` — facets from traced polygons; Solar for nearest pitch/azimuth/plane height hints.
- **Solar validation:** `validateSolarBuildingInsights` — reject building center too far from pin; warnings for empty segments / offset.
- **Experimental** single `boundingBox` outline behind `VITE_EXPERIMENTAL_SOLAR_OUTLINE` (facet-center assist UI removed from sidebar).
- **`VITE_SOLAR_REQUIRED_QUALITY`** passed into Solar `fetchBuildingInsights` / `fetchDataLayers`.
- **RoofStructurePanel:** user-trace vs Solar-only titles; static-map multi-view collapsed under advanced `<details>`.
