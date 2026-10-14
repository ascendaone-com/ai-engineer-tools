import * as os from "os";

/**
 * The operating system this collector runs on, as every event it sends
 * reports it in `metadata.collectorPlatform`, beside `collectorVersion`.
 *
 * It exists so the service can tell which systems its installs run on before
 * deciding where to build next. A closed, coarse vocabulary: no version, no
 * architecture, no machine name, nothing that narrows one install down.
 *
 * `wsl` is split from `linux` on purpose. A person running an agent inside
 * WSL is on a Windows machine, and counting them as Linux would hide exactly
 * the people a Windows build is for.
 */
export type CollectorPlatform = "darwin" | "win32" | "linux" | "wsl" | "other";

export type PlatformProbe = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The kernel release string, as `os.release()` returns it. */
  release?: string;
};

export function detectCollectorPlatform(probe: PlatformProbe = {}): CollectorPlatform {
  const platform = probe.platform ?? process.platform;
  switch (platform) {
    case "darwin":
    case "win32":
      return platform;
    case "linux": {
      const env = probe.env ?? process.env;
      // WSL sets WSL_DISTRO_NAME (and WSL_INTEROP on WSL 2) for every
      // process it starts. The kernel release names Microsoft on both WSL 1
      // and 2, which covers a process started with a scrubbed environment.
      if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return "wsl";
      const release = probe.release ?? safeRelease();
      return /microsoft/i.test(release) ? "wsl" : "linux";
    }
    default:
      return "other";
  }
}

function safeRelease(): string {
  try {
    return os.release();
  } catch {
    return "";
  }
}

/** Read once per process: the answer cannot change while a hook runs. */
export const COLLECTOR_PLATFORM: CollectorPlatform = detectCollectorPlatform();
