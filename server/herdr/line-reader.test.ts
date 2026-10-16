import { describe, expect, it } from "bun:test";
import { makeLineReader } from "./client.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The lines a reader emits for `chunks`, in order. */
function linesOf(chunks: Uint8Array[]): string[] {
  const lines: string[] = [];
  const feed = makeLineReader((line) => lines.push(line));
  for (const chunk of chunks) feed(chunk);
  return lines;
}

describe("herdr reply line reader", () => {
  it("emits each newline-terminated line once and keeps a partial tail until its newline comes", () => {
    const text = "{\"id\":1}\n{\"id\":2}\n{\"id\":3}";
    expect(linesOf([bytes(text.slice(0, 5)), bytes(text.slice(5, 12)), bytes(text.slice(12))])).toEqual(["{\"id\":1}", "{\"id\":2}"]);
    expect(linesOf([bytes(text), bytes("\n")])).toEqual(["{\"id\":1}", "{\"id\":2}", "{\"id\":3}"]);
  });

  it("joins a multi-byte character split across reads, and trims CRLF and blank lines", () => {
    const line = "{\"text\":\"중국어 🙂\"}";
    const encoded = bytes(`${line}\r\n\r\n`);
    // byte 10 is inside the first multi-byte character, which spans bytes 9 to 11
    expect(linesOf([encoded.subarray(0, 10), encoded.subarray(10)])).toEqual([line]);
  });

  it("returns a long answer that arrives in many small reads whole", () => {
    const line = "x".repeat(4 * 1024 * 1024);
    const encoded = bytes(`${line}\n`);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < encoded.length; offset += 64 * 1024) chunks.push(encoded.subarray(offset, offset + 64 * 1024));
    const lines = linesOf(chunks);
    expect(lines.length).toBe(1);
    expect(lines[0] === line).toBe(true);
  });
});
