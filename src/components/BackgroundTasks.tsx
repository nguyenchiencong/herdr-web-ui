import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { ChevronDown, ChevronRight, Circle, CircleAlert, CircleCheck, CircleDot, CircleSlash, CircleX, Layers, ListChecks, Terminal, Workflow, type LucideProps } from "lucide-react";

import "./BackgroundTasks.css";

import { useMachineApi } from "../lib/machineContext.tsx";
import { clockOffsetMs, endedSummary, formatElapsed, runGoing, spanMs, taskElapsedMs } from "../lib/omoTasks.ts";
import { formatTokens } from "../lib/compose.ts";
import { planWaves } from "../lib/plan.ts";
import { useT } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import type { AgentStatus, BackgroundOutput, OmoRun, OmoRunNode, OmoTask, PlanStep, PlanSummary } from "../../shared/protocol.ts";

const POLL_MS = 3000;

const ICONS: Record<OmoTask["status"], ComponentType<LucideProps>> = {
  running: CircleDot, completed: CircleCheck, failed: CircleX, cancelled: CircleSlash, lost: CircleAlert,
};
const STEP_ICONS: Record<PlanStep["status"], ComponentType<LucideProps>> = { pending: Circle, in_progress: CircleDot, completed: CircleCheck };
const NODE_ICONS: Record<OmoRunNode["state"], ComponentType<LucideProps>> = {
  pending: Circle, scheduled: Circle, running: CircleDot, blocked: CircleAlert, completed: CircleCheck, failed: CircleX, skipped: CircleSlash, cancelled: CircleSlash,
};

/** A background command's output, read from the end of its log when it is asked for: the row says whether there is one. */
function TaskOutput({ paneId, taskId }: { paneId: string; taskId: string }) {
  const t = useT();
  const { fetchPaneBackgroundOutput } = useMachineApi();
  const [open, setOpen] = useState(false);
  // undefined: not read yet; null: it could not be read
  const [output, setOutput] = useState<BackgroundOutput | null | undefined>(undefined);
  const id = useId();
  useEffect(() => {
    if (!open || output !== undefined) return;
    let alive = true;
    fetchPaneBackgroundOutput(paneId, taskId).then((next) => { if (alive) setOutput(next); }, () => { if (alive) setOutput(null); });
    return () => { alive = false; };
  }, [open, output, paneId, taskId, fetchPaneBackgroundOutput]);
  return <>
    <button type="button" className="bg-task-output-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      {open ? t("Hide output") : t("Show output")}
    </button>
    {open && <div id={id} className="bg-task-output-body">
      {output === undefined && <p className="bg-tasks-note">{t("Reading the output…")}</p>}
      {output === null && <p className="bg-tasks-note" role="status">{t("Couldn't read the output")}</p>}
      {output && <>
        {output.cut && <p className="bg-tasks-note">{t("Showing the end of the output")}</p>}
        <pre className="bg-task-output" tabIndex={0}>{output.output.length > 0 ? output.output : t("The output is empty")}</pre>
      </>}
    </div>}
  </>;
}

/**
 * One background task of the list: a subagent by its category and numbers, a background command by its exit code and
 * duration, with its output on request. `at` is the PC's clock now, which the task's times are on.
 */
