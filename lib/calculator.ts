// Deterministic painting takeoff math. Runs on the client.
// AI never touches these numbers — it only fills in suggested inputs
// for the user to accept or override.

import type { Estimate, MaterialItem, ProjectInputs } from "./types";

// Materials configuration: each entry is { name, ratePerSqFt } where
// the per-unit count is ceil(sqFt / rate). A few items follow a
// different rule and are computed inline in computeMaterials().
//
// Rates are V1 estimates from common residential takeoffs. They live
// here so a contractor can adjust without touching the math.
const MATERIAL_CONFIG: ReadonlyArray<{ name: string; rate: number }> = [
  { name: 'Blue Tape 1"', rate: 200 },
  { name: 'Blue Tape 1.5"', rate: 175 },
  { name: "Yellow Tape", rate: 200 },
  { name: "White Tape", rate: 250 },
  { name: 'Paper 9"', rate: 200 },
  { name: "Masking Plastic (6x99)", rate: 500 },
  { name: "Ram Board", rate: 150 },
  // Caulk handled separately (per opening, not per sq ft).
  { name: "Wood Putty", rate: 1000 },
  { name: "Bondo", rate: 2000 },
  { name: '18" Sleeves', rate: 300 },
  { name: '9" Sleeves', rate: 250 },
  { name: '4" Sleeves', rate: 400 },
  { name: "Sanding Pads", rate: 150 },
];

// Compute the full materials list for a given finished sq ft and
// optional opening counts (doors + windows).
//
// V1: when openings are unknown we use 10 as a reasonable default so
// caulk shows up on the list. Doors/windows aren't yet inputs, but
// the AI extraction returns them and they can be wired in later.
export function computeMaterials(
  sqFt: number,
  openings = 10,
): MaterialItem[] {
  const list: MaterialItem[] = MATERIAL_CONFIG.map((m) => ({
    name: m.name,
    qty: Math.ceil(sqFt / m.rate),
    rate: m.rate,
  }));

  // Insert Caulk after Ram Board (matches the spec ordering).
  const ramBoardIndex = list.findIndex((m) => m.name === "Ram Board");
  list.splice(ramBoardIndex + 1, 0, {
    name: "Caulk",
    qty: openings,
  });

  return list;
}

export const DEFAULT_INPUTS: ProjectInputs = {
  sqFt: null,
  wallHeight: null,
  wallMultiplier: 2.6,
  coats: 2,
  prime: true,
  doors: 10,
  windows: 10,
};

export function isValidInputs(inputs: ProjectInputs): boolean {
  return (
    inputs.sqFt !== null &&
    inputs.wallHeight !== null &&
    inputs.sqFt > 0 &&
    inputs.wallHeight > 0
  );
}

export function calculateEstimate(inputs: ProjectInputs): Estimate | null {
  if (!inputs.sqFt || !inputs.wallHeight) return null;

  const waste = 1.1;
  // Wall area scales with both the multiplier (which encodes typical
  // wall-perimeter / floor-area ratio) and the wall height vs. a 9 ft
  // baseline. So a 2,500 sq ft house with 9 ft walls = 2,500 × 2.6 × 1
  // = 6,500 sq ft of wall; with 10 ft walls it's 7,222 sq ft.
  const baseHeight = 9;
  const wallArea =
    inputs.sqFt * inputs.wallMultiplier * (inputs.wallHeight / baseHeight);
  const ceilingArea = inputs.sqFt;

  const wallCoverage = 350;
  const ceilingCoverage = 400;

  const wallGallons = Math.ceil(
    ((wallArea * inputs.coats) / wallCoverage) * waste,
  );
  const ceilingGallons = Math.ceil(
    ((ceilingArea * inputs.coats) / ceilingCoverage) * waste,
  );
  const primerGallons = inputs.prime
    ? Math.ceil((wallArea / wallCoverage) * waste)
    : 0;

  // Trim area = door perimeter (≈ 20 sq ft/door) + window perimeter
  // (≈ 15 sq ft/window) + a 0.5×sqFt baseboard allowance.
  const trimArea =
    inputs.doors * 20 + inputs.windows * 15 + inputs.sqFt * 0.5;
  const trimCoverage = 300; // sq ft / gallon for trim paint
  const trimGallons = Math.ceil(
    ((trimArea * inputs.coats) / trimCoverage) * waste,
  );

  // Door paint: doors × 20 sq ft × coats / 300, with 10% waste.
  const doorGallons = Math.ceil(
    ((inputs.doors * 20 * inputs.coats) / trimCoverage) * waste,
  );

  // Materials takeoff. Caulk = doors + windows; everything else uses
  // the sq-ft / rate config in MATERIAL_CONFIG.
  const materials = computeMaterials(
    inputs.sqFt,
    inputs.doors + inputs.windows,
  );

  return {
    wallArea,
    ceilingArea,
    trimArea,
    wallGallons,
    ceilingGallons,
    primerGallons,
    trimGallons,
    doorGallons,
    materials,
  };
}
