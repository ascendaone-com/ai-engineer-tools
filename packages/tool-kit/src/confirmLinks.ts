/**
 * Where a person confirms a pairing or a study join. Both can be confirmed
 * on a web page that signs them in, so someone without the Ascenda app can
 * finish from a browser; the app takes the same 6-digit code.
 *
 * Only an https link is printed. A backend without the web pages hands out
 * the `ascenda://pair` scheme instead, and the local dev server serves no
 * pages at all, so either one falls back to naming the app.
 */

/** `qrUrl` when it's a web page a browser can open, otherwise `undefined`. */
export function pairingConfirmUrl(qrUrl: string | undefined | null): string | undefined {
  return isHttps(qrUrl) ? qrUrl : undefined;
}

/**
 * The lines `setup` and `pair` print while they wait. The pairing secret
 * rides in the link's fragment, which a browser never sends to a server; it
 * is never printed on its own.
 */
export function pairingConfirmLines(qrUrl: string | undefined | null, code: string): string[] {
  const url = pairingConfirmUrl(qrUrl);
  if (!url) return [`Confirm in the Ascenda app — code ${code}`];
  return [`Open this link to confirm: ${url}`, `Or paste code ${code} in the Ascenda app.`];
}

/** `{apiBaseUrl}/join/{deviceCode}`, or `undefined` when the base isn't https. */
export function studyJoinConfirmUrl(apiBaseUrl: string, deviceCode: string): string | undefined {
  if (!isHttps(apiBaseUrl)) return undefined;
  return `${apiBaseUrl.replace(/\/+$/, "")}/join/${encodeURIComponent(deviceCode)}`;
}

function isHttps(value: string | undefined | null): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
