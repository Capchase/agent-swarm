import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import {
  ask,
  claim,
  findSlackTask,
  finish,
  registerLead,
  waitForOutcome,
  waitForReaction,
  waitForReactionAbsence,
} from "./slack-helpers";

export const slackReactionOverride: Scenario = {
  name: "slack-reaction-override",
  async run(ctx) {
    const key = "SLACK_REACTION_ACCEPTED";
    const configuredName = "eyeglasses";
    const upsert = await ctx.api("PUT", "/api/config", {
      body: { scope: "global", scopeId: null, key, value: configuredName, isSecret: false },
    });
    expectStatus(upsert, [200], `configure ${key}`);
    const configId = asRecord(upsert.json).id;
    expect(typeof configId === "string", `Config upsert for ${key} has no id`);

    try {
      // A global config write reloads process.env and restarts the Slack app
      // on a ~250ms debounce — wait for the override to actually be live
      // before driving a message through it.
      const live = await pollUntil(async () => {
        const response = await ctx.api("GET", `/api/config/env-presence?keys=${key}`);
        expectStatus(response, [200], `check ${key} presence`);
        const presence = asRecord(response.json).presence as Record<string, boolean> | undefined;
        return presence?.[key] === true;
      }, 10_000);
      expect(live, `${key} never became visible in process.env within 10 seconds`);

      // Registering a lead guarantees one exists when this scenario runs on
      // its own; when other Slack scenarios ran first, the swarm may still
      // route new messages to whichever of their leads `getLeadAgent()` still
      // considers non-offline. Read the task's own `agentId` back below
      // rather than assuming it's this freshly registered one.
      await registerLead(ctx, "e2e-lead-reaction-override");
      const message = await ask(ctx, "rename the staging bucket");
      ctx.markThread("reaction-override", "C0GENERAL0", message.ts);

      // The configured shortcode is what gets applied for acceptance, not
      // the "eyes" code default.
      await waitForReaction(ctx, message.ts, configuredName);

      const task = await findSlackTask(ctx, message.ts);
      const taskId = String(task.id);
      const ownerLeadId = String(task.agentId);
      await claim(ctx, ownerLeadId, taskId);
      const output = "Staging bucket renamed.";
      await finish(ctx, ownerLeadId, taskId, { status: "completed", output });

      await waitForOutcome(ctx, message.ts, output);
      // Finalization must replace the configured acceptance reaction with
      // the terminal outcome, not leave the two sitting side by side.
      await waitForReaction(ctx, message.ts, "white_check_mark");
      await waitForReactionAbsence(ctx, message.ts, configuredName);
    } finally {
      await ctx.api("DELETE", `/api/config/${configId}`);
    }
  },
};
