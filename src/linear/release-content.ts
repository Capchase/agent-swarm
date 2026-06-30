export const RELEASE_CONTENT_LABEL_ID = "5724e83e-1a72-4d43-ae4b-df680948bb77";
export const RELEASE_CONTENT_LABEL_NAME = "release-content";
export const RELEASE_CONTENT_TRIGGER_STATE = "Done";

export interface ReleaseContentTriggerMeta {
  /** Where the trigger originated. */
  source: "slack" | "linear-webhook";
  /** Linear issue UUID (the `id` field, not the human-readable identifier). */
  linearTicketId: string;
  /** Human-readable identifier, e.g. "TRI-7032". Optional — not available from slash command. */
  linearTicketIdentifier?: string;
  linearTicketTitle?: string;
  linearTicketUrl?: string;
  /** Linear-Delivery header value, for tracing. Only present for webhook triggers. */
  deliveryId?: string;
}

/**
 * Shared entrypoint reached by both the /release-content slash command and the
 * label-gated Linear webhook.  Currently a stub — downstream content generation
 * is implemented in TRI-7033+.
 */
export function handleReleaseContentTrigger(meta: ReleaseContentTriggerMeta): void {
  const id = meta.linearTicketIdentifier ?? meta.linearTicketId;
  const parts = [
    `[ReleaseContent] Trigger — source=${meta.source}`,
    `ticket=${id}`,
    meta.deliveryId ? `delivery=${meta.deliveryId}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  console.log(parts);
  // Stub: content generation to be implemented in TRI-7033+
}

function hasReleaseContentLabel(data: Record<string, unknown>): boolean {
  // Primary: labelIds array (flat array of UUID strings)
  const labelIds = data.labelIds;
  if (Array.isArray(labelIds)) {
    return labelIds.includes(RELEASE_CONTENT_LABEL_ID);
  }

  // Fallback: inline label objects — either array or { nodes: [...] } (GraphQL shape)
  const labels = data.labels;
  if (Array.isArray(labels)) {
    return labels.some(
      (l) =>
        l &&
        typeof l === "object" &&
        (String((l as Record<string, unknown>).id ?? "") === RELEASE_CONTENT_LABEL_ID ||
          String((l as Record<string, unknown>).name ?? "") === RELEASE_CONTENT_LABEL_NAME),
    );
  }
  if (labels && typeof labels === "object") {
    const nodes = (labels as { nodes?: unknown }).nodes;
    if (Array.isArray(nodes)) {
      return nodes.some(
        (l) =>
          l &&
          typeof l === "object" &&
          (String((l as Record<string, unknown>).id ?? "") === RELEASE_CONTENT_LABEL_ID ||
            String((l as Record<string, unknown>).name ?? "") === RELEASE_CONTENT_LABEL_NAME),
      );
    }
  }

  return false;
}

/**
 * Determines whether a Linear IssueUpdate webhook event should fire the
 * release-content trigger.
 *
 * Fires if and only if ALL of the following hold:
 * 1. The event includes `updatedFrom.state` — meaning the workflow state
 *    actually changed (a label-add event on an already-Done ticket would NOT
 *    include this field).
 * 2. The new state is "Done" (`data.state.name === "Done"`).
 * 3. The `release-content` label is present on the issue at the moment of
 *    transition (`data.labelIds` or inline label objects).
 *
 * Exported for testing.
 */
export function shouldFireReleaseContent(event: Record<string, unknown>): boolean {
  const updatedFrom = event.updatedFrom as Record<string, unknown> | undefined;
  const data = event.data as Record<string, unknown> | undefined;

  if (!updatedFrom || !data) return false;

  // Guard 1: must be a state transition, not a label-only change.
  if (!updatedFrom.state) return false;

  // Guard 2: the new state must be "Done".
  const currentState = data.state as Record<string, unknown> | undefined;
  if (!currentState || String(currentState.name ?? "") !== RELEASE_CONTENT_TRIGGER_STATE) {
    return false;
  }

  // Guard 3: release-content label must be present at transition time.
  return hasReleaseContentLabel(data);
}
