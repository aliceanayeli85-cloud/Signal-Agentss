# FBA Research Desk

A local, free Amazon FBA product research and profitability calculator.

**Status: Stage 4. Calculator, saving and comparing products, and a research assistant that screens items against your own rules.**

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

## Run the app

From inside the `fba-desk` folder:

```
npm install
npm start
```

Then open **http://127.0.0.1:4180** in your browser. Press `Ctrl+C` in the terminal to stop it.
The app runs only on your computer; nothing is sent anywhere.

Click **Load fictional sample** to try it with made-up numbers (labeled *Estimated*).

## Finding and screening products

The app does not find products by itself or know which ones sell. That needs Amazon sales data, which
is only available through a seller account or paid tools, and the app never makes it up. Instead it
helps you research ideas yourself and sorts them by your own rules:

1. **How to find product ideas (free)**, in the Saved products section: general tips for finding ideas.
2. **How to find this**, under each input: where to look that number up for free.
3. **Progress line**: how many inputs are filled in and how many are marked verified.
4. **Your rules**: your own minimums for contribution profit, margin, ROI and net profit per month.
   Leave any blank to skip it. They're saved when you leave a box.
5. **Verdict** for the current product, and a **Your rules** column for saved products:
   - *Meets your rules*, with "(unverified inputs)" when it relies on estimates.
   - *Fails your rules*, saying which rule and by how much.
   - *Not enough data*, when a needed input is unknown.
6. **Sort: Best first** ranks saved products: meets, then not enough data, then fails, with higher
   profit per unit first within each group.

"Meets your rules" is not a guarantee that a product is profitable. It means the numbers you entered
pass the limits you set.

## Saving products

Give the current inputs a product name and choose **Save as new product**. Saved products appear in
the **Saved products** table, recalculated from their saved inputs. Use **Open** to edit one, then
**Save changes**, or **Save as new product** to keep both versions. **Delete** asks before removing.

Where products are saved depends on how you open the app. The page always says which one applies:

| How you open it | Where products are saved |
| --- | --- |
| Your private claude.ai page | Privately in your Claude account. Only you can see them, on any device you sign in on. |
| `npm start` on your computer | In that browser on that computer only. |
| Anywhere saving is blocked | Nowhere. A warning says products will be lost when the page closes. |

Your unsaved typing is also kept in the browser, so a refresh doesn't lose it.

## Commands

Run these from inside the `fba-desk` folder:

| Command | What it does |
| --- | --- |
| `npm install` | Installs the free development tools (TypeScript, Vitest, Vite). |
| `npm start` | Builds the app and serves it at http://127.0.0.1:4180. |
| `npm run dev` | Development mode at http://127.0.0.1:5180 (reloads on code changes). |
| `npm run build` | Typechecks and builds the production files into `dist/`. |
| `npm run build:artifact` | Builds one self-contained page for the private claude.ai page (`dist-artifact/index.html`). |
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
- **`Port 4180 is already in use` (or 5180).** The app is already running in another terminal. Use
  that one, or stop it with `Ctrl+C` and try again.
- **"N saved item(s) could not be read".** Some saved data was damaged and is hidden rather than
  crashing the app. In the local version, if the whole list was unreadable, a copy is kept under the
  browser storage key `fba-desk:products:v1:damaged-backup` before anything new is saved.
- **Products saved locally don't appear on my phone.** Local saving stays in that one browser. Use the
  private claude.ai page to see products across devices.
- **The page is blank.** Make sure you opened the address printed in the terminal, and that
  JavaScript is enabled in your browser.

## Project layout

```
index.html      the web page shell
src/ui/
  main.ts       builds the form, results and saved-products table
  compare.ts    recalculates and ranks saved products for the comparison table
  form-state.ts form values, the fictional sample, conversion to engine inputs
  format.ts     number and label formatting
  styles.css    page styles (light and dark mode)
src/storage/
  product.ts         saved-product format and validation
  browser-store.ts   saving in this browser (local version)
  claude-store.ts    saving privately in your Claude account (claude.ai page)
  select.ts          picks where to save
  draft.ts           keeps unsaved typing across refreshes
src/build/
  artifact-html.ts   packs the built page into one file for claude.ai
src/engine/
  types.ts      data types: inputs, labels, metrics, report
  fields.ts     every input field, with its label and help text
  parse.ts      input validation and cent rounding
  calculate.ts  formulas, warnings and the calculateProfitability() entry point
  screening.ts  your rules: checks results against your minimums and ranks products
tests/          automated tests (fictional sample data only)
```
