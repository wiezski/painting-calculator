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

// Per-store pricing. $ per gallon for paint, $ per unit for materials.
// V1 numbers are reasonable estimates of real retail pricing; tune
// against actual receipts once a store API is wired in.
type StorePricing = {
  paint: {
    walls: number;
    ceilings: number;
    trim: number;
    primer: number;
  };
  materials: Record<string, number>;
};

export const STORE_PRICING: Record<Store, StorePricing> = {
  // Premium pro-painter store — highest paint quality and price.
  "sherwin-williams": {
    paint: { walls: 55, ceilings: 42, trim: 70, primer: 35 },
    materials: {
      'Blue Tape 1"': 7,
      'Blue Tape 1.5"': 8,
      "Yellow Tape": 6,
      "White Tape": 6,
      'Paper 9"': 14,
      "Masking Plastic (6x99)": 28,
      "Ram Board": 48,
      Caulk: 5,
      "Wood Putty": 9,
      Bondo: 14,
      '18" Sleeves': 12,
      '9" Sleeves': 7,
      '4" Sleeves': 6,
      "Sanding Pads": 3,
    },
  },
  // Big-box retail — generally lowest paint price, decent materials.
  "home-depot": {
    paint: { walls: 38, ceilings: 30, trim: 52, primer: 26 },
    materials: {
      'Blue Tape 1"': 5,
      'Blue Tape 1.5"': 6,
      "Yellow Tape": 4,
      "White Tape": 4,
      'Paper 9"': 10,
      "Masking Plastic (6x99)": 22,
      "Ram Board": 42,
      Caulk: 3,
      "Wood Putty": 7,
      Bondo: 11,
      '18" Sleeves': 9,
      '9" Sleeves': 5,
      '4" Sleeves': 4,
      "Sanding Pads": 2,
    },
  },
  // Big-box retail — sits in the middle.
  lowes: {
    paint: { walls: 42, ceilings: 33, trim: 56, primer: 28 },
    materials: {
      'Blue Tape 1"': 6,
      'Blue Tape 1.5"': 7,
      "Yellow Tape": 5,
      "White Tape": 5,
      'Paper 9"': 11,
      "Masking Plastic (6x99)": 24,
      "Ram Board": 44,
      Caulk: 4,
      "Wood Putty": 8,
      Bondo: 12,
      '18" Sleeves': 10,
      '9" Sleeves': 6,
      '4" Sleeves': 5,
      "Sanding Pads": 2,
    },
  },
};

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

// Pricing depends on the estimate (gallons + materials list), the
// inputs (production rates, hourly rate, painters, markup), and the
// chosen store (drives paint and material unit prices).
export function computeCosts(
  estimate: Estimate,
  inputs: ProjectInputs,
  store: Store,
): CostBreakdown {
  const prices = STORE_PRICING[store];

  const paintCosts = {
    walls: estimate.wallGallons * prices.paint.walls,
    ceilings: estimate.ceilingGallons * prices.paint.ceilings,
    trim: estimate.trimGallons * prices.paint.trim,
    primer: estimate.primerGallons * prices.paint.primer,
  };

  const materialCosts: MaterialCost[] = estimate.materials.map(
    (m: MaterialItem) => {
      const unitPrice = prices.materials[m.name] ?? 0;
      return {
        name: m.name,
        qty: m.qty,
        unitPrice,
        cost: m.qty * unitPrice,
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
