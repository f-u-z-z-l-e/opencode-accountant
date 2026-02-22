# classify-statements Tool

The `classify-statements` tool organizes bank statement CSV files by automatically detecting their provider and currency, then moves them to the appropriate directories for import processing.

This tool is **restricted to the accountant agent only**.

## Arguments

| Argument | Type | Default | Description                  |
| -------- | ---- | ------- | ---------------------------- |
| (none)   | -    | -       | This tool takes no arguments |

## Output Format

**Note on paths:** All file paths use `{paths.*}` variables configured in `config/import/providers.yaml`. Default values:

- `{paths.import}` = `import/incoming`
- `{paths.pending}` = `import/pending`
- `{paths.unrecognized}` = `import/unrecognized`

### Success - All Files Classified

When all CSV files are successfully classified:

```json
{
  "success": true,
  "classified": [
    {
      "filename": "transactions-ubs-2026-02.csv",
      "provider": "ubs",
      "currency": "chf",
      "targetPath": "{paths.pending}/ubs/chf/transactions-ubs-2026-02.csv"
    },
    {
      "filename": "account-statement_2026-02.csv",
      "provider": "revolut",
      "currency": "eur",
      "targetPath": "{paths.pending}/revolut/eur/account-statement_2026-02.csv"
    }
  ],
  "unrecognized": [],
  "summary": {
    "total": 2,
    "classified": 2,
    "unrecognized": 0
  }
}
```

### Success - With Filename Renaming

When provider config includes `renamePattern` with metadata extraction:

```json
{
  "success": true,
  "classified": [
    {
      "filename": "transactions-ubs-0235-90250546.csv",
      "originalFilename": "export.csv",
      "provider": "ubs",
      "currency": "chf",
      "targetPath": "{paths.pending}/ubs/chf/transactions-ubs-0235-90250546.csv"
    }
  ],
  "unrecognized": [],
  "summary": {
    "total": 1,
    "classified": 1,
    "unrecognized": 0
  }
}
```

The `originalFilename` field appears when the file was renamed using metadata extraction.

### Success - Some Files Unrecognized

When some files cannot be classified:

```json
{
  "success": true,
  "classified": [
    {
      "filename": "transactions-ubs-2026-02.csv",
      "provider": "ubs",
      "currency": "chf",
      "targetPath": "{paths.pending}/ubs/chf/transactions-ubs-2026-02.csv"
    }
  ],
  "unrecognized": [
    {
      "filename": "mystery-bank.csv",
      "targetPath": "{paths.unrecognized}/mystery-bank.csv"
    }
  ],
  "summary": {
    "total": 2,
    "classified": 1,
    "unrecognized": 1
  }
}
```

Unrecognized files are moved to `{paths.unrecognized}` for manual review.

### Failure - File Collisions

When target files already exist (prevents overwriting):

```json
{
  "success": false,
  "error": "Cannot classify: 1 file(s) would overwrite existing pending files.",
  "collisions": [
    {
      "filename": "transactions.csv",
      "existingPath": "{paths.pending}/ubs/chf/transactions.csv"
    }
  ],
  "classified": [],
  "unrecognized": []
}
```

**Important:** The tool uses a two-pass approach (detect → check collisions → move) to prevent partial classification. If ANY collision is detected, NO files are moved.

### Configuration Error

When `config/import/providers.yaml` is missing or invalid:

```json
{
  "success": false,
  "error": "Failed to load configuration: config/import/providers.yaml not found",
  "classified": [],
  "unrecognized": []
}
```

### Agent Restriction Error

When called by the wrong agent:

```json
{
  "success": false,
  "error": "This tool is restricted to the accountant agent only.",
  "hint": "Use: Task(subagent_type='accountant', prompt='classify statements')",
  "caller": "main assistant",
  "classified": [],
  "unrecognized": []
}
```

## Provider Detection

The tool detects providers using rules defined in `config/import/providers.yaml`:

### Detection Methods

1. **Filename Pattern** (optional): Regex match against filename
2. **CSV Header** (required): Exact match of CSV header row
3. **Currency Field** (required): Which column contains the currency

### Detection Example

```yaml
providers:
  revolut:
    detect:
      - filenamePattern: '^account-statement_'
        header: 'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance'
        currencyField: Currency
    currencies:
      CHF: chf
      EUR: eur
```

Detection process:

1. Check if filename matches `filenamePattern` (if specified)
2. Read CSV and check if header matches exactly
3. Determine currency from `currencyField` column
4. Map raw currency value (e.g., "EUR") to normalized folder name (e.g., "eur")

### Filename Renaming

Providers can specify `renamePattern` with metadata extraction:

```yaml
ubs:
  detect:
    - header: 'Trade date,Trade time,...'
      currencyField: Currency
      skipRows: 9
      delimiter: ';'
      renamePattern: 'transactions-ubs-{account-number}.csv'
      metadata:
        - field: account-number
          row: 0
          column: 1
          normalize: spaces-to-dashes
```

This extracts metadata from the CSV (e.g., account number from row 0, column 1) and uses it in the output filename.

## Directory Structure

```
your-project/
├── config/
│   └── import/
│       └── providers.yaml          # Defines all paths and detection rules
├── {paths.import}/                 # Drop CSV files here (default: import/incoming)
│   ├── bank1.csv
│   └── bank2.csv
│
├── {paths.pending}/                # Classified files (default: import/pending)
│   ├── <provider>/                 # e.g., revolut, ubs
│   │   └── <currency>/             # e.g., chf, eur, usd, btc
│   │       └── classified.csv
│   ├── ubs/
│   │   └── chf/
│   │       └── transactions-ubs-0235-90250546.csv
│   └── revolut/
│       └── eur/
│           └── account-statement_2026-02.csv
│
└── {paths.unrecognized}/           # Unclassified files (default: import/unrecognized)
    └── mystery-bank.csv
```

