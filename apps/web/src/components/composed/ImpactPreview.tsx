// SPDX-License-Identifier: Apache-2.0
import type { SimulatedImpact } from "@inboxclinic/core";

import { Card } from "../ui/Card";

/**
 * Read-only impact of applying (or changing) decisions — the counts from
 * `simulateEnforcement`, a loud delete warning, and an optional extrapolated
 * going-forward volume. Shared by the workflow's Review and the Decisions view.
 */
export function ImpactPreview({
  impact,
  weeklyVolume = 0,
}: {
  impact: SimulatedImpact | null;
  weeklyVolume?: number;
}) {
  if (impact === null) {
    return <p className="text-sm text-muted">Checking impact…</p>;
  }

  const lines: string[] = [];
  if (impact.filtersToCreate > 0) {
    lines.push(
      `Create ${impact.filtersToCreate} filter${impact.filtersToCreate === 1 ? "" : "s"} to auto-handle future mail`,
    );
  }
  if (impact.filtersToDelete > 0) {
    lines.push(`Remove ${impact.filtersToDelete} filter${impact.filtersToDelete === 1 ? "" : "s"}`);
  }
  if (impact.messagesToArchive > 0) {
    lines.push(
      `Archive ${impact.messagesToArchive} existing email${impact.messagesToArchive === 1 ? "" : "s"}`,
    );
  }
  if (impact.messagesToRescue > 0) {
    lines.push(
      `Restore ${impact.messagesToRescue} email${impact.messagesToRescue === 1 ? "" : "s"} from Spam/Trash`,
    );
  }

  return (
    <Card aria-label="Impact preview" className="space-y-2 text-sm">
      <p className="font-medium text-ink">When you apply</p>
      {lines.length > 0 ? (
        <ul className="ml-4 list-disc space-y-1 text-muted">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">Records your decision on-device; no Gmail changes needed.</p>
      )}
      {impact.messagesToDelete > 0 && (
        <p className="rounded-md bg-block/10 px-3 py-2 text-block">
          <strong className="font-semibold">
            Deletes {impact.messagesToDelete} existing email
            {impact.messagesToDelete === 1 ? "" : "s"}
          </strong>{" "}
          — moved to Trash, recoverable for ~30 days.
        </p>
      )}
      {weeklyVolume > 0 && (
        <p className="text-muted">
          Going forward: ~{weeklyVolume} email{weeklyVolume === 1 ? "" : "s"}/week auto-handled.
        </p>
      )}
    </Card>
  );
}
