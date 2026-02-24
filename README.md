# opencode-accountant

An OpenCode accounting agent, specialized in double-entry-bookkepping with hledger

> A Bun module created from the [bun-module](https://github.com/zenobi-us/bun-module) template

## Usage

<!-- Example usage code goes here -->

## Installation

<!-- Installation instructions go here -->

## Configuration

### Price Fetching Configuration

The `fetch-currency-prices` tool requires a configuration file to specify which currency pairs to fetch. Create a `config/prices.yaml` file in your project directory with the following structure:

```yaml
currencies:
  BTC:
    source: coinmarketcap
    pair: BTC/CHF
    file: btc-chf.journal
    backfill_date: '2025-12-31'

  EUR:
    source: ecb
    pair: EUR/CHF
    file: eur-chf.journal
    backfill_date: '2025-12-31'

  USD:
    source: yahoo
    pair: USDCHF=X
    file: usd-chf.journal
    fmt_base: USD
    backfill_date: '2025-06-01'
```

#### Configuration Options

Each currency entry supports the following fields:

| Field           | Required | Description                                                                |
| --------------- | -------- | -------------------------------------------------------------------------- |
| `source`        | Yes      | The pricehist data source (e.g., `coinmarketcap`, `ecb`, `yahoo`)          |
| `pair`          | Yes      | The currency pair to fetch (e.g., `BTC/CHF`, `EUR/CHF`)                    |
| `file`          | Yes      | Output filename in `ledger/currencies/` (e.g., `btc-chf.journal`)          |
| `fmt_base`      | No       | Base currency format override for pricehist (e.g., `USD` for yahoo source) |
| `backfill_date` | No       | Start date for backfill mode. Defaults to January 1st of the current year  |

#### Directory Structure

The plugin expects the following directory structure in your project:

```
your-project/
├── config/
│   └── prices.yaml      # Price fetching configuration
└── ledger/
    └── currencies/      # Where price journal files are written
        ├── btc-chf.journal
        ├── eur-chf.journal
        └── usd-chf.journal
```

#### Base Currency

The `pair` field determines the currency conversion. While the examples above use CHF as the base currency, you can use any currency supported by your price source:

```yaml
currencies:
  BTC:
    source: coinmarketcap
    pair: BTC/EUR # Prices in EUR instead of CHF
    file: btc-eur.journal
```

#### Available Data Sources

The `source` field accepts any source supported by [pricehist](https://github.com/chrisberkhout/pricehist). Common sources include:

- `coinmarketcap` - Cryptocurrency prices
- `ecb` - European Central Bank exchange rates
- `yahoo` - Yahoo Finance (use `fmt_base` for proper formatting)

### Statement Classification Configuration

The `classify-statements` tool classifies bank statement CSV files by provider and currency, moving them to the appropriate directories for import processing. Create a `config/import/providers.yaml` file:

```yaml
paths:
  import: import/incoming
  pending: import/pending
  done: import/done
  unrecognized: import/unrecognized
  rules: ledger/rules

providers:
  revolut:
    detect:
      - filenamePattern: '^account-statement_'
        header: 'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance'
        currencyField: Currency
      - filenamePattern: '^crypto-account-statement_'
        header: 'Symbol,Type,Quantity,Price,Value,Fees,Date'
        currencyField: Symbol
    currencies:
      CHF: chf
      EUR: eur
      USD: usd
      BTC: btc

  ubs:
    detect:
      # Note: UBS exports have a trailing semicolon in the header row, which creates
      # an empty field when parsed. The header must include a trailing comma to match.
      - header: 'Trade date,Trade time,Booking date,Value date,Currency,Debit,Credit,Individual amount,Balance,Transaction no.,Description1,Description2,Description3,Footnotes,'
        currencyField: Currency
        skipRows: 9
        delimiter: ';'
        renamePattern: 'transactions-ubs-{account-number}.csv'
        metadata:
          - field: account-number
            row: 0
            column: 1
            normalize: spaces-to-dashes
    currencies:
      CHF: chf
      EUR: eur
      USD: usd
```

#### Configuration Options

**Paths:**

| Field          | Description                                     |
| -------------- | ----------------------------------------------- |
| `import`       | Drop zone for new CSV files                     |
| `pending`      | Base path for classified files awaiting import  |
| `done`         | Base path for archived files after import       |
| `unrecognized` | Directory for files that couldn't be classified |
| `rules`        | Directory containing hledger `.rules` files     |

**Provider Detection Rules:**

| Field             | Required | Description                                                |
| ----------------- | -------- | ---------------------------------------------------------- |
| `filenamePattern` | No       | Regex pattern to match against filename                    |
| `header`          | Yes      | Expected CSV header row (comma-separated, exact match)\*   |
| `currencyField`   | Yes      | Column name containing the currency/symbol                 |
| `skipRows`        | No       | Number of rows to skip before header (default: 0)          |
| `delimiter`       | No       | CSV delimiter character (default: `,`)                     |
| `renamePattern`   | No       | Output filename pattern with `{placeholder}` substitutions |
| `metadata`        | No       | Array of metadata extraction rules (see below)             |
| `currencies`      | Yes      | Map of raw currency values to normalized folder names      |

\* **Note on trailing delimiters:** If the CSV header row ends with a trailing delimiter (e.g., `Field1;Field2;`), this creates an empty field when parsed. The `header` config must include a trailing comma to account for this (e.g., `Field1,Field2,`).

**Metadata Extraction Rules:**

| Field       | Required | Description                                             |
| ----------- | -------- | ------------------------------------------------------- |
| `field`     | Yes      | Placeholder name to use in `renamePattern`              |
| `row`       | Yes      | Row index within `skipRows` to extract from (0-indexed) |
| `column`    | Yes      | Column index to extract from (0-indexed)                |
| `normalize` | No       | Normalization type: `spaces-to-dashes`                  |

#### Directory Structure

```
your-project/
├── config/
│   └── import/
│       └── providers.yaml          # Configures all paths below
├── ledger/
│   └── rules/                      # {paths.rules}
│       └── <provider>-{account-number}.rules
├── import/
│   ├── incoming/                   # {paths.import} - Drop CSV files here
│   ├── pending/                    # {paths.pending} - Classified files
│   │   └── <provider>/             # e.g., revolut, ubs
│   │       └── <currency>/         # e.g., chf, eur, usd, btc
│   ├── done/                       # {paths.done} - Processed files
│   │   └── <provider>/
│   │       └── <currency>/
│   └── unrecognized/               # {paths.unrecognized} - Unknown files
```

#### Workflow

The `import-pipeline` tool provides an atomic, safe import workflow using git worktrees:

1. Drop CSV files into `{paths.import}` (default: `import/incoming/`)
2. Run `import-pipeline` tool with optional provider/currency filters
3. The tool automatically:
   - Creates an isolated git worktree
   - Classifies CSV files by provider/currency
   - Validates all transactions have matching rules
   - Imports transactions to the appropriate year journal
   - Reconciles closing balance (if available in CSV metadata)
   - Merges changes back to main branch with `--no-ff`
   - Cleans up the worktree
4. If any step fails, the worktree is discarded and main branch remains untouched

### Statement Import

The `import-pipeline` tool is the single entry point for importing bank statements. It orchestrates classification, validation, import, and reconciliation in an atomic operation.

#### Tool Arguments

| Argument         | Type    | Default | Description                                            |
| ---------------- | ------- | ------- | ------------------------------------------------------ |
| `provider`       | string  | -       | Filter by provider (e.g., `revolut`, `ubs`)            |
| `currency`       | string  | -       | Filter by currency (e.g., `chf`, `eur`)                |
| `skipClassify`   | boolean | `false` | Skip classification step (if files already classified) |
| `closingBalance` | string  | -       | Manual closing balance for reconciliation              |
| `account`        | string  | -       | Manual account override (auto-detected from rules)     |

#### Rules File Matching

The tool matches CSV files to their rules files by parsing the `source` directive in each `.rules` file. For example, if `ubs-account.rules` contains:

```
source ../../import/pending/ubs/chf/transactions.csv
```

The tool will use that rules file when processing `transactions.csv`.

**Note:** The `source` path should match your configured `{paths.pending}` directory structure.

See the hledger documentation for details on rules file format and syntax.

#### Unknown Postings

When a transaction doesn't match any `if` pattern in the rules file, hledger assigns it to `income:unknown` or `expenses:unknown` depending on the transaction direction. The pipeline will fail at the validation step, reporting the unknown postings so you can add appropriate rules before retrying.

#### Closing Balance Reconciliation

For providers that include closing balance in CSV metadata (e.g., UBS), the tool automatically validates that the imported transactions result in the correct balance. Configure metadata extraction in `providers.yaml`:

```yaml
metadata:
  - field: closing_balance
    row: 5
    column: 1
  - field: from_date
    row: 2
    column: 1
  - field: until_date
    row: 3
    column: 1
```

For providers without closing balance in metadata (e.g., Revolut), provide it manually via the `closingBalance` argument.

## Development

- `mise run build` - Build the module
- `mise run test` - Run tests
- `mise run lint` - Lint code
- `mise run lint:fix` - Fix linting issues
- `mise run format` - Format code with Prettier

## Release

See the [RELEASE.md](RELEASE.md) file for instructions on how to release a new version of the module.

## Contributing

Contributions are welcome! Please file issues or submit pull requests on the GitHub repository.

## License

See the [LICENSE](LICENSE) file for details.
