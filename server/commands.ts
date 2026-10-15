import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { piAgentDir } from "./pi-models.ts";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { PaneAgent, SlashCommand } from "../shared/protocol.ts";

const BUILTINS: Record<string, readonly string[]> = {
  claude: ["clear", "compact", "config", "cost", "effort", "goal", "help", "init", "memory", "model", "permissions", "review", "status", "doctor", "login", "logout", "pr-comments", "release-notes", "terminal-setup", "vim"],
  omp: ["help", "clear", "compact", "model", "new", "sessions", "exit"],
  codex: ["clear", "compact", "diff", "help", "model", "new", "quit", "review", "status"],
  // pi 0.87.1, as its own palette lists them, less /tree — the way omp's list curates its own
  // commands. The chat reads pi's tree browser as nothing at all: no card, and the pane still looks
  // idle while the terminal waits for arrow keys. Offering the one command that opens it from the
  // chat would walk a reader into a state only the terminal lens can leave. Navigating stays in the
  // terminal; the chat's place is the abandoned-turns marker, which says where a /tree left off
  pi: ["settings", "model", "thinking", "scoped-models", "login", "logout", "llama", "new", "resume", "name", "session", "fork", "clone", "compact", "import", "copy", "export", "share", "bug", "trust", "reload", "hotkeys", "changelog", "quit"],
};

/** pi states what each command opens or does, in its own words, read off its palette. */
const PI_DESCRIPTIONS: Record<string, string> = {
  settings: "Open settings menu", model: "<provider/model> — Select model", thinking: "<level> — Set thinking level",
  "scoped-models": "Enable/disable models for Ctrl+P cycling", login: "<provider> — Configure provider authentication",
  logout: "Remove provider authentication", llama: "[t] Manage llama.cpp router models", new: "Start a new session",
  resume: "Resume a different session", name: "Set session display name", session: "Show session info and stats",
  fork: "Create a new fork from a previous user message",
  clone: "Duplicate the current session at the current position", compact: "Manually compact the session context",
  import: "Import and resume a session from a JSONL file", copy: "Copy last agent message to clipboard",
  export: "Export session (HTML default, or specify path: .html/.jsonl)", share: "Share session as a secret GitHub gist",
  bug: "<description> — Report a bug to the Pi developers", trust: "Save project trust decision for future sessions",
  reload: "Reload keybindings, extensions, skills, prompts, themes, and context files", hotkeys: "Show all keyboard shortcuts",
  changelog: "Show changelog entries", quit: "Quit pi",
};

const DESCRIPTIONS: Record<string, string> = {
  clear: "Clear the conversation", compact: "Compact conversation context", config: "Open configuration",
  cost: "Show token usage and cost", help: "Show available commands", init: "Initialize project instructions",
  memory: "Edit agent memory", model: "Choose a model", permissions: "Manage tool permissions", review: "Review changes",
  status: "Show session status", doctor: "Check the installation", login: "Sign in", logout: "Sign out",
  "pr-comments": "Fetch pull request comments", "release-notes": "Show release notes", "terminal-setup": "Configure terminal integration",
  vim: "Toggle Vim mode", new: "Start a new session", sessions: "List sessions", exit: "Exit the agent",
  diff: "Show the current diff", quit: "Exit the agent",
  goal: "[condition|clear] — Keep working until a condition is met",
  effort: "Set effort level for model usage",
};

