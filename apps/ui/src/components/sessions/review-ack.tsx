/**
 * Sessions surface — status-aware summary shown beneath a worker's row when
 * the orchestrator auto-spawned one or more "Worker task completed — review
 * needed." follow-ups against it.
 *
 * The review row itself is hidden from the timeline (operational, not
 * conversational — see `isAutoReview` in `session-timeline.tsx`), but the
 * *outcome* of the most recent review is not: this chip mirrors the same
 * live-activity / final-outcome split a normal `<TaskCard>` uses, because a
 * hidden review is frequently where the agent's actual human-facing answer
 * lands (e.g. Lead relaying a completed delegated worker's result). Hiding
 * the row must never also hide the answer or the fact that work is still
 * happening.
 */

import { Check } from "lucide-react";
import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useAgent } from "@/api/hooks/use-agents";
import type { AgentTask } from "@/api/types";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { TERMINAL_STATUSES } from "@/lib/task-activity";
import { cn, formatRelativeTime } from "@/lib/utils";
import { ChainOfThought } from "./chain-of-thought";
import { TaskOutcome } from "./task-card";
import { TaskDetailSheet } from "./task-detail-sheet";

export function ReviewAck({ reviews, className }: { reviews: AgentTask[]; className?: string }) {
  // Most recent review carries the "final" prose — that's the entry point.
  const lastReview = reviews[reviews.length - 1];
  const isActive = !TERMINAL_STATUSES.has(lastReview.status);
  // Sheet open-state lives in the URL (`?task=<id>`) for shareable links —
  // mirrors TaskCard so a session URL pinning a review is reproducible.
  const [searchParams, setSearchParams] = useSearchParams();
  const open = searchParams.get("task") === lastReview.id;
  const setOpen = useCallback(
    (next: boolean) => {
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          if (next) sp.set("task", lastReview.id);
          else if (sp.get("task") === lastReview.id) sp.delete("task");
          return sp;
        },
        { replace: true },
      );
    },
    [setSearchParams, lastReview.id],
  );
  const { data: agent } = useAgent(lastReview.agentId ?? "");
  const reviewerName =
    agent?.name ?? (lastReview.agentId ? `${lastReview.agentId.slice(0, 8)}…` : "agent");
  const finishedAt = lastReview.lastUpdatedAt ?? lastReview.createdAt;
  return (
    <div className={cn("flex flex-col gap-1 min-w-0", className)}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "self-start inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/70",
          "hover:text-foreground transition-colors",
        )}
        aria-label={`Open review by ${reviewerName}`}
        title={`Open review by ${reviewerName}`}
      >
        <AgentAvatar
          agentId={lastReview.agentId}
          agentName={agent?.name}
          size="xs"
          className={cn(isActive && "ring-2 ring-primary/40 animate-pulse")}
        />
        {isActive ? (
          <span>
            <span className="text-foreground/80 font-medium">{reviewerName}</span> is reviewing…
          </span>
        ) : (
          <span>
            <Check className="h-3 w-3 shrink-0 inline -mt-0.5 mr-1" aria-hidden="true" />
            Reviewed by <span className="font-medium text-foreground/80">{reviewerName}</span>
            {reviews.length > 1 ? <span> · {reviews.length} reviews</span> : null}
            <span className="text-muted-foreground/60"> · {formatRelativeTime(finishedAt)}</span>
          </span>
        )}
      </button>
      {/* While the review is still running, show its live progress line —
          otherwise the hidden row reads as "nothing is happening" even
          though this is exactly where the real answer is being composed.
          Once it lands, render the outcome inline so the answer shows up
          the moment the next poll picks it up — no click required. */}
      <div className="pl-6 min-w-0">
        {isActive ? (
          <ChainOfThought taskId={lastReview.id} status={lastReview.status} />
        ) : (
          <TaskOutcome task={lastReview} />
        )}
      </div>
      <TaskDetailSheet
        taskId={lastReview.id}
        task={lastReview}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}
