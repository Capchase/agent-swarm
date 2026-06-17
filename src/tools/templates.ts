/**
 * Task lifecycle prompt template definitions (store-progress follow-ups).
 *
 * Each template is registered at module load time via registerTemplate().
 * Handlers import this module for the side-effect of registration.
 */

import { registerTemplate } from "../prompts/registry";

// ============================================================================
// Kapso/WhatsApp inbound (native handler creates a kapso-inbound task)
// ============================================================================

registerTemplate({
  eventType: "kapso.message.received",
  header: "",
  defaultBody: `# WhatsApp inbound (Kapso)

A Kapso webhook fired on the swarm's provisioned WhatsApp number. Load the \`kapso-whatsapp\` skill, then triage this like any other interaction and reply on WhatsApp by quote-replying the inbound WAMID (\`context.message_id\`).

## Source: WhatsApp (Kapso)
- conversation_id: {{conversation_id}}
- inbound_wamid: {{inbound_wamid}}
- sender_phone: {{sender_phone}}
- contact_name: {{contact_name}}
- phone_number_id: {{phone_number_id}}{{test_note}}

## Message
{{message_text}}`,
  variables: [
    { name: "conversation_id", description: "Kapso conversation id, or 'unknown'" },
    { name: "inbound_wamid", description: "Inbound message WAMID, or 'unknown'" },
    { name: "sender_phone", description: "Sender phone (E.164 no +), or 'unknown'" },
    { name: "contact_name", description: "Contact display name, or 'unknown'" },
    { name: "phone_number_id", description: "Provisioned phone-number id, or 'unknown'" },
    {
      name: "test_note",
      description: "Appended note when the payload is a Kapso test delivery (else empty)",
    },
    { name: "message_text", description: "Inbound message text or a non-text placeholder" },
  ],
  category: "event",
});

// ============================================================================
// Worker task follow-ups (created by store-progress for the lead)
// ============================================================================

registerTemplate({
  eventType: "task.worker.completed",
  header: "",
  defaultBody: `Worker task completed \u2014 review needed.

Agent: {{agent_name}}
Original task created by agent {{creator_agent}}
Task: "{{task_desc}}"

Output:
{{output_summary}}{{follow_up_instructions}}

IMPORTANT: Do NOT re-delegate or re-answer the original request. The worker has already handled it. Your job is ONLY to:
1. Review the output above
2. If the task has Slack metadata, use \`slack-reply\` to post the result to the thread (if the worker hasn't already)
3. Complete this follow-up task

Use \`get-task-details\` with taskId "{{task_id}}" for full details.`,
  variables: [
    { name: "agent_name", description: "Worker agent name or ID prefix" },
    { name: "creator_agent", description: "Agent ID that originally created the worker task" },
    { name: "task_desc", description: "Task description (truncated to 200 chars)" },
    { name: "output_summary", description: "Task output (truncated to 500 chars)" },
    {
      name: "follow_up_instructions",
      description: "Optional per-task instructions from followUpConfig for this completion",
    },
    { name: "task_id", description: "Original task ID" },
  ],
  category: "task_lifecycle",
});

// ============================================================================
// HITL follow-up (created when a standalone approval request is resolved)
// ============================================================================

registerTemplate({
  eventType: "hitl.follow_up",
  header: "",
  defaultBody: `Human responded to your approval request ({{request_id}}).

Title: {{title}}
Status: {{status}}

Questions and responses:
{{responses}}

Continue your work based on the human's input.`,
  variables: [
    { name: "request_id", description: "The approval request ID" },
    { name: "title", description: "Title of the approval request" },
    { name: "status", description: "Resolution status: approved or rejected" },
    {
      name: "responses",
      description: "Formatted questions and human responses",
    },
  ],
  category: "task_lifecycle",
});

registerTemplate({
  eventType: "task.worker.failed",
  header: "",
  defaultBody: `Worker task failed \u2014 action needed.

Agent: {{agent_name}}
Original task created by agent {{creator_agent}}
Task: "{{task_desc}}"

Failure reason: {{failure_reason}}{{follow_up_instructions}}

Decide whether to reassign, retry, or handle the failure. Use \`get-task-details\` with taskId "{{task_id}}" for full details.`,
  variables: [
    { name: "agent_name", description: "Worker agent name or ID prefix" },
    { name: "creator_agent", description: "Agent ID that originally created the worker task" },
    { name: "task_desc", description: "Task description (truncated to 200 chars)" },
    { name: "failure_reason", description: "Failure reason text" },
    {
      name: "follow_up_instructions",
      description: "Optional per-task instructions from followUpConfig for this failure",
    },
    { name: "task_id", description: "Original task ID" },
  ],
  category: "task_lifecycle",
});

