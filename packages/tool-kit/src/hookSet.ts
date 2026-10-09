/**
 * Which set of hooks an install registered, carried on the command line of
 * every hook it registered.
 *
 * Registration is a snapshot. `setup` writes a list of events into the
 * agent's settings file (or the plugin ships one in `hooks.json`), and
 * nothing updates that list when a later release adds an event. Claude Code
 * installs from before `StopFailure` was registered never send `halted` for
 * an API error, and Gemini installs from before `Notification` never send
 * `awaiting`. The hook binary can't see what else is registered, and the
 * desktop app can't read the agent's settings file, so the registration
 * says it out loud: each command ends `--hook-set <n>`, the hook copies
 * `<n>` onto its live signal, and the app compares it with the newest set
 * it knows for that tool.
 *
 * A command with no flag is set 1: everything registered before this
 * existed. Old binaries ignore the trailing argument, so a new registration
 * never breaks an old hook, and an old registration still runs a new one.
 *
 * Bump an adapter's set whenever its list of registered events changes, in
 * the same commit, and the app's `kCurrentHookSets` with it.
 */

/** The flag a registered hook command carries its set on. */
export const HOOK_SET_FLAG = "--hook-set";

/** What an unflagged registration is: anything from before hook sets existed. */
export const UNVERSIONED_HOOK_SET = 1;

/** `--hook-set <n>` for a registered command, or nothing for an adapter without a set. */
export function hookSetArgument(hookSet: number | undefined): string {
  return hookSet === undefined ? "" : ` ${HOOK_SET_FLAG} ${hookSet}`;
}

/**
 * The set named on argv, or undefined when the registration names none.
 *
 * Undefined is not "set 1" on the wire: the signal leaves the field out, and
 * the app reads its absence as set 1 for the tools that have a set. A bad
 * value is treated as absent, never guessed at.
 */
export function readHookSet(argv: readonly string[]): number | undefined {
  const index = argv.indexOf(HOOK_SET_FLAG);
  if (index === -1) return undefined;
  // Digits only: `Number` would also take " 2", "0x2" and "1e0".
  const raw = argv[index + 1];
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return undefined;
  const value = Number(raw);
  return isHookSet(value) ? value : undefined;
}

/** A value `hookSet` may carry on the wire (P-D64.3): a positive integer. */
export function isHookSet(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * `true` when Claude Code ran this hook from its plugin, else undefined.
 *
 * P-D64.3 clause 2: derived only from `CLAUDE_PLUGIN_ROOT` being set, which
 * Claude Code does for plugin hooks alone, and never from what the path
 * says. An empty value isn't a plugin root. Never `false`: a `setup`
 * install leaves the field out.
 */
export function readViaPlugin(env: NodeJS.ProcessEnv): true | undefined {
  return env.CLAUDE_PLUGIN_ROOT ? true : undefined;
}

/** The set a registered command string carries, with an unflagged command read as set 1. */
export function hookSetOfCommand(command: string): number {
  const match = command.match(/--hook-set\s+(\d+)/);
  return match ? Number(match[1]) : UNVERSIONED_HOOK_SET;
}

/** What one `setup` run changed in the registration, for the summary it prints. */
export type HookSetChanges = {
  /** Events that had none of our hooks before this run. */
  added: string[];
  /** The lowest set among the hooks that were already there, when any were. */
  previousSet?: number;
};

/**
 * Compares the registration before a write with the events about to be
 * registered. `before` maps each event that already had one of our hooks to
 * the set its command carried.
 */
export function hookSetChanges(before: ReadonlyMap<string, number>, events: readonly string[]): HookSetChanges {
  const added = events.filter((event) => !before.has(event));
  const sets = [...before.values()];
  return sets.length ? { added, previousSet: Math.min(...sets) } : { added };
}

/**
 * One line for `setup`'s summary when it upgraded an install: the events it
 * added and the set it moved from. Undefined on a first install, where
 * everything is new, and on a re-run that changed nothing.
 */
export function describeHookSetChanges(changes: HookSetChanges, hookSet: number): string | undefined {
  if (changes.previousSet === undefined) return undefined;
  const parts: string[] = [];
  if (changes.added.length) parts.push(`added ${changes.added.join(", ")}`);
  if (changes.previousSet < hookSet) parts.push(`hook set ${changes.previousSet} → ${hookSet}`);
  return parts.length ? `upgraded: ${parts.join("; ")}` : undefined;
}
