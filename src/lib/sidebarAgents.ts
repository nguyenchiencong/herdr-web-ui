import type { AgentInfo, HerdrPane, HibernatedPane, SessionSnapshot, TabInfo, WorkspaceInfo } from "../../shared/protocol.ts";
import { isSleepAgentLabel, shownAgent } from "../../shared/sleep-agent.ts";
import type { Translate } from "./i18n.ts";
import { customTabLabel, tabLabel } from "./tabName.ts";

export interface SidebarAgent {
  pane: HerdrPane;
  workspace: WorkspaceInfo;
  tab: TabInfo | null;
  agent: AgentInfo | null;
  canonicalAgent: string | null;
  agentLabel: string | null;
  /** a pi session asleep in this pane (its annotation): listed beside the agents, dimmed, with an Asleep badge */
  hibernated: HibernatedPane | null;
}

function nonblank(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

/**
 * The API's live agent roster, joined to the pane that owns its current state. OmO is also
 * recognized by the bridge's process-tree lookup, before herdr necessarily lists it as an
 * agent. A shell is never included just because it reports a working or blocked state.
 * Order follows the server's workspace, tab and pane order, independently of UI folds.
 */
export function sidebarAgents(snapshot: SessionSnapshot | null): SidebarAgent[] {
  if (!snapshot) return [];
  const agentByPane = new Map<string, AgentInfo>();
  for (const agent of snapshot.agents) {
    if (!agentByPane.has(agent.pane_id)) agentByPane.set(agent.pane_id, agent);
  }
  const workspaceById = new Map(snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
  const workspaceOrder = new Map(snapshot.workspaces.map((workspace, index) => [workspace.workspace_id, index]));
  const tabById = new Map(snapshot.tabs.map((tab) => [tab.tab_id, tab]));
  const tabOrder = new Map(snapshot.tabs.map((tab, index) => [tab.tab_id, index]));
  const seen = new Set<string>();
  const rows: Array<{ row: SidebarAgent; paneOrder: number }> = [];
  snapshot.panes.forEach((pane, paneOrder) => {
    if (seen.has(pane.pane_id)) return;
    seen.add(pane.pane_id);
    // a pi session asleep in its pane is listed by its sleep annotation, whether herdr names pi for the pane, the
    // launcher's label, or none; the launcher's label is no agent, so a pane that carries only it is a plain terminal
    const hibernated = (pane as HerdrPane).hibernated ?? null;
    const listed = agentByPane.get(pane.pane_id) ?? null;
    const agent = listed !== null && !isSleepAgentLabel(listed.agent) ? listed : null;
    const workspace = workspaceById.get(pane.workspace_id);
    const canonicalAgent = nonblank(shownAgent(pane.agent, hibernated !== null)) ?? nonblank(agent?.agent) ?? nonblank(hibernated?.agent);
    if (!workspace || (!agent && canonicalAgent === null)) return;
    const tab = tabById.get(pane.tab_id);
    rows.push({
      paneOrder,
      row: {
        pane,
        workspace,
        tab: tab?.workspace_id === pane.workspace_id ? tab : null,
        agent,
        canonicalAgent,
        hibernated,
        agentLabel: nonblank(agent?.display_agent) ?? nonblank(agent?.name)
          ?? nonblank(shownAgent(pane.display_agent, false)) ?? canonicalAgent ?? nonblank(agent?.title),
      },
    });
  });
  return rows.sort((left, right) =>
    workspaceOrder.get(left.row.workspace.workspace_id)! - workspaceOrder.get(right.row.workspace.workspace_id)!
    || (tabOrder.get(left.row.tab?.tab_id ?? "") ?? snapshot.tabs.length) - (tabOrder.get(right.row.tab?.tab_id ?? "") ?? snapshot.tabs.length)
    || left.paneOrder - right.paneOrder,
  ).map(({ row }) => row);
}

/**
 * The mark a row draws for the pane it opens: that pane's agent, never another pane's.
 * A shell (no entry) has none; an agent herdr names without a kind falls back to its label.
 */
export function paneMark(entry: SidebarAgent | undefined): string | null {
  if (!entry) return null;
  return entry.canonicalAgent ?? entry.agentLabel ?? "";
}

/**
 * Whether a row shows its pi session as asleep. A PC that is away draws no state (DESIGN.md), so its sleeping
 * session keeps its title, and the Asleep cue waits until the PC connects again.
 */
export function asleepCueShown(hibernated: HibernatedPane | null | undefined, online: boolean): boolean {
  return online && hibernated != null;
}

/**
 * The activity a pane reports (its `activity_dots` token, set by the pi extension): `▶ ◐ 2 ◑ ◓`, trimmed.
 * Null unless the pane reports one. herdr's TUI draws it beside the status dot.
 */
export function activityDots(pane: Pick<HerdrPane, "tokens">): string | null {
  const dots = pane.tokens?.["activity_dots"];
  return typeof dots === "string" ? nonblank(dots) : null;
}

/** One glyph of an activity string, with the number after it (null when it has none). */
export interface ActivityGlyph { glyph: string; count: number | null }

/** The glyphs of an activity string in order: a number right after a glyph is its count, as in `◐ 2`. */
export function activityGlyphs(dots: string): ActivityGlyph[] {
  const tokens = dots.trim().split(/\s+/);
  const glyphs: ActivityGlyph[] = [];
  for (let at = 0; at < tokens.length; at++) {
    const next = tokens[at + 1];
    const counted = next !== undefined && /^\d+$/.test(next);
    glyphs.push({ glyph: tokens[at]!, count: counted ? Number(next) : null });
    if (counted) at++;
  }
  return glyphs;
}

/**
 * An activity string in words, for a row's label: `▶ ◐ 2` reads "Build or test running · Subagents: 2".
 * A glyph the app does not know stays as it is.
 */
export function activityWords(dots: string, t: Translate): string {
  return activityGlyphs(dots).map(({ glyph, count }) => {
    switch (glyph) {
      case "▶": return t("Build or test running");
      case "◐": return t("Subagents: {n}", { n: count ?? 1 });
      case "◑": return t("Background commands: {n}", { n: count ?? 1 });
      case "◓": return t("Bot turns: {n}", { n: count ?? 1 });
      default: return count === null ? glyph : `${glyph} ${count}`;
    }
  }).join(" · ");
}

/** Every agent a workspace runs, each name once, in the roster's order. */
export function workspaceAgentLabels(agents: readonly SidebarAgent[]): Map<string, string[]> {
  const byWorkspace = new Map<string, string[]>();
  for (const { workspace, agentLabel, canonicalAgent } of agents) {
    const label = agentLabel ?? canonicalAgent;
    if (!label) continue;
    const labels = byWorkspace.get(workspace.workspace_id) ?? [];
    if (!labels.includes(label)) labels.push(label);
    byWorkspace.set(workspace.workspace_id, labels);
  }
  return byWorkspace;
}

/**
 * The tab an agent row names, as herdr's agents panel does: only when its workspace has two or
 * more tabs or the tab was renamed. A tab is judged by its place in the row, not its number:
 * herdr relabels the tab that moves up when the one before it closes, and keeps its number.
 */
export function agentTabName(tab: TabInfo | null | undefined, workspaceTabs: readonly TabInfo[], t: Parameters<typeof tabLabel>[1]): string | null {
  if (!tab) return null;
  const place = workspaceTabs.findIndex((candidate) => candidate.tab_id === tab.tab_id) + 1 || tab.number;
  return workspaceTabs.length > 1 || customTabLabel(tab, place) ? tabLabel(tab, t, place) : null;
}

export interface AgentContextParts {
  agentLabel: string | null;
  /** the row's first line; an agent named like it is not said twice */
  title: string;
  /** the agent the row's mark draws, null for the generic mark: a kind the mark already says is not written again */
  markAgent: string | null;
  /** null with a single PC: herdr does not name a lone machine either */
  machineName: string | null;
  workspaceLabel: string;
  tabName: string | null;
}

/** An agent row's second line: who it is, then where it runs, without repeating a word the row already says. */
export function agentContext({ agentLabel, title, markAgent, machineName, workspaceLabel, tabName }: AgentContextParts): string[] {
  const agent = nonblank(agentLabel);
  const tab = nonblank(tabName);
  return [
    agent && agent !== title.trim() && agent.toLowerCase() !== markAgent?.toLowerCase() ? agent : null,
    nonblank(machineName),
    workspaceLabel,
    tab && tab !== workspaceLabel ? tab : null,
  ].filter((part): part is string => Boolean(part));
}
