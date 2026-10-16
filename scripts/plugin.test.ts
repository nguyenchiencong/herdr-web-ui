import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { ProcessRow } from "../server/windows-processes.ts";
import type { stop as stopServer } from "./plugin.ts";

/**
 * The plugin's settings files, read by hand the way a headless PC runs `status` or `pair`:
 * no HERDR_PLUGIN_CONFIG_DIR, so the script asks herdr (a fake one here) for the config dir.
 */

const ROOT = join(import.meta.dir, "..");
let scratch: string;
let configDir: string;

async function status(extra: Record<string, string> = {}): Promise<{ out: string; err: string; exitCode: number }> {
  return run("status", extra);
}

async function run(command: string, extra: Record<string, string> = {}): Promise<{ out: string; err: string; exitCode: number }> {
  const bin = join(scratch, "bin");
  // Windows names the PATH variable `Path`, joins its entries with `;`, and reads the home directory from USERPROFILE, not HOME
  // a start spawns the server from ROOT: scratch holds none, so no test can run the checkout's server
  const env: Record<string, string | undefined> = { ...process.env, HOME: scratch, USERPROFILE: scratch, HERDR_PLUGIN_STATE_DIR: join(scratch, "state"), HERDR_PLUGIN_ROOT: scratch };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = [bin, process.env[pathKey] ?? ""].join(delimiter);
  for (const key of ["HERDR_PLUGIN_CONFIG_DIR", "PORT", "HOST", "HERDR_WEB_TOKEN", "HERDR_WEB_STATE_DIR", "XDG_CONFIG_HOME"]) delete env[key];
  Object.assign(env, extra);
  const child = Bun.spawn(["bun", "scripts/plugin.ts", command], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, exitCode };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "herdr-plugin-env-"));
  configDir = join(scratch, "config");
  mkdirSync(configDir);
  mkdirSync(join(scratch, "bin"));
  // Bun.which finds a Windows program only by its PATHEXT extension, so there the fake herdr is a .cmd
  if (platform() === "win32") {
    writeFileSync(join(scratch, "bin", "herdr.cmd"), `@echo off\r\nif "%1 %2"=="plugin config-dir" echo ${configDir}\r\n`);
  } else {
    const herdr = join(scratch, "bin", "herdr");
    writeFileSync(herdr, `#!/bin/sh\n[ "$1 $2" = "plugin config-dir" ] && echo "${configDir}"\n`);
    chmodSync(herdr, 0o755);
  }
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("plugin settings files", () => {
  it("finds the config dir through herdr and reads .env", async () => {
    writeFileSync(join(configDir, ".env"), "PORT=1\n");
    const run = await status();
    expect(run.exitCode, run.err).toBe(0);
    expect(run.out).toContain("down http://127.0.0.1:1");
    expect(run.out).toContain(`config: ${join(configDir, ".env")}`);
  });

  it("still reads env, from older installs", async () => {
    writeFileSync(join(configDir, "env"), "PORT=2\n");
    const run = await status();
    expect(run.out).toContain("down http://127.0.0.1:2");
    expect(run.out).toContain(`config: ${join(configDir, "env")}`);
  });

  it("lets .env win over env and names the keys they disagree on, not their values", async () => {
    writeFileSync(join(configDir, "env"), "PORT=2\nHERDR_WEB_TOKEN=old-secret\nHOST=127.0.0.1\n");
    writeFileSync(join(configDir, ".env"), "PORT=1\nHERDR_WEB_TOKEN=new-secret\nHOST=127.0.0.1\n");
    const run = await status();
    expect(run.out).toContain("down http://127.0.0.1:1");
    expect(run.out).toContain(`config: ${join(configDir, "env")}, ${join(configDir, ".env")}`);
    expect(run.out).toContain("set PORT, HERDR_WEB_TOKEN; .env wins");
    expect(run.out).not.toContain("secret");
  });

  it("says where settings go when there are none", async () => {
    // without a PORT, status probes the default port, which a running app on this PC holds
    const run = await status({ PORT: "1" });
    expect(run.out).toContain(`config: none (settings go in ${join(scratch, ".config", "herdr-web-ui", "env")})`);
  });
});

