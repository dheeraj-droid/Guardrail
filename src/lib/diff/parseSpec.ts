// Spec B, File 1 — parse raw OpenAPI text (JSON or YAML) into a plain object.
// PURE (Law 2): no IO, no env, no logging.

import { parse as parseYaml } from 'yaml';

/** Error thrown when an OpenAPI spec cannot be parsed into a root object. */
export class SpecParseError extends Error {
  constructor(
    message: string,
    readonly filePath: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SpecParseError';
  }
}

function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filePath.slice(lastDot).toLowerCase();
}

/** Parse raw OpenAPI text (JSON or YAML) into a plain object. */
export function parseOpenApiSpec(
  raw: string,
  filePath: string,
): Record<string, unknown> {
  if (raw.trim().length === 0) {
    throw new SpecParseError('Spec file is empty', filePath);
  }

  const ext = extension(filePath);
  let parsed: unknown;

  if (ext === '.json') {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SpecParseError('Failed to parse JSON spec', filePath, err);
    }
  } else if (ext === '.yaml' || ext === '.yml') {
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      throw new SpecParseError('Failed to parse YAML spec', filePath, err);
    }
  } else {
    // Unknown extension: try JSON first, on failure try YAML.
    try {
      parsed = JSON.parse(raw);
    } catch {
      try {
        parsed = parseYaml(raw);
      } catch (yamlErr) {
        throw new SpecParseError('Failed to parse spec as JSON or YAML', filePath, yamlErr);
      }
    }
  }

  if (!isNonNullObject(parsed)) {
    throw new SpecParseError('Spec root is not an object', filePath);
  }

  return parsed;
}
