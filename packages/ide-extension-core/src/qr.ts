// Local QR rendering.
//
// The pairing QR encodes the backend's own `qrUrl` — either the legacy
// `ascenda://pair?session=<id>&secret=<secret>` scheme, or (once
// the backend's pairing-web base URL is configured) an https link of
// the form `<BaseUrl>/p/<sessionId>#<secret>`. Either way the pairing
// secret is what claims the pairing, so it must never leave the machine —
// this used to be built by handing the URL to a third-party image service,
// which put the secret in someone else's access logs. Everything here is
// computed in-process and inlined into the webview as SVG markup, so the
// panel makes no network request at all.

import qrcode from "qrcode-generator";

/** Dark-module matrix, row-major. Exposed so tests can decode it directly. */
export function qrMatrix(data: string): boolean[][] {
  // Type 0 auto-sizes to the data; level M tolerates ~15% occlusion, which is
  // the usual trade-off for a screen-displayed code.
  const qr = qrcode(0, "M");
  qr.addData(data);
  qr.make();
  const count = qr.getModuleCount();
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, col) => qr.isDark(row, col)),
  );
}

/**
 * Renders the matrix as a standalone SVG element. One path segment per dark
 * module keeps the markup compact; `shape-rendering: crispEdges` stops the
 * renderer antialiasing module edges into an unscannable blur.
 */
export function renderQrSvg(data: string, matrix = qrMatrix(data)): string {
  const count = matrix.length;
  const quiet = 4; // QR spec requires a 4-module quiet zone to be scannable.
  const size = count + quiet * 2;

  let path = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (matrix[row][col]) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }

  return (
    `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="Ascenda pairing QR code">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/>` +
    `</svg>`
  );
}
