import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { AgentTask } from "../../api/types";

// The root-level test run cannot resolve ui's `@/` alias (same pattern as
// client.test.tsx / runtime-instances-section.test.tsx). Plain lib utils
// map to their real relative-path module; hook and heavy subcomponent
// modules are stubbed so we exercise only ReviewAck's own branching logic —
// not TaskOutcome's/ChainOfThought's/TaskDetailSheet's internals, which have
// their own deep `@/` import graphs and their own tests.
mock.module("@/lib/utils", () => import("../../lib/utils"));
mock.module("@/api/hooks/use-agents", () => ({
  useAgent: (id: string) => ({ data: id ? { id, name: "Lead" } : undefined }),
}));
mock.module("@/components/shared/agent-avatar", () => ({
  AgentAvatar: () => null,
}));
mock.module("./chain-of-thought", () => ({
  ChainOfThought: ({ taskId, status }: { taskId: string; status: string }) => (
    <div data-testid="chain-of-thought">{`live:${taskId}:${status}`}</div>
  ),
}));
mock.module("./task-card", () => ({
  TaskOutcome: ({ task }: { task: AgentTask }) => (
    <div data-testid="task-outcome">{task.output ?? ""}</div>
  ),
}));
mock.module("./task-detail-sheet", () => ({
  TaskDetailSheet: () => null,
}));
mock.module("@/lib/task-activity", () => import("../../lib/task-activity"));

const { ReviewAck } = await import("./review-ack");

function review(overrides: Partial<AgentTask> = {}): AgentTask {
  const now = new Date().toISOString();
  return {
    id: "task-review-1",
    key: "shared/task:root/",
    agentId: "lead-1",
    task: "Worker task completed — review needed.",
    status: "in_progress",
    source: "system",
    taskType: "follow-up",
    tags: [],
    priority: 0,
    dependsOn: [],
    createdAt: now,
    lastUpdatedAt: now,
    ...overrides,
  };
}

function render(reviews: AgentTask[]): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ReviewAck reviews={reviews} />
    </MemoryRouter>,
  );
}

describe("ReviewAck", () => {
  test("an in_progress follow-up shows a live working indicator, not a false 'Reviewed' label", () => {
    const html = render([review({ status: "in_progress" })]);

    expect(html).toContain("is reviewing");
    expect(html).not.toContain("Reviewed by");
    // The live progress line comes from the same ChainOfThought mechanism
    // visible task rows use — proves the hidden follow-up isn't silent.
    expect(html).toContain("live:task-review-1:in_progress");
    expect(html).not.toContain('data-testid="task-outcome"');
  });

  test("a completed follow-up with output renders the answer inline, without a click", () => {
    const html = render([
      review({
        status: "completed",
        output: "The port has started — here is the link you asked for.",
      }),
    ]);

    expect(html).toContain("Reviewed by");
    expect(html).toContain("The port has started — here is the link you asked for.");
    expect(html).not.toContain('data-testid="chain-of-thought"');
  });

  test("multiple reviews: the most recent one's status/output drives the chip", () => {
    const html = render([
      review({ id: "review-a", status: "completed", output: "first pass" }),
      review({ id: "review-b", status: "in_progress" }),
    ]);

    expect(html).toContain("is reviewing");
    expect(html).toContain("live:review-b:in_progress");
    expect(html).not.toContain("first pass");
  });
});