/** What the app's bridge health answers (server/index.ts): it holds the port whether herdr answers or not. */
const BRIDGE_HEALTH = { ok: true, auth: { required: false, authenticated: true }, bridge_protocol: 1 };
/** What the app's full health answers while herdr does (every release since v0.1.0 has sent these). */
const APP_HEALTH = { ok: true, herdr: { version: "0.9.3", protocol: 1 }, auth: { required: false, authenticated: true } };

describe("port", () => {
  const keep = (port: number) => {
    mkdirSync(join(scratch, ".config", "herdr-web-ui"), { recursive: true });
    writeFileSync(join(scratch, ".config", "herdr-web-ui", "plugin-port"), `${port}\n`);
  };

  it("reports the port an earlier start fell back to", async () => {
    keep(3);
    expect((await status()).out).toContain("down http://127.0.0.1:3");
  });

  it("lets a PORT the user set win over the kept one", async () => {
    keep(3);
    writeFileSync(join(configDir, ".env"), "PORT=1\n");
    expect((await status()).out).toContain("down http://127.0.0.1:1");
  });

  it("does not start on another port when the PORT the user set cannot be opened, and says so", async () => {
    // holds the port without answering as the app would
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
    try {
      writeFileSync(join(configDir, ".env"), `PORT=${holder.port}\n`);
      const started = await run("start");
      expect(started.exitCode).toBe(1);
      expect(started.err).toContain(`port ${holder.port} on 127.0.0.1 cannot be opened`);
      expect(started.err).toContain(`Set another PORT in ${join(configDir, ".env")}`);
      expect(readFileSync(join(scratch, "state", "server.log"), "utf8")).toContain(`start: port ${holder.port} on 127.0.0.1 cannot be opened`);
      expect(existsSync(join(scratch, "state", "server.pid"))).toBe(false);
      expect(existsSync(join(scratch, ".config", "herdr-web-ui", "plugin-port"))).toBe(false);
    } finally { await holder.stop(true); }
  });

  it("does not take another program's 200 on the port for the app", async () => {
    const stranger = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<html>not us</html>", { headers: { "content-type": "text/html" } }) });
    try {
      writeFileSync(join(configDir, ".env"), `PORT=${stranger.port}\n`);
      const started = await run("start");
      expect(started.out).not.toContain("already running");
      expect(started.exitCode).toBe(1);
      expect(started.err).toContain(`port ${stranger.port} on 127.0.0.1 cannot be opened`);
    } finally { await stranger.stop(true); }
  });

  it("does not take another program's JSON, or the app's shape with a failing status, for the app's bridge health", async () => {
    for (const bridge of [Response.json({ ok: true }), Response.json(BRIDGE_HEALTH, { status: 503 })]) {
      const stranger = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => new URL(request.url).searchParams.get("scope") === "bridge"
          ? bridge.clone()
          : Response.json({ error: { code: "unavailable", message: "not us" } }, { status: 503 }),
      });
      try {
        writeFileSync(join(configDir, ".env"), `PORT=${stranger.port}\n`);
        const started = await run("start");
        expect(started.err).not.toContain("herdr web ui is running");
        expect(started.exitCode).toBe(1);
        expect(started.err).toContain(`port ${stranger.port} on 127.0.0.1 cannot be opened`);
      } finally { await stranger.stop(true); }
    }
  });

  it("does not take another program answering ok on both health URLs for the app", async () => {
    const stranger = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
    try {
      writeFileSync(join(configDir, ".env"), `PORT=${stranger.port}\n`);
      const started = await run("start");
      expect(started.out).not.toContain("already running");
      expect(started.exitCode).toBe(1);
      expect(started.err).toContain(`port ${stranger.port} on 127.0.0.1 cannot be opened`);
    } finally { await stranger.stop(true); }
  });

  it("follows a start that is coming up on another port instead of opening a second server", async () => {
    // the app answers on the port the other start fell back to
    const ours = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(APP_HEALTH) });
    // the kept port is held by someone else; its first health probe is the moment the other start writes its choice
    const stranger = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { keep(ours.port!); return new Response(null, { status: 404 }); } });
    try {
      keep(stranger.port!);
      mkdirSync(join(scratch, "state"), { recursive: true });
      writeFileSync(join(scratch, "state", "server.pid"), `${process.pid}\n`); // the other start's record, alive
      const started = await run("start");
      expect(started.out).toContain(`already running at http://127.0.0.1:${ours.port}`);
      expect(started.exitCode).toBe(0);
      expect(readFileSync(join(scratch, "state", "server.pid"), "utf8")).toBe(`${process.pid}\n`);
      expect(readFileSync(join(scratch, ".config", "herdr-web-ui", "plugin-port"), "utf8")).toBe(`${ours.port}\n`);
    } finally { await Promise.all([ours.stop(true), stranger.stop(true)]); }
  });

  it("keeps the port of its own server that cannot reach herdr instead of moving the app (#428)", async () => {
    // the app answers its bridge health, but the full one fails as it does while herdr is away
    const ours = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => new URL(request.url).searchParams.get("scope") === "bridge"
        ? Response.json(BRIDGE_HEALTH)
        : Response.json({ error: { code: "connect_failed", message: "herdr socket unreachable" } }, { status: 502 }),
    });
    try {
      keep(ours.port!);
      mkdirSync(join(scratch, "state"), { recursive: true });
      writeFileSync(join(scratch, "state", "server.pid"), `${process.pid}\n`); // the start that runs it, alive
      // a start that moves anyway spawns no real server: there is no server/managed.ts under this root
      const started = await run("start", { HERDR_PLUGIN_ROOT: scratch });
      expect(started.out).not.toContain("instead");
      expect(started.exitCode).toBe(1);
      expect(started.err).toContain(`herdr web ui is running at http://127.0.0.1:${ours.port} (pid ${process.pid}) but cannot reach herdr: herdr socket unreachable`);
      expect(readFileSync(join(scratch, ".config", "herdr-web-ui", "plugin-port"), "utf8")).toBe(`${ours.port}\n`);
      expect(readFileSync(join(scratch, "state", "server.pid"), "utf8")).toBe(`${process.pid}\n`);
    } finally { await ours.stop(true); }
  }, 40_000);

  it("reports its own server as running when herdr comes back while start asks why it cannot reach it", async () => {
    // herdr is away through the wait and the check after the bridge probe, and back for the question after that
    let afterBridge = -1;
    const ours = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).searchParams.get("scope") === "bridge") { afterBridge = 0; return Response.json(BRIDGE_HEALTH); }
        if (afterBridge >= 0 && afterBridge++ >= 1) return Response.json(APP_HEALTH);
        return Response.json({ error: { code: "connect_failed", message: "herdr socket unreachable" } }, { status: 502 });
      },
    });
    try {
      keep(ours.port!);
      mkdirSync(join(scratch, "state"), { recursive: true });
      writeFileSync(join(scratch, "state", "server.pid"), `${process.pid}\n`);
      const started = await run("start", { HERDR_PLUGIN_ROOT: scratch });
      expect(started.err).not.toContain("cannot reach herdr");
      expect(started.exitCode).toBe(0);
      expect(started.out).toContain(`herdr web ui already running at http://127.0.0.1:${ours.port}`);
    } finally { await ours.stop(true); }
  }, 40_000);
});

