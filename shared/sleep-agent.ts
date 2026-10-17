/**
 * The agent name the sleep launcher reports for its pane (pi-hibernate, in the user's pi). While a pi session
 * sleeps, herdr lists the pane as this agent, idle, with the state label `idle=asleep`; resume or quit releases the
 * listing. It is the launcher's own label, not an agent: a sleeping pi session is shown as pi, and a pane that
 * carries the label without a sleeping session is shown as a plain terminal. Kept apart from protocol.ts so the
 * browser can import the value (that module reads the environment as it loads).
 */
export const SLEEP_AGENT_LABEL = "zz pi";

/** Whether an agent name is the sleep launcher's label. */
export function isSleepAgentLabel(agent: string | null | undefined): boolean {
  return agent?.trim() === SLEEP_AGENT_LABEL;
}

/**
 * The agent names a pane may carry while a pi session sleeps in it: none, pi (the launcher runs as a process named
 * pi, which herdr names), or the launcher's label. Any other agent means an awake pane, whatever its title says.
 */
export function agentMayBeAsleep(agent: string | null | undefined): boolean {
  const name = agent?.trim() ?? "";
  return name === "" || name === "pi" || name === SLEEP_AGENT_LABEL;
}

/**
 * The agent a pane is shown as: pi for a sleeping session, whatever herdr lists for the pane; otherwise the agent
 * herdr names, except that the launcher's label is no agent. A pane herdr names no agent for, or one that carries
 * only the label without a sleeping session, is shown as no agent (null).
 */
export function shownAgent(agent: string | null | undefined, asleep: boolean): string | null {
  if (asleep) return "pi";
  const name = agent?.trim() ?? "";
  return name === "" || name === SLEEP_AGENT_LABEL ? null : name;
}

/**
 * The agent a message to this pane waits for: the agent shownAgent names, else the agent of the session herdr reports for
 * the pane. The launcher's label is no agent, so a stale label leaves no agent in front of the pane unless a session says so.
 */
export function agentInFront(pane: { agent?: string | null; agent_session?: { agent?: string | null } | null }): string | null {
  return shownAgent(pane.agent, false) ?? pane.agent_session?.agent ?? null;
}
