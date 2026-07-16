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
  const height = SNAPSHOT_IMAGE_HEIGHT;

  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, width, height);

  const cardX = CARD_PAD;
  const cardY = CARD_PAD;
  const cardWidth = width - CARD_PAD * 2;
  const cardHeight = height - CARD_PAD * 2;
  ctx.fillStyle = PALETTE.surface;
  roundedRect(ctx, cardX, cardY, cardWidth, cardHeight, 24);
  ctx.fill();

  const innerX = cardX + 48;
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

  const earned = snapshot.achievements;
  if (earned.length > 0) {
    ctx.fillStyle = PALETTE.muted;
    ctx.font = "600 16px system-ui, sans-serif";
    ctx.fillText("ACHIEVEMENTS", innerX, y);
    y += 32;

    let pillX = innerX;
    const pillHeight = 36;
    const pillGap = 10;
    ctx.font = "600 16px system-ui, sans-serif";
    for (const name of earned) {
      const label = `★ ${name}`;
      const textWidth = ctx.measureText(label).width;
      const pillWidth = textWidth + 32;
      if (pillX + pillWidth > cardX + cardWidth - 48) break;

      ctx.fillStyle = PALETTE.accentSoft;
      roundedRect(ctx, pillX, y, pillWidth, pillHeight, pillHeight / 2);
      ctx.fill();

      ctx.fillStyle = PALETTE.accentInk;
      ctx.fillText(label, pillX + 16, y + 24);

      pillX += pillWidth + pillGap;
    }
    y += pillHeight + 24;
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
export function renderSnapshotCanvas(snapshot: AnalyticsSnapshot): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SNAPSHOT_IMAGE_WIDTH;
  canvas.height = SNAPSHOT_IMAGE_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("Canvas 2D rendering is not available in this browser");
  }
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
