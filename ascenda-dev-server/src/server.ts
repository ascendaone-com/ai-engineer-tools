import * as crypto from "node:crypto";
import * as http from "node:http";
import {
  ASCENDA_TOOL_TYPES,
  AscendaEventPayload,
  EVENT_WORKLOAD_CATEGORY,
  WorkloadCategory
} from "@ascenda-one/tool-contract";

type Session = {
  pairingSessionId: string;
  code: string;
  secret: string;
  toolInstallationId: string;
  toolType: string;
  displayName: string | null;
  status: "pending" | "paired" | "expired" | "cancelled";
  tokenIssued: boolean;
  pairedAt: string | null;
};

type Tool = {
  toolInstallationId: string;
  toolType: string;
  displayName: string | null;
  token: string;
  revoked: boolean;
  pairedAt: string;
  lastSeenAt: string | null;
};

type StudyJoinSession = {
  joinSessionId: string;
  shortCode: string;
  toolInstallationId: string;
  organisationName: string;
  studyTitle: string;
  studyWindow: string;
  grants: string[];
  status: "pending" | "confirmed" | "expired" | "refused";
  expiresAt: string;
  reason: string | null;
};

/**
 * Fixture join codes for `join` to exercise locally — a stand-in for
 * the backend's own branch for this feature, which had not merged when this
 * mock was written. What a real code resolves to (the organisation, the
 * study, its window, what Report mode grants) lives entirely server-side;
 * this table is that server for a machine with no backend.
 */
const STUDY_JOIN_CODES: Readonly<Record<string, Omit<StudyJoinSession, "joinSessionId" | "shortCode" | "toolInstallationId" | "status" | "expiresAt" | "reason">>> = {
  "NORTHVIEW-2026": {
    organisationName: "Northview Health",
    studyTitle: "Autonomy at Work",
    studyWindow: "13 Oct – 10 Nov 2026",
    // Exactly two, confirmed 28 Sep 2026: Report mode carries no third,
    // agent-observed grant. Kept here as plain names only because this is a
    // fixture standing in for the backend; the CLI itself never hard-codes
    // this list — it always prints whatever the start response names.
    grants: [
      "Live AI tool telemetry, for the study window",
      "A one-time import of your past AI work"
    ]
  }
};

export type ReceivedEvent = AscendaEventPayload & { category: WorkloadCategory; receivedAt: string };

export type DevServerOptions = {
  /** Pair sessions the moment they are created (default true) — no app, no confirm call needed. */
  autoConfirm?: boolean;
  /**
   * Confirm study-join sessions the moment they are created (default:
   * whatever `autoConfirm` is). Separated from pairing's flag so a test can
   * pair instantly (the easy setup every other suite already uses) while
   * still driving a join session's `confirmed` / `expired` / `refused`
   * outcomes by hand through `/v1/org-study-joins/:id/confirm` and
   * `/_dev/org-study-joins/:id/refuse`.
   */
  autoConfirmJoins?: boolean;
  log?: (line: string) => void;
};

export type DevServer = {
  server: http.Server;
  state: {
    sessions: Map<string, Session>;
    tools: Map<string, Tool>;
    studyJoins: Map<string, StudyJoinSession>;
    events: ReceivedEvent[];
    consentActive: boolean;
    autoConfirm: boolean;
    autoConfirmJoins: boolean;
    unclassified: number;
  };
};



