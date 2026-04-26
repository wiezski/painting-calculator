// Types shared across server and client.

// What the user controls. Required fields are nullable so we can
// validate "user has explicitly entered a value" vs "we silently filled
// in a placeholder". sqFt, wallHeight, doors, and windows are all
// required — only the calc-tuning fields (wallMultiplier, coats, prime)
// and the labor/markup fields (hourlyRate, numberOfPainters, markup)
// keep defaults.
export type ProjectInputs = {
  sqFt: number | null;
  wallHeight: number | null;
  wallMultiplier: number;
  coats: number;
  prime: boolean;
  doors: number | null;
  windows: number | null;
  hourlyRate: number;
  numberOfPainters: number;
  markup: number; // percent, e.g. 30 = +30 %
  // Production rates — sq ft / hr, except doorRate which is doors / hr.
  // Editable so contractors can tune to their crew's actual pace.
  wallRate: number;
  ceilingRate: number;
  trimRate: number;
  doorRate: number;
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
  doorArea: number; // doors × 20
  wallGallons: number;
  ceilingGallons: number;
  primerGallons: number;
  trimGallons: number;
  doorGallons: number;
  materials: MaterialItem[];
}
