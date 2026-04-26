// Types shared across server and client.

// What the user controls. Required fields default to null so we can
// validate "user has explicitly entered a value" vs "we silently filled
// in a placeholder".
export type ProjectInputs = {
  sqFt: number | null;
  wallHeight: number | null;
  wallMultiplier: number;
  coats: number;
  prime: boolean;
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

// Calculator output.
export interface Estimate {
  wallArea: number;
  ceilingArea: number;
  wallGallons: number;
  ceilingGallons: number;
  primerGallons: number;
  materials: {
    tape: number;
    plastic: number;
    paper: number;
    sandingPads: number;
  };
}