function description(markdown: string): string {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  if (frontmatter) {
    const found = frontmatter[1]?.match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim();
    if (found) return found.replace(/^(["'])(.*)\1$/, "$2").slice(0, 120);
  }
  const body = frontmatter ? markdown.slice(frontmatter[0].length) : markdown;
  return (body.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "").slice(0, 120);
}

/** `name:` from a SKILL.md's frontmatter, else its directory's name. */
function skillName(markdown: string, directory: string): string {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  const named = frontmatter?.[1]?.match(/^name:\s*(.+?)\s*$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
  return named && /^[\p{L}\p{N}_:-]+$/u.test(named) ? named : directory;
}

/** Skills under a root: one directory each, with a SKILL.md; `prefix` names a plugin's. */
function skills(root: string, source: SlashCommand["source"], options: { prefix?: string; trigger?: "$" } = {}): SlashCommand[] {
  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const directory = join(root, entry.name);
    let markdown: string;
    try {
      if (!statSync(directory).isDirectory()) continue;
      markdown = readFileSync(join(directory, "SKILL.md"), "utf8");
    } catch { continue; }
    const name = skillName(markdown, entry.name);
    result.push({ name: options.prefix ? `${options.prefix}:${name}` : name, description: description(markdown), source, ...(options.trigger ? { trigger: options.trigger } : {}) });
  }
  return result;
}

/**
 * The skills and commands of the Claude plugins turned on in settings.json, as Claude
 * offers them: `/<plugin>:<name>`.
 */
function pluginCommands(home: string): SlashCommand[] {
  const read = (path: string): unknown => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
  const enabled = (read(join(home, ".claude", "settings.json")) as { enabledPlugins?: Record<string, unknown> } | null)?.enabledPlugins ?? {};
  const installed = (read(join(home, ".claude", "plugins", "installed_plugins.json")) as { plugins?: Record<string, Array<{ installPath?: unknown }>> } | null)?.plugins ?? {};
  const result: SlashCommand[] = [];
  for (const [id, on] of Object.entries(enabled)) {
    if (on !== true) continue;
    const installPath = installed[id]?.[0]?.installPath;
    if (typeof installPath !== "string") continue;
    const plugin = id.split("@")[0]!;
    result.push(...skills(join(installPath, "skills"), "plugin", { prefix: plugin }));
    result.push(...customCommands(join(installPath, "commands"), "plugin").map((command) => ({ ...command, name: `${plugin}:${command.name}` })));
  }
  return result;
}

function customCommands(root: string, source: SlashCommand["source"]): SlashCommand[] {  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  // Guard only the current ancestry: sibling links can expose different command namespaces.
  const ancestors = new Set<string>();
  const visit = (directory: string): void => {
    let canonical: string;
    try { canonical = realpathSync(directory); } catch { return; }
    if (ancestors.has(canonical)) return;
    ancestors.add(canonical);
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        try {
          const target = statSync(path);
          if (target.isDirectory()) visit(path);
          else if (target.isFile() && entry.name.endsWith(".md")) {
            const relativeName = relative(root, path).slice(0, -3).split(sep).join(":");
            result.push({ name: relativeName, description: description(readFileSync(path, "utf8")), source });
          }
        } catch { continue; }
      }
    } finally { ancestors.delete(canonical); }
  };
  visit(root);
  return result;
}

/**
 * Templates are commands. A conventional prompt directory holds direct `.md` children only —
 * pi reads no deeper there, so recursing would offer commands pi never loads.
 *
 * A link is asked of what it points at, not of itself: pi stats the entry, so a `.md` reached
 * through a symlink is a template it loads, and a directory is not one however the link is named.
 */
function piTemplates(root: string, source: SlashCommand["source"]): SlashCommand[] {
  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    let markdown: string;
    try {
      // the target is what gets read, so the target is what gets asked: a broken link throws here
      // and is skipped, as pi skips it, and a link to a folder fails isFile however it is named.
      // One path for links and plain files alike — the stat costs less than the read that follows
      // and keeps the two from being judged by different rules
      const target = join(root, entry.name);
      if (!statSync(target).isFile()) continue;
      markdown = readFileSync(target, "utf8");
    } catch {
      continue;
    }
    result.push({ name: entry.name.slice(0, -3), description: description(markdown), source });
  }
  return result;
}

/** A JSON file's top-level object, or null when it is missing, unreadable or not an object. */
function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The `description:` a markdown file's frontmatter declares, unquoted and at most 120 characters; undefined when it declares none. */
function declaredDescription(markdown: string): string | undefined {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  const found = frontmatter?.[1]?.match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  return found ? found.slice(0, 120) : undefined;
}

