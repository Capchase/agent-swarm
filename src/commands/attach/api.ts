import type {
  Agent,
  AgentTask,
  SessionLog,
  SteeringMessage,
  SteerMode,
  SteerResult,
  TaskDetail,
  WhoAmI,
} from "./types";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export type CreateTaskBody = {
  task: string;
  agentId: string;
  routingReason: string;
  source: string;
  tags?: string[];
  parentTaskId?: string;
};

export type SteerBody = {
  message: string;
  mode: SteerMode;
  onUnsupported: "degrade" | "fail";
  source: "api";
};

export type AttachClient = ReturnType<typeof createClient>;

export function createClient(opts: { apiUrl: string; token: string; fetchImpl?: typeof fetch }) {
  const base = opts.apiUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep raw text
    }
    if (!res.ok) {
      const detail =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : text.slice(0, 200);
      const message =
        res.status === 401
          ? "Token rejected (401). Run: agent-swarm attach setup"
          : `${method} ${path} failed (${res.status}): ${detail}`;
      throw new ApiError(res.status, message, parsed);
    }
    return parsed as T;
  }

  const qs = (q: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
    return p.toString();
  };

  return {
    whoami: () => call<WhoAmI>("GET", "/api/whoami"),
    listAgents: async () =>
      (await call<{ agents: Agent[] }>("GET", "/api/agents?fields=slim")).agents,
    listTasks: async (q: { agentId?: string; status?: string; limit?: number }) =>
      (await call<{ tasks: AgentTask[] }>("GET", `/api/tasks?${qs({ ...q, fields: "slim" })}`))
        .tasks,
    getTask: (id: string) => call<TaskDetail>("GET", `/api/tasks/${id}?logsLimit=1`),
    createTask: (body: CreateTaskBody) => call<AgentTask>("POST", "/api/tasks", body),
    sessionLogs: async (id: string, limit = 1000) =>
      (await call<{ logs: SessionLog[] }>("GET", `/api/tasks/${id}/session-logs?limit=${limit}`))
        .logs,
    steer: (id: string, body: SteerBody) =>
      call<SteerResult>("POST", `/api/tasks/${id}/steer`, body),
    steeringMessages: async (id: string) =>
      (await call<{ messages: SteeringMessage[] }>("GET", `/api/tasks/${id}/steering-messages`))
        .messages,
    cancel: (id: string) =>
      call<{ success: boolean; task: AgentTask }>("POST", `/api/tasks/${id}/cancel`),
  };
}