## Typical Workflow

### Scenario 1: Successful Classification

1. Drop CSV files into `{paths.import}/` (e.g., `import/incoming/`)
2. Run `classify-statements` tool (no arguments)
3. Check output - all files classified successfully
4. Files organized in `{paths.pending}/<provider>/<currency>/`
5. Proceed to `import-statements` tool

### Scenario 2: Handling Unrecognized Files

1. Run `classify-statements` tool
2. Review `unrecognized` array in output
3. Check files in `{paths.unrecognized}/` directory
4. Options to resolve:
   - **Add provider config**: Update `config/import/providers.yaml` with detection rules
   - **Manual classification**: Move file to correct `{paths.pending}/<provider>/<currency>/` directory
   - **Investigate format**: Check if CSV format matches expected patterns
5. Re-run tool after adding configuration

### Scenario 3: Resolving Collisions

1. Run `classify-statements` tool
2. Tool reports collision - file would overwrite existing file
3. Check `collisions` array for affected files
4. Options to resolve:
   - **Archive existing**: Move existing pending file to `{paths.done}/` if already processed
   - **Rename**: Rename one of the conflicting files
   - **Remove**: Delete duplicate file if confirmed redundant
5. Re-run tool after resolving collision

**Important:** No files are moved until ALL collisions are resolved. This prevents partial/inconsistent state.

## Handling Unrecognized Files

### What "Unrecognized" Means

A file is unrecognized when:

- Filename doesn't match any `filenamePattern` (if patterns are specified)
- CSV header doesn't match any configured provider's `header`
- CSV is malformed or has unexpected structure
- Currency value doesn't map to configured currencies

### Common Causes

| Cause                     | Solution                                                                        |
| ------------------------- | ------------------------------------------------------------------------------- |
| New bank/provider         | Add provider config to `config/import/providers.yaml`                           |
| Non-standard CSV format   | Check CSV structure; add detection rules with correct header/skipRows/delimiter |
| Filename pattern mismatch | Update `filenamePattern` or remove it (header-only detection)                   |
| Unknown currency          | Add currency mapping to provider's `currencies` section                         |
| Metadata in header rows   | Use `skipRows` to skip non-CSV rows before header                               |
| Wrong delimiter           | Specify `delimiter` (e.g., `";"` for semicolon-delimited)                       |

### Adding Provider Detection

Example: Adding a new bank called "SwissBank":

```yaml
providers:
  swissbank:
    detect:
      - filenamePattern: '^swissbank-'
        header: 'Date,Description,Amount,Balance,Currency'
        currencyField: Currency
    currencies:
      CHF: chf
      EUR: eur
```

After updating config, re-run `classify-statements` to classify previously unrecognized files.

## Collision Safety

The tool uses a **two-pass approach** to ensure atomic operations:

### Two-Pass Process

**Pass 1: Detection & Planning**

- Scan all CSV files in `{paths.import}/`
- Detect provider/currency for each file
- Determine target path for each file
- Build complete move plan

**Pass 2: Collision Check**

- Check if ANY target file already exists
- If collisions found: abort with error (no files moved)
- If no collisions: proceed to Pass 3

**Pass 3: Move Files**

- Execute all planned moves atomically
- All files moved successfully or none at all

### Why This Matters

Without collision checking, partial classification could occur:

- Some files moved, others fail mid-process
- Inconsistent state requiring manual cleanup
- Risk of lost data or confusion about what was processed

With two-pass approach:

- All-or-nothing operation
- Easy to retry after fixing collisions
- No partial/inconsistent states

### Resolving Collisions

Check the `collisions` array in the error output:

```json
"collisions": [
  {
    "filename": "transactions.csv",
    "existingPath": "{paths.pending}/ubs/chf/transactions.csv"
  }
]
```

Then:

1. Inspect existing file: `cat {paths.pending}/ubs/chf/transactions.csv`
2. Determine if it's already processed (check if transactions were imported)
3. If processed: Move to `{paths.done}/` or delete
4. If not processed: Rename one of the files or merge manually
5. Re-run `classify-statements`

## Error Handling

### Common Errors

| Error               | Cause                                             | Solution                                                              |
| ------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| File collision      | Target file already exists in pending directory   | Move existing file to done, rename, or delete; then re-run            |
| Configuration error | Missing or invalid `config/import/providers.yaml` | Ensure config file exists with proper YAML syntax and required fields |
| Agent restriction   | Called by wrong agent                             | Use `Task(subagent_type='accountant', prompt='classify statements')`  |
| Permission error    | Cannot read/write directories                     | Check file permissions on import/pending/unrecognized directories     |
| No CSV files found  | Import directory is empty                         | Add CSV files to `{paths.import}` directory first                     |
| CSV parsing error   | Malformed CSV file                                | Check CSV structure; ensure proper delimiter and header row           |

### Configuration File Required Fields

Ensure `config/import/providers.yaml` contains:

```yaml
paths:
  import: <path> # Required
  pending: <path> # Required
  done: <path> # Required (used by import-statements tool)
  unrecognized: <path> # Required
  rules: <path> # Required (used by import-statements tool)

providers:
  <provider-name>:
    detect:
      - header: <exact-csv-header> # Required
        currencyField: <column-name> # Required
        # Optional: filenamePattern, skipRows, delimiter, renamePattern, metadata
    currencies:
      <RAW-VALUE>: <normalized-folder> # Required (at least one)
```

Missing any required field will cause a configuration error.
