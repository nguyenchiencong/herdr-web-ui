import { join } from "node:path";
import { MAX_PREFERENCES_BYTES, sharedPreferencesBody, type PreferencesChange, type SharedPreferences } from "../shared/preferences.ts";
import { badRequest, isJsonObject, jsonResponse } from "./http.ts";
import { readJsonState, writeFileAtomic } from "./state-file.ts";

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** The document a file holds, or undefined when it holds none. */
function savedPreferences(value: unknown): SharedPreferences | undefined {
  const body = sharedPreferencesBody(value);
  if (body === null) return undefined;
  const revision = isJsonObject(value) && Number.isSafeInteger(value["revision"]) ? value["revision"] as number : 0;
  return { revision: Math.max(0, revision), settings: body.settings, ...(body.pins === undefined ? {} : { pins: body.pins }) };
}

/** The document a change would make is over MAX_PREFERENCES_BYTES; nothing was kept. */
export class PreferencesTooLarge extends Error {
  constructor() { super(`Shared preferences are at most ${MAX_PREFERENCES_BYTES / 1024} KB`); }
}

/**
 * The preferences every browser of this server shares (shared/preferences.ts), kept in the state
 * directory beside devices.json. One document: a browser sends the settings it changed (and the
 * pins when they changed), laid over what is held, last write wins per setting; the others take
 * the whole document from the event. A change is held, and told, only once it is on disk.
 */
export class PreferenceStore {
  private current: SharedPreferences = { revision: 0, settings: {} };
  private readonly path: string;
  private readonly listeners = new Set<(preferences: SharedPreferences) => void>();
  /** false until the file has been read: a change is refused, not kept over a document this run never read */
  private loaded = false;

  constructor(stateDir: string) {
    this.path = join(stateDir, "preferences.json");
    try {
      this.load();
    } catch (error) {
      // the server starts without the shared document; a change reads the file again before it is written
      console.error(`preferences: ${this.path} could not be read; shared preferences start empty until it can be (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /** A missing file is a server that has shared nothing yet; a damaged one is moved aside and starts empty. */
  private load(): void {
    this.current = readJsonState(this.path, savedPreferences) ?? this.current;
    this.loaded = true;
  }

  get(): SharedPreferences { return this.current; }

  set(change: PreferencesChange): SharedPreferences {
    if (!this.loaded) this.load();
    const pins = change.pins ?? this.current.pins;
    const next: SharedPreferences = { revision: this.current.revision + 1, settings: { ...this.current.settings, ...change.settings }, ...(pins === undefined ? {} : { pins }) };
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (byteLength(JSON.stringify(next)) > MAX_PREFERENCES_BYTES) throw new PreferencesTooLarge();
    writeFileAtomic(this.path, text, { mode: 0o600 });
    this.current = next;
    for (const listener of [...this.listeners]) listener(this.current);
    return this.current;
  }

  subscribe(listener: (preferences: SharedPreferences) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** /api/preferences: GET the shared document, PUT a change to it. A watching device's PUT is refused before this (index.ts). */
export async function handlePreferencesRequest(request: Request, store: PreferenceStore): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const tooLarge = () => reply({ error: { code: "too_large", message: new PreferencesTooLarge().message } }, 413);
  if (request.method === "GET") return reply(store.get());
  if (request.method !== "PUT") return reply({ error: { code: "method_not_allowed", message: "Use GET or PUT /api/preferences" } }, 405);
  // a body announced over the limit is refused unread; one that lies about its length is measured
  const announced = Number(request.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_PREFERENCES_BYTES) return tooLarge();
  const text = await request.text();
  if (byteLength(text) > MAX_PREFERENCES_BYTES) return tooLarge();
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return badRequest("invalid_json", "The body is not JSON"); }
  const body = sharedPreferencesBody(raw);
  if (body === null) return badRequest("invalid_body", "Send { settings: object, pins?: string[] }");
  try { return reply(store.set(body)); }
  catch (error) {
    if (error instanceof PreferencesTooLarge) return tooLarge();
    return reply({ error: { code: "preferences_unwritable", message: error instanceof Error ? error.message : String(error) } }, 500);
  }
}
