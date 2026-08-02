import { AscendaTelemetryEventType, AscendaEventMetadata } from "@ascenda-one/tool-contract";

export type MappedForgeEvent = {
  eventType: AscendaTelemetryEventType;
  severity: "low";
  metadata: AscendaEventMetadata;
};

/**
 * A GitHub webhook / Actions payload, read defensively. Every field is optional
 * because the collector must never throw on a shape it did not expect — a
 * telemetry mapper that crashes takes the user's CI step down with it.
 */
export type ForgePayload = Record<string, unknown>;

/**
 * Maps a code-forge event to Ascenda's collaboration events (§4.2's
 * collaboration family).
 *
 * ## The one rule that shapes everything here
 *
 * **Only the viewer's own activity is ever emitted.** `viewerLogin` is the
 * person whose installation this is, and an event is produced only when the
 * payload says *they* did the thing or *they* were asked. A payload about two
 * other people produces nothing at all.
 *
 * That is not squeamishness. "Who reviews for whom" is a map of a team, and a
 * wellbeing rail that assembles one has become a management tool. The report's
 * verification-overload concern — checking load concentrating on senior
 * engineers — is still answerable, because it shows up in that person's own
 * supervision share and in cohort aggregates the org rail already suppresses
 * below its minimum cohort size.
 *
 * ## What never travels
 *
 * No repository name, PR title, branch name, PR number, or any other person's
 * login. The repository is reduced to an opaque hash so that "always the same
 * repo" stays answerable without naming it, and nothing else about the change
 * is carried. There is no field on the emitted metadata that a title or a body
 * could be placed in.
 */
export function mapForgeEvent(
  eventName: string | undefined,
  payload: ForgePayload,
  viewerLogin: string | undefined
): MappedForgeEvent[] {
  if (!eventName || !viewerLogin) return [];

  const action = str(payload["action"]);
  const viewer = viewerLogin.toLowerCase();

  if (eventName === "pull_request") {
    const pr = obj(payload["pull_request"]);
    const author = str(obj(pr["user"])["login"])?.toLowerCase();

    if (action === "opened" && author === viewer) {
      return [{
        eventType: "pull_request_opened",
        severity: "low",
        metadata: base(payload)
      }];
    }

    // A review request naming the viewer. The requester is not recorded: what
    // matters to this rail is that checking work arrived, not who sent it.
    if (action === "review_requested") {
      const requested = str(obj(payload["requested_reviewer"])["login"])?.toLowerCase();
      if (requested === viewer) {
        return [{
          eventType: "review_requested_of_me",
          severity: "low",
          metadata: base(payload)
        }];
      }
    }

    return [];
  }

  if (eventName === "pull_request_review" && action === "submitted") {
    const review = obj(payload["review"]);
    const reviewer = str(obj(review["user"])["login"])?.toLowerCase();
    if (reviewer !== viewer) return [];

    return [{
      eventType: "review_given",
      severity: "low",
      metadata: {
        ...base(payload),
        // The verdict is a property of the checking work, not of the author,
        // and it is the closest thing to a "how heavy was this review" signal
        // that carries no content. `commented` and `changes_requested` are
        // more work than `approved`.
        outcome: reviewState(str(review["state"]))
      }
    }];
  }

  return [];
}

function base(payload: ForgePayload): AscendaEventMetadata {
  const repo = str(obj(payload["repository"])["full_name"]);
  return {
    host: "github",
    // Hashed, never the name. "Is it always the same repository" stays
    // answerable; which repository does not travel.
    ...(repo ? { projectHash: hash(repo) } : {})
  };
}

/**
 * A review verdict, mapped onto the shared outcome vocabulary. An approval is
 * a success; anything asking for more work is not a *failure* of the reviewer,
 * so it maps to unknown rather than borrowing a word that would read as blame
 * in an aggregate.
 */
function reviewState(state: string | undefined): "success" | "unknown" {
  return state?.toLowerCase() === "approved" ? "success" : "unknown";
}

/**
 * FNV-1a. Not a security boundary and not pretending to be one — the
 * repository name is low-entropy and a determined holder of the data could
 * guess it. Its job is to keep names out of the payload and stable across
 * events, which is what makes "the same repository" answerable without
 * recording which one.
 */
function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
