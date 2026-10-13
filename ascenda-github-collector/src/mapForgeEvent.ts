import { AscendaTelemetryEventType, AscendaEventMetadata } from "@ascenda-one/tool-contract";
import { forgeBranchKey, forgeProjectHash, forgeRepoKey } from "@ascenda-one/tool-kit";

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
 * repo" stays answerable without naming it, and the head branch to a digest so
 * a coding session on that branch can be matched to the pull request. Nothing
 * else about the change is carried. There is no field on the emitted metadata
 * that a title or a body could be placed in.
 *
 * ## Matching a session
 *
 * A pull request of yours carries `repoKey` and `branchKey`, computed the way
 * the hooks compute them on a developer's machine (see forgeProject.ts), and
 * the times GitHub gives for it being created, closed and merged. The keys are
 * unsalted, so anyone who guesses a repository or branch name can confirm it.
 * That is the trade-off the repository digest already made, with a branch name
 * added.
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
        metadata: { ...base(payload), ...pullRequestKeys(pr) }
      }];
    }

    // How a pull request of mine ended. Merging is mine to record whoever
    // pressed the button: the merger's identity is not read, only that my pull
    // request is done and when.
    if (action === "closed" && author === viewer) {
      const merged = pr["merged"] === true;
      return [{
        eventType: merged ? "pull_request_merged" : "pull_request_closed",
        severity: "low",
        metadata: { ...base(payload), ...pullRequestKeys(pr), ...pullRequestTimes(pr, merged) }
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
    ...(repo ? { projectHash: forgeProjectHash(repo), repoKey: forgeRepoKey(repo) } : {})
  };
}

/**
 * The keys a session on this pull request's head branch carries.
 *
 * A clone of a fork has the fork as `origin`, so its sessions are keyed by the
 * fork, not by the base repository. The branch key therefore uses the head
 * repository when GitHub gives one, and `headRepoKey` names it when it isn't
 * the base. No branch key on the head repository's default branch, which is
 * where the hooks leave it off too.
 */
function pullRequestKeys(pr: Record<string, unknown>): AscendaEventMetadata {
  const head = obj(pr["head"]);
  const headRepo = obj(head["repo"]);
  const headName = str(headRepo["full_name"]);
  const base = str(obj(obj(pr["base"])["repo"])["full_name"]);
  const branch = str(head["ref"]);
  const keyName = headName ?? base;
  const onDefault = branch !== undefined && branch === str(headRepo["default_branch"]);
  return {
    ...(headName && base && headName.toLowerCase() !== base.toLowerCase() ? { headRepoKey: forgeRepoKey(headName) } : {}),
    ...(keyName && branch && !onDefault ? { branchKey: forgeBranchKey(keyName, branch) } : {})
  };
}

/** `repoKey` is the base repository's; see {@link pullRequestKeys} for the head's. */
function pullRequestTimes(pr: Record<string, unknown>, merged: boolean): AscendaEventMetadata {
  const created = timestamp(pr["created_at"]);
  const closed = timestamp(pr["closed_at"]);
  const mergedAt = merged ? timestamp(pr["merged_at"]) : undefined;
  return {
    ...(created ? { prCreatedAt: created } : {}),
    ...(closed ? { prClosedAt: closed } : {}),
    ...(mergedAt ? { prMergedAt: mergedAt } : {})
  };
}

/** An ISO 8601 string GitHub sent, normalised, or nothing for anything else. */
function timestamp(value: unknown): string | undefined {
  const text = str(value);
  if (!text) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
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
