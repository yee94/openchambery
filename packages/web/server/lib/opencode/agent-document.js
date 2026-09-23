/**
 * OpenCode v2 agent markdown.
 *
 * A file is native only when every frontmatter key is a current agent field.
 * Any older key makes the loader migrate the whole file, and native keys in
 * that file are then treated as request body. Saving therefore rewrites the
 * whole file as native markdown. Fields the runtime does not apply are reported
 * and kept until the caller confirms they can be dropped.
 */

const NATIVE_KEYS = new Set([
  'model',
  'variant',
  'request',
  'system',
  'description',
  'mode',
  'hidden',
  'color',
  'steps',
  'disabled',
  'permissions',
]);

const ACTION_RENAMES = {
  bash: 'shell',
  task: 'subagent',
  write: 'edit',
  patch: 'edit',
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const PROMPT_FILE = /^\{file:.+\}$/i;
const EFFECTS = new Set(['allow', 'ask', 'deny']);

export class DropConfirmationRequired extends Error {
  /**
   * @param {Array<{ key: string, reason: string }>} dropped
   */
  constructor(dropped) {
    super('Drop confirmation required');
    this.code = 'drop-confirmation';
    this.dropped = dropped;
  }
}

const isEffect = (value) => typeof value === 'string' && EFFECTS.has(value);

const renameAction = (action) => ACTION_RENAMES[action] || action;

/**
 * @param {unknown} config
 * @returns {{ legacy: boolean, dropped: Array<{ key: string, reason: string }> }}
 */
export function inspectAgentConfig(config) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  /** @type {Array<{ key: string, reason: string }>} */
  const dropped = [];
  const keys = Object.keys(source);

  for (const key of keys) {
    if (key === 'temperature' || key === 'top_p') {
      dropped.push({ key, reason: 'generation' });
      continue;
    }
    if (key === 'options' && source.options && typeof source.options === 'object' && Object.keys(source.options).length > 0) {
      dropped.push({ key, reason: 'unknown' });
      continue;
    }
    if (key === 'prompt' && typeof source.prompt === 'string' && PROMPT_FILE.test(source.prompt.trim())) {
      dropped.push({ key, reason: 'prompt-file' });
      continue;
    }
    if (key === 'color' && source.color != null && source.color !== '' && !HEX_COLOR.test(String(source.color))) {
      dropped.push({ key, reason: 'color' });
      continue;
    }
    if (key === 'variant' && (typeof source.model !== 'string' || source.model.length === 0)) {
      dropped.push({ key, reason: 'variant' });
      continue;
    }
    if (!NATIVE_KEYS.has(key) && !isConvertibleKey(key)) {
      dropped.push({ key, reason: 'unknown' });
    }
  }

  const legacy = keys.some((key) => !NATIVE_KEYS.has(key)) || dropped.length > 0;
  return { legacy, dropped };
}

const isConvertibleKey = (key) => (
  key === 'prompt'
  || key === 'tools'
  || key === 'disable'
  || key === 'maxSteps'
  || key === 'permission'
  || key === 'name'
  || key === 'options'
);

/**
 * @param {unknown} config
 * @returns {{ frontmatter: Record<string, unknown>, body: string, legacy: boolean, dropped: Array<{ key: string, reason: string }> }}
 */
export function convertAgentConfig(config) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? { ...config } : {};
  const inspection = inspectAgentConfig(source);
  /** @type {Record<string, unknown>} */
  const frontmatter = {};

  if (typeof source.description === 'string' && source.description.trim()) {
    frontmatter.description = source.description;
  }
  if (source.mode === 'primary' || source.mode === 'subagent' || source.mode === 'all') {
    frontmatter.mode = source.mode;
  }

  const model = encodeModel(source.model, source.variant);
  if (model) frontmatter.model = model;

  if (source.hidden === true) frontmatter.hidden = true;
  if (source.disabled === true || source.disable === true) frontmatter.disabled = true;
  if (typeof source.color === 'string' && HEX_COLOR.test(source.color)) frontmatter.color = source.color;

  const steps = positiveInt(source.steps) ?? positiveInt(source.maxSteps);
  if (steps !== undefined) frontmatter.steps = steps;

  if (isRequest(source.request)) frontmatter.request = source.request;

  const permissions = normalizePermissions(source.permissions ?? source.permission, source.tools);
  if (permissions.length > 0) frontmatter.permissions = permissions;

  const body = readSystem(source);
  return { frontmatter, body, legacy: inspection.legacy, dropped: inspection.dropped };
}

