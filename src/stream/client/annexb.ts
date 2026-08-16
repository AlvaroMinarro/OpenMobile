/**
 * Client-side Annex-B access-unit splitter (task 3.1, design D7).
 *
 * The video WS delivers one Annex-B AU per binary message. Message payloads
 * are self-contained segments: a segment begins with a 3/4-byte start code
 * and holds one or more NAL units. A NAL may be split across WS messages
 * (the server re-frames one AU per message — the decoder needs the FULL NAL,
 * so the client concatenates segments).
 *
 * push(chunk)  — feed the next WS message payload (or any raw bytes).
 * drain()      — emit every NAL COMPLETE at the current scan point.
 * drain(true)  — segment end: an incomplete NAL is emitted too.
 */
export type NalType = "sps" | "pps" | "idr" | "slice" | "unknown";

/** Classify a complete NAL payload (bytes AFTER the start code). */
export function classifyNal(nal: Uint8Array): NalType {
  const h = nal[0];
  // forbidden_zero_bit must be 0; nal_unit_type is the low 5 bits. A corrupt
  // header or an empty NAL falls back to "slice" (harmless to the decoder).
  if (h === undefined || (h & 0x80) !== 0) return "slice";
  const type = h & 0x1f;
  if (type === 7) return "sps";
  if (type === 8) return "pps";
  if (type === 5) return "idr";
  return "slice";
}

/** Append-only byte accumulation with preserve-()-semantics emission. */
export class AnnexBSplitter {
  /** Bytes accumulated since the last emission. */
  private pending: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): void {
    if (this.pending.length === 0) {
      this.pending = chunk;
      return;
    }
    const next = new Uint8Array(this.pending.length + chunk.length);
    next.set(this.pending, 0);
    next.set(chunk, this.pending.length);
    this.pending = next;
  }

  /**
   * Emit NALs that are complete at the current scan position.
   * @param segmentEnd true when this is the last chunk of a message: an
   *   incomplete trailing NAL is then emitted as-is (it IS the message).
   */
  drain(segmentEnd = false): Uint8Array[] {
    const out: Uint8Array[] = [];
    const n = this.pending.length;
    let cursor = 0;
    // Scan for start-code candidates: 4-byte (00 00 00 01) or 3-byte (00 00 01).
    // A NAL's trailing zero bytes that merge into the next code are absorbed
    // (Annex-B) — never emitted as a phantom NAL. `cursor` tracks the first
    // byte not yet assigned to an emitted NAL.
    let i = 0;
    while (i + 2 < n && cursor < n) {
      const a = this.pending[i]!;
      const b = this.pending[i + 1]!;
      const c = this.pending[i + 2]!;
      if (a === 0 && b === 0 && c === 1) {
        const codeLen = i > 0 && this.pending[i - 1] === 0 ? 4 : 3;
        const codeStart = i + 3 - codeLen;
        // NAL payload between cursor (first un-emitted NAL byte) and the code.
        // NOTE: copy (slice), not subarray — the pending buffer is compacted
        // below and an emitted NAL would be corrupted by later compaction.
        if (cursor < codeStart) {
          out.push(this.pending.slice(cursor, codeStart));
        }
        cursor = codeStart + codeLen;
        i = cursor;
        continue;
      }
      i++;
    }
    // Preserve the un-emitted tail (may contain a partial code/NAL): COPY it
    // so it survives the compaction below.
    const tail = this.pending.slice(cursor);
    if (segmentEnd) {
      // Message boundary: the remaining tail is the final NAL (even if
      // technically incomplete) — it IS this message's AU.
      if (cursor < n) out.push(tail);
      this.pending = new Uint8Array(0);
      return out;
    }
    this.pending = tail;
    return out;
  }
}