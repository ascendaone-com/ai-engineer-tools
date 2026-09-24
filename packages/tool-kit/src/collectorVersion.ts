/**
 * The release this collector was built from, as every event it sends reports
 * it in `metadata.collectorVersion`.
 *
 * A collector that predates an event type sends nothing for it, and a reader
 * summing that absence gets a zero indistinguishable from a real one. The
 * version on each event is what lets a reader tell "nothing happened" from
 * "this build could not see it".
 *
 * Filled at bundle time. `scripts/esbuild-collector.mjs` wraps every shipped
 * bundle and defines `__ASCENDA_COLLECTOR_VERSION__` from the release tag, so
 * the value is fixed inside the artifact a person installs. Anything else, a
 * repo build with no tag or this package's own tests running `out/` directly,
 * reports {@link UNRELEASED_COLLECTOR_VERSION}. Never the placeholder version
 * an unstamped `package.json` carries, which names a release this build isn't,
 * and never empty, which a reader would group with "not sent".
 */

/** What a build carries when no release tag was defined into it. */
export const UNRELEASED_COLLECTOR_VERSION = "unreleased";

declare const __ASCENDA_COLLECTOR_VERSION__: string | undefined;

export const COLLECTOR_VERSION: string =
  typeof __ASCENDA_COLLECTOR_VERSION__ === "string" && __ASCENDA_COLLECTOR_VERSION__
    ? __ASCENDA_COLLECTOR_VERSION__
    : UNRELEASED_COLLECTOR_VERSION;

/** The `version` line `status` prints, value only. */
export function describeCollectorVersion(version: string = COLLECTOR_VERSION): string {
  return version === UNRELEASED_COLLECTOR_VERSION ? `${version} (built from a checkout, not a release)` : version;
}
