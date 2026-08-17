/**
 * Official OpenCode v2 permission rules: ordered array, last-match wins.
 *
 * A rule is `{ action, resource, effect }`. Evaluation walks the flattened
 * rulesets from the end and returns the last rule whose action and resource
 * both wildcard-match. Default effect is ask.
 *
 * Saved project rules are allow-only and appended after configured rules.
 * A configured deny still wins: evaluate configured first, and if any
 * resource is denied, saved cannot override it.
 */

export type PermissionEffect = "allow" | "deny" | "ask"

export type PermissionRule = {
  action: string
  resource: string
  effect: PermissionEffect
}

export type PermissionSavedRule = {
  action: string
  resource: string
}

const isEffect = (value: unknown): value is PermissionEffect =>
  value === "allow" || value === "deny" || value === "ask"

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return value === pattern
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(value)
}

export function evaluatePermissionRule(
  action: string,
  resource: string,
  ...rulesets: readonly (readonly PermissionRule[])[]
): PermissionRule {
  const rules = rulesets.flat()
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index]
    if (!rule) continue
    if (wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource)) {
      return rule
    }
  }
  return { action, resource: "*", effect: "ask" }
}

export function evaluatePermissionEffect(
  action: string,
  resources: readonly string[],
  configured: readonly PermissionRule[],
  saved: readonly PermissionSavedRule[] = [],
): PermissionEffect {
  if (resources.some((resource) => evaluatePermissionRule(action, resource, configured).effect === "deny")) {
    return "deny"
  }
  const savedAsAllow: PermissionRule[] = saved.map((item) => ({
    action: item.action,
    resource: item.resource,
    effect: "allow",
  }))
  const all = [...configured, ...savedAsAllow]
  const effects = resources.map((resource) => evaluatePermissionRule(action, resource, all).effect)
  if (effects.includes("deny")) return "deny"
  if (effects.includes("ask")) return "ask"
  return "allow"
}

function ruleFromUnknown(entry: unknown): PermissionRule | null {
  if (!record(entry)) return null
  if (typeof entry.action === "string" && typeof entry.resource === "string" && isEffect(entry.effect)) {
    return { action: entry.action, resource: entry.resource, effect: entry.effect }
  }
  // Agents / V1 flattened: { permission, pattern, action: allow|deny|ask }
  if (typeof entry.permission === "string" && typeof entry.pattern === "string" && isEffect(entry.action)) {
    return { action: entry.permission, resource: entry.pattern, effect: entry.action }
  }
  return null
}

export function toPermissionRuleset(value: unknown): PermissionRule[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const rule = ruleFromUnknown(entry)
      return rule ? [rule] : []
    })
  }

  if (isEffect(value)) {
    return [{ action: "*", resource: "*", effect: value }]
  }

  if (!record(value)) return []

  const rules: PermissionRule[] = []
  for (const [permissionName, configValue] of Object.entries(value)) {
    if (permissionName === "__originalKeys") continue
    if (isEffect(configValue)) {
      rules.push({ action: permissionName, resource: "*", effect: configValue })
      continue
    }
    if (record(configValue)) {
      for (const [pattern, action] of Object.entries(configValue)) {
        if (isEffect(action)) {
          rules.push({ action: permissionName, resource: pattern, effect: action })
        }
      }
    }
  }
  return rules
}

/** Ordered last-match display: later rows override earlier matches. */
export function displayPermissionRulesLastMatch(value: unknown): PermissionRule[] {
  return toPermissionRuleset(value)
}
