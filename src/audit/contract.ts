/**
 * Tool contract rules, as data-in / findings-out.
 *
 * Separated from the CLI so the rules can be exercised against synthetic tool
 * descriptors without spawning a server. That matters for the security rule in
 * particular: you want to prove that a credential-shaped parameter is actually
 * caught, and you should not have to edit a real provider to demonstrate it.
 *
 * Rules are documented in `docs/MCP应用架构设计.md`, chapter 3.
 */

import type { JsonSchema, ToolDescriptor } from '../scripts/lib/stdio-session.js';

export type FindingLevel = 'error' | 'warn';

export interface Finding {
  level: FindingLevel;
  tool: string;
  rule: string;
  message: string;
}

/**
 * Minimum description length. Not arbitrary: a description has to fit "what it
 * does" + "when to use it" + "what it costs", and anything much shorter cannot
 * carry all three.
 */
export const MIN_DESCRIPTION_CHARS = 60;

/**
 * Phrases indicating the description does its disambiguation job. This is a
 * heuristic on prose, so a miss is a warning rather than an error - but a miss
 * is worth reading, because tools that never say when to use them are the ones
 * models pick wrongly.
 */
export const GUIDANCE_PATTERNS: readonly RegExp[] = [
  /use this/i,
  /prefer this/i,
  /when you/i,
  /use it when/i,
  /do not/i,
];

/**
 * Parameter names that must never exist.
 *
 * Credentials belong in server configuration. A parameter the model can see is
 * a parameter the model can fill with anything and echo back into its context,
 * so this rule is the difference between "the server holds a token" and "the
 * model can choose which token to use".
 */
export const FORBIDDEN_PARAM_PATTERN = /(token|secret|password|passwd|api[-_]?key|authorization|credential|bearer)/i;

export const ANNOTATION_HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

function propertiesOf(schema: JsonSchema | undefined): Record<string, JsonSchema> {
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return {};
  return properties as Record<string, JsonSchema>;
}

function requiredOf(schema: JsonSchema | undefined): string[] {
  const required = schema?.required;
  return Array.isArray(required) ? required.filter((entry): entry is string => typeof entry === 'string') : [];
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function auditTool(tool: ToolDescriptor, allNames: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const add = (level: FindingLevel, rule: string, message: string): void => {
    findings.push({ level, tool: tool.name, rule, message });
  };

  // --- naming: models rely on a consistent, greppable family ---------------
  if (!SNAKE_CASE.test(tool.name)) {
    add(
      'error',
      'naming',
      `"${tool.name}" is not lower_snake_case with a provider prefix; some hosts reject it and models mis-select`,
    );
  }
  if (allNames.filter((name) => name === tool.name).length > 1) {
    add('error', 'naming', `duplicate tool name "${tool.name}"`);
  }

  // --- description: the model's only documentation -------------------------
  const description = tool.description?.trim() ?? '';
  if (description === '') {
    add('error', 'description', 'no description: the model has nothing to select this tool by');
  } else if (description.length < MIN_DESCRIPTION_CHARS) {
    add(
      'error',
      'description',
      `description is ${description.length} chars, below the ${MIN_DESCRIPTION_CHARS} needed to state purpose, disambiguation and cost`,
    );
  } else if (!GUIDANCE_PATTERNS.some((pattern) => pattern.test(description))) {
    add('warn', 'description', 'description never says when to use this tool (or when not to), which is how wrong-tool selection happens');
  }

  // --- input schema: documented parameters, no credentials -----------------
  const properties = propertiesOf(tool.inputSchema);
  const required = requiredOf(tool.inputSchema);

  if (!tool.inputSchema) {
    add('error', 'schema', 'no inputSchema, so the host cannot validate arguments before dispatch');
  }

  for (const [name, property] of Object.entries(properties)) {
    if (FORBIDDEN_PARAM_PATTERN.test(name)) {
      add(
        'error',
        'credentials',
        `parameter "${name}" looks like a credential; credentials must come from server config, never from the model`,
      );
    }

    const paramDescription = typeof property.description === 'string' ? property.description.trim() : '';
    if (paramDescription === '') {
      add('error', 'docs', `parameter "${name}" has no .describe(), so the model is guessing at its meaning and format`);
      continue;
    }

    // Bounds the model cannot see are bounds it learns only by failing.
    const minimum = numeric(property.minimum);
    const maximum = numeric(property.maximum);
    const maxItems = numeric(property.maxItems);
    const maxLength = numeric(property.maxLength);

    if (maximum !== undefined && !paramDescription.includes(String(maximum))) {
      add('error', 'limits', `parameter "${name}" caps at ${maximum} but the description never states it, so the model learns the bound only by failing`);
    }
    if (minItemsIsCapped(property) && !paramDescription.includes(String(minimum))) {
      add('warn', 'limits', `parameter "${name}" has a lower bound of ${minimum} that the description does not mention`);
    }
    if (maxItems !== undefined && !paramDescription.includes(String(maxItems))) {
      add('warn', 'limits', `parameter "${name}" caps at ${maxItems} items but the description never states it`);
    }
    if (maxLength !== undefined && !paramDescription.includes(String(maxLength))) {
      add('warn', 'limits', `parameter "${name}" caps at ${maxLength} characters but the description never states it`);
    }
  }

  for (const name of required) {
    if (!(name in properties)) {
      add('error', 'schema', `"${name}" is required but absent from properties, so no argument can ever satisfy it`);
    }
  }

  // --- annotations: how a host decides what to gate behind a confirmation ---
  const annotations = (tool.annotations ?? {}) as Record<string, unknown>;
  if (!tool.annotations) {
    add('error', 'annotations', 'no annotations, so a host cannot tell a read-only tool from one that writes to a live system');
  } else {
    for (const hint of ANNOTATION_HINTS) {
      if (typeof annotations[hint] !== 'boolean') {
        add('error', 'annotations', `annotation "${hint}" is not set explicitly; relying on a default leaves the host guessing`);
      }
    }
  }

  if (annotations.readOnlyHint === false) {
    const mentionsConsequence = /confirm|undo|visible|irreversible|shared/i.test(description);
    if (!mentionsConsequence) {
      add('error', 'annotations', 'tool performs writes but its description never states that it cannot be undone or needs confirmation');
    }
  }

  // --- results the host can validate --------------------------------------
  if (!tool.outputSchema) {
    add('error', 'schema', 'no outputSchema, so hosts cannot validate results and `structuredContent` is unusable');
  }

  return findings;
}

function minItemsIsCapped(property: JsonSchema): boolean {
  return numeric(property.minimum) !== undefined && numeric(property.maximum) !== undefined;
}

export function auditTools(tools: readonly ToolDescriptor[]): Finding[] {
  const names = tools.map((tool) => tool.name);
  return tools.flatMap((tool) => auditTool(tool, names));
}
