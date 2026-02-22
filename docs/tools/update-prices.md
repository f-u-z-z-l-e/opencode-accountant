# update-prices Tool

The `update-prices` tool fetches end-of-day currency exchange rates and updates the price journals in `ledger/currencies/`. It uses the external `pricehist` tool to fetch data from various sources (Yahoo Finance, CoinMarketCap, ECB, etc.).

This tool is **restricted to the accountant agent only**.

## Arguments

| Argument   | Type    | Default | Description                                                    |
| ---------- | ------- | ------- | -------------------------------------------------------------- |
| `backfill` | boolean | `false` | If true, fetch historical prices from configured backfill_date |

## Output Format

### Daily Update Success (backfill: false)

When fetching only yesterday's prices:

```json
{
  "success": true,
  "endDate": "2026-02-21",
  "backfill": false,
  "results": [
    {
      "ticker": "EUR",
      "priceLine": "P 2026-02-21 EUR 0.944 CHF",
      "file": "eur.journal"
    },
    {
      "ticker": "USD",
      "priceLine": "P 2026-02-21 USD 0.881 CHF",
      "file": "usd.journal"
    },
    {
      "ticker": "BTC",
      "priceLine": "P 2026-02-21 BTC 52341.50 CHF",
      "file": "btc.journal"
    }
  ]
}
```

**Note:** The `priceLine` shows the latest (most recent) price added. In daily mode, only one price per currency is fetched.

### Backfill Success (backfill: true)

When fetching historical prices:

```json
{
  "success": true,
  "endDate": "2026-02-21",
  "backfill": true,
  "results": [
    {
      "ticker": "EUR",
      "priceLine": "P 2026-02-21 EUR 0.944 CHF",
      "file": "eur.journal"
    },
    {
      "ticker": "USD",
      "priceLine": "P 2026-02-21 USD 0.881 CHF",
      "file": "usd.journal"
    }
  ]
}
```

**Note:** The output shows the latest price line, but many historical prices were added to the journal files. Check the journal files to see all added prices.

### Partial Failure

When some currencies succeed and others fail:

```json
{
  "success": false,
  "endDate": "2026-02-21",
  "backfill": false,
  "results": [
    {
      "ticker": "EUR",
      "priceLine": "P 2026-02-21 EUR 0.944 CHF",
      "file": "eur.journal"
    },
    {
      "ticker": "BTC",
      "error": "No price data found within date range 2026-02-21 to 2026-02-21"
    },
    {
      "ticker": "AAPL",
      "error": "API rate limit exceeded"
    }
  ]
}
```

The tool processes all currencies independently. Partial success is possible.

### Configuration Error

When `config/prices.yaml` is missing or invalid:

```json
{
  "error": "Failed to load configuration: config/prices.yaml not found"
}
```

### Agent Restriction Error

When called by the wrong agent:

```json
{
  "error": "This tool is restricted to the accountant agent only.",
  "hint": "Use: Task(subagent_type='accountant', prompt='update prices')",
  "caller": "main assistant"
}
```

## Daily vs Backfill Modes

### Daily Mode (backfill: false, default)

**Behavior:**

- Fetches only yesterday's price for each currency
- Fast execution (single date per currency)
- Typical use: Daily or weekly routine updates

**Date range:** Yesterday to yesterday

**Example:**

```
update-prices()
# or
update-prices(backfill: false)
```

**Use when:**

- Performing routine price updates
- Keeping prices current
- No historical gaps exist

### Backfill Mode (backfill: true)

**Behavior:**

- Fetches historical prices from `backfill_date` to yesterday
- Slower execution (multiple dates per currency)
- Typical use: Initial setup, adding new currency, filling gaps

**Date range:** Per-currency `backfill_date` (or default) to yesterday

**Example:**

```
update-prices(backfill: true)
```

**Use when:**

- Adding a new currency (populate full history)
- Fixing missing dates (fill gaps)
- Initial repository setup (populate all currencies)
- Recovering from extended outage

### Backfill Date Configuration

**Per-currency backfill_date:**

```yaml
currencies:
  EUR:
    source: yahoo
    pair: EURCHF=X
    fmt_base: CHF
    backfill_date: '2024-01-01' # Start from this date
```

**Default backfill_date:**

- If currency has no `backfill_date` configured: January 1st of current year
- Example: In 2026, default is `2026-01-01`

**Why per-currency?**

- Different assets have different availability histories
- Cryptocurrencies may have shorter histories
- Some stocks/commodities have specific start dates

## Date Range Behavior

### End Date (Always Yesterday)

The tool **always fetches up to yesterday**, never today.

**Why?**

- End-of-day prices are used for accounting
- Today's prices are incomplete (market still open)
- Consistency: yesterday is the latest complete day

**Example:**

- If run on 2026-02-22, `endDate` will be `2026-02-21`

### Start Date

**Daily mode:**

- Start date = end date (yesterday)
- Fetches only one day

**Backfill mode:**

