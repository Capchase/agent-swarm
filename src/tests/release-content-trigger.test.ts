/**
 * Unit tests for the Release Content Agent trigger gating logic (TRI-7032).
 *
 * Covers shouldFireReleaseContent() — the predicate that decides whether an
 * IssueUpdate webhook event should kick off the release-content flow.
 *
 * Key invariants:
 * - Fires ONLY when state transitions INTO "Done" AND the release-content label
 *   is present at the moment of transition.
 * - Does NOT fire for label-add events on already-Done tickets (no
 *   updatedFrom.state in that event type).
 * - Does NOT fire for transitions into any other state.
 */
import { describe, expect, test } from "bun:test";
import {
  RELEASE_CONTENT_LABEL_ID,
  RELEASE_CONTENT_LABEL_NAME,
  shouldFireReleaseContent,
} from "../linear/release-content";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent({
  updatedFromState,
  currentStateName,
  labelIds,
  inlineLabels,
}: {
  updatedFromState?: Record<string, unknown>;
  currentStateName?: string;
  labelIds?: string[];
  inlineLabels?: Array<{ id?: string; name?: string }>;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: "issue-uuid-123",
    identifier: "TRI-9999",
    title: "Test Issue",
    url: "https://linear.app/capchase/issue/TRI-9999",
  };

  if (currentStateName !== undefined) {
    data.state = { id: "state-uuid", name: currentStateName, type: "completed" };
  }

  if (labelIds !== undefined) {
    data.labelIds = labelIds;
  } else if (inlineLabels !== undefined) {
    data.labels = inlineLabels;
  }

  const updatedFrom: Record<string, unknown> = {};
  if (updatedFromState !== undefined) {
    updatedFrom.state = updatedFromState;
  }

  return { type: "Issue", action: "update", data, updatedFrom };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("shouldFireReleaseContent", () => {
  // ── Positive cases ──────────────────────────────────────────────────────

  test("fires for into-Done transition with label ID in labelIds", () => {
    const event = makeEvent({
      updatedFromState: { name: "In Progress" },
      currentStateName: "Done",
      labelIds: [RELEASE_CONTENT_LABEL_ID, "other-label-uuid"],
    });
    expect(shouldFireReleaseContent(event)).toBe(true);
  });

  test("fires when label is the only label", () => {
    const event = makeEvent({
      updatedFromState: { name: "Todo" },
      currentStateName: "Done",
      labelIds: [RELEASE_CONTENT_LABEL_ID],
    });
    expect(shouldFireReleaseContent(event)).toBe(true);
  });

  test("fires for inline labels array with matching id", () => {
    const event = makeEvent({
      updatedFromState: { name: "In Progress" },
      currentStateName: "Done",
      inlineLabels: [{ id: RELEASE_CONTENT_LABEL_ID, name: "release-content" }],
    });
    expect(shouldFireReleaseContent(event)).toBe(true);
  });

  test("fires for inline labels array with matching name (no id)", () => {
    const event = makeEvent({
      updatedFromState: { name: "In Progress" },
      currentStateName: "Done",
      inlineLabels: [{ name: RELEASE_CONTENT_LABEL_NAME }],
    });
    expect(shouldFireReleaseContent(event)).toBe(true);
  });

  test("fires for { nodes: [...] } GraphQL label shape matching by id", () => {
    const event = makeEvent({
      updatedFromState: { name: "In Review" },
      currentStateName: "Done",
    });
    // Inject GraphQL-shaped labels directly into data
    (event.data as Record<string, unknown>).labels = {
      nodes: [{ id: RELEASE_CONTENT_LABEL_ID, name: "release-content" }],
    };
    expect(shouldFireReleaseContent(event)).toBe(true);
  });

  // ── Negative cases ──────────────────────────────────────────────────────

  test("does NOT fire for into-Done without the release-content label", () => {
    const event = makeEvent({
      updatedFromState: { name: "In Progress" },
      currentStateName: "Done",
      labelIds: ["some-other-label-uuid"],
    });
    expect(shouldFireReleaseContent(event)).toBe(false);
  });

  test("does NOT fire for into-Done with no labels at all", () => {
    const event = makeEvent({
      updatedFromState: { name: "In Progress" },
      currentStateName: "Done",
      labelIds: [],
    });
    expect(shouldFireReleaseContent(event)).toBe(false);
  });

  test("does NOT fire for label-add on already-Done ticket (no updatedFrom.state)", () => {
    // This is the key invariant: a label-add event does NOT have updatedFrom.state
    const event: Record<string, unknown> = {
      type: "Issue",
      action: "update",
      data: {
        id: "issue-uuid-123",
        state: { name: "Done" },
        labelIds: [RELEASE_CONTENT_LABEL_ID],
      },
      updatedFrom: {
        // labelIds changed, but state did NOT change → no updatedFrom.state
        labelIds: [],
      },
    };
    expect(shouldFireReleaseContent(event)).toBe(false);
  });

  test("does NOT fire for transition into a non-Done state with label", () => {
    const event = makeEvent({
      updatedFromState: { name: "Todo" },
      currentStateName: "In Progress",
      labelIds: [RELEASE_CONTENT_LABEL_ID],
    });
    expect(shouldFireReleaseContent(event)).toBe(false);
  });

  test("does NOT fire for transition into Cancelled with label", () => {
    const event = makeEvent({
      updatedFromState: { name: "In Progress" },
      currentStateName: "Cancelled",
      labelIds: [RELEASE_CONTENT_LABEL_ID],
    });
    expect(shouldFireReleaseContent(event)).toBe(false);
  });

  test("does NOT fire when updatedFrom is missing entirely", () => {
    const event: Record<string, unknown> = {
      type: "Issue",
      action: "update",
      data: {
        id: "issue-uuid-123",
        state: { name: "Done" },
        labelIds: [RELEASE_CONTENT_LABEL_ID],
      },
    };
    expect(shouldFireReleaseContent(event)).toBe(false);
  });

  test("does NOT fire when data is missing", () => {
    const event: Record<string, unknown> = {
      type: "Issue",
      action: "update",
      updatedFrom: { state: { name: "In Progress" } },
    };
    expect(shouldFireReleaseContent(event)).toBe(false);
  });

  test("does NOT fire when data.state is missing", () => {
    const event: Record<string, unknown> = {
      type: "Issue",
      action: "update",
      data: { id: "x", labelIds: [RELEASE_CONTENT_LABEL_ID] },
      updatedFrom: { state: { name: "In Progress" } },
    };
    expect(shouldFireReleaseContent(event)).toBe(false);
  });
});
