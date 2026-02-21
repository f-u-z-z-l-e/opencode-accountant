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
  imports: statements/imports
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/imports/unrecognized

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
```

#### Configuration Options

**Paths:**

| Field          | Description                                     |
| -------------- | ----------------------------------------------- |
| `imports`      | Drop zone for new CSV files                     |
| `pending`      | Base path for classified files awaiting import  |
| `done`         | Base path for archived files after import       |
| `unrecognized` | Directory for files that couldn't be classified |

**Provider Detection Rules:**

| Field             | Description                                           |
| ----------------- | ----------------------------------------------------- |
| `filenamePattern` | Regex pattern to match against filename               |
| `header`          | Expected CSV header row (exact match)                 |
| `currencyField`   | Column name containing the currency/symbol            |
| `currencies`      | Map of raw currency values to normalized folder names |

#### Directory Structure

```
your-project/
├── config/
│   └── import/
│       └── providers.yaml
├── statements/
│   └── import/                  # Drop CSV files here
│       └── unrecognized/         # Unclassified files moved here
└── doc/
    └── agent/
        ├── todo/
        │   └── import/
        │       └── <provider>/   # e.g. revolut
        │           └── <currency>/   # e.g. chf, eur, usd, btc
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
5. After successful import, files should be moved to `doc/agent/done/import/`

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
