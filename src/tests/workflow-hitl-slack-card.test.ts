import { beforeEach, describe, expect, mock, test } from "bun:test";

const postMessage = mock(async (_args: Record<string, unknown>) => ({ ts: "1.0" }));
mock.module("../slack/app", () => ({
  getSlackApp: () => ({ client: { chat: { postMessage } } }),
}));

import type { ExecutorDependencies } from "../workflows/executors/base";
import { fitSlackDetails, HumanInTheLoopExecutor } from "../workflows/executors/human-in-the-loop";

type Block = { type: string; text?: { type: string; text: string } };

async function postCard(extra: Record<string, unknown> = {}): Promise<Block[]> {
  const deps: ExecutorDependencies = {
    db: {
      getApprovalRequestByStepId: async () => null,
      createApprovalRequest: async () => ({ status: "pending" }),
      updateApprovalRequestNotifications: async () => {},
      getApprovalRequestById: async () => ({ status: "pending" }),
    } as unknown as typeof import("../be/db"),
    eventBus: { emit: () => {}, on: () => {}, off: () => {} },
    interpolate: (template: string) => template,
  };
  const executor = new HumanInTheLoopExecutor(deps);

  await executor.run({
    config: {
      title: "Deploy",
      questions: [{ id: "q1", type: "approval", label: "Approve <now>?", required: true }],
      approvers: { policy: "any" },
      timeout: { seconds: 3600, action: "reject" },
      notifications: [{ channel: "slack", target: "C1" }],
      ...extra,
    },
    context: {},
    meta: {
      runId: crypto.randomUUID(),
      stepId: crypto.randomUUID(),
      nodeId: "review",
      workflowId: crypto.randomUUID(),
      dryRun: false,
    },
  });
  // Notifications are fire-and-forget; wait for the dispatch to post.
  for (let i = 0; i < 50 && postMessage.mock.calls.length === 0; i++) {
    await Bun.sleep(10);
  }
  expect(postMessage).toHaveBeenCalledTimes(1);
  return postMessage.mock.calls[0]![0].blocks as Block[];
}

beforeEach(() => postMessage.mockClear());

describe("HITL Slack card timeout caption", () => {
  test("says the request times out, never that it auto-rejects", async () => {
    const blocks = JSON.stringify(await postCard());
    expect(blocks).toContain("times out if not responded");
    expect(blocks).not.toContain("auto-rejects");
  });
});

describe("HITL Slack card slackDetails", () => {
  test("posts slackDetails unescaped between the title and the questions", async () => {
    const details = "*Uses (1):*\n• <https://x.test/a#L1|a.ts:1>";
    const blocks = await postCard({ slackDetails: details });

    expect(blocks.map((b) => b.type)).toEqual([
      "section",
      "section",
      "section",
      "actions",
      "context",
    ]);
    expect(blocks[0]!.text!.text).toContain("Approval Required: Deploy");
    expect(blocks[1]!.text).toEqual({ type: "mrkdwn", text: details });
    expect(blocks[2]!.text!.text).toContain("Approve &lt;now&gt;?");
  });

  for (const [name, slackDetails] of [
    ["absent", undefined],
    ["blank", "  "],
    ["an unresolved template", ""],
  ] as const) {
    test(`keeps today's 4 blocks when slackDetails is ${name}`, async () => {
      const blocks = await postCard(slackDetails === undefined ? {} : { slackDetails });
      expect(blocks.map((b) => b.type)).toEqual(["section", "section", "actions", "context"]);
      expect(blocks[1]!.text!.text).toStartWith("*Questions:*");
    });
  }

  test("fitSlackDetails cuts a long text at a line break under the section limit", () => {
    const line = `${"x".repeat(99)}\n`;
    const text = line.repeat(50);
    expect(text.length).toBe(5000);

    const fitted = fitSlackDetails(text);

    expect(fitted.length).toBeLessThanOrEqual(3000);
    expect(fitted).toEndWith("_…cut. See the dashboard._");
    expect(
      fitted
        .split("\n")
        .slice(0, -1)
        .every((l) => l === "x".repeat(99)),
    ).toBe(true);
  });

  test("fitSlackDetails returns a text within the limit unchanged", () => {
    const text = "a\n".repeat(1500);
    expect(fitSlackDetails(text)).toBe(text);
  });
});
