// V1 pricing — uniform across stores for now. The Store selector
// is wired through to state but doesn't affect numbers yet (no API
// calls). Drop in a per-store table here when ready.

import type { Estimate, MaterialItem, ProjectInputs } from "./types";

export type Store = "sherwin-williams" | "home-depot" | "lowes";

export const STORES: ReadonlyArray<{ id: Store; label: string }> = [
  { id: "sherwin-williams", label: "Sherwin Williams" },
  { id: "home-depot", label: "Home Depot" },
  { id: "lowes", label: "Lowe's" },
];

// Each price cell is a small object so we can attach a product URL
// and a last-fetched timestamp. The calculator always reads `.price`,
// the URL/timestamp are metadata for the Pricing Settings UI.
export interface PriceEntry {
  price: number;
  url: string;
  lastUpdated: number | null;
}

// Helper for seeding defaults / building entries during migration.
export function makePriceEntry(
  price: number,
  url: string = "",
  lastUpdated: number | null = null,
): PriceEntry {
  return { price, url, lastUpdated };
}

// Per-store pricing. $ per gallon for paint, $ per unit for materials.
// V1 numbers are reasonable estimates of real retail pricing; the
// Pricing Settings UI lets users override any cell or fetch a real
// price from a product URL.
export type StorePricing = {
  paint: {
    walls: PriceEntry;
    ceilings: PriceEntry;
    trim: PriceEntry;
    primer: PriceEntry;
  };
  materials: Record<string, PriceEntry>;
};

export type StorePricingMap = Record<Store, StorePricing>;

// Quick alias so the literal default block below stays readable.
const e = (n: number): PriceEntry => makePriceEntry(n);

export const DEFAULT_STORE_PRICING: StorePricingMap = {
  // Premium pro-painter store — highest paint quality and price.
  "sherwin-williams": {
    paint: { walls: e(55), ceilings: e(42), trim: e(70), primer: e(35) },
    materials: {
      'Blue Tape 1"': e(7),
      'Blue Tape 1.5"': e(8),
      "Yellow Tape": e(6),
      "White Tape": e(6),
      'Paper 9"': e(14),
      "Masking Plastic (6x99)": e(28),
      "Ram Board": e(48),
      Caulk: e(5),
      "Wood Putty": e(9),
      Bondo: e(14),
      '18" Sleeves': e(12),
      '9" Sleeves': e(7),
      '4" Sleeves': e(6),
      "Sanding Pads": e(3),
    },
  },
  // Big-box retail — generally lowest paint price, decent materials.
  "home-depot": {
    paint: { walls: e(38), ceilings: e(30), trim: e(52), primer: e(26) },
    materials: {
      'Blue Tape 1"': e(5),
      'Blue Tape 1.5"': e(6),
      "Yellow Tape": e(4),
      "White Tape": e(4),
      'Paper 9"': e(10),
      "Masking Plastic (6x99)": e(22),
      "Ram Board": e(42),
      Caulk: e(3),
      "Wood Putty": e(7),
      Bondo: e(11),
      '18" Sleeves': e(9),
      '9" Sleeves': e(5),
      '4" Sleeves': e(4),
      "Sanding Pads": e(2),
    },
  },
  // Big-box retail — sits in the middle.
  lowes: {
    paint: { walls: e(42), ceilings: e(33), trim: e(56), primer: e(28) },
    materials: {
      'Blue Tape 1"': e(6),
      'Blue Tape 1.5"': e(7),
      "Yellow Tape": e(5),
      "White Tape": e(5),
      'Paper 9"': e(11),
      "Masking Plastic (6x99)": e(24),
      "Ram Board": e(44),
      Caulk: e(4),
      "Wood Putty": e(8),
      Bondo: e(12),
      '18" Sleeves': e(10),
      '9" Sleeves': e(6),
      '4" Sleeves': e(5),
      "Sanding Pads": e(2),
    },
  },
};

// Migrate legacy pricing values (raw numbers) to PriceEntry shape.
// Idempotent — already-migrated PriceEntry objects pass through.
export function toPriceEntry(value: unknown): PriceEntry {
  if (typeof value === "number") return makePriceEntry(value);
  if (value && typeof value === "object") {
    const v = value as Partial<PriceEntry>;
    return {
      price: typeof v.price === "number" ? v.price : 0,
      url: typeof v.url === "string" ? v.url : "",
      lastUpdated:
        typeof v.lastUpdated === "number" ? v.lastUpdated : null,
    };
  }
  return makePriceEntry(0);
}