export function BackgroundTaskRow({ paneId, task, at }: { paneId: string; task: OmoTask; at: number }) {
  const t = useT();
  const Icon = ICONS[task.status];
  const command = task.category === "command";
  const words: Record<OmoTask["status"], string> = {
    running: t("running"), completed: t("done"), failed: t("failed"), cancelled: t("cancelled"), lost: t("lost"),
  };
  const elapsed = taskElapsedMs(task, at);
  const details = command
    ? [typeof task.exit_code === "number" ? t("Exit code {code}", { code: task.exit_code }) : null, elapsed === null ? null : formatElapsed(elapsed)]
    : [
      task.category, task.model, elapsed === null ? null : formatElapsed(elapsed),
      task.turns === null ? null : t(task.turns === 1 ? "{n} turn" : "{n} turns", { n: task.turns }),
      task.tool_calls === null ? null : t(task.tool_calls === 1 ? "{n} tool call" : "{n} tool calls", { n: task.tool_calls }),
      task.tokens === null ? null : t("{n} tokens", { n: formatTokens(task.tokens) }),
    ];
  const meta = details.filter((item) => item !== null).join(" · ");
  const worded = task.status !== "running" && task.status !== "completed";
  return <li className={`bg-task is-${task.status}${command ? " is-command" : ""}`}>
    <Icon className="bg-task-icon" aria-hidden="true" />
    <span className="bg-task-main">
      <span className="bg-task-title">{command && <Terminal className="bg-task-kind" aria-hidden="true" />}{task.title}<span className="sr-only"> ({command && <>{t("Command")}: </>}{words[task.status]})</span></span>
      {(meta.length > 0 || worded) && <span className="bg-task-meta">{[worded ? words[task.status] : null, meta || null].filter((item) => item !== null).join(" · ")}</span>}
      {task.output === true && <TaskOutput paneId={paneId} taskId={task.id} />}
    </span>
  </li>;
}

/**
 * The status line's one chip for what the agent works through besides its answer: the plan it
 * keeps (Claude Code's task list, Codex's checklist: `plan`, read again while open) and its
 * background tasks. Shown while there is a plan, or as below for the tasks; one list holds both.
 *
 * The background tasks: opens what OmO's background tasks are and how far they got.
 * Shown on every OmO pane (quiet while nothing runs: what ended in the last day can still be read,
 * after a reload too), and on any pane while a task runs. The list is for what runs now: what
 * ended is one line that says how many ended and how many went wrong, and opens on request.
 * The server keeps the newest ten ended tasks and five ended workflows of the last day, so the
 * line counts those, and says "recently", not "in the last day".
 * A Claude pane's tasks are its subagents. Most Claude panes have none, so it asks when
 * the pane is shown (and when its count changes), and appears only when there are or were some.
 * A pi pane's running subagents are counted and listed by the server as they run, so it needs no ask for them;
 * its ended subagents and background commands are read from its transcript, and asked for as a Claude pane's are.
 */
