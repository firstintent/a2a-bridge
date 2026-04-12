import { describe, test, expect } from "bun:test";
import { buildAgentCard } from "@daemon/inbound/a2a-http/agent-card";

describe("buildAgentCard", () => {
  test("advertises protocolVersion 0.3.0", () => {
    const card = buildAgentCard({ url: "http://example.test/a2a" });
    expect(card.protocolVersion).toBe("0.3.0");
  });

  test("declares streaming capability and stable default modes", () => {
    const card = buildAgentCard({ url: "http://example.test/a2a" });
    expect(card.capabilities.streaming).toBe(true);
    expect(card.defaultInputModes).toContain("text/plain");
    expect(card.defaultOutputModes).toContain("text/plain");
  });

  test("ships at least one skill with the required fields", () => {
    const card = buildAgentCard({ url: "http://example.test/a2a" });
    expect(card.skills.length).toBeGreaterThanOrEqual(1);
    const skill = card.skills[0]!;
    expect(skill.id).toBeTruthy();
    expect(skill.name).toBeTruthy();
    expect(skill.description).toBeTruthy();
    expect(Array.isArray(skill.tags)).toBe(true);
  });

  test("declares an http bearer security scheme and a security requirement", () => {
    const card = buildAgentCard({ url: "http://example.test/a2a" });
    const schemeNames = Object.keys(card.securitySchemes);
    expect(schemeNames.length).toBeGreaterThanOrEqual(1);
    const [schemeName] = schemeNames;
    const scheme = card.securitySchemes[schemeName!]!;
    expect(scheme.type).toBe("http");
    expect(scheme.scheme).toBe("bearer");
    // The advertised security requirement must reference the declared scheme.
    const refs = card.security.flatMap((entry) => Object.keys(entry));
    expect(refs).toContain(schemeName!);
  });

  test("echoes the absolute url verbatim", () => {
    const url = "https://bridge.example.com:8443/a2a";
    const card = buildAgentCard({ url });
    expect(card.url).toBe(url);
  });

  test("honors config overrides for name, description, version, and skills", () => {
    const card = buildAgentCard({
      url: "http://example.test/a2a",
      name: "custom-bridge",
      description: "overridden",
      version: "9.9.9",
      skills: [
        { id: "s1", name: "S1", description: "d", tags: ["t"] },
      ],
      extraOutputModes: ["application/json"],
    });
    expect(card.name).toBe("custom-bridge");
    expect(card.description).toBe("overridden");
    expect(card.version).toBe("9.9.9");
    expect(card.skills.map((s) => s.id)).toEqual(["s1"]);
    expect(card.defaultOutputModes).toEqual(["text/plain", "application/json"]);
  });

  test("rejects an empty skills array", () => {
    expect(() =>
      buildAgentCard({ url: "http://example.test/a2a", skills: [] }),
    ).toThrow(/at least one/);
  });
});