// ============================================================================
// Takeover-decision follow-up (Lead-routed crash-recovery, DES-523)
// Created when HEARTBEAT_TAKEOVER_VIA_LEAD=true and a worker crashes.
// The Lead reads the routing policy (see `takeover-routing` skill) and
// direct-assigns a replacement to a role/harness-appropriate worker.
// Built-in default policy is included so routing works even without the skill.
// ============================================================================

registerTemplate({
  eventType: "task.takeover.decision",
  header: "",
  defaultBody: `Takeover-decision: orphaned task needs a new owner.

Original agent: {{original_agent_name}} (role: {{original_role}}, harness: {{original_provider}})
Original task ID: {{original_task_id}}
Trigger: {{reason}}
Task: "{{task_desc}}"

Resume generation: {{generation_next}} of {{max_generations}} (max). You MUST set \`taskType: "resume"\`, attach the tag \`resume-generation:{{generation_next}}\`, and set \`parentTaskId: {{original_task_id}}\` when dispatching via \`send-task\`. Do NOT inherit the original task's \`model\`.{{artifacts_block}}

## Your job

Consult the \`takeover-routing\` skill for the per-work-class routing policy.
Default policy (apply when no skill override exists):
- Coding tasks → direct-assign to a coder agent on a non-capped harness (role includes "coder" or capabilities include coding). Never route coding work to a reviewer.
- Review tasks → direct-assign to a reviewer agent. Never route review work to a coder.
- PM / planning tasks → direct-assign to a PM or researcher agent.
- All others → direct-assign to any available worker whose role matches the task type.

Capacity-check the target agent first (use \`get-agent-info\` or \`task-action claim\`). Default action is **direct-assign** via \`send-task\` with an explicit \`agentId\`.

⚠️ Fail-open warning: if you do not route within approximately {{timeout_min}} minutes, the system will automatically fall back to the unassigned pool. Route promptly — the work will not be lost either way, but pool routing is role-blind.`,
  variables: [
    { name: "original_agent_name", description: "Name or ID prefix of the crashed agent" },
    { name: "original_role", description: "Role of the crashed agent, or 'unknown'" },
    {
      name: "original_provider",
      description: "Harness provider of the crashed agent, or 'unknown'",
    },
    { name: "original_task_id", description: "ID of the superseded original task" },
    { name: "reason", description: "Takeover trigger reason (e.g. crash_recovery)" },
    { name: "task_desc", description: "Task description (truncated to 200 chars)" },
    {
      name: "generation_next",
      description: "Next resume generation number (must be set on dispatched resume)",
    },
    { name: "max_generations", description: "Maximum resume generations before budget exhaustion" },
    {
      name: "artifacts_block",
      description: "Formatted attachment list from the original task, or empty string",
    },
    {
      name: "timeout_min",
      description:
        "Lead-escalation timeout in minutes — after this the system falls back to pool routing",
    },
  ],
  category: "task_lifecycle",
});

// ============================================================================
// Budget refusal follow-up (Phase 5: created when an agent is refused due to
// per-agent or global daily budget exhaustion)
// ============================================================================

registerTemplate({
  eventType: "task.budget.refused",
  header: "",
  defaultBody: `Budget refusal \u2014 task is blocked.

Cause: {{cause}}
Agent: {{agent_name}}
Task: {{task_desc}}
Spend / budget: {{spend_summary}}
Resets at: {{reset_at}}

Decide whether to raise the budget, reassign, or wait for the daily reset.
Use \`get-task-details\` with taskId "{{task_id}}" for full details.`,
  variables: [
    { name: "cause", description: "'agent' or 'global'" },
    { name: "agent_name", description: "Refusing agent name or ID prefix" },
    { name: "task_desc", description: "Task description (truncated to 200 chars)" },
    { name: "spend_summary", description: 'Formatted "$X / $Y" pair' },
    { name: "reset_at", description: "UTC reset time (human readable)" },
    { name: "task_id", description: "Original task ID" },
  ],
  category: "task_lifecycle",
});
