// Types for the painting takeoff estimator output.
// Matches the JSON spec exactly.

export type Confidence = "high" | "medium" | "low";

export interface Extracted {
  finished_sq_ft: number | null;
  garage_sq_ft: number | null;
  patio_sq_ft: number | null;
  ceiling_height_ft: number | null;
  door_count: number | null;
  window_count: number | null;
  confidence: Confidence;
  notes: string;
}

export interface Assumptions {
  wall_multiplier: number;
  coats: number;
  waste_factor: string;
}

export interface Areas {
  wall_area_sq_ft: number;
  ceiling_area_sq_ft: number;
}

export interface Paint {
  wall_paint_gallons: number;
  ceiling_paint_gallons: number;
  trim_paint_gallons: number;
  door_paint_gallons: number;
  primer_gallons: number;
}

export interface Materials {
  tape_rolls: number;
  plastic_rolls: number;
  paper_rolls: number;
  caulk_tubes: number;
  sanding_pads: number;
}

export interface TakeoffResult {
  extracted: Extracted;
  assumptions: Assumptions;
  areas: Areas;
  paint: Paint;
  materials: Materials;
}
