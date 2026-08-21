# UX Experience Spec: Cinematic Fantasy Overhaul

## Scope
- Priority surfaces: `Catalog` and `Map Detail`
- Secondary surfaces: global shell, home, admin visual alignment
- Primary KPI: exploration depth (map opens, dwell, maps/session, return)

## User Journeys
1. Discovery loop
- Home hero -> Catalog -> Map Detail -> Related Maps -> Next Map Detail
2. Authenticated collector loop
- Catalog -> Map Detail -> DD2VTT countdown -> Download -> Account timeline
3. Admin curation loop
- Admin Panel -> Sync/Jobs -> Catalog QA -> Map Detail POI/metadata edit

## Page Intent
- Home: atmospheric entry point with clear exploration CTA.
- Catalog: low-friction discovery and map selection.
- Map Detail: dominant exploration stage + contextual actions.
- Admin pages: operationally dense but visually consistent with public UI.

## Visual Principles
- Cinematic fantasy mood with layered surfaces and atmospheric color.
- Strong hierarchy: map media first, controls second, operations third.
- Consistent primitives (`surface-card`, `action-button`, `status-chip`, `stat-tile`).

## Motion Rules
- Medium cinematic motion only for hierarchy and flow:
- Entrance sequencing on major sections.
- Hover lift and overlay reveal on map cards.
- Respect `prefers-reduced-motion` and disable non-essential animation.

## Accessibility Gates
- Minimum WCAG AA contrast for body text and controls.
- Keyboard access for nav, catalog filters, action rails, and admin tables.
- Visible focus states for all interactive elements.
- Mobile-safe breakpoints for filters and map explorer controls.

## Conversion Hierarchy
1. Explore maps
2. Download assets
3. Donate

## Baseline Metric Snapshot (Pre-Overhaul)
- Catalog -> Detail CTR: `TODO capture from analytics`
- Median detail dwell: `TODO capture from analytics`
- Maps per session: `TODO capture from analytics`
- D1/D7 return: `TODO capture from analytics`
- Home/Catalog bounce: `TODO capture from analytics`

## Validation
- Functional checks: catalog search/filter/load, map detail controls, POI edit mode.
- Visual checks: Home/Catalog/Map Detail/Admin at desktop + mobile.
- Analytics checks: view-start/view-end and donation events still emitted.
