# Painting Calculator

Residential painting takeoff assistant. Upload architectural plans (PDF or images) and get a paint and material estimate.

## How it works

1. The user uploads one or more PDFs / images of plans.
2. The `/api/analyze` route forwards them to Claude (vision) with a strict extraction prompt.
3. Claude returns only the extracted data points (finished sq ft, ceiling height, door / window counts, etc.).
4. The server runs the deterministic takeoff math (`lib/calculator.ts`) and returns a full estimate.
5. The UI shows a clean estimate with a "Show JSON" toggle for the spec output.

The math (multipliers, coverage rates, waste factor, rounding) lives in `lib/calculator.ts` so results are reproducible regardless of model variance.

## Setup

```bash
npm install
cp .env.example .env.local
# Add your ANTHROPIC_API_KEY to .env.local
npm run dev
```

Open http://localhost:3000.

## Deploy

This project is built for Vercel.

1. Push to GitHub.
2. Import the repo into Vercel.
3. Add `ANTHROPIC_API_KEY` as an environment variable in the Vercel project settings.
4. Deploy.

## Defaults (from spec)

| Setting | Value |
| --- | --- |
| Wall multiplier | 2.6 × finished sq ft |
| Coats | 2 |
| Waste factor | 10% |
| Wall paint coverage | 350 sq ft / gal |
| Ceiling paint coverage | 400 sq ft / gal |
| Trim paint coverage | 300 sq ft / gal |
| Doors | 0.5 gal each |
| Primer | wall area × 1 coat (default on for new construction) |

V1 does not subtract windows/doors from wall area. Always sanity-check before ordering.
