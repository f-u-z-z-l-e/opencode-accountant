# import-statements Tool

The `import-statements` tool imports classified CSV bank statements into hledger using rules files. It operates in two modes:

- **Check mode** (`checkOnly: true`, default): Validates transactions and reports any that cannot be categorized
- **Import mode** (`checkOnly: false`): Imports validated transactions and moves processed files to the done directory

## Arguments

| Argument    | Type    | Default | Description                                 |
| ----------- | ------- | ------- | ------------------------------------------- |
| `provider`  | string  | -       | Filter by provider (e.g., `revolut`, `ubs`) |
| `currency`  | string  | -       | Filter by currency (e.g., `chf`, `eur`)     |
| `checkOnly` | boolean | `true`  | If true, only validate without importing    |

## Output Format

### Check Mode - All Transactions Matched

When all transactions have matching rules:

```json
{
  "success": true,
  "files": [
    {
      "csv": "doc/agent/todo/import/ubs/chf/transactions-ubs-0235-90250546.0.csv",
      "rulesFile": "ledger/rules/ubs-0235-90250546.0.rules",
      "transactions": 25,
      "unknownPostings": []
    }
  ],
  "summary": {
    "filesProcessed": 1,
    "totalTransactions": 25,
    "matched": 25,
    "unknown": 0
  },
  "message": "All transactions matched. Ready to import with checkOnly: false"
}
```

### Check Mode - Unknown Postings Found

When transactions don't match any `if` pattern in the rules file, the tool returns the full CSV row data for each unknown posting to provide context for classification:

```json
{
  "success": false,
  "files": [
    {
      "csv": "doc/agent/todo/import/ubs/chf/transactions-ubs-0235-90250546.0.csv",
      "rulesFile": "ledger/rules/ubs-0235-90250546.0.rules",
      "transactions": 25,
      "unknownPostings": [
        {
          "date": "2026-01-16",
          "description": "Connor, John",
          "amount": "CHF95.25",
          "account": "income:unknown",
          "csvRow": {
            "trade_date": "2026-01-16",
            "trade_time": "",
            "booking_date": "2026-01-16",
            "value_date": "2026-01-16",
            "currency": "CHF",
            "debit": "",
            "credit": "95.25",
            "individual_amount": "",
            "balance": "4746.23",
            "transaction_no": "ABC123",
            "description1": "Connor, John",
            "description2": "Twint deposit",
            "description3": "Ref: TW-12345",
            "footnotes": ""
          }
        },
        {
          "date": "2026-01-30",
          "description": "Balance closing of service prices",
          "amount": "CHF-10.00",
          "account": "expenses:unknown",
          "csvRow": {
            "trade_date": "2026-01-30",
            "trade_time": "",
            "booking_date": "2026-01-30",
            "value_date": "2026-01-30",
            "currency": "CHF",
            "debit": "10.00",
            "credit": "",
            "individual_amount": "",
            "balance": "2364.69",
            "transaction_no": "DEF456",
            "description1": "Balance closing of service prices",
            "description2": "",
            "description3": "",
            "footnotes": ""
          }
        }
      ]
    }
  ],
  "summary": {
    "filesProcessed": 1,
    "totalTransactions": 25,
    "matched": 23,
    "unknown": 2
  }
}
```

### Check Mode - Missing Rules File

When a CSV file has no matching rules file:

```json
{
  "success": false,
  "files": [
    {
      "csv": "doc/agent/todo/import/ubs/chf/transactions.csv",
      "error": "No matching rules file found. Create a rules file with 'source' directive pointing to this CSV."
    }
  ],
  "summary": {
    "filesProcessed": 1,
    "filesWithoutRules": 1
  }
}
```

### Import Mode - Success

When importing with all transactions matched:

```json
{
  "success": true,
  "files": [
    {
      "csv": "doc/agent/todo/import/ubs/chf/transactions.csv",
      "rulesFile": "ledger/rules/ubs.rules",
      "imported": true,
      "movedTo": "doc/agent/done/import/ubs/chf/transactions.csv"
    }
  ],
  "summary": {
    "filesProcessed": 1,
    "filesImported": 1,
    "totalTransactions": 25
  },
  "message": "Successfully imported 1 file(s)"
}
```

### Import Mode - Blocked by Unknown Postings

Import mode runs a check first and aborts if any unknowns exist:

```json
{
  "success": false,
  "error": "Cannot import: 2 transactions have unknown accounts. Run with checkOnly: true to see details and add rules.",
  "hint": "Run with checkOnly: true first to identify and fix unknown postings"
}
```

## Unknown Posting Types

hledger assigns transactions to `income:unknown` or `expenses:unknown` based on the direction:

| Transaction Type           | Account Assigned   |
| -------------------------- | ------------------ |
| Money coming in (positive) | `income:unknown`   |
| Money going out (negative) | `expenses:unknown` |

## Fixing Unknown Postings

When the tool reports unknown postings, the `csvRow` field contains all available data from the original CSV to help determine the correct account. This includes additional description fields, transaction references, and other metadata that may help with classification.

Add `if` rules to the appropriate rules file based on the posting details:

```
# Example: Categorize a friend's reimbursement
# (csvRow showed description2: "Twint deposit" confirming it's a payment app transfer)
if Connor, John
    account1 income:reimbursements

# Example: Categorize bank service charges
if Balance closing of service prices
    account1 expenses:fees:bank
```

Then run the tool again with `checkOnly: true` to verify the rules work.

### CSV Row Field Names

The `csvRow` object uses field names from the `fields` directive in the rules file. Common fields include:

| Field            | Description                                             |
| ---------------- | ------------------------------------------------------- |
| `trade_date`     | When the transaction occurred                           |
| `booking_date`   | When it was booked                                      |
| `description1`   | Primary description                                     |
| `description2`   | Secondary description (often useful for classification) |
| `description3`   | Additional reference information                        |
| `transaction_no` | Unique transaction identifier                           |
| `debit`          | Debit amount (money out)                                |
| `credit`         | Credit amount (money in)                                |

The exact field names depend on your rules file configuration.

## Error Handling

### hledger Errors

If hledger fails to parse a CSV or rules file:

```json
{
  "success": false,
  "files": [
    {
      "csv": "doc/agent/todo/import/ubs/chf/transactions.csv",
      "rulesFile": "ledger/rules/ubs.rules",
      "error": "hledger error: Parse error at line 5: invalid date format"
    }
  ],
  "summary": {
    "filesProcessed": 1,
    "filesWithErrors": 1
  }
}
```

### Configuration Errors

If the config file is missing or invalid:

```json
{
  "success": false,
  "error": "Failed to load configuration: Configuration file not found: config/import/providers.yaml",
  "hint": "Ensure config/import/providers.yaml exists with a 'rules' path configured"
}
```
