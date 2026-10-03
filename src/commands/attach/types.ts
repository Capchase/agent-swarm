export type TaskStatus =
  | "draft"
  | "backlog"
  | "unassigned"
  | "offered"
  | "reviewing"
  | "pending"
  | "in_progress"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

export const TERMINAL_STATUSES = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);

export type Agent = {
  id: string;
  name: string;
  isLead?: boolean;
  status: string;
  role?: string | null;
  harnessProvider?: string | null;
  maxTasks?: number;
  capacity?: { current: number; max: number; available: number };
};

export type AgentTask = {
  id: string;
  task: string;
  status: TaskStatus;
  agentId?: string | null;
  parentTaskId?: string | null;
};

export type SteerMode = "steer" | "queue";

export type TaskDetail = AgentTask & { supportedSteerModes?: SteerMode[] };

export type SessionLog = {
  id: string;
  taskId?: string;
  sessionId: string;
  iteration: number;
  cli: string;
  content: string;
  lineNumber: number;
  createdAt: string;
};

export type SteerResult = {
  outcome: "steered" | "queued" | "promoted";
  steeringMessageId?: string;
  promotedTaskId?: string;
  effectiveMode?: SteerMode;
  degradedFrom?: SteerMode;
};

export type SteeringMessage = {
  id: string;
  body: string;
  mode: SteerMode;
  status: "pending" | "delivered" | "handled" | "promoted" | "cancelled";
  promotedTaskId?: string | null;
  createdAt?: string;
};

export type WhoAmI = {
  kind: "operator" | "user";
  user: { id: string; name: string } | null;
};
