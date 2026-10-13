import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  approvalDefaultSlackTarget,
  approvalRequestDefaultTimeoutSeconds,
} from "@/be/approval-sweeps";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import {
  createApprovalRequest,
  getAgentById,
  getAgentCurrentTask,
  getTaskById,
  updateApprovalRequestNotifications,
} from "@/be/db";
import { findUserByEmail, findUserByExternalId, findUserById } from "@/be/users";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { getAppUrl } from "@/utils/constants";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { postApprovalNotice } from "@/workflows/approval-notifications";

const QuestionSchema = z.object({
  id: z.string().describe("Unique ID for the question (used as key in responses)"),
  type: z
    .enum(["approval", "text", "single-select", "multi-select", "boolean"])
    .describe("Question type"),
  label: z.string().describe("The question text displayed to the user"),
  required: z.boolean().optional().describe("Whether this question is required (default: true)"),
  description: z
    .string()
    .optional()
    .describe("Optional help text, rendered as markdown (code fences, images)"),
  placeholder: z.string().optional().describe("Placeholder text (for text type)"),
  multiline: z.boolean().optional().describe("Use textarea instead of input (for text type)"),
  options: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional()
    .describe("Options (for single-select/multi-select types)"),
  minSelections: z.number().int().min(0).optional().describe("Min selections (for multi-select)"),
  maxSelections: z.number().int().min(1).optional().describe("Max selections (for multi-select)"),
  defaultValue: z.boolean().optional().describe("Default value (for boolean type)"),
});