- Start date = currency's `backfill_date` (or default: Jan 1 of current year)
- Fetches range from start to yesterday

### Date Filtering

The tool filters price data to only include dates within the requested range.

**Why?**

- Prevents accidentally adding future dates
- Ensures data consistency
- Some sources may return data outside requested range

## Deduplication Logic

The tool updates journal files **in place** with automatic deduplication.

### How Deduplication Works

1. **Read existing** price lines from journal file (or empty if new)
2. **Build map** of `date → price line`
3. **Add existing** prices to map
4. **Add/override** with new prices (newer overwrites older for same date)
5. **Sort** by date (ascending: oldest first, newest at bottom)
6. **Write** back to file

### Key Behaviors

| Behavior        | Description                                        |
| --------------- | -------------------------------------------------- |
| Duplicate dates | Newer price overwrites older for the same date     |
| Timestamps      | Preserved from original source (if present)        |
| Sort order      | Chronological (oldest first, newest at bottom)     |
| File updates    | In-place (no backups created)                      |
| Idempotent      | Running twice produces same result as running once |

### Deduplication Example

**Before (existing file):**

```
P 2026-02-19 EUR 0.942 CHF
P 2026-02-20 EUR 0.943 CHF
```

**New data fetched:**

```
P 2026-02-20 EUR 0.945 CHF  # Different price for same date
P 2026-02-21 EUR 0.944 CHF  # New date
```

**After deduplication:**

```
P 2026-02-19 EUR 0.942 CHF  # Unchanged
P 2026-02-20 EUR 0.945 CHF  # Updated (newer overwrites)
P 2026-02-21 EUR 0.944 CHF  # Added
```

### Timestamps

Some sources provide timestamps:

```
P 2026-02-21 00:00:00 EUR 0.944 CHF
```

The tool preserves timestamps if present, but deduplication is based on **date only** (ignoring time).

## Price File Format

### Journal File Structure

```
# ledger/currencies/eur.journal
P 2026-01-15 EUR 0.945 CHF
P 2026-01-16 EUR 0.943 CHF
P 2026-02-21 EUR 0.944 CHF
```

### Price Line Format

**Format:** `P date commodity price base-currency`

**Components:**

- `P` = Price directive (hledger syntax)
- `date` = YYYY-MM-DD (may include timestamp HH:MM:SS)
- `commodity` = Currency being priced (e.g., EUR, USD, BTC)
- `price` = Exchange rate value
- `base-currency` = Base currency for conversion (e.g., CHF)

**Example:**

```
P 2026-02-21 EUR 0.944 CHF
```

Means: 1 EUR = 0.944 CHF on 2026-02-21

### File Locations

- All price journals stored in `ledger/currencies/`
- One file per currency (configured in `config/prices.yaml`)
- Files updated in place (existing prices preserved, new ones added/merged)

**Example structure:**

```
ledger/
└── currencies/
    ├── eur.journal
    ├── usd.journal
    ├── btc.journal
    └── eth.journal
```

## Typical Workflow

### Scenario 1: Daily Price Update

**Goal:** Keep prices current with daily/weekly updates

1. Run `update-prices()` (or `update-prices(backfill: false)`)
2. Check output for any errors
3. Verify prices were added:
   ```bash
   tail -3 ledger/currencies/eur.journal
   ```
4. Success: Latest prices now available for hledger

**Frequency:** Daily, weekly, or as needed for current prices

### Scenario 2: Adding a New Currency

**Goal:** Add a new currency with full historical data

1. Add currency config to `config/prices.yaml`:
   ```yaml
   currencies:
     GBP:
       source: yahoo
       pair: GBPCHF=X
       fmt_base: CHF
       file: gbp.journal
       backfill_date: '2024-01-01'
   ```
2. Run `update-prices(backfill: true)` to fetch historical data
3. Check output and verify `ledger/currencies/gbp.journal` created
4. Inspect file to confirm date range:
   ```bash
   head -3 ledger/currencies/gbp.journal
   tail -3 ledger/currencies/gbp.journal
   ```
5. Subsequent updates: use daily mode (`update-prices()`)

### Scenario 3: Fixing Missing Dates

**Goal:** Fill gaps in existing price history

1. Identify date gaps in price journals:
   ```bash
   cat ledger/currencies/eur.journal
   # Notice: prices for Feb 15-20 are missing
   ```
2. Run `update-prices(backfill: true)` to fill gaps
3. Deduplication ensures:
   - Existing prices preserved
   - Missing dates added
   - No duplicate entries
4. Verify gaps are filled:
   ```bash
   cat ledger/currencies/eur.journal | grep "2026-02"
   ```

### Scenario 4: Handling Errors

**Goal:** Recover from partial failures

1. Run `update-prices()`
2. Output shows `success: false` with partial results:
   ```json
   {
     "success": false,
     "results": [
       { "ticker": "EUR", "priceLine": "..." },
       { "ticker": "BTC", "error": "API rate limit exceeded" }
     ]
   }
   ```
