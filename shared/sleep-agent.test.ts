import { describe, expect, it } from "bun:test";
import { agentInFront, agentMayBeAsleep, isSleepAgentLabel, SLEEP_AGENT_LABEL, shownAgent } from "./sleep-agent.ts";

describe("the sleep launcher's label", () => {
  it("is the agent name the launcher reports, and only that", () => {
    expect(SLEEP_AGENT_LABEL).toBe("zz pi");
    expect(isSleepAgentLabel("zz pi")).toBe(true);
    expect(isSleepAgentLabel(" zz pi ")).toBe(true);
    expect(isSleepAgentLabel("pi")).toBe(false);
    expect(isSleepAgentLabel("zz")).toBe(false);
    expect(isSleepAgentLabel(null)).toBe(false);
    expect(isSleepAgentLabel(undefined)).toBe(false);
  });
});

describe("which agents a sleeping pane may carry", () => {
  it("is none, pi, or the launcher's label", () => {
    for (const agent of [null, undefined, "", "  ", "pi", "zz pi"]) expect(agentMayBeAsleep(agent)).toBe(true);
  });

  it("is no other agent, whatever the title says", () => {
    for (const agent of ["claude", "codex", "omo", "pi-extra", "zz codex"]) expect(agentMayBeAsleep(agent)).toBe(false);
  });
});

describe("the agent a pane is shown as", () => {
  it("is pi for a sleeping session, whatever herdr lists for the pane", () => {
    for (const agent of [null, undefined, "", "pi", "zz pi"]) expect(shownAgent(agent, true)).toBe("pi");
  });

  it("is no agent for the launcher's label without a sleeping session: a plain terminal", () => {
    expect(shownAgent("zz pi", false)).toBeNull();
    expect(shownAgent(" zz pi ", false)).toBeNull();
    expect(shownAgent(null, false)).toBeNull();
    expect(shownAgent("", false)).toBeNull();
  });

  it("is the agent herdr names otherwise", () => {
    expect(shownAgent("pi", false)).toBe("pi");
    expect(shownAgent("claude", false)).toBe("claude");
  });
});

describe("the agent in front of a pane a message waits for", () => {
  it("is the agent herdr names, and the launcher's label is no agent", () => {
    expect(agentInFront({ agent: "claude", agent_session: null })).toBe("claude");
    expect(agentInFront({ agent: "zz pi", agent_session: null })).toBeNull();
    expect(agentInFront({ agent: null, agent_session: null })).toBeNull();
    expect(agentInFront({ agent: "", agent_session: { agent: "codex" } })).toBe("codex");
  });

  it("is the session's agent where the label is shown alone, so a stale label does not count as an agent by itself", () => {
    expect(agentInFront({ agent: "zz pi", agent_session: { agent: "pi" } })).toBe("pi");
    expect(agentInFront({ agent: "zz pi" })).toBeNull();
  });
});
