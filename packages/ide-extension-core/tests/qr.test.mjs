// Proves the locally-generated QR is a real, scannable QR code — and that the
// pairing secret never reaches the network.
//
// The encode path is verified end to end by decoding with an independent
// library (jsqr), so a broken matrix cannot pass by agreeing with itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import jsQR from "jsqr";

import { qrMatrix, renderQrSvg } from "../out/qr.js";

const PAIRING_URL = "ascenda://pair/9f2c1ab74e0d4c5f8a3b6d1e0c7f4a25";

/** Rasterise the module matrix to RGBA at `scale` px per module, with quiet zone. */
function rasterise(matrix, scale = 4, quiet = 4) {
  const count = matrix.length;
  const size = (count + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255); // white
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!matrix[row][col]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = (col + quiet) * scale + dx;
          const y = (row + quiet) * scale + dy;
          const i = (y * size + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0; // black, alpha stays 255
        }
      }
    }
  }
  return { data, size };
}

test("the generated QR decodes back to the pairing URL", () => {
  const { data, size } = rasterise(qrMatrix(PAIRING_URL));
  const decoded = jsQR(data, size, size);

  assert.ok(decoded, "an independent decoder must find a QR code at all");
  assert.equal(decoded.data, PAIRING_URL, "it must encode exactly the pairing URL");
});

test("the SVG draws one module per dark cell of the verified matrix", () => {
  const matrix = qrMatrix(PAIRING_URL);
  const dark = matrix.flat().filter(Boolean).length;
  const svg = renderQrSvg(PAIRING_URL, matrix);

  assert.equal(svg.match(/M\d+ \d+h1v1h-1z/g)?.length, dark, "SVG and matrix must agree");
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
});

test("the pairing secret never reaches a remote URL", () => {
  const svg = renderQrSvg(PAIRING_URL);

  assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org)/, "no remote origin may appear in the markup");
  assert.doesNotMatch(svg, /qrserver|api\.qrserver\.com/, "the third-party QR service must stay gone");
  // The secret is encoded in the module pattern, never in readable markup.
  assert.doesNotMatch(svg, /9f2c1ab74e0d4c5f8a3b6d1e0c7f4a25/, "the secret must not appear verbatim");
});

test("QR sizing adapts to the data length", () => {
  const short = qrMatrix("ascenda://pair/abc").length;
  const long = qrMatrix(`ascenda://pair/${"a".repeat(200)}`).length;
  assert.ok(long > short, "auto type-number must grow with the payload");
});
