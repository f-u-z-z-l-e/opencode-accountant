import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

export interface DetectionRule {
  filenamePattern: string;
  header: string;
  currencyField: string;
}

export interface ProviderConfig {
  detect: DetectionRule[];
  currencies: Record<string, string>;
}

export interface ImportPaths {
  imports: string;
  pending: string;
  done: string;
  unrecognized: string;
}

export interface ImportConfig {
  paths: ImportPaths;
  providers: Record<string, ProviderConfig>;
}

const CONFIG_FILE = 'config/import/providers.yaml';

const REQUIRED_PATH_FIELDS: (keyof ImportPaths)[] = ['imports', 'pending', 'done', 'unrecognized'];
const REQUIRED_DETECTION_FIELDS: (keyof DetectionRule)[] = [
  'filenamePattern',
  'header',
  'currencyField',
];

/**
 * Validates the paths configuration
 * @throws Error if required fields are missing
 */
function validatePaths(paths: unknown): ImportPaths {
  if (typeof paths !== 'object' || paths === null) {
    throw new Error("Invalid config: 'paths' must be an object");
  }

  const pathsObj = paths as Record<string, unknown>;

  for (const field of REQUIRED_PATH_FIELDS) {
    if (typeof pathsObj[field] !== 'string' || pathsObj[field] === '') {
      throw new Error(`Invalid config: 'paths.${field}' is required`);
    }
  }

  return {
    imports: pathsObj.imports as string,
    pending: pathsObj.pending as string,
    done: pathsObj.done as string,
    unrecognized: pathsObj.unrecognized as string,
  };
}

/**
 * Validates a detection rule
 * @throws Error if required fields are missing
 */
function validateDetectionRule(providerName: string, index: number, rule: unknown): DetectionRule {
  if (typeof rule !== 'object' || rule === null) {
    throw new Error(
      `Invalid config: provider '${providerName}' detect[${index}] must be an object`
    );
  }

  const ruleObj = rule as Record<string, unknown>;

  for (const field of REQUIRED_DETECTION_FIELDS) {
    if (typeof ruleObj[field] !== 'string' || ruleObj[field] === '') {
      throw new Error(
        `Invalid config: provider '${providerName}' detect[${index}].${field} is required`
      );
    }
  }

  // Validate that filenamePattern is a valid regex
  try {
    new RegExp(ruleObj.filenamePattern as string);
  } catch {
    throw new Error(
      `Invalid config: provider '${providerName}' detect[${index}].filenamePattern is not a valid regex`
    );
  }

  return {
    filenamePattern: ruleObj.filenamePattern as string,
    header: ruleObj.header as string,
    currencyField: ruleObj.currencyField as string,
  };
}

/**
 * Validates a provider configuration
 * @throws Error if required fields are missing
 */
function validateProviderConfig(name: string, config: unknown): ProviderConfig {
  if (typeof config !== 'object' || config === null) {
    throw new Error(`Invalid config for provider '${name}': expected an object`);
  }

  const configObj = config as Record<string, unknown>;

  // Validate detect array
  if (!Array.isArray(configObj.detect) || configObj.detect.length === 0) {
    throw new Error(`Invalid config for provider '${name}': 'detect' must be a non-empty array`);
  }

  const detect: DetectionRule[] = [];
  for (let i = 0; i < configObj.detect.length; i++) {
    detect.push(validateDetectionRule(name, i, configObj.detect[i]));
  }

  // Validate currencies mapping
  if (typeof configObj.currencies !== 'object' || configObj.currencies === null) {
    throw new Error(`Invalid config for provider '${name}': 'currencies' must be an object`);
  }

  const currenciesObj = configObj.currencies as Record<string, unknown>;
  const currencies: Record<string, string> = {};

  for (const [key, value] of Object.entries(currenciesObj)) {
    if (typeof value !== 'string') {
      throw new Error(`Invalid config for provider '${name}': currencies.${key} must be a string`);
    }
    currencies[key] = value;
  }

  if (Object.keys(currencies).length === 0) {
    throw new Error(
      `Invalid config for provider '${name}': 'currencies' must contain at least one mapping`
    );
  }

  return { detect, currencies };
}

/**
 * Loads and validates the import configuration from the user's project directory
 * @param directory The base directory (typically context.directory)
 * @returns Validated ImportConfig object
 * @throws Error if config file is missing, invalid YAML, or missing required fields
 */
export function loadImportConfig(directory: string): ImportConfig {
  const configPath = path.join(directory, CONFIG_FILE);

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Configuration file not found: ${CONFIG_FILE}. Please create this file to configure statement imports.`
    );
  }

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

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Invalid config: ${CONFIG_FILE} must contain a YAML object`);
  }

  const parsedObj = parsed as Record<string, unknown>;

  // Validate paths
  if (!parsedObj.paths) {
    throw new Error("Invalid config: 'paths' section is required");
  }
  const paths = validatePaths(parsedObj.paths);

  // Validate providers
  if (!parsedObj.providers || typeof parsedObj.providers !== 'object') {
    throw new Error("Invalid config: 'providers' section is required");
  }

  const providersObj = parsedObj.providers as Record<string, unknown>;

  if (Object.keys(providersObj).length === 0) {
    throw new Error("Invalid config: 'providers' section must contain at least one provider");
  }

  const providers: Record<string, ProviderConfig> = {};
  for (const [name, config] of Object.entries(providersObj)) {
    providers[name] = validateProviderConfig(name, config);
  }

  return { paths, providers };
}
