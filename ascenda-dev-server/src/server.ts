import * as crypto from "node:crypto";
import * as http from "node:http";
import {
  ASCENDA_TOOL_TYPES,
  AscendaEventPayload,
  EVENT_WORKLOAD_CATEGORY,
  StudyJoinGrant,
  StudyJoinRefusedReason,
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
  /** The study join riding on this pairing, when the create call carried `orgJoinCode`. */
  joinSessionId?: string;
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
  deviceCode: string;
  toolInstallationId: string;
  organisationName: string;
  studyKind: string;
  windowStartUtc: string;
  windowEndUtc: string;
  /** What Start showed — never what to report back on confirm/refuse; see {@link granted}. */
  grants: StudyJoinGrant[];
  status: "pending" | "confirmed" | "expired" | "refused";
  expiresAt: string;
  refusedReason: StudyJoinRefusedReason | null;
  /**
   * What actually landed, read back independently of {@link grants} — null
   * until confirmed (in full) or refused as `grant_failed` (a real, possibly
   * empty, partial list), the same distinction the real backend's readback
   * makes rather than mirroring what Start showed.
   */
  granted: StudyJoinGrant[] | null;
};

/** A join code the mock recognises but treats as having nothing live to join — the same answer a department-scoped study gives a CLI join, which carries no department. */
const NO_LIVE_STUDY_CODE = "DEPT-ONLY-2026";

/**
 * Fixture join codes for `join` to exercise locally. What a real code
 * resolves to (the organisation, the study, its window, what Report mode
 * grants) lives entirely server-side; this table is that server for a
 * machine with no backend. Grant codes 501 (`AiDataProcessing`) and 507
 * (`HistoricalImport`) are the wire's own internal names, not display text —
 * `join` renders its own plain sentence per grant `code`, so changing the
 * `name` spelling here proves nothing about what a person actually sees.
 */
