# FBA Research Desk

A local, free Amazon FBA product research and profitability calculator.

**Status: Stage 1. The calculation engine and its tests only; there is no user interface yet.**

## Rules this project follows

- **No built-in Amazon fees.** You enter every fee, cost and sales estimate yourself.
- **Every input is labeled** `verified`, `user-provided`, `estimated` or `unknown`.
- **Unknown is never zero.** A result that depends on an unknown input is reported as
  `incomplete` and lists exactly which inputs are missing.
- **Every result shows its formula**, the numbers substituted into it, the inputs it used, and the
  weakest label among those inputs (`basis`).
- **Three separate profit figures:**
  - *Gross revenue*: sale price × units. No costs removed.
  - *Contribution profit*: sale price minus all per-unit costs (product, shipping, referral,
    fulfillment, storage, prep, ads, expected returns).
  - *Net business profit*: monthly contribution profit minus fixed monthly costs.
- **Never says "profitable" or "validated".** It reports arithmetic plus warnings whenever results
  depend on estimated or unverified inputs.
- All money inputs must be in one currency. Results are rounded to 2 decimal places.

## Requirements

- Node.js **22.12 or newer** (`node --version`)
- npm (comes with Node)
- No accounts, API keys, paid services or internet connection needed after install.

## Commands

Run these from inside the `fba-desk` folder:

| Command | What it does |
| --- | --- |
| `npm install` | Installs the free development tools (TypeScript, Vitest, Vite). |
| `npm test` | Runs all automated tests. |
| `npm run typecheck` | Checks the code for type errors. |

## Using the engine (for developers)

```ts
import { calculateProfitability } from './src/engine';

const report = calculateProfitability({
  salePrice: { value: '24.99', source: 'user-provided' },
  productCost: { value: '6.10', source: 'verified' },
  fulfillmentFeePerUnit: { value: '', source: 'unknown' }, // blank = unknown, never 0
  // ...the remaining fields are listed in src/engine/fields.ts
});

report.metrics.contributionProfitPerUnit;
// { status: 'incomplete', value: null, missingInputs: [...], formula: '...', ... }
report.warnings; // plain-English warnings, always including a disclaimer
```

## Troubleshooting

- **`npm install` fails with `Cannot read properties of null (reading 'edgesOut')`.** This is a
  known npm 10 bug. The `.npmrc` file in this folder works around it, so make sure you are running
  the command *inside* `fba-desk`.
- **`Cannot find package 'vite'` when running tests.** Run `npm install` again inside `fba-desk`.
  If it still happens, delete the `node_modules` folder and run `npm install`.
- **`npm test` says the Node version is unsupported.** Install Node.js 22.12 or newer.

## Project layout

```
src/engine/
  types.ts      data types: inputs, labels, metrics, report
  fields.ts     every input field, with its label and help text
  parse.ts      input validation and cent rounding
  calculate.ts  formulas, warnings and the calculateProfitability() entry point
tests/          automated tests (fictional sample data only)
```
