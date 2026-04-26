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

// $ per gallon for paint, $ per unit for materials.
export const PRICING = {
  paint: {
    walls: 45,
    ceilings: 35,
    trim: 60,
    primer: 30,
  },
  materials: {
    'Blue Tape 1"': 6,
    'Blue Tape 1.5"': 7,
    "Yellow Tape": 5,
    "White Tape": 5,
    'Paper 9"': 12,
    "Masking Plastic (6x99)": 25,
    "Ram Board": 45,
    Caulk: 4,
    "Wood Putty": 8,
    Bondo: 12,
    '18" Sleeves': 10,
    '9" Sleeves': 6,
    '4" Sleeves': 5,
    "Sanding Pads": 2,
  } as Record<string, number>,
} as const;

export interface MaterialCost {
  name: string;
  qty: number;
  unitPrice: number;
  cost: number;
}

// Labor rate of work — sq ft of wall painted per painter-hour.
const LABOR_SQFT_PER_HOUR = 150;

export interface CostBreakdown {
  paintCosts: {
    walls: number;
    ceilings: number;
    trim: number;
    primer: number;
  };
  materialCosts: MaterialCost[];
  labor: {
    hours: number;          // wallArea / 150
    costPerPainter: number; // hours × hourlyRate
    totalCost: number;      // costPerPainter × numberOfPainters
  };
  totals: {
    paint: number;
    materials: number;
    labor: number;
    grand: number;          // paint + materials (used by store comparison)
  };
  jobPricing: {
    materials: number;      // = totals.materials
    labor: number;          // = totals.labor
    subtotal: number;       // materials + labor
    markupAmount: number;   // subtotal × (markup / 100)
    finalPrice: number;     // subtotal + markupAmount
  };
}

// Pricing depends on the estimate (gallons + materials list), the
// inputs (hourlyRate / numberOfPainters / markup drive labor and final
// price), and the chosen store. Store is currently unused but accepted
// so the signature is stable when real per-store pricing lands.
export function computeCosts(
  estimate: Estimate,
  inputs: ProjectInputs,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  store: Store,
): CostBreakdown {
  const paintCosts = {
    walls: estimate.wallGallons * PRICING.paint.walls,
    ceilings: estimate.ceilingGallons * PRICING.paint.ceilings,
    trim: estimate.trimGallons * PRICING.paint.trim,
    primer: estimate.primerGallons * PRICING.paint.primer,
  };

  const materialCosts: MaterialCost[] = estimate.materials.map(
    (m: MaterialItem) => {
      const unitPrice = PRICING.materials[m.name] ?? 0;
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

  // Labor: wallArea / 150 sq ft per painter-hour.
  const laborHours = estimate.wallArea / LABOR_SQFT_PER_HOUR;
  const laborCostPerPainter = laborHours * inputs.hourlyRate;
  const totalLaborCost = laborCostPerPainter * inputs.numberOfPainters;

  // Job pricing: materials + labor → markup → final price.
  const subtotal = materialTotal + totalLaborCost;
  const markupAmount = subtotal * (inputs.markup / 100);
  const finalPrice = subtotal + markupAmount;

  return {
    paintCosts,
    materialCosts,
    labor: {
      hours: laborHours,
      costPerPainter: laborCostPerPainter,
      totalCost: totalLaborCost,
    },
    totals: {
      paint: paintTotal,
      materials: materialTotal,
      labor: totalLaborCost,
      grand,
    },
    jobPricing: {
      materials: materialTotal,
      labor: totalLaborCost,
      subtotal,
      markupAmount,
      finalPrice,
    },
  };
}
