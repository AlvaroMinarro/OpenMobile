/**
 * Android-keycode → emulator input translation (live-verified on 37.1.11).
 *
 * The WS `key{keycode}` contract carries ANDROID keycodes (the natural space
 * for browser clients). On emulator 37.1.11 the sendKey `keyCode` field with
 * `codeType: Usb` delivers NOTHING into the guest (proto docs promise a
 * chromium-table translation, but zero evdev events arrive — verified live
 * with `getevent -lt`), while `codeType: Evdev` delivers faithfully
 * (KEY_A=30 observed as EV_KEY KEY_A DOWN/UP; KEY_VOLUMEUP=115 opens the
 * volume dialog). So mappable keys ride Evdev.
 *
 * Android keys with NO evdev keyboard-page equivalent (BACK, HOME) ride the
 * emulator's NAMED key events (`KeyboardEvent.key`) — GoBack/GoHome verified
 * live (Settings → launcher). Unmappable keys are a hard actionable error:
 * a silently accepted no-op is worse than an explicit refusal.
 */

/** Android keycode → emulator named key event (live-verified names). */
export const ANDROID_SPECIAL_KEYS: ReadonlyMap<number, string> = new Map([
  [3, "GoHome"],
  [4, "GoBack"],
]);

/**
 * Android keycode → Linux evdev code (linux/input-event-codes.h). Derived
 * from AOSP KeyEvent constants; not a uniform offset (digits are -5, letters
 * are +1), so an explicit table keeps every row auditable.
 */
export const ANDROID_TO_EVDEV: ReadonlyMap<number, number> = new Map([
  // 0-9: AKEYCODE_0=7..9=16 → KEY_0=2..KEY_9=11
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => [7 + d, 2 + d] as const),
  // DPAD
  [19, 103], // DPAD_UP → KEY_UP
  [20, 108], // DPAD_DOWN → KEY_DOWN
  [21, 105], // DPAD_LEFT → KEY_LEFT
  [22, 106], // DPAD_RIGHT → KEY_RIGHT
  // Volume + power (KEY_VOLUMEUP 115 live-verified via the volume dialog)
  [24, 115], // VOLUME_UP → KEY_VOLUMEUP
  [25, 114], // VOLUME_DOWN → KEY_VOLUMEDOWN
  [26, 116], // POWER → KEY_POWER
  // A-Z: AKEYCODE_A=29..Z=54 → KEY_A=30..KEY_Z=55
  ...Array.from({ length: 26 }, (_, i) => [29 + i, 30 + i] as const),
  // Punctuation + modifiers + control keys
  [55, 51], // COMMA → KEY_COMMA
  [56, 52], // PERIOD → KEY_DOT
  [57, 56], // ALT_LEFT → KEY_LEFTALT
  [58, 100], // ALT_RIGHT → KEY_RIGHTALT
  [59, 42], // SHIFT_LEFT → KEY_LEFTSHIFT
  [60, 54], // SHIFT_RIGHT → KEY_RIGHTSHIFT
  [61, 15], // TAB → KEY_TAB
  [62, 57], // SPACE → KEY_SPACE
  [66, 28], // ENTER → KEY_ENTER
  [67, 14], // DEL → KEY_BACKSPACE
  [68, 41], // GRAVE → KEY_GRAVE
  [69, 12], // MINUS → KEY_MINUS
  [70, 13], // EQUALS → KEY_EQUAL
  [73, 43], // BACKSLASH → KEY_BACKSLASH
  [74, 39], // SEMICOLON → KEY_SEMICOLON
  [75, 40], // APOSTROPHE → KEY_APOSTROPHE
  [76, 53], // SLASH → KEY_SLASH
  [82, 139], // MENU → KEY_MENU
  [111, 1], // ESCAPE → KEY_ESC
  [112, 111], // FORWARD_DEL → KEY_DELETE
  [113, 29], // CTRL_LEFT → KEY_LEFTCTRL
  [114, 97], // CTRL_RIGHT → KEY_RIGHTCTRL
  [115, 58], // CAPS_LOCK → KEY_CAPSLOCK
  [164, 113], // VOLUME_MUTE → KEY_MUTE
]);

/** Translate an Android keycode to its evdev code, or null when unmappable. */
export function androidKeycodeToEvdev(code: number): number | null {
  return ANDROID_TO_EVDEV.get(code) ?? null;
}
