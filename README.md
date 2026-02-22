# opencode-accountant

An OpenCode accounting agent, specialized in double-entry-bookkepping with hledger

> A Bun module created from the [bun-module](https://github.com/zenobi-us/bun-module) template

## Usage

<!-- Example usage code goes here -->

## Installation

<!-- Installation instructions go here -->

## Configuration

### Price Fetching Configuration

The `update-prices` tool requires a configuration file to specify which currency pairs to fetch. Create a `config/prices.yaml` file in your project directory with the following structure:

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
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/import/unrecognized
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
│       └── providers.yaml
├── ledger/
│   └── rules/                                   # hledger rules files
│       └── <provider>-{account-number}.rules    # {account-number} from metadata extraction
├── statements/
│   └── import/                                  # Drop CSV files here
│       └── unrecognized/                        # Unclassified files moved here
└── doc/
    └── agent/
        ├── todo/
        │   └── import/
        │       └── <provider>/                  # e.g. revolut
        │           └── <currency>/              # e.g. chf, eur, usd, btc
        └── done/
            └── import/
                └── <provider>/
                    └── <currency>/
```

#### Workflow

1. Drop CSV files into `statements/import/`
2. Run `classify-statements` tool
3. Files are moved to `doc/agent/todo/import/<provider>/<currency>/`
4. Unrecognized files are moved to `statements/import/unrecognized/`
5. Run `import-statements` with `checkOnly: true` to validate transactions
6. If unknown postings found: Add rules to the `.rules` file, repeat step 5
7. Once all transactions match: Run `import-statements` with `checkOnly: false`
8. Transactions are imported to journal, CSV files moved to `doc/agent/done/import/`

### Statement Import

The `import-statements` tool imports classified CSV statements into hledger using rules files. It validates transactions before import and identifies any that cannot be categorized.

#### Tool Arguments

| Argument    | Type    | Default | Description                                 |
| ----------- | ------- | ------- | ------------------------------------------- |
| `provider`  | string  | -       | Filter by provider (e.g., `revolut`, `ubs`) |
| `currency`  | string  | -       | Filter by currency (e.g., `chf`, `eur`)     |
| `checkOnly` | boolean | `true`  | If true, only validate without importing    |

#### Rules File Matching

The tool matches CSV files to their rules files by parsing the `source` directive in each `.rules` file. For example, if `ubs-account.rules` contains:

```
source ../../doc/agent/todo/import/ubs/chf/transactions.csv
```

The tool will use that rules file when processing `transactions.csv`.

See the hledger documentation for details on rules file format and syntax.

#### Unknown Postings

When a transaction doesn't match any `if` pattern in the rules file, hledger assigns it to `income:unknown` or `expenses:unknown` depending on the transaction direction. The tool reports these so you can add appropriate rules.

For detailed output format examples, see [`docs/tools/import-statements.md`](docs/tools/import-statements.md).

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
