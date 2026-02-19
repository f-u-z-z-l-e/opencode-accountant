import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

export interface CurrencyConfig {
  source: string;
  pair: string;
  file: string;
  fmt_base?: string;
  backfill_date?: string;
}

export interface PricesConfig {
  currencies: Record<string, CurrencyConfig>;
}

const CONFIG_FILE = 'config/prices.yaml';
const REQUIRED_CURRENCY_FIELDS: (keyof CurrencyConfig)[] = ['source', 'pair', 'file'];

/**
 * Returns the default backfill date (January 1st of current year)
 */
export function getDefaultBackfillDate(): string {
  const year = new Date().getFullYear();
  return `${year}-01-01`;
}

/**
 * Validates a currency configuration object
 * @throws Error if required fields are missing
 */
function validateCurrencyConfig(name: string, config: unknown): CurrencyConfig {
  if (typeof config !== 'object' || config === null) {
    throw new Error(`Invalid config for currency '${name}': expected an object`);
  }

  const configObj = config as Record<string, unknown>;

  for (const field of REQUIRED_CURRENCY_FIELDS) {
    if (typeof configObj[field] !== 'string' || configObj[field] === '') {
      throw new Error(`Invalid config for currency '${name}': missing required field '${field}'`);
    }
  }

  return {
    source: configObj.source as string,
    pair: configObj.pair as string,
    file: configObj.file as string,
    fmt_base: typeof configObj.fmt_base === 'string' ? configObj.fmt_base : undefined,
    backfill_date:
      typeof configObj.backfill_date === 'string' ? configObj.backfill_date : undefined,
  };
}

/**
 * Loads and validates the prices configuration from the user's project directory
 * @param directory The base directory (typically context.directory)
 * @returns Validated PricesConfig object
 * @throws Error if config file is missing, invalid YAML, or missing required fields
 */
export function loadPricesConfig(directory: string): PricesConfig {
  const configPath = path.join(directory, CONFIG_FILE);

  // Check if file exists
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Configuration file not found: ${CONFIG_FILE}. Please refer to the plugin's GitHub repository for setup instructions.`
    );
  }

  // Read and parse YAML
  let parsed: unknown;
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    parsed = yaml.load(content);
  } catch (err) {
    if (err instanceof yaml.YAMLException) {
      throw new Error(`Failed to parse ${CONFIG_FILE}: ${err.message}`);
    }
    throw err;
  }

  // Validate structure
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Invalid config: ${CONFIG_FILE} must contain a YAML object`);
  }

  const parsedObj = parsed as Record<string, unknown>;

  if (!parsedObj.currencies || typeof parsedObj.currencies !== 'object') {
    throw new Error(`Invalid config: 'currencies' section is required`);
  }

  const currenciesObj = parsedObj.currencies as Record<string, unknown>;

  if (Object.keys(currenciesObj).length === 0) {
    throw new Error(`Invalid config: 'currencies' section must contain at least one currency`);
  }

  // Validate each currency
  const currencies: Record<string, CurrencyConfig> = {};
  for (const [name, config] of Object.entries(currenciesObj)) {
    currencies[name] = validateCurrencyConfig(name, config);
  }

  return { currencies };
}