describe("stop", () => {
  /** Ends a process this test started, and what it started, so that a failed assertion cannot leave it running. */
  const killTree = (pid: number): void => {
    if (platform() === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    }
    try { process.kill(-pid, "SIGKILL"); } catch { /* its group is already gone */ }
  };
  /** Whether a pid names a live process: a child is gone at once once it is killed, handle or no handle. */
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  };

  // POSIX only: stop signals the process group, which Windows does not have; the Windows case is below
  it.skipIf(platform() === "win32")("returns only once the server's process group is gone", async () => {
    // a server that takes a second to exit, as the supervisor does while its bridge shuts down
    const server = spawn("sh", ["-c", "trap 'sleep 1; exit 0' TERM; while :; do sleep 0.1; done"], { detached: true, stdio: "ignore" });
    const pid = server.pid!;
    try {
      mkdirSync(join(scratch, "state"));
      writeFileSync(join(scratch, "state", "server.pid"), `${pid}\n`);
      const started = Date.now();
      const stopped = await run("stop");
      expect(stopped.exitCode, stopped.err).toBe(0);
      expect(stopped.out).toContain(`stopped herdr web ui (pid ${pid})`);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(() => process.kill(-pid, 0)).toThrow();
      expect(existsSync(join(scratch, "state", "server.pid"))).toBe(false);
    } finally { killTree(pid); }
  });

  it.skipIf(platform() !== "win32")("stops the recorded server's whole process tree on Windows", async () => {
    // stop ends a recorded pid's tree only once it has verified the pid is this app's server: a bun process
    // whose command line runs <plugin root>/server/managed.ts, so the fixture is one, with a child to be ended too
    const root = join(scratch, "root");
    mkdirSync(join(root, "server"), { recursive: true });
    const managed = join(root, "server", "managed.ts");
    writeFileSync(managed, [
      'import { writeFileSync } from "node:fs";',
      'const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] });',
      "writeFileSync(process.argv[2]!, String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const childPidFile = join(scratch, "child.pid");
    const server = spawn(process.execPath, [managed, childPidFile], { detached: true, stdio: "ignore", windowsHide: true });
    const pid = server.pid!;
    const childPidOf = (): number => (existsSync(childPidFile) ? Number(readFileSync(childPidFile, "utf8")) : 0);
    let childPid = 0;
    try {
      mkdirSync(join(scratch, "state"));
      writeFileSync(join(scratch, "state", "server.pid"), `${pid}\n`);
      for (const deadline = Date.now() + 10_000; childPidOf() <= 0 && Date.now() < deadline;) await Bun.sleep(25);
      childPid = childPidOf();
      expect(childPid).toBeGreaterThan(0);
      expect(alive(childPid)).toBe(true);
      // the config dir is given, so stop does not ask the PC's own herdr for it
      const stopped = await run("stop", { HERDR_PLUGIN_ROOT: root, HERDR_PLUGIN_CONFIG_DIR: configDir });
      expect(stopped.exitCode, stopped.err).toBe(0);
      expect(stopped.out).toContain(`stopped herdr web ui (pid ${pid})`);
      expect(alive(pid)).toBe(false);
      expect(alive(childPid)).toBe(false);
      expect(existsSync(join(scratch, "state", "server.pid"))).toBe(false);
    } finally {
      killTree(pid);
      if (childPid > 0) killTree(childPid);
    }
  }, 40_000);

  // a server that exited while its parent (a plugin host, say) has not reaped it yet
  it.skipIf(platform() !== "linux" || !Bun.which("setsid"))("counts an exited, unreaped server as gone", async () => {
    // the inner shell leads its own group; its parent turns into a sleep that never reaps it
    const parent = spawn("sh", ["-c", `setsid sh -c 'echo $$; exec sleep 0.2' & exec sleep 30`], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const pid = Number(await new Promise<string>((resolve) => parent.stdout!.once("data", (chunk) => resolve(String(chunk).trim()))));
      const state = () => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0];
      const deadline = Date.now() + 5_000;
      while (state() !== "Z" && Date.now() < deadline) await Bun.sleep(20);
      expect(state()).toBe("Z");
      // what `stop` waited on: the zombie's group still answers signal 0
      expect(() => process.kill(-pid, 0)).not.toThrow();
      mkdirSync(join(scratch, "state"));
      writeFileSync(join(scratch, "state", "server.pid"), `${pid}\n`);
      const started = Date.now();
      const stopped = await run("stop");
      expect(stopped.exitCode, stopped.err).toBe(0);
      expect(stopped.out).toContain(`stopped herdr web ui (pid ${pid})`);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(existsSync(join(scratch, "state", "server.pid"))).toBe(false);
    } finally { parent.kill("SIGKILL"); }
  }, 30_000);
});