/** pi's agent directory under a home folder; PI_CODING_AGENT_DIR moves it, as it does for pi's sessions and models. */
function piAgentDirFor(home: string): string {
  return process.env["PI_CODING_AGENT_DIR"] ? piAgentDir() : join(home, ".pi", "agent");
}

/** A path as pi keys its trust store: resolved and canonical where it exists, case-folded on Windows. */
function trustKey(path: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(resolve(path));
  } catch {
    canonical = resolve(path);
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/**
 * Whether pi trusts the project at `cwd`: the nearest entry at or above it in pi's trust store
 * (`<agent dir>/trust.json`, folder → true | false | null) decides, as pi's own lookup does.
 */
function piProjectTrusted(cwd: string, agentDir: string): boolean {
  const store = readJsonObject(join(agentDir, "trust.json"));
  if (store === null) return false;
  const decisions = new Map<string, unknown>(Object.entries(store).map(([path, decision]) => [trustKey(path), decision]));
  for (let dir = trustKey(cwd); ; dir = dirname(dir)) {
    const decision = decisions.get(dir);
    if (decision === true) return true;
    if (decision === false) return false;
    if (dirname(dir) === dir) return false;
  }
}

/** pi's personal settings.json: the packages it installs, and whether skills register as `/skill:` commands (on unless it says otherwise). */
function piPersonalSettings(agentDir: string): { packages: unknown[]; enableSkillCommands: boolean } {
  const settings = readJsonObject(join(agentDir, "settings.json"));
  const packages = settings?.["packages"];
  return { packages: Array.isArray(packages) ? packages : [], enableSkillCommands: settings?.["enableSkillCommands"] !== false };
}

/** One `packages` entry of the personal settings: a source, and the `skills` filter the object form adds. */
function piPackageEntry(entry: unknown): { source: string; skills?: string[] } | null {
  if (typeof entry === "string") return { source: entry };
  if (entry === null || typeof entry !== "object" || typeof (entry as { source?: unknown }).source !== "string") return null;
  const { source, skills } = entry as { source: string; skills?: unknown };
  return Array.isArray(skills) ? { source, skills: skills.filter((item): item is string => typeof item === "string") } : { source };
}

/** Where pi installs a package source, or null for one this code does not read: git and URL checkouts keep pi's own layout. */
function piPackageRoot(source: string, agentDir: string, home: string): string | null {
  if (source.startsWith("npm:")) {
    const name = /^(@[^/@]+\/[^/@]+|[^/@]+)/.exec(source.slice("npm:".length).trim())?.[1];
    return name === undefined ? null : join(agentDir, "npm", "node_modules", ...name.split("/"));
  }
  if (source.startsWith("~/") || source.startsWith("~\\")) return join(home, source.slice(2));
  if (isAbsolute(source)) return source;
  // a relative local path resolves from the settings file that names it, the agent directory's own
  return /^\.\.?(?:[\\/]|$)/.test(source) ? join(agentDir, source) : null;
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The directories a package pattern names under its root: a plain path, or the directories a glob matches there. */
function patternDirectories(root: string, pattern: string): string[] {
  const relativePattern = pattern.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (relativePattern === "" || isAbsolute(relativePattern)) return [];
  if (!/[*?[\]{}]/.test(relativePattern)) return isDirectory(join(root, relativePattern)) ? [join(root, relativePattern)] : [];
  try {
    return [...new Bun.Glob(relativePattern).scanSync({ cwd: root, onlyFiles: false })].map((match) => join(root, match)).filter(isDirectory);
  } catch {
    return [];
  }
}

/** The directories a package keeps its skills in: the `pi.skills` patterns of its manifest (a `!` pattern takes away), else its `skills/` folder. */
function piPackageSkillRoots(root: string): string[] {
  const pi = readJsonObject(join(root, "package.json"))?.["pi"];
  const declared = pi !== null && typeof pi === "object" && Array.isArray((pi as { skills?: unknown }).skills)
    ? (pi as { skills: unknown[] }).skills.filter((item): item is string => typeof item === "string")
    : undefined;
  if (declared === undefined) return patternDirectories(root, "skills");
  const roots = new Set(declared.filter((pattern) => !pattern.startsWith("!")).flatMap((pattern) => patternDirectories(root, pattern)));
  for (const pattern of declared) if (pattern.startsWith("!")) for (const dir of patternDirectories(root, pattern.slice(1))) roots.delete(dir);
  return [...roots];
}

/** Folders under a root that hold a SKILL.md, found the way pi finds them: recursively, never inside a skill, never twice through a link. */
function skillFolders(root: string, seen = new Set<string>()): string[] {
  let canonical: string;
  try {
    canonical = realpathSync(root);
  } catch {
    return [];
  }
  if (seen.has(canonical) || !isDirectory(canonical)) return [];
  seen.add(canonical);
  if (existsSync(join(root, "SKILL.md"))) return [root];
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
    .flatMap((entry) => skillFolders(join(root, entry.name), seen));
}

/** A skill folder as a `/skill:` command, or null when its SKILL.md declares no description: pi does not load such a skill. */
function piSkillCommand(folder: string): SlashCommand | null {
  let markdown: string;
  try {
    markdown = readFileSync(join(folder, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const text = declaredDescription(markdown);
  return text === undefined ? null : { name: `skill:${skillName(markdown, basename(folder))}`, description: text, source: "skill" };
}

/** The `/skill:` commands of every skill under a pi skills folder. */
function piSkillsUnder(root: string): SlashCommand[] {
  return skillFolders(root).flatMap((folder) => piSkillCommand(folder) ?? []);
}

/**
 * A package's skill folders, narrowed by its settings entry the way pi's Select package resources
 * reads it: an omitted `skills` loads all, `[]` loads none, a pattern includes, `!pattern` and
 * `-path` take away, and `+path` adds one exact folder.
 */
function selectSkillFolders(root: string, folders: string[], filter: string[] | undefined): string[] {
  if (filter === undefined) return folders;
  if (filter.length === 0) return [];
  const pathOf = (folder: string): string => relative(root, folder).split(sep).join("/");
  const pattern = (text: string): string => text.replace(/^\.\//, "").replace(/\/+$/, "");
  const includes = filter.filter((entry) => !/^[!+-]/.test(entry));
  const kept = new Set(includes.length === 0 ? folders : folders.filter((folder) => includes.some((entry) => new Bun.Glob(pattern(entry)).match(pathOf(folder)))));
  for (const entry of filter) {
    if (entry.startsWith("+")) for (const folder of folders) if (pathOf(folder) === pattern(entry.slice(1))) kept.add(folder);
    if (entry.startsWith("!")) for (const folder of folders) if (new Bun.Glob(pattern(entry.slice(1))).match(pathOf(folder))) kept.delete(folder);
    if (entry.startsWith("-")) for (const folder of folders) if (pathOf(folder) === pattern(entry.slice(1))) kept.delete(folder);
  }
  return folders.filter((folder) => kept.has(folder));
}

/** The `/skill:` commands of pi's installed packages, as the personal settings' `packages` name and narrow them. */
function piPackageSkills(packages: readonly unknown[], agentDir: string, home: string): SlashCommand[] {
  return packages.flatMap((entry) => {
    const parsed = piPackageEntry(entry);
    const root = parsed === null ? null : piPackageRoot(parsed.source, agentDir, home);
    if (parsed === null || root === null) return [];
    const folders = [...new Set(piPackageSkillRoots(root).flatMap((skillRoot) => skillFolders(skillRoot)))];
    return selectSkillFolders(root, folders, parsed.skills).flatMap((folder) => piSkillCommand(folder) ?? []);
  });
}

// HOME is unset on Windows outside a POSIX shell: an empty home would read `.pi` under the server's own folder
export function paneCommands(agent: string | null | undefined, cwd: string | null | undefined, home = process.env.HOME || homedir()): SlashCommand[] {
  if (!agent || !(agent in BUILTINS)) return [];
  const commands: SlashCommand[] = (BUILTINS[agent] ?? []).map((name) => ({ name, description: (agent === "pi" ? PI_DESCRIPTIONS[name] : undefined) ?? DESCRIPTIONS[name] ?? `Run /${name}`, source: "builtin" }));
  if (agent === "claude") {
    commands.push(...customCommands(join(home, ".claude", "commands"), "user"));
    if (cwd) commands.push(...customCommands(join(cwd, ".claude", "commands"), "project"));
    commands.push(...skills(join(home, ".claude", "skills"), "skill"));
    if (cwd) commands.push(...skills(join(cwd, ".claude", "skills"), "skill"));
    commands.push(...pluginCommands(home));
  }
  if (agent === "pi") {
    // The person's own folders, which pi loads whether or not a project is trusted: the agent
    // directory, ~/.agents, and the packages the personal settings install. A project's own skills,
    // prompts and packages are left out on purpose: pi gates them behind a trust decision and a
    // project root of its own choosing, and offering a command the agent will not run is worse than
    // offering one fewer command. Extension commands are not on disk, so no file scan lists them;
    // they stay in the terminal's own `/` menu.
    const agentDir = piAgentDirFor(home);
    const personal = piPersonalSettings(agentDir);
    commands.push(...piTemplates(join(agentDir, "prompts"), "user"));
    if (personal.enableSkillCommands) {
      commands.push(...piSkillsUnder(join(agentDir, "skills")));
      commands.push(...piSkillsUnder(join(home, ".agents", "skills")));
      commands.push(...piPackageSkills(personal.packages, agentDir, home));
    }
  }
  if (agent === "codex") {
    // Codex's saved prompts run as /prompts:<name>; its skills are named with `$`
    commands.push(...customCommands(join(home, ".codex", "prompts"), "user").map((command) => ({ ...command, name: `prompts:${command.name}` })));
    commands.push(...skills(join(home, ".codex", "skills"), "skill", { trigger: "$" }));
    if (cwd) commands.push(...skills(join(cwd, ".codex", "skills"), "skill", { trigger: "$" }));
  }
  return commands.sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source));
}

/** A markdown file's front matter, and the `enabled: false` in it that turns a pi-subagents agent off. */
const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/;
const DISABLED = /^enabled:\s*false\s*$/m;

/** A mention-safe agent name: the form pi-subagents' `@name` dispatch and the composer both take. */
const MENTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * The agents a message can `@`-mention in a pi pane: `<agent dir>/agents/*.md`, and the project's
 * `.pi/agents/*.md` and `.agents/agents/*.md` only where pi trusts the project, the same gate
 * pi-subagents applies. A project agent shadows a personal one of the same name, and `.pi/agents` the
 * shared `.agents/agents`, as they do there. The name is the file's name, which is what `@name`
 * dispatches to; a linked folder or file is skipped, and so is an agent its front matter disables
 * (`enabled: false`), as pi-subagents skips them.
 */
export function paneAgents(agent: string | null | undefined, cwd: string | null | undefined, home = process.env.HOME || homedir()): PaneAgent[] {
  if (agent !== "pi") return [];
  const agentDir = piAgentDirFor(home);
  const found = new Map<string, PaneAgent>();
  const collect = (dir: string, source: PaneAgent["source"]): void => {
    let entries: Dirent[];
    try {
      if (lstatSync(dir).isSymbolicLink()) return;
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const name = entry.name.slice(0, -".md".length);
      if (!MENTION_NAME.test(name) || found.has(name)) continue;
      let markdown: string;
      try {
        markdown = readFileSync(join(dir, entry.name), "utf8");
      } catch {
        continue;
      }
      if (DISABLED.test(markdown.match(FRONTMATTER)?.[1] ?? "")) continue;
      found.set(name, { name, description: declaredDescription(markdown) ?? "", source });
    }
  };
  if (cwd && piProjectTrusted(cwd, agentDir)) {
    collect(join(cwd, ".pi", "agents"), "project");
    collect(join(cwd, ".agents", "agents"), "project");
  }
  collect(join(agentDir, "agents"), "user");
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}
