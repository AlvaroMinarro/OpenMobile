/**
 * Input-channel helpers: escaping text for `adb shell input text` and rejecting
 * characters adb cannot inject rather than silently corrupting them.
 */

/** Error raised when text cannot be injected through the adb input channel. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

const IMPERMISSIBLE = new Set(["\u0000", "\n", "\r", "\t", "\u001b", "\u007f"]);

/** Escape text for adb: spaces become %s, and validate injectable characters. */
export function escapeForAdb(text: string): string {
  for (const ch of text) {
    if (IMPERMISSIBLE.has(ch) || ch.codePointAt(0)! > 0xffff) {
      throw new InputError(
        `input_text cannot inject character U+${ch.codePointAt(0)!.toString(16).toUpperCase()} (${JSON.stringify(ch)}); adb 'input text' only supports basic ASCII/space via %s`,
      );
    }
  }
  return text.replace(/ /g, "%s");
}