/**
 * @param {{ frontmatter: Record<string, unknown>, body: string }} current
 * @param {Record<string, unknown>} patch
 */
export function applyNativePatch(current, patch) {
  const frontmatter = { ...current.frontmatter };
  let body = current.body;
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined || key === 'name' || key === 'scope' || key === 'confirmDrop') continue;
    if (key === 'system') {
      body = value === null ? '' : String(value);
      continue;
    }
    if (value === null || value === false && (key === 'hidden' || key === 'disabled')) {
      delete frontmatter[key];
      continue;
    }
    if (key === 'color' && (typeof value !== 'string' || !HEX_COLOR.test(value))) {
      continue;
    }
    if (key === 'steps') {
      const steps = positiveInt(value);
      if (steps === undefined) delete frontmatter.steps;
      else frontmatter.steps = steps;
      continue;
    }
    if (key === 'permissions') {
      const permissions = normalizePermissions(value, undefined);
      if (permissions.length === 0) delete frontmatter.permissions;
      else frontmatter.permissions = permissions;
      continue;
    }
    frontmatter[key] = value;
  }
  delete frontmatter.system;
  delete frontmatter.variant;
  delete frontmatter.prompt;
  delete frontmatter.permission;
  delete frontmatter.temperature;
  delete frontmatter.top_p;
  return { frontmatter, body };
}

const encodeModel = (model, variant) => {
  if (typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes('#')) return trimmed;
  if (typeof variant === 'string' && variant.trim() && !variant.includes('#')) {
    return `${trimmed}#${variant.trim()}`;
  }
  return trimmed;
};

const positiveInt = (value) => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < 1) return undefined;
  return number;
};

const isRequest = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = /** @type {Record<string, unknown>} */ (value);
  return request.headers != null || request.body != null;
};

const readSystem = (source) => {
  if (typeof source.system === 'string') return source.system;
  if (typeof source.prompt === 'string' && !PROMPT_FILE.test(source.prompt.trim())) return source.prompt;
  return '';
};

const normalizePermissions = (permission, tools) => {
  /** @type {Array<{ action: string, resource: string, effect: string }>} */
  const rules = [];
  if (tools && typeof tools === 'object' && !Array.isArray(tools)) {
    for (const [tool, enabled] of Object.entries(tools)) {
      if (typeof enabled !== 'boolean') continue;
      pushRule(rules, renameAction(tool), '*', enabled ? 'allow' : 'deny');
    }
  }
  if (isEffect(permission)) {
    pushRule(rules, '*', '*', permission);
  } else if (Array.isArray(permission)) {
    for (const rule of permission) {
      if (!rule || typeof rule !== 'object') continue;
      if (typeof rule.permission === 'string' && typeof rule.pattern === 'string') {
        pushRule(rules, renameAction(rule.permission), rule.pattern, rule.action);
        continue;
      }
      pushRule(rules, renameAction(rule.action), rule.resource, rule.effect);
    }
  } else if (permission && typeof permission === 'object') {
    for (const [key, rule] of Object.entries(permission)) {
      const action = renameAction(key);
      if (isEffect(rule)) {
        pushRule(rules, action, '*', rule);
        continue;
      }
      if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
        for (const [resource, effect] of Object.entries(rule)) {
          pushRule(rules, action, resource, effect);
        }
      }
    }
  }
  return rules;
};

const pushRule = (rules, action, resource, effect) => {
  if (!action || !resource || !isEffect(effect)) return;
  const index = rules.findIndex((rule) => rule.action === action && rule.resource === resource);
  const next = { action, resource, effect };
  if (index >= 0) rules[index] = next;
  else rules.push(next);
};
