/**
 * Colour and marks for what `setup`, `status` and `doctor` print to a person.
 *
 * Off unless stdout is a terminal, so a piped `doctor | grep`, a test's
 * captured output and a CI log stay plain text. `NO_COLOR` (any value) turns
 * it off and `FORCE_COLOR` (anything but `0`) turns it on, the two
 * conventions other CLIs already follow. The marks carry the meaning on their
 * own, so nothing depends on seeing the colour.
 */
export type Tone = "ok" | "warn" | "bad" | "info";

export interface TerminalStyle {
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  cyan(text: string): string;
  /** `✓`, `!`, `✗` or `·`, coloured to match. */
  mark(tone: Tone): string;
  /** Text in the tone's colour, unmarked. */
  tone(tone: Tone, text: string): string;
}

export function colourEnabled(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  if (env.TERM === "dumb") return false;
  return Boolean(stream.isTTY);
}

export function terminalStyle(enabled = colourEnabled()): TerminalStyle {
  const wrap = (open: number, close: number) => (text: string) => (enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text);
  const bold = wrap(1, 22);
  const dim = wrap(2, 22);
  const green = wrap(32, 39);
  const yellow = wrap(33, 39);
  const red = wrap(31, 39);
  const cyan = wrap(36, 39);
  const colour: Record<Tone, (text: string) => string> = { ok: green, warn: yellow, bad: red, info: dim };
  const marks: Record<Tone, string> = { ok: "✓", warn: "!", bad: "✗", info: "·" };
  return {
    enabled,
    bold,
    dim,
    green,
    yellow,
    red,
    cyan,
    mark: (tone) => colour[tone](marks[tone]),
    tone: (tone, text) => colour[tone](text)
  };
}