const STUDY_JOIN_CODES: Readonly<Record<string, Omit<StudyJoinSession, "joinSessionId" | "deviceCode" | "toolInstallationId" | "status" | "expiresAt" | "refusedReason" | "granted">>> = {
  "NORTHVIEW-2026": {
    organisationName: "Northview Health",
    // The backend's own internal kind name, not display text — `join`
    // translates it, same as it does grant `name`.
    studyKind: "Report30",
    windowStartUtc: "2026-10-13T00:00:00.000Z",
    windowEndUtc: "2026-11-10T00:00:00.000Z",
    // Exactly two, confirmed 28 Sep 2026: Report mode carries no third,
    // agent-observed grant.
    grants: [
      { code: 501, name: "AiDataProcessing" },
      { code: 507, name: "HistoricalImport" }
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
   * outcomes by hand through `/v1/org-study-join-sessions/confirm-device-code`
   * and `/_dev/org-study-join-sessions/:id/refuse`.
   */
  autoConfirmJoins?: boolean;
  /**
   * Start with the history-import consent (grant 507) already active
   * (default true, so `import --ship --local` works with no join). False
   * starts without it, the way the real backend does: pairing never grants
   * it, a confirmed join that carries 507 does, and until then every
   * historical event is rejected `consent_missing_or_expired`.
   */
  historicalImportLease?: boolean;
  /**
   * Take `orgJoinCode` on a pairing session and answer with `studyJoin`
   * (default true, as the real backend does). False behaves like a server
   * that has never heard of the field: the code is ignored and the response
   * carries no `studyJoin`, which is what a client's fallback path is tested
   * against.
   */
  pairingCarriesJoin?: boolean;
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
    /** The history-import consent (grant 507). See `historicalImportLease` on the options. */
    historicalImportLease: boolean;
    /** `<toolInstallationId>|<importKey>` for every event stored under a key, so a replay answers `duplicate`. */
    importKeys: Set<string>;
    autoConfirm: boolean;
    autoConfirmJoins: boolean;
    pairingCarriesJoin: boolean;
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
    historicalImportLease: opts.historicalImportLease ?? true,
    importKeys: new Set(),
    autoConfirm: opts.autoConfirm ?? true,
    autoConfirmJoins: opts.autoConfirmJoins ?? (opts.autoConfirm ?? true),
    pairingCarriesJoin: opts.pairingCarriesJoin ?? true,
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

    const declineMatch = path.match(/^\/_dev\/tool-pairing-sessions\/([^/]+)\/decline$/);
    if (method === "POST" && declineMatch) return declinePairing(res, decodeURIComponent(declineMatch[1]));

    // --- org study join ---
    if (method === "POST" && path === "/v1/org-study-join-sessions") return startStudyJoinRoute(req, res);
    if (method === "POST" && path === "/v1/org-study-join-sessions/confirm-device-code") return confirmStudyJoinRoute(req, res);
    const joinStatusMatch = path.match(/^\/v1\/org-study-join-sessions\/([^/]+)\/status$/);
    if (method === "GET" && joinStatusMatch) return studyJoinStatus(res, decodeURIComponent(joinStatusMatch[1]));
    const joinRefuseMatch = path.match(/^\/_dev\/org-study-join-sessions\/([^/]+)\/refuse$/);
    if (method === "POST" && joinRefuseMatch) return refuseStudyJoin(req, res, decodeURIComponent(joinRefuseMatch[1]));

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
    const body = (await readJson(req)) as { toolInstallationId?: string; toolType?: string; displayName?: string | null; orgJoinCode?: string; mode?: string };
    if (!body.toolInstallationId || !body.toolType) return json(res, 400, { error: "invalid_request" });
    if (!(ASCENDA_TOOL_TYPES as readonly string[]).includes(body.toolType)) return json(res, 400, { error: "unknown_tool_type" });

    // The same refusals, with the same codes, as the join door.
    const carriedCode = state.pairingCarriesJoin ? body.orgJoinCode : undefined;
    let info: (typeof STUDY_JOIN_CODES)[string] | undefined;
    if (carriedCode) {
      if (body.mode !== "report") return json(res, 400, { error: "Unsupported join mode", code: "unknown_mode" });
      if (carriedCode === NO_LIVE_STUDY_CODE) return json(res, 404, { error: "Nothing live to join", code: "no_live_study" });
      info = STUDY_JOIN_CODES[carriedCode];
      if (!info) return json(res, 404, { error: "Unknown join code", code: "join_code_not_found" });
    }

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
    let join: StudyJoinSession | undefined;
    if (info) {
      join = {
        joinSessionId: crypto.randomUUID(),
        deviceCode: session.code,
        toolInstallationId: session.toolInstallationId,
        ...info,
        status: "pending",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        refusedReason: null,
        granted: null
      };
      session.joinSessionId = join.joinSessionId;
      state.studyJoins.set(join.joinSessionId, join);
      log(`${DIM}${time()}${RESET} pairing carries a join -> ${info.organisationName}`);
    }
    if (state.autoConfirm) {
      pair(session);
      if (join && state.autoConfirmJoins) confirmStudyJoin(join);
    }

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
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      ...(join ? { studyJoin: { organisationName: join.organisationName, mode: "report", windowStartUtc: join.windowStartUtc, windowEndUtc: join.windowEndUtc } } : {})
    });
  }

  /** Dev-only: the person declining on the review page. Refuses the pairing and the join together. */
  function declinePairing(res: http.ServerResponse, sessionId: string): void {
    const session = state.sessions.get(sessionId);
    if (!session) return json(res, 404, { error: "not_found" });
    session.status = "cancelled";
    const join = session.joinSessionId ? state.studyJoins.get(session.joinSessionId) : undefined;
    if (join) {
      join.status = "refused";
      join.refusedReason = "declined";
      join.granted = null;
    }
    log(`${DIM}${time()}${RESET} \x1b[31mpairing declined${RESET} ${session.toolInstallationId}${join ? " (and its join)" : ""}`);
    json(res, 200, { status: "cancelled" });
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
    const join = session.joinSessionId ? state.studyJoins.get(session.joinSessionId) : undefined;
    // A pairing that carries a join is confirmed from its link, where the
    // person sees what they are agreeing to. A typed code is turned away.
    if (join && by !== "secret") return json(res, 409, { error: "study_join_needs_review", code: "study_join_needs_review" });
    if (session.status !== "paired") pair(session);
    if (join && join.status === "pending") confirmStudyJoin(join);
    json(res, 200, { status: "paired" });
  }

  function status(res: http.ServerResponse, sessionId: string): void {
    const session = state.sessions.get(sessionId);
    if (!session) return json(res, 404, { error: "not_found" });
    const join = session.joinSessionId ? state.studyJoins.get(session.joinSessionId) : undefined;
    const studyJoin = join
      ? {
          studyJoin: {
            joinSessionId: join.joinSessionId,
            status: join.status,
            organisationName: join.organisationName,
            studyKind: join.studyKind,
            mode: "report",
            windowStartUtc: join.windowStartUtc,
            windowEndUtc: join.windowEndUtc,
            granted: join.granted,
            refusedReason: join.status === "refused" ? join.refusedReason : null
          }
        }
      : {};
    if (session.status !== "paired") {
      return json(res, 200, { status: session.status, toolInstallationId: null, eventWriteToken: null, pairedAt: null, ...studyJoin });
    }
    // Contract: token only on the first paired poll.
    const token = session.tokenIssued ? null : state.tools.get(session.toolInstallationId)?.token ?? null;
    session.tokenIssued = true;
    json(res, 200, { status: "paired", toolInstallationId: session.toolInstallationId, eventWriteToken: token, pairedAt: session.pairedAt, ...studyJoin });
  }

  /**
   * `mode` is always `"report"` from a real CLI (it is the only mode `join`
   * offers; `study` is refused here too, matching the real door), checked
   * anyway because this is the mock's one contract boundary worth guarding:
   * a caller sending anything else is a bug, not a person's choice.
   */
  async function startStudyJoinRoute(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const tool = authTool(req);
    if (!tool || tool.revoked) return json(res, 401, { error: "Invalid token or revoked tool connection" });

    const body = (await readJson(req)) as { joinCode?: string; mode?: string };
    if (!body.joinCode) return json(res, 400, { error: "invalid_request" });
    if (body.mode !== "report") return json(res, 400, { error: "Unsupported join mode", code: "unknown_mode" });
    if (body.joinCode === NO_LIVE_STUDY_CODE) return json(res, 404, { error: "Nothing live to join", code: "no_live_study" });

    const info = STUDY_JOIN_CODES[body.joinCode];
    if (!info) return json(res, 404, { error: "Unknown join code", code: "join_code_not_found" });

    const session: StudyJoinSession = {
      joinSessionId: crypto.randomUUID(),
      deviceCode: String(Math.floor(100000 + Math.random() * 900000)),
      toolInstallationId: tool.toolInstallationId,
      ...info,
      status: "pending",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      refusedReason: null,
      granted: null
    };
    state.studyJoins.set(session.joinSessionId, session);
    log(`${DIM}${time()}${RESET} study-join session for ${tool.toolInstallationId} -> ${info.organisationName} (code ${session.deviceCode})`);
    if (state.autoConfirmJoins) confirmStudyJoin(session);

    json(res, 200, {
      joinSessionId: session.joinSessionId,
      deviceCode: session.deviceCode,
      expiresAt: session.expiresAt,
      organisationName: session.organisationName,
      studyKind: session.studyKind,
      windowStartUtc: session.windowStartUtc,
      windowEndUtc: session.windowEndUtc,
      grants: session.grants
    });
  }

  function confirmStudyJoin(session: StudyJoinSession): void {
    session.status = "confirmed";
    // The real backend reads back what actually landed rather than
    // mirroring what Start showed; this mock's "full success" path has
    // nothing that can fail, so its readback is simply everything.
    session.granted = session.grants;
    grantLeases(session.granted);
    log(`${DIM}${time()}${RESET} \x1b[32mstudy-join confirmed${RESET} ${session.joinSessionId}${state.autoConfirmJoins ? " (auto-confirm)" : ""}`);
  }

  /**
   * Stands in for the app confirming the device code — a signed-in user's
   * call, never the CLI's own. The real door authenticates with a user
   * session token; this mock only checks that *some* Authorization header
   * is present, the same minimum the pairing confirm routes above already
   * accept.
   */
  async function confirmStudyJoinRoute(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!req.headers.authorization) return json(res, 401, { error: "unauthorized" });
    const body = (await readJson(req)) as { deviceCode?: string };
    const session = [...state.studyJoins.values()].find((s) => s.deviceCode === body.deviceCode);
    if (!session) return json(res, 400, { error: "invalid_or_expired" });
    // A join riding on a pairing is confirmed with the pairing, from its link.
    if ([...state.sessions.values()].some((pairing) => pairing.joinSessionId === session.joinSessionId)) {
      return json(res, 409, { error: "study_join_needs_review", code: "study_join_needs_review" });
    }
    if (session.status === "pending") confirmStudyJoin(session);
    json(res, 200, { status: session.status, granted: session.granted });
  }

  /**
   * Dev-only: simulate a refusal — the study closing before confirmation,
   * the confirming person no longer being an enrolled participant, the
   * person declining on the confirming surface, or a grant failing
   * partway through. `reason` in the body picks which `refusedReason` the
   * status poll reports; defaults to `study_no_longer_live`. There is no
   * sixth "wrong tool" reason: a mismatched device code is indistinguishable
   * from one that does not exist, refused at the confirm call itself (400
   * `invalid_or_expired`), never reaching a session this route could act on.
   *
   * For `grant_failed` only, an optional `grantedCodes` array in the body
   * (a subset of the codes this session's own `grants` carries) simulates
   * which of them landed before the failure — real, active, and reported
   * back even though the join as a whole did not complete. Omitted or
   * empty means nothing landed.
   */
  async function refuseStudyJoin(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const session = state.studyJoins.get(id);
    if (!session) return json(res, 404, { error: "not_found" });
    const body = (await readJson(req)) as { reason?: StudyJoinRefusedReason; grantedCodes?: number[] };
    const knownReasons: StudyJoinRefusedReason[] = ["withdrawn", "grant_failed", "declined", "not_enrolled"];
    session.status = "refused";
    session.refusedReason = body.reason && knownReasons.includes(body.reason) ? body.reason : "study_no_longer_live";
    if (session.refusedReason === "grant_failed") {
      const landed = session.grants.filter((grant) => (body.grantedCodes ?? []).includes(grant.code));
      // The real backend reports null, not an empty array, when nothing landed before the failure.
      session.granted = landed.length > 0 ? landed : null;
      grantLeases(landed);
    } else {
      session.granted = null;
    }
    log(`${DIM}${time()}${RESET} \x1b[31mstudy-join refused${RESET} ${session.joinSessionId} (simulated: ${session.refusedReason})`);
    json(res, 200, { status: "refused" });
  }

  /** A join's grants that this mock gates on. 501 is `consentActive`, which starts on. */
  function grantLeases(granted: StudyJoinGrant[]): void {
    if (granted.some((grant) => grant.code === 507)) state.historicalImportLease = true;
  }

  function studyJoinStatus(res: http.ServerResponse, id: string): void {
    const session = state.studyJoins.get(id);
    if (!session) return json(res, 404, { error: "unknown_session" });
    if (session.status === "pending" && Date.parse(session.expiresAt) < Date.now()) {
      session.status = "expired";
    }
    json(res, 200, {
      status: session.status,
      granted: session.granted,
      refusedReason: session.status === "refused" ? session.refusedReason : null
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
    let duplicate = 0;

    events.forEach((raw, index) => {
      const event = raw as AscendaEventPayload;
      if (!event || typeof event !== "object" || !event.eventType || !event.source) {
        results.push({ index, status: "rejected", reason: "malformed" });
        return;
      }
      // A historical provenance needs the history-import consent, whatever
      // scope the event claims, and the backend answers per item.
      if (HISTORICAL_PROVENANCES.has(String(event.provenance)) && !state.historicalImportLease) {
        results.push({ index, status: "rejected", reason: "consent_missing_or_expired" });
        return;
      }
      const importKey = event.metadata?.importKey;
      if (typeof importKey === "string" && importKey) {
        const key = `${tool.toolInstallationId}|${importKey}`;
        if (state.importKeys.has(key)) {
          results.push({ index, status: "duplicate", reason: "already_imported" });
          duplicate += 1;
          return;
        }
        state.importKeys.add(key);
      }
      const category: WorkloadCategory = EVENT_WORKLOAD_CATEGORY[event.eventType] ?? "unclassified";
      if (category === "unclassified") state.unclassified += 1;
      const received: ReceivedEvent = { ...event, category, receivedAt: new Date().toISOString() };
      state.events.push(received);
      tool.lastSeenAt = received.receivedAt;
      accepted += 1;
      printEvent(received);
      results.push({ index, status: "accepted" });
    });

    if (batch) return json(res, 200, { accepted, duplicate, rejected: events.length - accepted - duplicate, results });
    if (duplicate === 1) return json(res, 200, { status: "duplicate" });
    if (results[0]?.reason === "consent_missing_or_expired") return json(res, 403, { error: "consent_missing_or_expired" });
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

const HISTORICAL_PROVENANCES = new Set(["historical_direct", "historical_derived", "historical_unparsed"]);

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
