// Deterministic painting takeoff math. Runs on the client.
// AI never touches these numbers — it only fills in suggested inputs
// for the user to accept or override.

import type { Estimate, ProjectInputs } from "./types";

export const DEFAULT_INPUTS: ProjectInputs = {
  sqFt: null,
  wallHeight: null,
  wallMultiplier: 2.6,
  coats: 2,
  prime: true,
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

  const tape = Math.ceil(inputs.sqFt / 175);
  const plastic = Math.ceil(inputs.sqFt / 500);
  const paper = Math.ceil(inputs.sqFt / 400);
  const sandingPads = Math.ceil(inputs.sqFt / 150);

  return {
    wallArea,
    ceilingArea,
    wallGallons,
    ceilingGallons,
    primerGallons,
    materials: { tape, plastic, paper, sandingPads },
  };
}
