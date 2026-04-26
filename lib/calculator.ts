// Deterministic painting takeoff math.
// Implements Steps 2-5 of the spec exactly.

import type {
  Areas,
  Assumptions,
  Extracted,
  Materials,
  Paint,
  TakeoffResult,
} from "./types";

// Defaults from the spec (Step 2).
export const DEFAULTS = {
  wall_multiplier: 2.6,
  coats: 2,
  waste_factor: 0.10, // 10%
  wall_paint_coverage: 350, // sq ft per gallon
  ceiling_paint_coverage: 400,
  trim_paint_coverage: 300,
} as const;

// Round up to nearest whole number.
function ceil(n: number): number {
  return Math.ceil(n);
}

// If the AI returned non-numeric or negative junk, normalize to null/0.
function safeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function normalizeExtracted(raw: Partial<Extracted>): Extracted {
  return {
    finished_sq_ft: safeNum(raw.finished_sq_ft),
    garage_sq_ft: safeNum(raw.garage_sq_ft),
    patio_sq_ft: safeNum(raw.patio_sq_ft),
    ceiling_height_ft: safeNum(raw.ceiling_height_ft),
    door_count:
      raw.door_count === null || raw.door_count === undefined
        ? null
        : Math.max(0, Math.round(Number(raw.door_count))),
    window_count:
      raw.window_count === null || raw.window_count === undefined
        ? null
        : Math.max(0, Math.round(Number(raw.window_count))),
    confidence:
      raw.confidence === "high" || raw.confidence === "medium" || raw.confidence === "low"
        ? raw.confidence
        : "low",
    notes: typeof raw.notes === "string" ? raw.notes : "",
  };
}

export function calculate(extracted: Extracted): TakeoffResult {
  const assumptions: Assumptions = {
    wall_multiplier: DEFAULTS.wall_multiplier,
    coats: DEFAULTS.coats,
    waste_factor: "10%",
  };

  // Step 3 — areas. If finished_sq_ft is unknown, areas are 0 and the user is told.
  const finished = extracted.finished_sq_ft ?? 0;
  const wall_area_sq_ft = finished * DEFAULTS.wall_multiplier;
  const ceiling_area_sq_ft = finished;

  const areas: Areas = {
    // Areas themselves are not rounded (informational); they feed the gallon math.
    wall_area_sq_ft: Math.round(wall_area_sq_ft),
    ceiling_area_sq_ft: Math.round(ceiling_area_sq_ft),
  };

  // Step 4 — paint quantities.
  // Wall paint: ((wall_area × coats) / wall_paint_coverage) × 1.10
  const wall_paint_raw =
    (wall_area_sq_ft * DEFAULTS.coats) / DEFAULTS.wall_paint_coverage;
  const wall_paint_gallons = ceil(wall_paint_raw * (1 + DEFAULTS.waste_factor));

  // Ceiling paint: same shape with ceiling coverage.
  const ceiling_paint_raw =
    (ceiling_area_sq_ft * DEFAULTS.coats) / DEFAULTS.ceiling_paint_coverage;
  const ceiling_paint_gallons = ceil(
    ceiling_paint_raw * (1 + DEFAULTS.waste_factor),
  );

  // Trim paint: spec says "use door and window counts if available; else
  // estimate trim gallons as: finished_sq_ft / 300".
  // For V1, when counts are present we still derive trim gallons from
  // finished_sq_ft / trim_paint_coverage (the more reliable proxy), and we
  // bump it slightly for a high count of openings. If we don't even know
  // finished_sq_ft, we fall back to count-based: (doors + windows) / 4.
  let trim_paint_gallons = 0;
  if (finished > 0) {
    trim_paint_gallons = ceil(finished / DEFAULTS.trim_paint_coverage);
  } else if (
    (extracted.door_count ?? 0) + (extracted.window_count ?? 0) >
    0
  ) {
    const openings =
      (extracted.door_count ?? 0) + (extracted.window_count ?? 0);
    trim_paint_gallons = ceil(openings / 4);
  }

  // Doors: 0.5 gallon per door (2 coats).
  const door_paint_gallons = ceil((extracted.door_count ?? 0) * 0.5);

  // Primer: same as wall paint but only 1 coat.
  const primer_raw =
    (wall_area_sq_ft * 1) / DEFAULTS.wall_paint_coverage;
  const primer_gallons = ceil(primer_raw * (1 + DEFAULTS.waste_factor));

  const paint: Paint = {
    wall_paint_gallons,
    ceiling_paint_gallons,
    trim_paint_gallons,
    door_paint_gallons,
    primer_gallons,
  };

  // Step 5 — material estimates.
  const tape_rolls = ceil(finished / 175);
  const plastic_rolls = ceil(finished / 500);
  const paper_rolls = ceil(finished / 400);
  const caulk_tubes =
    (extracted.door_count ?? 0) + (extracted.window_count ?? 0);
  const sanding_pads = ceil(finished / 150);

  const materials: Materials = {
    tape_rolls,
    plastic_rolls,
    paper_rolls,
    caulk_tubes,
    sanding_pads,
  };

  return {
    extracted,
    assumptions,
    areas,
    paint,
    materials,
  };
}
