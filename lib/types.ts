// Types shared across server and client.

// What the user controls. Required fields default to null so we can
// validate "user has explicitly entered a value" vs "we silently filled
// in a placeholder". Doors / windows have a sensible default since the
// calculator can run without them being plan-derived.
export type ProjectInputs = {
  sqFt: number | null;
  wallHeight: number | null;
  wallMultiplier: number;
  coats: number;
  prime: boolean;
  doors: number;
  windows: number;
};

// What the AI extracts from uploaded plans. These are *suggestions* —
// the user must accept them by leaving the inputs as-is, or override.
export type Confidence = "high" | "medium" | "low";

export interface Extracted {
  finished_sq_ft: number | null;
  ceiling_height_ft: number | null;
  door_count: number | null;
  window_count: number | null;
  confidence: Confidence;
  notes: string;
}

// One row in the materials takeoff list.
export interface MaterialItem {
  name: string;
  qty: number;
  // Optional sq-ft / unit rate for transparency. Caulk and other
  // rule-based items can leave this undefined.
  rate?: number;
}

// Calculator output.
export interface Estimate {
  wallArea: number;
  ceilingArea: number;
  trimArea: number;
  wallGallons: number;
  ceilingGallons: number;
  primerGallons: number;
  trimGallons: number;
  doorGallons: number;
  materials: MaterialItem[];
}
