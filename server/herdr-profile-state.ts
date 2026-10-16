import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SshTarget } from "../shared/machines.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { type JsonEntries, readJsonEntries, writeFileAtomic } from "./state-file.ts";

/** `retiring`: this binding's key removal was started and has not succeeded yet. */
interface ProfileState { binding: string; approved: boolean; connectionApproved: boolean; snapshot: SessionSnapshot | null; retiring?: true }
/** One entry of herdr-profile-state.json; files from before connection consent have no `connectionApproved`. */
interface SavedProfile extends Omit<ProfileState, "connectionApproved"> { profile_id: string; connectionApproved?: boolean }

/** One entry of the file, or undefined when it is not of that shape or repeats a profile an earlier entry holds. */
function savedProfile(value: unknown, kept: readonly SavedProfile[]): SavedProfile | undefined {
  const item = value as Partial<SavedProfile> | null;
  if (!item || typeof item.profile_id !== "string" || !item.profile_id || kept.some((other) => other.profile_id === item.profile_id)
    || typeof item.binding !== "string" || !/^[a-f0-9]{64}$/.test(item.binding) || typeof item.approved !== "boolean"
    || (item.connectionApproved !== undefined && typeof item.connectionApproved !== "boolean")
    || (item.retiring !== undefined && item.retiring !== true)
    || (item.snapshot !== null && (!item.snapshot || typeof item.snapshot !== "object" || !Array.isArray(item.snapshot.panes)))) return undefined;
  return item as SavedProfile;
}

// Existing routes accept UUID-shaped machine IDs; deriving one keeps browser storage stable.
export function herdrMachineId(profileId: string): string {
  const digest = createHash("sha256").update("herdr-profile:" + profileId).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}
function binding(target: SshTarget | null): string {
  return createHash("sha256").update(JSON.stringify(target ? [target.destination, target.port ?? null, target.session || "default"] : null)).digest("hex");
}

/** Only web-owned state is stored here. A new destination cannot inherit approval or panes. */
export class HerdrProfileState {
  private entries = new Map<string, ProfileState>();
  private dirty = false;
  /** false until the file has been read: nothing is reconciled, approved or written before then */
  private loaded = false;
  private unreadError: string | undefined;
  private path: string;
  /**
   * Set when the file was damaged: moved aside, or an entry of it dropped. The approvals it held are
   * lost, so MachineManager removes the keys of the saved herdr PCs that lost theirs.
   */
  recovered = false;
  /** A damaged file is moved aside and its approvals start over; a damaged entry is dropped alone. */
  constructor(directory: string) {
    this.path = join(directory, "herdr-profile-state.json");
    this.read();
  }
  /** Reads the file if it has not been read yet; false while it cannot be read. */
  ensureLoaded(): boolean {
    if (!this.loaded) this.read();
    return this.loaded;
  }
  /** The profiles whose saved state survived the last read. */
  profileIds(): string[] { return [...this.entries.keys()]; }
  private read(): void {
    const existed = existsSync(this.path);
    let saved: JsonEntries<SavedProfile> | undefined;
    try {
      saved = readJsonEntries(this.path, savedProfile, "profile_id");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.unreadError) console.error(`herdr-profile-state: ${this.path} could not be read; saved herdr PCs wait until it can be (${message})`);
      this.unreadError = message;
      return;
    }
    this.loaded = true;
    this.unreadError = undefined;
    // a file moved aside reads as undefined, as a missing one does: only a file that existed had approvals to lose
    if (existed && saved === undefined) this.recovered = true;
    if (saved && saved.dropped.length > 0) this.recovered = true;
    for (const item of saved?.entries ?? []) {
      this.entries.set(item.profile_id, { binding: item.binding, approved: item.approved, connectionApproved: item.connectionApproved ?? item.approved, snapshot: item.snapshot, ...(item.retiring ? { retiring: true as const } : {}) });
    }
  }
  reconcile(id: string, target: SshTarget | null, retire?: () => void): boolean {
    const next = binding(target);
    const previous = this.entries.get(id);
    // A removal that failed is owed even when the old target comes back: the same binding is not "unchanged" then.
    if (previous?.binding === next && !(previous.retiring && retire)) return false;
    // Keep the old binding, marked, until its credentials are gone, so failures remain retryable.
    if (previous) { this.revoke(id); if (retire) { previous.retiring = true; retire(); } }
    const owed = !retire && previous?.retiring;
    this.entries.set(id, { binding: next, approved: false, connectionApproved: false, snapshot: null, ...(owed ? { retiring: true as const } : {}) }); this.dirty = true;
    return !!previous;
  }
  approved(id: string, target: SshTarget): boolean {
    const entry = this.entries.get(id);
    return entry?.binding === binding(target) && entry.approved;
  }
  connectionApproved(id: string, target: SshTarget): boolean {
    const entry = this.entries.get(id);
    return entry?.binding === binding(target) && entry.connectionApproved;
  }
  allowConnection(id: string, target: SshTarget): void {
    this.reconcile(id, target);
    this.entries.get(id)!.connectionApproved = true; this.dirty = true;
  }
  private revoke(id: string): void {
    const entry = this.entries.get(id)!;
    entry.approved = false; entry.connectionApproved = false; entry.snapshot = null; this.dirty = true;
  }
  approve(id: string, target: SshTarget): void {
    this.reconcile(id, target);
    this.entries.get(id)!.approved = true; this.entries.get(id)!.connectionApproved = true; this.dirty = true;
  }
  snapshot(id: string): SessionSnapshot | null { return this.entries.get(id)?.snapshot ?? null; }
  saveSnapshot(id: string, snapshot: SessionSnapshot | null): void {
    const entry = this.entries.get(id);
    if (entry && entry.snapshot !== snapshot) { entry.snapshot = snapshot; this.dirty = true; }
  }
  prune(ids: Set<string>, retire?: (id: string) => void): string[] {
    const removed: string[] = [];
    const errors: unknown[] = [];
    for (const id of this.entries.keys()) if (!ids.has(id)) {
      this.revoke(id); this.entries.get(id)!.retiring = true;
      try { retire?.(id); this.entries.delete(id); removed.push(id); this.dirty = true; }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Some saved machine keys could not be removed; cleanup will retry");
    return removed;
  }
  flush(): void {
    if (!this.dirty || !this.loaded) return;
    writeFileAtomic(this.path, JSON.stringify([...this.entries].map(([profile_id, state]) => ({ profile_id, ...state }))), { mode: 0o600 });
    this.dirty = false;
  }
}