export function migrateStorePricingMap(raw: unknown): StorePricingMap {
  const fallback = DEFAULT_STORE_PRICING;
  if (!raw || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  const out: StorePricingMap = { ...fallback };
  for (const storeKey of Object.keys(fallback) as Store[]) {
    const sourceStore = r[storeKey] as Record<string, unknown> | undefined;
    if (!sourceStore) continue;
    const def = fallback[storeKey];
    const sourcePaint = (sourceStore.paint ?? {}) as Record<string, unknown>;
    const sourceMats = (sourceStore.materials ?? {}) as Record<string, unknown>;
    out[storeKey] = {
      paint: {
        walls: toPriceEntry(sourcePaint.walls ?? def.paint.walls),
        ceilings: toPriceEntry(sourcePaint.ceilings ?? def.paint.ceilings),
        trim: toPriceEntry(sourcePaint.trim ?? def.paint.trim),
        primer: toPriceEntry(sourcePaint.primer ?? def.paint.primer),
      },
      materials: Object.fromEntries(
        Object.keys(def.materials).map((name) => [
          name,
          toPriceEntry(sourceMats[name] ?? def.materials[name]),
        ]),
      ),
    };
  }
  return out;
}

export interface MaterialCost {
  name: string;
  qty: number;
  unitPrice: number;
  cost: number;
}

export interface CostBreakdown {
  paintCosts: {
    walls: number;
    ceilings: number;
    trim: number;
    primer: number;
  };
  materialCosts: MaterialCost[];
  // Task-based labor model. Hours come from the production rates in
  // ProjectInputs; cost = totalHours × hourlyRate × numberOfPainters.
  labor: {
    wallHours: number;
    ceilingHours: number;
    trimHours: number;
    doorHours: number;
    totalHours: number;
    laborCost: number;
  };
  totals: {
    paint: number;
    materials: number;
    labor: number;
    grand: number; // paint + materials (used by store comparison)
  };
  jobPricing: {
    materials: number;
    labor: number;
    subtotal: number;     // materials + labor
    markupAmount: number; // subtotal × (markup / 100)
    finalPrice: number;   // subtotal + markupAmount
    profit: number;       // alias of markupAmount
    marginPct: number;    // (profit / finalPrice) × 100
  };
}

// Region detection by ZIP prefix. Simple lookup — no API. Add more
// rows here as needed.
const LOCATION_TABLE: Record<
  string,
  { region: string; multiplier: number }
> = {
  "84": { region: "Utah", multiplier: 1.0 },
  "90": { region: "California", multiplier: 1.15 },
  "91": { region: "California", multiplier: 1.15 },
  "75": { region: "Texas", multiplier: 0.95 },
};

export function getLocationInfo(zip: string): {
  region: string | null;
  multiplier: number;
} {
  const trimmed = (zip ?? "").trim();
  if (trimmed.length < 2) return { region: null, multiplier: 1.0 };
  const prefix = trimmed.slice(0, 2);
  const hit = LOCATION_TABLE[prefix];
  if (!hit) return { region: null, multiplier: 1.0 };
  return hit;
}

// Pricing depends on the estimate (gallons + materials list), the
// inputs (production rates, hourly rate, painters, markup, zip), the
// chosen store, the editable pricing table, and a location multiplier
// derived from the ZIP code.
export function computeCosts(
  estimate: Estimate,
  inputs: ProjectInputs,
  store: Store,
  pricing: StorePricingMap,
  locationMultiplier: number = 1.0,
): CostBreakdown {
  const prices = pricing[store];
  const m = locationMultiplier;

  const paintCosts = {
    walls: estimate.wallGallons * prices.paint.walls.price * m,
    ceilings: estimate.ceilingGallons * prices.paint.ceilings.price * m,
    trim: estimate.trimGallons * prices.paint.trim.price * m,
    primer: estimate.primerGallons * prices.paint.primer.price * m,
  };

  const materialCosts: MaterialCost[] = estimate.materials.map(
    (mi: MaterialItem) => {
      const entry = prices.materials[mi.name];
      const unitPrice = (entry?.price ?? 0) * m;
      return {
        name: mi.name,
        qty: mi.qty,
        unitPrice,
        cost: mi.qty * unitPrice,
      };
    },
  );

  const paintTotal =
    paintCosts.walls +
    paintCosts.ceilings +
    paintCosts.trim +
    paintCosts.primer;
  const materialTotal = materialCosts.reduce((sum, m) => sum + m.cost, 0);
  const grand = paintTotal + materialTotal;

  // Task-based labor: each surface gets its own production rate.
  const wallHours = estimate.wallArea / inputs.wallRate;
  const ceilingHours = estimate.ceilingArea / inputs.ceilingRate;
  const trimHours = estimate.trimArea / inputs.trimRate;
  const doorHours = (inputs.doors ?? 0) / inputs.doorRate;
  const totalHours = wallHours + ceilingHours + trimHours + doorHours;
  const laborCost = totalHours * inputs.hourlyRate * inputs.numberOfPainters;

  // Job pricing: materials + labor → markup → final price.
  const subtotal = materialTotal + laborCost;
  const markupAmount = subtotal * (inputs.markup / 100);
  const finalPrice = subtotal + markupAmount;
  const marginPct = finalPrice > 0 ? (markupAmount / finalPrice) * 100 : 0;

  return {
    paintCosts,
    materialCosts,
    labor: {
      wallHours,
      ceilingHours,
      trimHours,
      doorHours,
      totalHours,
      laborCost,
    },
    totals: {
      paint: paintTotal,
      materials: materialTotal,
      labor: laborCost,
      grand,
    },
    jobPricing: {
      materials: materialTotal,
      labor: laborCost,
      subtotal,
      markupAmount,
      finalPrice,
      profit: markupAmount,
      marginPct,
    },
  };
}