describe("stop's Windows identity read", () => {
  /** plugin.ts's STOP_TIMEOUT_MS: the retry may use only what is left of it */
  const STOP_TIMEOUT_MS = 15_000;
  const roots: string[] = [];
  let copies = 0;

  afterEach(() => {
    setSystemTime();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function newRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "herdr-plugin-identity-"));
    roots.push(root);
    return root;
  }

  /**
   * A copy of plugin.ts whose paths lie under `root`. It reads them when it loads, and a new query makes Bun load a
   * new copy instead of reusing another test's, so the environment is only needed while it loads.
   */
  async function loadStop(root: string): Promise<typeof stopServer> {
    const names = ["HERDR_PLUGIN_ROOT", "HERDR_PLUGIN_STATE_DIR", "HERDR_PLUGIN_CONFIG_DIR", "HERDR_WEB_STATE_DIR"];
    const saved = names.map((name) => process.env[name]);
    process.env["HERDR_PLUGIN_ROOT"] = root;
    process.env["HERDR_PLUGIN_STATE_DIR"] = join(root, "state");
    process.env["HERDR_PLUGIN_CONFIG_DIR"] = join(root, "config");
    process.env["HERDR_WEB_STATE_DIR"] = join(root, "app");
    try {
      const copy: { stop: typeof stopServer } = await import(`./plugin.ts?identity-copy=${++copies}`);
      return copy.stop;
    } finally {
      names.forEach((name, index) => {
        const value = saved[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  }

  /**
   * stop's Windows branch with fakes: the process table comes from `read`, and a kill is recorded, not sent. The
   * recorded process is this test process, so the fakes must stay: a real kill would end the run.
   */
  async function stopWindows(root: string, read: (call: number, owner: ProcessRow) => ProcessRow[]) {
    const stop = await loadStop(root);
    const state = join(root, "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "server.pid"), `${process.pid}\n`);
    const owner: ProcessRow = {
      pid: process.pid,
      parent: 0,
      path: process.execPath,
      commandLine: `"${process.execPath}" "${join(resolve(root), "server", "managed.ts")}"`,
      started: Date.now() - 60_000,
    };
    const reads: (number | undefined)[] = [];
    const killed: number[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const writeOut = spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    const writeErr = spyOn(process.stderr, "write").mockImplementation((chunk) => { err.push(String(chunk)); return true; });
    try {
      const code = await stop({
        isWindows: true,
        processTable: async (timeoutMs) => {
          reads.push(timeoutMs);
          return read(reads.length, owner);
        },
        isAlive: () => false,
        terminateTree: (pid) => {
          killed.push(pid);
          return { status: 0, error: undefined, stderr: "" };
        },
      });
      return { code, reads, killed, out: out.join(""), err: err.join(""), pidFile: join(state, "server.pid") };
    } finally {
      writeOut.mockRestore();
      writeErr.mockRestore();
    }
  }

  it("retries a read that failed, within the stop timeout, and stops the server the retry finds", async () => {
    const run = await stopWindows(newRoot(), (call, owner) => (call === 1 ? [] : [owner]));
    expect(run.code, run.err).toBe(0);
    expect(run.reads[0]).toBeUndefined();
    // the retry gets what is left of the stop timeout: more than a fresh default read would get
    expect(run.reads[1]).toBeGreaterThan(10_000);
    expect(run.reads[1]).toBeLessThanOrEqual(STOP_TIMEOUT_MS);
    expect(run.killed).toEqual([process.pid]);
    expect(run.out).toContain(`stopped herdr web ui (pid ${process.pid})`);
    expect(existsSync(run.pidFile)).toBe(false);
  });

  it("refuses once the retry also finds no table, and stops nothing", async () => {
    const run = await stopWindows(newRoot(), () => []);
    expect(run.code).toBe(1);
    expect(run.reads).toHaveLength(2);
    expect(run.killed).toEqual([]);
    expect(run.err).toContain("could not verify the recorded herdr web ui process");
    expect(existsSync(run.pidFile)).toBe(true);
  });

  it("does not retry a readable table that lacks the recorded process", async () => {
    const other: ProcessRow = { pid: 1, parent: 0, path: null, commandLine: "other.exe", started: 1 };
    const run = await stopWindows(newRoot(), () => [other]);
    expect(run.code).toBe(1);
    expect(run.reads).toHaveLength(1);
    expect(run.killed).toEqual([]);
    expect(run.err).toContain("could not verify the recorded herdr web ui process");
    expect(existsSync(run.pidFile)).toBe(true);
  });

  it("does not retry once the stop timeout has passed", async () => {
    const run = await stopWindows(newRoot(), () => {
      // the first read takes the whole stop timeout
      setSystemTime(new Date(Date.now() + STOP_TIMEOUT_MS));
      return [];
    });
    expect(run.code).toBe(1);
    expect(run.reads).toHaveLength(1);
    expect(run.killed).toEqual([]);
  });
});