export function BackgroundTasks({ paneId, count, omo, claude = false, pi = false, waiting = false, status, plan = null }: { paneId: string; count: number; omo: boolean; claude?: boolean; pi?: boolean; waiting?: boolean; status?: AgentStatus; plan?: PlanSummary | null }) {
  const t = useT();
  const { fetchPaneOmoActivity, fetchPanePlan } = useMachineApi();
  const [open, setOpen] = useState(false);
  // a phone's Back closes the list, as it closes the other dialogs there (the plan used to be a sheet)
  usePhoneSheetBack(() => setOpen(false), open);
  const [seen, setSeen] = useState(count > 0);
  useEffect(() => { if (count > 0) setSeen(true); }, [count]);
  // a pi pane's ended tasks are read from its transcript, so it is asked for as a Claude pane is
  const asks = claude || pi;
  useEffect(() => {
    if (!asks || count > 0) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The server answers within a second with what it knows, so a pane whose session it is still
    // looking for reads as having none: an empty answer is asked again a few times. Agents that
    // ended before that are told by nothing else, as the count changes only for running ones.
    const ask = (left: number): void => {
      const again = (): void => { if (alive && left > 0) timer = setTimeout(() => ask(left - 1), POLL_MS); };
      fetchPaneOmoActivity(paneId).then((found) => { if (!alive) return; if (found.tasks.length > 0) setSeen(true); else again(); }, again);
    };
    ask(3);
    return () => { alive = false; clearTimeout(timer); };
    // asked when the pane is shown, when its count changes, and when its status does: a command that ended is not counted
  }, [asks, paneId, count, status]);
  const [tasks, setTasks] = useState<OmoTask[] | null>(null);
  const [runs, setRuns] = useState<OmoRun[]>([]);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** the PC's clock minus this browser's: task times are on the PC's */
  const [offset, setOffset] = useState(0);
  const [showEnded, setShowEnded] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const endedId = useId();
  // closed, the list forgets what was opened: it opens on what runs now every time
  useEffect(() => { if (!open) setShowEnded(false); }, [open]);

  // the tasks part shows while a task runs, on any OmO pane, and on a Claude or pi pane once one ran or ended (its ended tasks stay listed);
  // a pi pane's running subagents are counted by the server, and what it ended is read from its transcript
  const tasksShown = count > 0 || ((claude || pi) && seen) || omo;
  useEffect(() => {
    if (!open || !tasksShown) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        const next = await fetchPaneOmoActivity(paneId);
        if (!alive) return;
        const received = Date.now();
        setTasks(next.tasks); setRuns(next.runs); setFailed(false); setOffset(clockOffsetMs(next.serverTime, received)); setNow(received);
      } catch {
        // the clock stops with the list: a running task's time is no longer known to run on
        if (alive) setFailed(true);
      }
      if (!alive) return;
      timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [open, tasksShown, paneId, fetchPaneOmoActivity]);

  // the plan's steps, read while the list is open: undefined not read yet, null none kept now
  const [steps, setSteps] = useState<PlanStep[] | null | undefined>(undefined);
  const [planFailed, setPlanFailed] = useState(false);
  const planShown = plan !== null;
  useEffect(() => {
    if (!open || !planShown) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSteps(undefined);
    const load = async (): Promise<void> => {
      try {
        const next = await fetchPanePlan(paneId);
        if (!alive) return;
        const received = Date.now();
        setSteps(next.steps); setPlanFailed(false); setOffset(clockOffsetMs(next.serverTime, received)); setNow(received);
      } catch {
        if (alive) setPlanFailed(true);
      }
      if (alive) timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [open, planShown, paneId, fetchPanePlan]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // the list unmounts with whatever inside it held the focus: hand it back to the toggle
      if (root.current?.contains(document.activeElement)) toggle.current?.focus();
      setOpen(false);
    };
    // The list shares its place above the card with the slash and @ menus: once the focus has gone
    // somewhere else (Shift+Tab back to the message box), it closes, or it would cover them.
    // No relatedTarget is a press on a row of the list, or a browser that does not focus a pressed
    // button: that is not leaving, and a press outside is `outside`'s
    const left = (event: FocusEvent): void => { if (event.relatedTarget instanceof Node && !node?.contains(event.relatedTarget)) setOpen(false); };
    const node = root.current;
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    node?.addEventListener("focusout", left);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); node?.removeEventListener("focusout", left); };
  }, [open]);

  // The list opens upward from the composer, whose height CSS cannot know (text, quick replies,
  // attachments): the room above it, up to the top of the pane, is measured and bounds the list,
  // so on a short screen the list scrolls inside that room and never runs under the app header.
  useLayoutEffect(() => {
    const list = menu.current;
    const anchor = list?.offsetParent;
    // the list is anchored to the input card, inside the composer: the room is the pane's, above the card
    const composer = anchor?.closest(".composer") ?? null;
    const frame = (composer ?? anchor)?.parentElement;
    if (!open || !list || !anchor || !frame) return;
    const measure = (): void => list.style.setProperty("--bg-tasks-room", `${anchor.getBoundingClientRect().top - frame.getBoundingClientRect().top}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    observer.observe(frame);
    // a note or a hint under the card, a quick-reply row above it: the card moves and neither it
    // nor the pane changes size, the composer does
    if (composer) observer.observe(composer);
    return () => observer.disconnect();
  }, [open]);

  const running = tasks?.filter((task) => task.status === "running") ?? [];
  const ended = tasks?.filter((task) => task.status !== "running") ?? [];
  const taskRow = (task: OmoTask) => <BackgroundTaskRow key={task.id} paneId={paneId} task={task} at={now + offset} />;

  const nodeWords: Record<OmoRunNode["state"], string> = {
    pending: t("waiting"), scheduled: t("waiting"), running: t("running"), blocked: t("blocked"), completed: t("done"), failed: t("failed"), skipped: t("skipped"), cancelled: t("cancelled"),
  };

  const runView = (run: OmoRun) => {
    const nodes = run.waves.flat();
    const done = nodes.filter((node) => node.state === "completed").length;
    const runningNow = nodes.filter((node) => node.state === "running").length;
    const failedNodes = nodes.filter((node) => node.state === "failed");
    const elapsed = spanMs(run.started_at, run.ended_at, runGoing(run), now + offset);
    const meta = [
      t("{done} of {total} done", { done, total: nodes.length }),
      runningNow > 0 ? t("{n} running", { n: runningNow }) : null,
      failedNodes.length > 0 ? t("{n} failed", { n: failedNodes.length }) : null,
      run.status === "cancelled" ? t("cancelled") : run.status === "paused" ? t("paused") : run.status === "pending" ? t("waiting") : null,
      elapsed === null ? null : formatElapsed(elapsed),
    ].filter((item) => item !== null).join(" · ");
    return <li key={run.id} className={`bg-run is-${run.status}`}>
      <div className="bg-run-head"><Workflow className="bg-task-icon" aria-hidden="true" /><span className="bg-task-main"><span className="bg-task-title">{run.name}</span><span className="bg-task-meta">{meta}</span></span></div>
      <ol className="bg-run-waves">{run.waves.map((wave, index) => <li key={index} className="bg-run-wave">
        {wave.map((node) => {
          const Icon = NODE_ICONS[node.state];
          return <span key={node.id} className={`bg-node is-${node.state}`} title={node.error ?? undefined}><Icon aria-hidden="true" />{node.label}<span className="sr-only"> ({nodeWords[node.state]})</span></span>;
        })}
      </li>)}</ol>
      {failedNodes.filter((node) => node.error !== null).map((node) => <p key={node.id} className="bg-run-error">{node.label}: {node.error}</p>)}
    </li>;
  };

  const goingRuns = runs.filter(runGoing);
  const endedRuns = runs.filter((run) => !runGoing(run));
  const summary = endedSummary(tasks ?? [], runs);

  // a plan cleared or a PC gone while the list is open: nothing is left to list, so the control goes
  useEffect(() => { if (open && !planShown && !tasksShown) setOpen(false); }, [open, planShown, tasksShown]);
  if (!planShown && !tasksShown) return null;
  const tasksLabel = count === 0 ? t("Background tasks") : t(count === 1 ? "{n} background task" : "{n} background tasks", { n: count });
  // a pane at rest while its background work runs says so, as a Claude pane's chip does: it waits on that work
  const workLabel = waiting && count > 0 ? t("Background work running") : tasksLabel;
  const planLabel = plan ? t("Plan: {done} of {total} done", { done: plan.done, total: plan.total }) : null;
  const label = [planLabel, tasksShown ? workLabel : null].filter((part) => part !== null).join(" · ");
  const title = plan?.current ? `${label} · ${plan.current}` : label;
  const busy = count > 0 || (plan !== null && plan.done < plan.total);
  const stepWords: Record<PlanStep["status"], string> = { pending: t("waiting"), in_progress: t("running"), completed: t("done") };
  const stepRow = (step: PlanStep) => {
    const Icon = STEP_ICONS[step.status];
    const elapsed = spanMs(step.started_at, step.ended_at, step.status === "in_progress", now + offset);
    const meta = [stepWords[step.status], elapsed === null ? null : formatElapsed(elapsed), step.owner].filter((part) => part !== null).join(" · ");
    return <li key={step.id} className={`bg-task bg-step is-${step.status}`}>
      <Icon className="bg-task-icon" aria-hidden="true" />
      <span className="bg-task-main">
        <span className="bg-task-title">{step.label}</span>
        {step.status === "in_progress" && step.active && step.active !== step.label && <span className="bg-step-active">{step.active}</span>}
        <span className="bg-task-meta">{meta}</span>
      </span>
    </li>;
  };
  // a phone's status line has one row: there the words give way to the icons and the numbers
  return <span className="bg-tasks" ref={root}>
    <button type="button" ref={toggle} className={`bg-tasks-toggle${busy ? "" : " is-idle"}${waiting && count > 0 ? " is-waiting" : ""}`} aria-label={label} title={title} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      {plan && <><ListChecks aria-hidden="true" /><span className="bg-tasks-label">{t("Plan")}</span><span className="bg-tasks-plan" aria-hidden="true">{plan.done}/{plan.total}</span></>}
      {plan && tasksShown && count > 0 && <span className="bg-tasks-sep" aria-hidden="true" />}
      {(!plan || count > 0) && tasksShown && <><Layers aria-hidden="true" /><span className={`bg-tasks-label${plan ? " is-secondary" : ""}`}>{workLabel}</span>{count > 0 && <span className="bg-tasks-count" aria-hidden="true">{count}</span>}</>}
    </button>
    {open && <div id={id} ref={menu} className="menu bg-tasks-menu" role="dialog" aria-live="off" aria-label={planShown && tasksShown ? t("Plan and background tasks") : planShown ? t("Plan") : t("Background tasks")}>
      {planShown && <>
        <div className="menu-heading">{t("Plan")}{plan && <span className="bg-plan-progress">{t("{done} of {total} done", { done: plan.done, total: plan.total })}</span>}</div>
        {steps === undefined && !planFailed && <p className="bg-tasks-note">{t("Reading the plan…")}</p>}
        {steps === null && <p className="bg-tasks-note">{t("This session keeps no plan right now")}</p>}
        {planFailed && <p className="bg-tasks-note" role="status">{t("Couldn't read the plan. Trying again…")}</p>}
        {steps && steps.length > 0 && <ol className="bg-task-list">{planWaves(steps).flat().map(stepRow)}</ol>}
      </>}
      {planShown && tasksShown && <div className="menu-heading bg-tasks-heading">{t("Background tasks")}</div>}
      {tasksShown && <>
      {tasks === null && !failed && <p className="bg-tasks-note">{t("Loading…")}</p>}
      {failed && tasks === null && <p className="bg-tasks-note">{t("Couldn't load the background tasks")}</p>}
      {failed && tasks !== null && <p className="bg-tasks-note" role="status">{t("Couldn't refresh: this is the list as it last read")}</p>}
      {tasks !== null && tasks.length === 0 && runs.length === 0 && <p className="bg-tasks-note">{t("No background tasks to show yet")}</p>}
      {/* said only of a fresh read that agrees with the pushed count: a stale list must not deny a task that just started */}
      {tasks !== null && !failed && count === 0 && running.length === 0 && goingRuns.length === 0 && summary.ended > 0 && <p className="bg-tasks-note">{t("Nothing running right now")}</p>}
      {goingRuns.length > 0 && <><div className="menu-heading">{t("Workflows")}</div><ul className="bg-task-list">{goingRuns.map(runView)}</ul></>}
      {running.length > 0 && <><div className="menu-heading">{t("Running")}</div><ul className="bg-task-list">{running.map(taskRow)}</ul></>}
      {summary.ended > 0 && <>
        <button type="button" className="bg-ended-toggle" aria-expanded={showEnded} aria-controls={endedId} onClick={() => setShowEnded(!showEnded)}>
          {showEnded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          <span>{t("{n} recently ended", { n: summary.ended })}</span>
          {summary.failed > 0 && <span className="bg-ended-failed">{t("{n} failed", { n: summary.failed })}</span>}
        </button>
        <ul id={endedId} className="bg-task-list" hidden={!showEnded}>{endedRuns.map(runView)}{ended.map(taskRow)}</ul>
      </>}
      </>}
    </div>}
  </span>;
}
