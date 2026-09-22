import { describe, expect, test } from "vitest";

import {
  agentDisplayName,
  findAgentBySelectionKey,
  projectAgent,
  resolveAgentSendIdentity,
} from "./agent-identity";

const wireBuild = {
  id: "build",
  name: "Build",
  mode: "primary" as const,
  hidden: false,
  request: { settings: {}, headers: {}, body: {} },
  permissions: [],
};

const wirePlan = {
  id: "plan",
  name: "Plan",
  mode: "primary" as const,
  hidden: false,
  request: { settings: {}, headers: {}, body: {} },
  permissions: [],
};

const customId = {
  id: "Build",
  name: "Custom Build Label",
  mode: "primary" as const,
  hidden: false,
  request: { settings: {}, headers: {}, body: {} },
  permissions: [],
};

describe("projectAgent", () => {
  test("keys builtin agents by wire id and keeps wire name for display", () => {
    const agent = projectAgent(wireBuild);
    expect(agent.id).toBe("build");
    expect(agent.name).toBe("build");
    expect(agent.displayName).toBe("Build");
  });

  test("keeps custom ids that only differ from builtin display labels by case", () => {
    const agent = projectAgent(customId);
    expect(agent.id).toBe("Build");
    expect(agent.name).toBe("Build");
    expect(agent.displayName).toBe("Custom Build Label");
  });

  test("is idempotent when already projected", () => {
    const once = projectAgent(wireBuild);
    const twice = projectAgent(once);
    expect(twice).toEqual(once);
  });

  test("name-only fixtures keep name as both key and display", () => {
    const agent = projectAgent({ name: "orchestrator" });
    expect(agent.name).toBe("orchestrator");
    expect(agent.id).toBe("orchestrator");
    expect(agent.displayName).toBe("orchestrator");
  });
});

describe("findAgentBySelectionKey / resolveAgentSendIdentity", () => {
  const catalog = [projectAgent(wireBuild), projectAgent(wirePlan), projectAgent(customId)];

  test("matches authoritative id / domain name for builtin Build", () => {
    expect(findAgentBySelectionKey(catalog, "build")?.name).toBe("build");
    expect(resolveAgentSendIdentity(catalog, "build")).toBe("build");
  });

  test("maps legacy persisted display name Build to id build without toLowerCase rewrite of custom Build", () => {
    // Catalog has both id "build" (display Build) and custom id "Build".
    // Exact displayName match on builtin is "Build" → the builtin row's displayName.
    // Custom row displayName is "Custom Build Label", so "Build" hits builtin displayName.
    const hit = findAgentBySelectionKey(
      [projectAgent(wireBuild), projectAgent(wirePlan)],
      "Build",
    );
    expect(hit?.name).toBe("build");
    expect(resolveAgentSendIdentity([projectAgent(wireBuild)], "Build")).toBe("build");
  });

  test("prefers exact domain name/id over displayName when custom id equals builtin display", () => {
    // Selection key "Build" matches custom agent.name first (authoritative id).
    const hit = findAgentBySelectionKey(catalog, "Build");
    expect(hit?.name).toBe("Build");
    expect(hit?.displayName).toBe("Custom Build Label");
    expect(resolveAgentSendIdentity(catalog, "Build")).toBe("Build");
  });

  test("does not case-fold unknown or custom keys", () => {
    expect(findAgentBySelectionKey(catalog, "BUILD")).toBeUndefined();
    expect(resolveAgentSendIdentity(catalog, "BUILD")).toBe("BUILD");
    expect(resolveAgentSendIdentity(catalog, "MyAgent")).toBe("MyAgent");
  });

  test("returns undefined for empty selection", () => {
    expect(resolveAgentSendIdentity(catalog, "  ")).toBeUndefined();
    expect(resolveAgentSendIdentity(catalog, undefined)).toBeUndefined();
  });
});

describe("agentDisplayName", () => {
  test("prefers displayName over machine key", () => {
    expect(agentDisplayName(projectAgent(wireBuild))).toBe("Build");
    expect(agentDisplayName({ name: "build" })).toBe("build");
  });
});