export const registerRequestHumanInputTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "request-human-input",
    {
      title: "Request human input",
      annotations: { destructiveHint: false },
      description:
        "Create an approval request and return at once with the request id and URL. The answer arrives later as a hitl-follow-up task. " +
        "Supports multiple question types: approval (yes/no), text, single-select, " +
        "multi-select, and boolean. Returns the request ID and URL for the human to respond. " +
        "The dashboard renders each label and description as markdown: put long content in description, fence code with a language, and put an image URL alone on its own line to show it. " +
        "The tool posts a Slack notice: to notify if given, else to your task's Slack thread with a mention of the requester, else to APPROVAL_DEFAULT_SLACK_TARGET. The result says where the notice went. Give approvers when you know who must decide.",
      inputSchema: z.object({
        title: z.string().min(1).describe("Title of the approval request"),
        questions: z.array(QuestionSchema).min(1).describe("Questions to ask the human"),
        approvers: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Swarm user ids, emails, or Slack user ids of the people who may answer. When set, only they (or the operator key) can answer. Give this when you know the right owner.",
          ),
        notify: z
          .string()
          .regex(/^[CDGU][A-Z0-9]+$/)
          .optional()
          .describe(
            "A Slack channel id (C...) or user id (U...) for the notice. Requires lead privileges. Default: a reply in your task's Slack thread that mentions the requester.",
          ),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Default: APPROVAL_REQUEST_DEFAULT_TIMEOUT_SECONDS (86400). After the timeout the request becomes 'timeout' and you get a hitl-follow-up task. 0 in the config means no default timeout; then the request is cancelled after APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS days (default 7).",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        requestId: z.string().optional(),
        url: z.string().optional(),
        notifiedTarget: z.string().optional(),
        timeoutSeconds: z.number().optional(),
      }),
    },
    async ({ title, questions, timeoutSeconds, approvers, notify }, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr(
          'Agent ID not found. The MCP client should define the "X-Agent-ID" header.',
          { data: { yourAgentId: requestInfo.agentId } },
        );
      }

      if (notify) {
        const agent = await getAgentById(requestInfo.agentId);
        const decision = can({
          principal: { kind: "agent", agentId: requestInfo.agentId, isLead: !!agent?.isLead },
          verb: "integration.slack.post",
          resource: { kind: "none" },
          source: "mcp",
        });
        if (!decision.allow) {
          return toolErr("Choosing a Slack notice target requires lead privileges.");
        }
      }

      const resolvedApprovers: string[] = [];
      const unresolvedApprovers: string[] = [];
      for (const entry of approvers ?? []) {
        const user =
          (await findUserById(entry)) ??
          (await findUserByEmail(entry)) ??
          (await findUserByExternalId("slack", entry));
        if (user) resolvedApprovers.push(user.id);
        else unresolvedApprovers.push(entry);
      }
      if (unresolvedApprovers.length > 0) {
        return toolErr(`Unknown approvers: ${unresolvedApprovers.join(", ")}`);
      }

      // Resolve sourceTaskId: prefer header, fall back to agent's current in-progress task.
      // The X-Source-Task-Id header may be missing when the per-session MCP config wasn't
      // created (e.g. .mcp.json not found, session resumed, or lead agent on a non-task trigger).
      let sourceTaskId = requestInfo.sourceTaskId;
      if (!sourceTaskId && requestInfo.agentId) {
        const currentTask = await getAgentCurrentTask(requestInfo.agentId);
        if (currentTask) {
          sourceTaskId = currentTask.id;
        }
      }

      const sourceTask = sourceTaskId ? await getTaskById(sourceTaskId) : null;
      const effectiveTimeout = timeoutSeconds ?? approvalRequestDefaultTimeoutSeconds();
      const fallbackTarget = approvalDefaultSlackTarget();
      const notification = notify
        ? { channel: "slack", target: notify }
        : sourceTask?.slackChannelId && sourceTask.slackThreadTs
          ? {
              channel: "slack",
              target: sourceTask.slackChannelId,
              threadTs: sourceTask.slackThreadTs,
            }
          : fallbackTarget
            ? { channel: "slack", target: fallbackTarget }
            : undefined;
      const mentionSlackUserId =
        !notify && notification?.threadTs ? sourceTask?.slackUserId : undefined;

      const id = crypto.randomUUID();
      const request = await createApprovalRequest({
        id,
        title,
        questions,
        approvers: approvers ? { policy: "any", users: resolvedApprovers } : { policy: "any" },
        sourceTaskId: sourceTaskId ?? undefined,
        timeoutSeconds: effectiveTimeout || undefined,
        notificationChannels: notification ? [notification] : undefined,
        createdBy: (await resolveTaskAuditUserId(sourceTaskId, requestInfo.agentId)) ?? undefined,
      });

      let notifiedTarget: string | undefined;
      if (notification) {
        try {
          const result = await postApprovalNotice({
            requestId: request.id,
            title: request.title,
            questions: questions.map(({ label }) => ({ label: scrubSecrets(label) })),
            timeoutSeconds: effectiveTimeout || undefined,
            target: notification.target,
            threadTs: notification.threadTs,
            mentionSlackUserId: mentionSlackUserId ?? undefined,
          });
          if (result.messageTs) {
            notifiedTarget = notification.target;
            await updateApprovalRequestNotifications(request.id, [
              { ...notification, messageTs: result.messageTs },
            ]);
          }
        } catch (error) {
          console.error(
            "[HITL] Failed to send or store approval notice:",
            scrubSecrets(error instanceof Error ? error.message : String(error)),
          );
        }
      }

      const appUrl = getAppUrl();
      const url = `${appUrl}/approval-requests/${request.id}`;

      const notice = notifiedTarget
        ? `Slack notice sent to ${notifiedTarget}${notification?.threadTs ? ` in thread ${notification.threadTs}` : ""}.`
        : "No Slack notice was sent; share the URL yourself.";
      return toolOk(`Created approval request "${id}". Human can respond at: ${url}. ${notice}`, {
        data: {
          yourAgentId: requestInfo.agentId,
          requestId: request.id,
          url,
          notifiedTarget,
          timeoutSeconds: effectiveTimeout || undefined,
        },
      });
    },
  );
};