const CATEGORY_COLOR: Record<WorkloadCategory, string> = {
  creation: "\x1b[34m",
  verification: "\x1b[32m",
  supervision: "\x1b[33m",
  risk: "\x1b[31m",
  neutral: "\x1b[90m",
  unclassified: "\x1b[35m"
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export function createDevServer(opts: DevServerOptions = {}): DevServer {
  const log = opts.log ?? ((line: string) => console.log(line));
  const state: DevServer["state"] = {
    sessions: new Map(),
    tools: new Map(),
    studyJoins: new Map(),
    events: [],
    consentActive: true,
    autoConfirm: opts.autoConfirm ?? true,
    autoConfirmJoins: opts.autoConfirmJoins ?? (opts.autoConfirm ?? true),
    unclassified: 0
  };

  const server = http.createServer((req, res) => {
    void route(req, res).catch((error) => {
      json(res, 500, { error: "dev_server_error", detail: String(error) });
    });
  });

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    // --- pairing ---
    if (method === "POST" && path === "/v1/tool-pairing-sessions") return createSession(req, res);
    if (method === "POST" && path === "/v1/tool-pairing-sessions/confirm-device-code") return confirm(req, res, "deviceCode");
    if (method === "POST" && path === "/v1/tool-pairing-sessions/confirm-by-code") return confirm(req, res, "code");
    const confirmMatch = path.match(/^\/v1\/tool-pairing-sessions\/([^/]+)\/confirm$/);
    if (method === "POST" && confirmMatch) return confirm(req, res, "secret", decodeURIComponent(confirmMatch[1]));
    const statusMatch = path.match(/^\/v1\/tool-pairing-sessions\/([^/]+)\/status$/);
    if (method === "GET" && statusMatch) return status(res, decodeURIComponent(statusMatch[1]));

    // --- org study join ---
    if (method === "POST" && path === "/v1/org-study-joins") return startStudyJoin(req, res);
    const joinStatusMatch = path.match(/^\/v1\/org-study-joins\/([^/]+)\/status$/);
    if (method === "GET" && joinStatusMatch) return studyJoinStatus(res, decodeURIComponent(joinStatusMatch[1]));
    const joinConfirmMatch = path.match(/^\/v1\/org-study-joins\/([^/]+)\/confirm$/);
    if (method === "POST" && joinConfirmMatch) return confirmStudyJoinRoute(res, decodeURIComponent(joinConfirmMatch[1]));
    const joinRefuseMatch = path.match(/^\/_dev\/org-study-joins\/([^/]+)\/refuse$/);
    if (method === "POST" && joinRefuseMatch) return refuseStudyJoin(res, decodeURIComponent(joinRefuseMatch[1]));

    // --- ingest ---
    if (method === "POST" && path === "/v1/tool-events") return ingest(req, res, false);
    if (method === "POST" && path === "/v1/tool-events/batch") return ingest(req, res, true);
    if (method === "POST" && path === "/v1/tool-events/renew-token") return renew(req, res);

    // --- connected tools ---
    if (method === "GET" && path === "/v1/connected-tools") {
      return json(res, 200, { tools: [...state.tools.values()].map(({ token: _t, revoked: _r, ...pub }) => pub) });
    }
    const revokeMatch = path.match(/^\/v1\/connected-tools\/([^/]+)$/);
    if (method === "DELETE" && revokeMatch) {
      const tool = state.tools.get(decodeURIComponent(revokeMatch[1]));
      if (!tool) return json(res, 404, { error: "not_found" });
      tool.revoked = true;
      log(`${DIM}${time()}${RESET} \x1b[31mrevoked${RESET} ${tool.toolInstallationId}`);
      return json(res, 200, { status: "revoked" });
    }

    // --- dev controls (not part of the real contract) ---
    if (method === "GET" && path === "/_dev/events") return json(res, 200, { events: state.events, unclassified: state.unclassified });
    if (method === "POST" && path === "/_dev/reset") { state.events.length = 0; state.unclassified = 0; state.studyJoins.clear(); return json(res, 200, { status: "reset" }); }
    if (method === "POST" && path === "/_dev/consent") {
      const body = await readJson(req);
      state.consentActive = Boolean((body as { active?: boolean }).active);
      log(`${DIM}${time()}${RESET} consent ${state.consentActive ? "\x1b[32mactive" : "\x1b[31mexpired"}${RESET} (simulated)`);
      return json(res, 200, { consentActive: state.consentActive });
    }

    json(res, 404, { error: "not_found", detail: `${method} ${path}` });
  }

  async function createSession(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = (await readJson(req)) as { toolInstallationId?: string; toolType?: string; displayName?: string | null };
    if (!body.toolInstallationId || !body.toolType) return json(res, 400, { error: "invalid_request" });
    if (!(ASCENDA_TOOL_TYPES as readonly string[]).includes(body.toolType)) return json(res, 400, { error: "unknown_tool_type" });

    const session: Session = {
      pairingSessionId: crypto.randomUUID(),
      code: String(Math.floor(100000 + Math.random() * 900000)),
      secret: crypto.randomBytes(16).toString("hex"),
      toolInstallationId: body.toolInstallationId,
      toolType: body.toolType,
      displayName: body.displayName ?? null,
      status: "pending",
      tokenIssued: false,
      pairedAt: null
    };
    state.sessions.set(session.pairingSessionId, session);
    log(`${DIM}${time()}${RESET} pairing session for ${session.toolInstallationId} (code ${session.code})`);
    if (state.autoConfirm) pair(session);

    json(res, 200, {
      pairingSessionId: session.pairingSessionId,
      code: session.code,
      deviceCode: session.code,
      secret: session.secret,
      // Query form with both session and secret — matches the `qrUrl` the
      // real backend returns when it has no pairing web page configured.
      // This drifted to a path-only form with no session id, which the app's
      // parser rejects with "Invalid pairing link" — a mock that produces an
      // unusable link is worse than no mock.
      qrUrl: `ascenda://pair?session=${session.pairingSessionId}&secret=${session.secret}`,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    });
  }

  function pair(session: Session): void {
    session.status = "paired";
    session.pairedAt = new Date().toISOString();
    const token = `devtok_${crypto.randomBytes(24).toString("hex")}`;
    state.tools.set(session.toolInstallationId, {
      toolInstallationId: session.toolInstallationId,
      toolType: session.toolType,
      displayName: session.displayName,
      token,
      revoked: false,
      pairedAt: session.pairedAt,
      lastSeenAt: null
    });
    log(`${DIM}${time()}${RESET} \x1b[32mpaired${RESET} ${session.toolInstallationId}${state.autoConfirm ? " (auto-confirm)" : ""}`);
  }

  async function confirm(req: http.IncomingMessage, res: http.ServerResponse, by: "deviceCode" | "code" | "secret", sessionId?: string): Promise<void> {
    if (!req.headers.authorization) return json(res, 401, { error: "unauthorized" });
    const body = (await readJson(req)) as Record<string, string>;
    const value = body[by];
    const session = sessionId
      ? state.sessions.get(sessionId)
      : [...state.sessions.values()].find((s) => s.code === value || s.secret === value);
    if (!session || (by === "secret" && session.secret !== value)) return json(res, 400, { error: "invalid_code_or_secret" });
    if (session.status !== "paired") pair(session);
    json(res, 200, { status: "paired" });
  }

  function status(res: http.ServerResponse, sessionId: string): void {
    const session = state.sessions.get(sessionId);
    if (!session) return json(res, 404, { error: "not_found" });
    if (session.status !== "paired") {
      return json(res, 200, { status: session.status, toolInstallationId: null, eventWriteToken: null, pairedAt: null });
    }
    // Contract: token only on the first paired poll.
    const token = session.tokenIssued ? null : state.tools.get(session.toolInstallationId)?.token ?? null;
    session.tokenIssued = true;
    json(res, 200, { status: "paired", toolInstallationId: session.toolInstallationId, eventWriteToken: token, pairedAt: session.pairedAt });
  }

  /**
   * `mode` is always `"report"` from a real CLI (it is the only mode `join`
   * offers), checked anyway because this is the mock's one contract
   * boundary worth guarding: a caller sending anything else is a bug, not a
   * person's choice.
   */
  async function startStudyJoin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const tool = authTool(req);
    if (!tool || tool.revoked) return json(res, 401, { error: "Invalid token or revoked tool connection" });

    const body = (await readJson(req)) as { joinCode?: string; mode?: string };
    if (!body.joinCode) return json(res, 400, { error: "invalid_request" });
    if (body.mode !== "report") return json(res, 400, { error: "unsupported_mode" });

    const info = STUDY_JOIN_CODES[body.joinCode];
    if (!info) return json(res, 404, { error: "unknown_join_code" });

    const session: StudyJoinSession = {
      joinSessionId: crypto.randomUUID(),
      shortCode: String(Math.floor(100000 + Math.random() * 900000)),
      toolInstallationId: tool.toolInstallationId,
      ...info,
      status: "pending",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      reason: null
    };
    state.studyJoins.set(session.joinSessionId, session);
    log(`${DIM}${time()}${RESET} study-join session for ${tool.toolInstallationId} -> ${info.organisationName} (code ${session.shortCode})`);
    if (state.autoConfirmJoins) confirmStudyJoin(session);

    json(res, 200, {
      joinSessionId: session.joinSessionId,
      shortCode: session.shortCode,
      expiresAt: session.expiresAt,
      organisationName: session.organisationName,
      studyTitle: session.studyTitle,
      studyWindow: session.studyWindow,
      grants: session.grants
    });
  }

  function confirmStudyJoin(session: StudyJoinSession): void {
    session.status = "confirmed";
    log(`${DIM}${time()}${RESET} \x1b[32mstudy-join confirmed${RESET} ${session.joinSessionId}${state.autoConfirmJoins ? " (auto-confirm)" : ""}`);
  }

  /** Stands in for the app or the pairing page confirming the short code. */
  async function confirmStudyJoinRoute(res: http.ServerResponse, id: string): Promise<void> {
    const session = state.studyJoins.get(id);
    if (!session) return json(res, 404, { error: "not_found" });
    if (session.status === "pending") confirmStudyJoin(session);
    json(res, 200, { status: session.status });
  }

  /** Dev-only: simulate a person declining on the confirming device. */
  async function refuseStudyJoin(res: http.ServerResponse, id: string): Promise<void> {
    const session = state.studyJoins.get(id);
    if (!session) return json(res, 404, { error: "not_found" });
    session.status = "refused";
    session.reason = "Declined on the confirming device.";
    log(`${DIM}${time()}${RESET} \x1b[31mstudy-join refused${RESET} ${session.joinSessionId} (simulated)`);
    json(res, 200, { status: "refused" });
  }

  function studyJoinStatus(res: http.ServerResponse, id: string): void {
    const session = state.studyJoins.get(id);
    if (!session) return json(res, 404, { error: "not_found" });
    if (session.status === "pending" && Date.parse(session.expiresAt) < Date.now()) {
      session.status = "expired";
      session.reason = "This code expired before it was confirmed.";
    }
    json(res, 200, {
      status: session.status,
      grants: session.status === "confirmed" ? session.grants : null,
      reason: session.reason
    });
  }

  function authTool(req: http.IncomingMessage): Tool | undefined {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    return [...state.tools.values()].find((t) => t.token === bearer);
  }

  async function ingest(req: http.IncomingMessage, res: http.ServerResponse, batch: boolean): Promise<void> {
    const tool = authTool(req);
    if (!tool || tool.revoked) return json(res, 401, { error: "Invalid token or revoked tool connection" });
    if (!state.consentActive) return json(res, 403, { error: "consent_missing_or_expired" });

    const body = await readJson(req);
    const events = batch ? ((body as { events?: unknown[] }).events ?? []) : [body];
    const results: Array<{ index: number; status: string; reason?: string }> = [];
    let accepted = 0;

    events.forEach((raw, index) => {
      const event = raw as AscendaEventPayload;
      if (!event || typeof event !== "object" || !event.eventType || !event.source) {
        results.push({ index, status: "rejected", reason: "malformed" });
        return;
      }
      const category: WorkloadCategory = EVENT_WORKLOAD_CATEGORY[event.eventType] ?? "unclassified";
      if (category === "unclassified") state.unclassified += 1;
      const received: ReceivedEvent = { ...event, category, receivedAt: new Date().toISOString() };
      state.events.push(received);
      tool.lastSeenAt = received.receivedAt;
      accepted += 1;
      printEvent(received);
    });

    if (batch) return json(res, 200, { accepted, rejected: results.length, results });
    if (accepted === 0) return json(res, 400, { error: "malformed_payload" });
    json(res, 200, { status: "accepted" });
  }

  async function renew(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const tool = authTool(req);
    if (!tool || tool.revoked) return json(res, 401, { error: "Invalid token or revoked tool connection" });
    tool.token = `devtok_${crypto.randomBytes(24).toString("hex")}`;
    log(`${DIM}${time()}${RESET} token renewed for ${tool.toolInstallationId}`);
    json(res, 200, { eventWriteToken: tool.token, expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString() });
  }

  function printEvent(event: ReceivedEvent): void {
    const color = CATEGORY_COLOR[event.category];
    const meta = event.metadata && Object.keys(event.metadata).length > 0 ? ` ${DIM}${JSON.stringify(event.metadata)}${RESET}` : "";
    log(`${DIM}${time()}${RESET} ${event.source.padEnd(16)} ${color}${event.eventType.padEnd(30)}${RESET} ${color}[${event.category}]${RESET} ${event.severity}${meta}`);
  }

  return { server, state };
}

function time(): string {
  return new Date().toTimeString().slice(0, 8);
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
