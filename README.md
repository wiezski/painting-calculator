# Painting Calculator

Residential painting estimator. The user controls all numbers; AI is optional and only suggests starting values from uploaded plans.

## Architecture

- **User inputs are the source of truth.** Required fields (sq ft, wall height) start blank and must be entered before any calculation runs.
- **AI suggests, never decides.** Optional plan upload sends PDFs / images to Claude (vision). The model returns suggested values for finished sq ft, wall / ceiling height, door count, and window count. The user applies them with a one-click button or ignores them.
- **Math runs client-side.** `lib/calculator.ts` contains the deterministic takeoff math. The server never computes gallons.

## Inputs

| Field | Required | Default |
| --- | --- | --- |
| Finished Sq Ft | yes | (blank) |
| Wall Height (ft) | yes | (blank — quick buttons 8 / 9 / 10) |
| Wall Multiplier | no | 2.6 |
| Coats | no | 2 |
| Prime | no | true |

If sq ft or wall height is blank, the app shows "Enter square footage and wall height to calculate estimate" and computes nothing.

## Math

```
wallArea     = sqFt × wallMultiplier
ceilingArea  = sqFt
wallGallons    = ceil((wallArea × coats / 350) × 1.10)
ceilingGallons = ceil((ceilingArea × coats / 400) × 1.10)
primerGallons  = prime ? ceil((wallArea / 350) × 1.10) : 0
tape          = ceil(sqFt / 175)
plastic       = ceil(sqFt / 500)
paper         = ceil(sqFt / 400)
sandingPads   = ceil(sqFt / 150)
```

Wall height is required for documentation but the V1 multiplier (2.6) is the proxy for perimeter; height itself is not used in the math yet.

## Setup

```bash
npm install
cp .env.example .env.local   # only needed if you want the AI suggestion panel
npm run dev
```

The AI panel needs `ANTHROPIC_API_KEY`. Without it, the manual calculator still works — only the upload feature is disabled.

## Deploy

This project is on Vercel. Pushes to `main` auto-deploy. `ANTHROPIC_API_KEY` is configured in Project Settings → Environment Variables.
