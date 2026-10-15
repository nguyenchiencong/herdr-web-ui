import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { backupPath, bashLauncher, cmdLauncher, decideWrite, expandHome, installLaunchers, isHwebLauncher, launchers, onPath, parseArgs, pathLines, shellQuote, stampOf, uninstallLaunchers } from "./install-hweb.ts";

const repo = resolve(import.meta.dir, "..");
const checkout = realpathSync(repo);
const script = join(repo, "scripts", "hweb");
const STAMP = "20261015-203512";
const at = new Date(2026, 9, 15, 20, 35, 12);
/** The helper's first copies, as the personal files began (LEGACY_HEADERS in install-hweb.ts). */
const LEGACY_BASH = "#!/usr/bin/env bash\n# Script: hweb | Personal control for the locally linked herdr web UI (Windows/Git Bash)\nset -euo pipefail\n";
const LEGACY_CMD = "@echo off\r\nrem Script: hweb.cmd - Run the personal hweb Bash command from cmd/PowerShell.\r\nsetlocal\r\n";

describe("parseArgs", () => {
  it("defaults to a plain install", () => {
    expect(parseArgs([])).toEqual({ dir: undefined, force: false, uninstall: false, help: false });
  });

  it("takes --dir with a value or with =, and the switches", () => {
    expect(parseArgs(["--dir", "C:/bin", "--force"])).toEqual({ dir: "C:/bin", force: true, uninstall: false, help: false });
    expect(parseArgs(["--dir=/opt/bin", "--uninstall", "-h"])).toEqual({ dir: "/opt/bin", force: false, uninstall: true, help: true });
  });

  it("rejects a --dir without a folder and any other argument", () => {
    expect(() => parseArgs(["--dir"])).toThrow("--dir needs a folder");
    expect(() => parseArgs(["--dir", "--force"])).toThrow("--dir needs a folder");
    expect(() => parseArgs(["--dir="])).toThrow("--dir needs a folder");
    expect(() => parseArgs(["stray"])).toThrow("unknown argument: stray");
  });
});