3. Check error messages for each failed currency
4. Common fixes:
   - **Network issues**: Retry later
   - **API rate limits**: Wait (usually resets hourly/daily) and retry
   - **Invalid config**: Fix `config/prices.yaml` syntax or source/pair
   - **Missing pricehist**: Install external dependency
5. Re-run tool (idempotent - safe to retry)

**Note:** Successful currencies are already updated. Only failed currencies need retry.

## Configuration

### Config File: `config/prices.yaml`

**Structure:**

```yaml
currencies:
  <TICKER>:
    source: <source-name> # e.g., yahoo, coinbase, coinmarketcap, ecb
    pair: <trading-pair> # Source-specific format
    file: <journal-filename> # e.g., eur.journal
    fmt_base: <base-currency> # Optional, e.g., CHF, USD
    backfill_date: <YYYY-MM-DD> # Optional, per-currency backfill start
```

### Field Descriptions

| Field           | Required | Description                                                    |
| --------------- | -------- | -------------------------------------------------------------- |
| `source`        | Yes      | Price data source (passed to pricehist)                        |
| `pair`          | Yes      | Trading pair identifier (source-specific format)               |
| `file`          | Yes      | Journal filename in `ledger/currencies/`                       |
| `fmt_base`      | No       | Base currency for price notation (default: inferred from pair) |
| `backfill_date` | No       | Override default backfill start date for this currency         |

### Configuration Examples

**Fiat currencies (Yahoo Finance):**

```yaml
currencies:
  EUR:
    source: yahoo
    pair: EURCHF=X
    fmt_base: CHF
    file: eur.journal
    backfill_date: '2024-01-01'

  USD:
    source: yahoo
    pair: USDCHF=X
    fmt_base: CHF
    file: usd.journal
```

**Cryptocurrencies (CoinMarketCap):**

```yaml
currencies:
  BTC:
    source: coinmarketcap
    pair: BTC/CHF
    fmt_base: CHF
    file: btc.journal
    backfill_date: '2025-01-01'

  ETH:
    source: coinmarketcap
    pair: ETH/CHF
    fmt_base: CHF
    file: eth.journal
```

**EUR via ECB (European Central Bank):**

```yaml
currencies:
  EUR:
    source: ecb
    pair: EUR/CHF
    fmt_base: CHF
    file: eur.journal
```

### External Dependency: pricehist

The tool uses the `pricehist` command-line tool to fetch price data.

**Requirements:**

- `pricehist` must be installed and available in PATH
- Install: `pip install pricehist` (or distribution-specific package)

**Supported sources:** Yahoo Finance, CoinMarketCap, Coinbase, ECB, and more. See `pricehist` documentation for full list.

**Note:** The tool abstracts pricehist details - you only need to configure `source` and `pair` in the YAML.

## Error Handling

### Common Errors

| Error               | Cause                                   | Solution                                                                       |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| External tool error | pricehist not installed or not in PATH  | Install pricehist: `pip install pricehist`                                     |
| No price data found | No data available for date range        | Check if date range is valid; API may not have historical data for that period |
| API rate limit      | Too many requests to price source       | Wait and retry; rate limits typically reset hourly or daily                    |
| Network error       | Cannot reach price data source          | Check internet connection; retry later                                         |
| Configuration error | Missing or invalid `config/prices.yaml` | Ensure config file exists with proper YAML syntax and required fields          |
| Invalid date range  | Start date after end date               | Check `backfill_date` configuration; must be before yesterday                  |
| Agent restriction   | Called by wrong agent                   | Use `Task(subagent_type='accountant', prompt='update prices')`                 |
| Permission error    | Cannot write to journal files           | Check file permissions on `ledger/currencies/` directory                       |
| Invalid source/pair | Source or pair format incorrect         | Check `pricehist` docs for correct format for your source                      |

### Partial Failures

The tool processes all currencies **independently**.

**Behavior:**

- Each currency is fetched and updated separately
- Failure in one currency doesn't affect others
- Overall `success: false` if ANY currency fails
- Check `results` array for per-currency status

**Example:**

```json
{
  "success": false,
  "results": [
    { "ticker": "EUR", "priceLine": "P 2026-02-21 EUR 0.944 CHF", "file": "eur.journal" },
    { "ticker": "BTC", "error": "API rate limit exceeded" }
  ]
}
```

EUR succeeded (updated), BTC failed (not updated).

**Recovery:**

- Can re-run tool safely (idempotent)
- Successful currencies won't re-fetch (deduplication handles this)
- Only failed currencies will retry

### Debugging Tips

**Check pricehist directly:**

```bash
pricehist fetch -o ledger -s 2026-02-21 -e 2026-02-21 yahoo EURCHF=X
```

**Check journal file:**

```bash
cat ledger/currencies/eur.journal
```

**Check config syntax:**

```bash
cat config/prices.yaml
```

**Check permissions:**

```bash
ls -la ledger/currencies/
```
