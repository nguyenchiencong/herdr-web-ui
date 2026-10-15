/**
 * Installs the personal `hweb` helper (scripts/hweb) as thin launchers in a folder outside the
 * checkout, so `hweb` works from any directory: from Git Bash on every platform, and from cmd and
 * PowerShell on Windows through `hweb.cmd`.
 *
 *   bun run hweb:install [--dir <folder>] [--force]  write the launchers (default folder: ~/bin)
 *   bun run hweb:uninstall [--dir <folder>]          remove the launchers this installer wrote
 *
 * Each launcher embeds this checkout's scripts/hweb, so it serves the checkout it came from. A
 * launcher that is already current is left alone. An hweb launcher that gets replaced is moved aside
 * first (hweb.bak-<time>); a file that is not an hweb launcher is never overwritten without --force,
 * and then it is moved aside too. PATH is never changed: the folder's status and the line that adds
 * it are printed instead.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const BASH_NAME = "hweb";
const CMD_NAME = "hweb.cmd";
/** Every launcher this installer writes carries it: uninstall and replacement recognise their own files by it. */
const MARKER = "hweb launcher";
/** The helper's first copies, from before it lived in the checkout (bash, then cmd): an install replaces them without --force. */
const LEGACY_HEADERS = [/^# Script: hweb \|/m, /^rem Script: hweb\.cmd /im];
const USAGE = [
  "Usage: bun run hweb:install [--dir <folder>] [--force]",
  "       bun run hweb:uninstall [--dir <folder>]",
  "  --dir <folder>  where the launchers go (default: ~/bin)",
  "  --force         replace a file that is not an hweb launcher (it is moved aside first)",
  "  --uninstall     remove the launchers this installer wrote",
].join("\n");

export type Options = { dir: string | undefined; force: boolean; uninstall: boolean; help: boolean };

/** The command line: `--dir <folder>` or `--dir=<folder>`, `--force`, `--uninstall`, `--help`. Anything else throws. */
export function parseArgs(args: readonly string[]): Options {
  const options: Options = { dir: undefined, force: false, uninstall: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--force") options.force = true;
    else if (arg === "--uninstall") options.uninstall = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dir" || arg.startsWith("--dir=")) {
      const value = arg === "--dir" ? args[++index] : arg.slice("--dir=".length);
      if (!value || value.startsWith("--")) throw new Error("--dir needs a folder");
      options.dir = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/** A `~/` or `~\` prefix in --dir, expanded here because cmd and PowerShell do not expand it. */
export function expandHome(path: string, home: string = homedir()): string {
  return /^~[\\/]/.test(path) ? join(home, path.slice(2)) : path;
}

export type Launcher = { name: string; content: string };

/** The launchers a platform gets: `hweb` everywhere, and `hweb.cmd` as well on Windows. `script` is scripts/hweb's absolute path. */
export function launchers(platform: NodeJS.Platform, script: string): Launcher[] {
  const bash: Launcher = { name: BASH_NAME, content: bashLauncher(platform === "win32" ? script.replaceAll("\\", "/") : script) };
  return platform === "win32" ? [bash, { name: CMD_NAME, content: cmdLauncher(script) }] : [bash];
}

/** A POSIX shell single-quoted word: nothing inside it expands, and each ' becomes '\''. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** The POSIX shell launcher: it checks the script is still there, then runs it with bash and passes the arguments on. */
export function bashLauncher(script: string): string {
  const quoted = shellQuote(script);
  return [
    "#!/usr/bin/env bash",
    `# ${MARKER}, written by bun run hweb:install. It runs scripts/hweb of its checkout; change that file, not this one.`,
    `[ -f ${quoted} ] || { echo "hweb: the checkout's scripts/hweb is missing; run bun run hweb:install in the checkout again." >&2; exit 1; }`,
    `exec bash ${quoted} "$@"`,
    "",
  ].join("\n");
}

/** The cmd launcher, with CRLF line ends as cmd expects. It finds Git for Windows' bash, checks the script, and runs it with the arguments. */
export function cmdLauncher(script: string): string {
  if (/[%"\r\n]/.test(script)) {
    throw new Error(`cannot write a cmd launcher for ${script}: a percent sign, a double quote or a line break in the path cannot be quoted for cmd; move the checkout`);
  }
  return [
    "@echo off",
    `rem ${MARKER}, written by bun run hweb:install. It runs scripts\\hweb of its checkout with Git for Windows bash; change that file, not this one.`,
    "setlocal",
    'if not defined HWEB_BASH set "HWEB_BASH=%ProgramFiles%\\Git\\bin\\bash.exe"',
    'if not exist "%HWEB_BASH%" (',
    '  echo ERROR: Git for Windows Bash not found at "%HWEB_BASH%". Install Git for Windows or set HWEB_BASH. 1>&2',
    "  exit /b 1",
    ")",
    `if not exist "${script}" (`,
    `  echo ERROR: Missing Bash script "${script}". Run bun run hweb:install in the checkout again. 1>&2`,
    "  exit /b 1",
    ")",
    `"%HWEB_BASH%" -- "${script}" %*`,
    "exit /b %errorlevel%",
    "",
  ].join("\r\n");
}

/** Whether a file is an hweb launcher, or one of the helper's first copies: an install may replace either. */
export function isHwebLauncher(text: string): boolean {
  return text.includes(MARKER) || LEGACY_HEADERS.some((pattern) => pattern.test(text));
}

export type Decision = { action: "create" } | { action: "unchanged" } | { action: "replace"; foreign: boolean } | { action: "refuse" };

/**
 * What an install does with one launcher file. `existing` is that file's text: null when there is no
 * file, undefined when it is not readable text (a folder or a dangling link).
 */
export function decideWrite(existing: string | null | undefined, wanted: string, force: boolean): Decision {
  if (existing === null) return { action: "create" };
  if (existing === wanted) return { action: "unchanged" };
  if (existing !== undefined && isHwebLauncher(existing)) return { action: "replace", foreign: false };
  return force ? { action: "replace", foreign: true } : { action: "refuse" };
}

/** A local timestamp for backup names, such as 20261015-203512. */
export function stampOf(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

/** `<file>.bak-<stamp>`, with -2, -3, ... added while that name is taken. */
export function backupPath(file: string, stamp: string, taken: (path: string) => boolean): string {
  let candidate = `${file}.bak-${stamp}`;
  for (let n = 2; taken(candidate); n++) candidate = `${file}.bak-${stamp}-${n}`;
  return candidate;
}

/** An environment variable by name, whatever the case of its key (Windows keys are case-insensitive). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/** A PATH entry as a comparable string: quotes and trailing separators dropped; on Windows also %VAR% expanded, slashes unified, case folded. */
function normalizeEntry(entry: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  let text = entry.trim().replace(/^"(.*)"$/, "$1");
  if (platform === "win32") {
    text = text.replace(/%([^%]+)%/g, (whole, name: string) => envValue(env, name) ?? whole).replaceAll("/", "\\").toLowerCase();
  }
  return text.replace(/[\\/]+$/, "");
}

/** Whether `dir` is one of the entries of a PATH value (`;`-separated on Windows, `:` elsewhere). */
export function onPath(dir: string, pathValue: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  const wanted = normalizeEntry(dir, platform, env);
  return pathValue.split(platform === "win32" ? ";" : ":").some((entry) => entry.trim() !== "" && normalizeEntry(entry, platform, env) === wanted);
}

/** The Windows user PATH as stored in HKCU\Environment (%VAR% unexpanded), or null when it cannot be read. */
export function readUserPath(): string | null {
  const result = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  return /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(result.stdout)?.[1] ?? "";
}

/**
 * Lines saying whether `dir` is on PATH and, when it is not, the exact step that adds it. `shellPath`
 * is this process's PATH; `userPath` is the Windows user PATH, or null when it could not be read.
 * PATH itself is never changed.
 */
export function pathLines(dir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, shellPath: string, userPath: string | null): string[] {
  if (platform !== "win32") {
    if (onPath(dir, shellPath, platform, env)) return [`${dir} is on your PATH.`];
    return [
      `${dir} is not on your PATH. Add this line to your shell profile (~/.zshrc or ~/.bashrc), then open a new terminal:`,
      `  export PATH="${dir}:$PATH"`,
    ];
  }
  const add = `Start > Edit environment variables for your account > Path > New > ${dir}, then open a new terminal.`;
  if (userPath !== null && onPath(dir, userPath, platform, env)) return [`${dir} is on your user PATH.`];
  if (onPath(dir, shellPath, platform, env)) {
    const why = userPath === null ? "your user PATH could not be read" : "it is not on your user PATH";
    return [`${dir} is on this shell's PATH, but ${why}. Add it so new terminals find hweb: ${add}`];
  }
  return [`${dir} is not on your PATH. Add it: ${add}`];
}

/** Git for Windows' bash, which the cmd launcher runs unless HWEB_BASH names another. */
export function gitBashPath(env: NodeJS.ProcessEnv): string {
  return join(envValue(env, "ProgramFiles") ?? "C:\\Program Files", "Git", "bin", "bash.exe");
}

/** A launcher file's text: null when there is no file; undefined for a folder or for something unreadable (a dangling link). */
function readExisting(file: string): string | null | undefined {
  const info = lstatOrNull(file);
  if (info === null) return null;
  if (info.isDirectory()) return undefined;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function lstatOrNull(file: string) {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

function writeLauncher(file: string, content: string, platform: NodeJS.Platform): void {
  writeFileSync(file, content);
  if (platform !== "win32") chmodSync(file, 0o755);
}

export type Outcome = { ok: boolean; lines: string[] };

/** Writes the launchers into `binDir` (creating it) as the module comment describes; one line per launcher. */
export function installLaunchers(options: { binDir: string; script: string; platform: NodeJS.Platform; force: boolean; now: Date }): Outcome {
  const stamp = stampOf(options.now);
  const lines: string[] = [];
  let ok = true;
  mkdirSync(options.binDir, { recursive: true });
  for (const { name, content } of launchers(options.platform, options.script)) {
    const file = join(options.binDir, name);
    const decision = decideWrite(readExisting(file), content, options.force);
    if (decision.action === "unchanged") {
      lines.push(`${name}: unchanged`);
    } else if (decision.action === "refuse") {
      ok = false;
      lines.push(`${name}: ${file} is not an hweb launcher. Move it aside, or rerun with --force to replace it (the old file is saved first).`);
    } else if (decision.action === "create") {
      writeLauncher(file, content, options.platform);
      lines.push(`${name}: created`);
    } else {
      const saved = backupPath(file, stamp, existsSync);
      renameSync(file, saved);
      writeLauncher(file, content, options.platform);
      lines.push(`${name}: replaced${decision.foreign ? " (it was not an hweb launcher; --force)" : ""}; the previous file is ${basename(saved)}`);
    }
  }
  return { ok, lines };
}

/** Removes the launchers this installer wrote (they carry MARKER). Any other file in the folder is left alone and said so. */
export function uninstallLaunchers(binDir: string): Outcome {
  const lines: string[] = [];
  for (const name of [BASH_NAME, CMD_NAME]) {
    const file = join(binDir, name);
    const text = readExisting(file);
    if (text === null) {
      lines.push(`${name}: not installed`);
    } else if (text !== undefined && text.includes(MARKER)) {
      rmSync(file);
      lines.push(`${name}: removed`);
    } else {
      lines.push(`${name}: left alone (not written by hweb:install)`);
    }
  }
  return { ok: true, lines };
}

/** The parsed command line, or the usage on stderr and exit 2. */
function parseOrUsage(args: readonly string[]): Options {
  try {
    return parseArgs(args);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return process.exit(2);
  }
}

if (import.meta.main) {
  const options = parseOrUsage(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const binDir = resolve(options.dir === undefined ? join(homedir(), "bin") : expandHome(options.dir));
  if (options.uninstall) {
    for (const line of uninstallLaunchers(binDir).lines) console.log(line);
    process.exit(0);
  }
  const root = realpathSync(resolve(import.meta.dir, ".."));
  const script = join(root, "scripts", "hweb");
  if (!existsSync(script)) {
    console.error(`scripts/hweb is missing from ${root}; the launchers need it.`);
    process.exit(1);
  }
  const result = installLaunchers({ binDir, script, platform: process.platform, force: options.force, now: new Date() });
  console.log(`checkout: ${root}`);
  console.log(`folder: ${binDir}`);
  for (const line of result.lines) console.log(line);
  if (process.platform === "win32" && !existsSync(gitBashPath(process.env))) {
    console.log(`warning: Git for Windows Bash is not at ${gitBashPath(process.env)}; hweb.cmd needs it. Install Git for Windows, or set HWEB_BASH to its bash.exe.`);
  }
  const shellPath = envValue(process.env, "PATH") ?? "";
  const userPath = process.platform === "win32" ? readUserPath() : null;
  for (const line of pathLines(binDir, process.platform, process.env, shellPath, userPath)) console.log(line);
  process.exit(result.ok ? 0 : 1);
}