describe("launcher text", () => {
  it("quotes the script path for bash, escaping single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    const text = bashLauncher("/home/me/it's here/scripts/hweb");
    expect(text).toContain("exec bash '/home/me/it'\\''s here/scripts/hweb' \"$@\"");
    expect(text.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(text).not.toContain("\r");
    expect(isHwebLauncher(text)).toBe(true);
  });

  it("gives Windows bash a forward-slash path and cmd a CRLF launcher with backslashes", () => {
    const [bash, cmd] = launchers("win32", "C:\\Users\\me\\repo\\scripts\\hweb");
    expect(bash?.name).toBe("hweb");
    expect(bash?.content).toContain("exec bash 'C:/Users/me/repo/scripts/hweb' \"$@\"");
    expect(cmd?.name).toBe("hweb.cmd");
    expect(cmd?.content).toContain('"%HWEB_BASH%" -- "C:\\Users\\me\\repo\\scripts\\hweb" %*');
    expect(cmd?.content.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("writes only the bash launcher off Windows, with the path as given", () => {
    const only = launchers("linux", "/repo/scripts/hweb");
    expect(only.map((launcher) => launcher.name)).toEqual(["hweb"]);
    expect(only[0]?.content).toContain("exec bash '/repo/scripts/hweb' \"$@\"");
  });

  it("refuses a cmd launcher for a path cmd cannot quote", () => {
    expect(() => cmdLauncher("C:\\100%\\scripts\\hweb")).toThrow("cannot write a cmd launcher");
    expect(() => cmdLauncher('C:\\a"b\\scripts\\hweb')).toThrow("cannot write a cmd launcher");
  });
});

describe("isHwebLauncher", () => {
  it("recognises both launchers and the helper's first copies", () => {
    expect(isHwebLauncher(bashLauncher("/repo/scripts/hweb"))).toBe(true);
    expect(isHwebLauncher(cmdLauncher("C:\\repo\\scripts\\hweb"))).toBe(true);
    expect(isHwebLauncher(LEGACY_BASH)).toBe(true);
    expect(isHwebLauncher(LEGACY_CMD)).toBe(true);
  });

  it("does not claim a file that merely mentions hweb", () => {
    expect(isHwebLauncher("#!/bin/sh\necho hweb\n")).toBe(false);
    expect(isHwebLauncher("")).toBe(false);
  });
});

describe("decideWrite", () => {
  const wanted = bashLauncher("/repo/scripts/hweb");

  it("creates, leaves a current launcher alone, and replaces an hweb launcher", () => {
    expect(decideWrite(null, wanted, false)).toEqual({ action: "create" });
    expect(decideWrite(wanted, wanted, false)).toEqual({ action: "unchanged" });
    expect(decideWrite(LEGACY_BASH, wanted, false)).toEqual({ action: "replace", foreign: false });
  });

  it("refuses a file that is not an hweb launcher unless forced, and treats a folder as one", () => {
    expect(decideWrite("#!/bin/sh\necho mine\n", wanted, false)).toEqual({ action: "refuse" });
    expect(decideWrite("#!/bin/sh\necho mine\n", wanted, true)).toEqual({ action: "replace", foreign: true });
    expect(decideWrite(undefined, wanted, false)).toEqual({ action: "refuse" });
  });
});

describe("backupPath and stampOf", () => {
  it("names a backup by time and counts up past names already taken", () => {
    const taken = new Set([`/bin/hweb.bak-${STAMP}`]);
    expect(backupPath("/bin/hweb", STAMP, (path) => taken.has(path))).toBe(`/bin/hweb.bak-${STAMP}-2`);
    expect(backupPath("/bin/hweb", STAMP, () => false)).toBe(`/bin/hweb.bak-${STAMP}`);
  });

  it("formats local time as YYYYMMDD-HHMMSS", () => {
    expect(stampOf(at)).toBe(STAMP);
  });
});

describe("PATH and folder helpers", () => {
  it("matches Windows entries without case, slash direction, trailing separators or quotes, expanding %VAR%", () => {
    const env = { USERPROFILE: "C:\\Users\\me" };
    const pathValue = '"C:\\Program Files\\Git\\cmd";%USERPROFILE%\\bin\\;C:\\other';
    expect(onPath("C:\\Users\\me\\bin", pathValue, "win32", env)).toBe(true);
    expect(onPath("c:/users/ME/bin", pathValue, "win32", env)).toBe(true);
    expect(onPath("C:\\Users\\me\\binx", pathValue, "win32", env)).toBe(false);
  });

  it("matches POSIX entries exactly, ignoring a trailing slash", () => {
    expect(onPath("/home/me/bin", "/usr/bin:/home/me/bin/", "linux", {})).toBe(true);
    expect(onPath("/home/me/Bin", "/usr/bin:/home/me/bin", "linux", {})).toBe(false);
  });

  it("prints the Start-menu step for a Windows folder missing from PATH, and says so when only this shell has it", () => {
    const dir = "C:\\Users\\me\\bin";
    const add = `Start > Edit environment variables for your account > Path > New > ${dir}, then open a new terminal.`;
    expect(pathLines(dir, "win32", {}, "C:\\Windows", "C:\\Windows")).toEqual([`${dir} is not on your PATH. Add it: ${add}`]);
    expect(pathLines(dir, "win32", {}, dir, "C:\\Windows")[0]).toContain("is on this shell's PATH, but it is not on your user PATH.");
    expect(pathLines(dir, "win32", {}, dir, null)[0]).toContain("your user PATH could not be read");
    expect(pathLines(dir, "win32", {}, "", dir)).toEqual([`${dir} is on your user PATH.`]);
  });

  it("prints the export line for a POSIX folder missing from PATH", () => {
    const lines = pathLines("/home/me/bin", "linux", {}, "/usr/bin", null);
    expect(lines[1]).toBe('  export PATH="/home/me/bin:$PATH"');
    expect(pathLines("/home/me/bin", "linux", {}, "/home/me/bin", null)).toEqual(["/home/me/bin is on your PATH."]);
  });

  it("expands a leading ~ in --dir", () => {
    expect(expandHome("~/bin", "/home/me")).toBe(join("/home/me", "bin"));
    expect(expandHome("/opt/bin", "/home/me")).toBe("/opt/bin");
  });
});

describe("installLaunchers and uninstallLaunchers", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "hweb-install-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const bin = (): string => join(base, "bin");
  const winScript = "C:\\repo\\scripts\\hweb";
  const install = (platform: NodeJS.Platform, force = false) =>
    installLaunchers({ binDir: bin(), script: platform === "win32" ? winScript : "/repo/scripts/hweb", platform, force, now: at });

  it("creates both Windows launchers in a new folder, and a second run changes nothing", () => {
    expect(install("win32")).toEqual({ ok: true, lines: ["hweb: created", "hweb.cmd: created"] });
    expect(readFileSync(join(bin(), "hweb.cmd"), "utf8")).toBe(cmdLauncher(winScript));
    expect(readFileSync(join(bin(), "hweb"), "utf8")).toBe(bashLauncher("C:/repo/scripts/hweb"));
    expect(install("win32")).toEqual({ ok: true, lines: ["hweb: unchanged", "hweb.cmd: unchanged"] });
    expect(readdirSync(bin()).sort()).toEqual(["hweb", "hweb.cmd"]);
  });

  it("moves the helper's first copies aside before replacing them, without --force", () => {
    mkdirSync(bin());
    writeFileSync(join(bin(), "hweb"), LEGACY_BASH);
    writeFileSync(join(bin(), "hweb.cmd"), LEGACY_CMD);
    expect(install("win32")).toEqual({
      ok: true,
      lines: [`hweb: replaced; the previous file is hweb.bak-${STAMP}`, `hweb.cmd: replaced; the previous file is hweb.cmd.bak-${STAMP}`],
    });
    expect(readFileSync(join(bin(), `hweb.bak-${STAMP}`), "utf8")).toBe(LEGACY_BASH);
    expect(readFileSync(join(bin(), `hweb.cmd.bak-${STAMP}`), "utf8")).toBe(LEGACY_CMD);
    expect(readFileSync(join(bin(), "hweb"), "utf8")).toBe(bashLauncher("C:/repo/scripts/hweb"));
  });

  it("refuses a file that is not an hweb launcher unless forced, and then saves it first", () => {
    mkdirSync(bin());
    writeFileSync(join(bin(), "hweb"), "#!/bin/sh\necho mine\n");
    const refused = install("linux");
    expect(refused.ok).toBe(false);
    expect(refused.lines).toEqual([`hweb: ${join(bin(), "hweb")} is not an hweb launcher. Move it aside, or rerun with --force to replace it (the old file is saved first).`]);
    expect(readFileSync(join(bin(), "hweb"), "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(readdirSync(bin())).toEqual(["hweb"]);
    expect(install("linux", true)).toEqual({ ok: true, lines: [`hweb: replaced (it was not an hweb launcher; --force); the previous file is hweb.bak-${STAMP}`] });
    expect(readFileSync(join(bin(), `hweb.bak-${STAMP}`), "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it.skipIf(process.platform === "win32")("writes the POSIX launcher executable and no cmd launcher", () => {
    expect(install("linux").lines).toEqual(["hweb: created"]);
    expect(statSync(join(bin(), "hweb")).mode & 0o777).toBe(0o755);
    expect(existsSync(join(bin(), "hweb.cmd"))).toBe(false);
  });

  it("uninstall removes the launchers it wrote and leaves other files in place", () => {
    install("win32");
    writeFileSync(join(bin(), `hweb.cmd.bak-${STAMP}`), LEGACY_CMD);
    expect(uninstallLaunchers(bin())).toEqual({ ok: true, lines: ["hweb: removed", "hweb.cmd: removed"] });
    expect(readdirSync(bin())).toEqual([`hweb.cmd.bak-${STAMP}`]);
  });

  it("uninstall leaves a file it did not write alone and reports a missing one", () => {
    mkdirSync(bin());
    writeFileSync(join(bin(), "hweb"), LEGACY_BASH);
    expect(uninstallLaunchers(bin())).toEqual({ ok: true, lines: ["hweb: left alone (not written by hweb:install)", "hweb.cmd: not installed"] });
    expect(readFileSync(join(bin(), "hweb"), "utf8")).toBe(LEGACY_BASH);
    expect(uninstallLaunchers(join(base, "missing")).lines).toEqual(["hweb: not installed", "hweb.cmd: not installed"]);
  });
});

/** Git for Windows' bash on Windows (WSL's bash.exe would run the helper in another system), else bash on PATH. */
function findBash(): string | null {
  if (process.platform !== "win32") return Bun.which("bash");
  const git = join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Git", "bin", "bash.exe");
  return existsSync(git) ? git : null;
}
const bash = findBash();
const forward = (path: string): string => path.replaceAll("\\", "/");

describe.skipIf(bash === null)("scripts/hweb", () => {
  let base: string;
  let config: string;
  let state: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "hweb-script-"));
    config = join(base, "config");
    state = join(base, "state");
    mkdirSync(config);
    mkdirSync(state);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** Runs bash with the helper's settings pointed at this test's folders (never the user's), and no herdr. */
  async function run(argv: string[], settings: Record<string, string> = {}) {
    for (const [name, text] of Object.entries(settings)) writeFileSync(join(config, name), text);
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const child = Bun.spawn([bash!, ...argv], {
      cwd: base,
      env: {
        ...process.env,
        [pathKey]: `${dirname(process.execPath)}${delimiter}${process.env[pathKey] ?? ""}`,
        HERDR_PLUGIN_CONFIG_DIR: forward(config),
        HERDR_WEB_STATE_DIR: forward(state),
        APPDATA: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  }

  /** A loopback server answering the app's health with a revision that matches no checkout. */
  async function withHealthServer<T>(body: (port: number) => Promise<T>): Promise<T> {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ web_ui: { revision: "a".repeat(40) } }) });
    try {
      return await body(server.port);
    } finally {
      server.stop(true);
    }
  }

  it("parses as bash", async () => {
    expect((await run(["-n", script])).code).toBe(0);
  });

  it("prints usage for help without touching herdr or the server", async () => {
    const result = await run([script, "help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Usage: hweb [--dry-run] <command>");
  });

  it("refuses --dry-run for commands that have no plan", async () => {
    const result = await run([script, "--dry-run", "log"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--dry-run is only for start/stop/restart/update.");
  });

  it("plans start on the PORT of the env file, which may be CRLF with a quoted value", async () => {
    const result = await run([script, "--dry-run", "start"], { env: 'HOST=0.0.0.0\r\nPORT="8123"\r\n' });
    expect(result.code).toBe(0);
    expect(result.out).toBe("Would invoke start and wait up to 30s for http://127.0.0.1:8123.\n");
  });

  it("lets .env override env, as the plugin does", async () => {
    const result = await run([script, "--dry-run", "start"], { env: "PORT=8123\n", ".env": "PORT=9234\n" });
    expect(result.out).toContain("http://127.0.0.1:9234.");
  });

  it("falls back to the saved port, then to 7317, and a PORT setting wins over the saved one", async () => {
    writeFileSync(join(state, "plugin-port"), "17317\n");
    expect((await run([script, "--dry-run", "start"])).out).toContain("http://127.0.0.1:17317.");
    expect((await run([script, "--dry-run", "start"], { env: "PORT=8123\n" })).out).toContain("http://127.0.0.1:8123.");
    rmSync(join(state, "plugin-port"));
    expect((await run([script, "--dry-run", "start"], { env: "" })).out).toContain("http://127.0.0.1:7317.");
  });

  it("refuses a PORT that is not a port number", async () => {
    const result = await run([script, "--dry-run", "start"], { env: "PORT=http\n" });
    expect(result.code).toBe(1);
    expect(result.err).toContain("PORT in the plugin settings");
  });

  it("plans an update in the checkout the script lives in", async () => {
    const result = await run([script, "--dry-run", "update"]);
    expect(result.code).toBe(0);
    expect(result.out.toLowerCase()).toContain(`build in "${forward(checkout).toLowerCase()}"`);
  });

  it.skipIf(process.platform === "win32")("finds the checkout through a symlink to the script", async () => {
    const link = join(base, "hweb");
    symlinkSync(script, link);
    const result = await run([link, "--dry-run", "update"]);
    expect(result.out.toLowerCase()).toContain(`build in "${forward(checkout).toLowerCase()}"`);
  });

  it("status reads PORT from the env file and shows HOST 0.0.0.0 as 127.0.0.1", async () => {
    await withHealthServer(async (port) => {
      const result = await run([script, "status"], { env: `HOST=0.0.0.0\r\nPORT=${port}\r\n` });
      expect(result.code).toBe(0);
      expect(result.out).toMatch(new RegExp(`^running at http://127\\.0\\.0\\.1:${port} \\(rev aaaaaaa\\); checkout [0-9a-f]{7} - rebuild needed\\n$`));
    });
  });

  it("status takes the port from .env over env", async () => {
    await withHealthServer(async (port) => {
      const result = await run([script, "status"], { env: "PORT=1\n", ".env": `PORT=${port}\n` });
      expect(result.out).toContain(`running at http://127.0.0.1:${port} (rev aaaaaaa)`);
    });
  });
});
