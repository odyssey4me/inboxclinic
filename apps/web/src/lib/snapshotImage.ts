// SPDX-License-Identifier: Apache-2.0
import { timeSavedMinutes, type AnalyticsSnapshot } from "@inboxclinic/core";

/**
 * Render the privacy-safe analytics snapshot as a shareable PNG image — the primary
 * share form for the opt-in snapshot (design-analytics.md, Decision 5). Rendering is
 * on-device (canvas 2D, no network); the image carries only the aggregate numbers
 * already stripped of identifiers by `buildSnapshot`.
 */

export const SNAPSHOT_IMAGE_WIDTH = 1000;
export const SNAPSHOT_IMAGE_HEIGHT = 620;

/** Light "Vitals" palette tokens (index.css), fixed so a shared image reads the same
 * regardless of the viewer's device theme. */
const PALETTE = {
  bg: "#f8fafa",
  surface: "#ffffff",
  ink: "#0f172a",
  muted: "#5c6b78",
  line: "#e5edef",
  accentSoft: "#d6f4ef",
  accentInk: "#0a5f57",
};

const CARD_PAD = 48;

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.arcTo(x + width, y, x + width, y + radius, radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius);
  ctx.lineTo(x + radius, y + height);
  ctx.arcTo(x, y + height, x, y + height - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

const PILL_HEIGHT = 36;
const PILL_GAP = 10;
const PILL_ROW_GAP = 12;
/** Usable width for a row of achievement pills, inside the card's left/right insets. */
const PILL_MAX_WIDTH = SNAPSHOT_IMAGE_WIDTH - CARD_PAD * 2 - 96;

interface Pill {
  label: string;
  width: number;
}

/**
 * Lay earned-achievement pills into rows that each fit `PILL_MAX_WIDTH`, so a power user
 * with many badges wraps onto extra rows instead of silently dropping the overflow (there
 * are up to 6 — design-analytics.md Decision 4). Pure aside from `ctx.measureText`.
 */
function achievementRows(ctx: CanvasRenderingContext2D, names: readonly string[]): Pill[][] {
  ctx.font = "600 16px system-ui, sans-serif";
  const rows: Pill[][] = [];
  let row: Pill[] = [];
  let x = 0;
  for (const name of names) {
    const label = `★ ${name}`;
    const width = ctx.measureText(label).width + 32;
    const advance = (row.length > 0 ? PILL_GAP : 0) + width;
    if (row.length > 0 && x + advance > PILL_MAX_WIDTH) {
      rows.push(row);
      row = [];
      x = 0;
    }
    row.push({ label, width });
    x += (row.length > 1 ? PILL_GAP : 0) + width;
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/** Canvas height for `rowCount` pill rows — grows by a row-height for each extra line. */
function heightForRows(rowCount: number): number {
  return SNAPSHOT_IMAGE_HEIGHT + Math.max(0, rowCount - 1) * (PILL_HEIGHT + PILL_ROW_GAP);
}

interface Stat {
  label: string;
  value: string;
}

function snapshotStats(snapshot: AnalyticsSnapshot): Stat[] {
  return [
    { label: "Senders blocked", value: String(snapshot.blockedSenders) },
    { label: "Senders trusted", value: String(snapshot.trustedSenders) },
    { label: "Emails blocked", value: String(snapshot.emailsBlocked) },
    {
      label: "Time saved (min)",
      value: String(timeSavedMinutes(snapshot.estimatedTimeSavedSeconds)),
    },
  ];
}

/**
 * Draw the snapshot onto a 2D context (pure aside from the canvas API calls — no
 * network, no DOM lookups beyond the context passed in). Exported separately from
 * canvas creation so it can be exercised against a mock context in tests.
 */
export function drawSnapshot(ctx: CanvasRenderingContext2D, snapshot: AnalyticsSnapshot): void {
  const width = SNAPSHOT_IMAGE_WIDTH;
  const cardX = CARD_PAD;
  const cardY = CARD_PAD;
  const cardWidth = width - CARD_PAD * 2;
  const innerX = cardX + 48;

  // Wrap achievement pills across rows and grow the canvas so none are silently dropped;
  // the footer is bottom-anchored, so the row→footer gap stays constant as height grows.
  const rows = achievementRows(ctx, snapshot.achievements);
  const height = heightForRows(rows.length);
  const cardHeight = height - CARD_PAD * 2;

  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = PALETTE.surface;
  roundedRect(ctx, cardX, cardY, cardWidth, cardHeight, 24);
  ctx.fill();

  let y = cardY + 72;

  ctx.fillStyle = PALETTE.muted;
  ctx.font = "600 20px system-ui, sans-serif";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("INBOX CLINIC", innerX, y);

  y += 56;
  ctx.fillStyle = PALETTE.ink;
  ctx.font = "700 40px system-ui, sans-serif";
  ctx.fillText("My inbox at a glance", innerX, y);

  y += 80;
  ctx.fillStyle = PALETTE.accentInk;
  ctx.font = "700 88px system-ui, sans-serif";
  ctx.fillText(String(snapshot.inboxHealthScore), innerX, y);
  const scoreWidth = ctx.measureText(String(snapshot.inboxHealthScore)).width;
  ctx.fillStyle = PALETTE.muted;
  ctx.font = "400 28px system-ui, sans-serif";
  ctx.fillText("/ 100 inbox health", innerX + scoreWidth + 16, y);

  y += 56;
  const stats = snapshotStats(snapshot);
  const columns = 2;
  const gridWidth = cardWidth - 96;
  const colWidth = gridWidth / columns;
  const rowHeight = 76;
  stats.forEach((stat, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = innerX + col * colWidth;
    const statY = y + row * rowHeight;

    ctx.fillStyle = PALETTE.ink;
    ctx.font = "700 30px system-ui, sans-serif";
    ctx.fillText(stat.value, x, statY);

    ctx.fillStyle = PALETTE.muted;
    ctx.font = "400 16px system-ui, sans-serif";
    ctx.fillText(stat.label, x, statY + 24);
  });
  y += Math.ceil(stats.length / columns) * rowHeight + 24;

  if (rows.length > 0) {
    ctx.fillStyle = PALETTE.muted;
    ctx.font = "600 16px system-ui, sans-serif";
    ctx.fillText("ACHIEVEMENTS", innerX, y);
    y += 32;

    for (const row of rows) {
      let pillX = innerX;
      for (const { label, width: pillWidth } of row) {
        ctx.fillStyle = PALETTE.accentSoft;
        roundedRect(ctx, pillX, y, pillWidth, PILL_HEIGHT, PILL_HEIGHT / 2);
        ctx.fill();

        ctx.fillStyle = PALETTE.accentInk;
        ctx.font = "600 16px system-ui, sans-serif";
        ctx.fillText(label, pillX + 16, y + 24);

        pillX += pillWidth + PILL_GAP;
      }
      y += PILL_HEIGHT + PILL_ROW_GAP;
    }
  }

  ctx.fillStyle = PALETTE.line;
  ctx.fillRect(innerX, cardY + cardHeight - 64, cardWidth - 96, 1);

  ctx.fillStyle = PALETTE.muted;
  ctx.font = "400 14px system-ui, sans-serif";
  ctx.fillText(
    "Generated on-device — aggregate numbers only, no senders or addresses.",
    innerX,
    cardY + cardHeight - 32,
  );
}

/**
 * Render the snapshot onto a fresh canvas element. Throws if a 2D context isn't
 * available (no `canvas` support) so callers can present a graceful fallback.
 */
function renderSnapshotCanvas(snapshot: AnalyticsSnapshot): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("Canvas 2D rendering is not available in this browser");
  }
  // Size to the wrapped-pill layout before drawing (drawSnapshot recomputes the same rows).
  canvas.width = SNAPSHOT_IMAGE_WIDTH;
  canvas.height = heightForRows(achievementRows(ctx, snapshot.achievements).length);
  drawSnapshot(ctx, snapshot);
  return canvas;
}

/** Render the snapshot and encode it as a PNG `Blob` (on-device, no network). */
export async function snapshotPngBlob(snapshot: AnalyticsSnapshot): Promise<Blob> {
  const canvas = renderSnapshotCanvas(snapshot);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("Failed to encode the snapshot image"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}
