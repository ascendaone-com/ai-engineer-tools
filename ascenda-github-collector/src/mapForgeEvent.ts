import { AscendaTelemetryEventType, AscendaEventMetadata } from "@ascenda-one/tool-contract";
import { forgeProjectHash } from "@ascenda-one/tool-kit";

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
    //
    // The digest is an UNSALTED FNV-1a of `owner/repo`, and this step stays
    // deliberately salt-free: it runs in CI from a webhook payload, where the
    // only place a machine salt could come from is a repository secret — which
    // is to say, from everyone who can read the repository's settings. The
    // function now lives in tool-kit so a developer's own machine, which holds
    // both identities, can compute this exact digest and file it beside its
    // own; nothing about what this step emits has changed.
    ...(repo ? { projectHash: forgeProjectHash(repo) } : {})
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

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
