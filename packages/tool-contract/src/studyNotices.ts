/**
 * A purpose of the person's own organisation study that the organisation
 * counts on a notice basis: the person is counted unless they object. One
 * entry per such purpose in the list a paired tool can read; the list is
 * empty when the organisation counts nothing that way, which is the default.
 *
 * An objection belongs to the person and the purpose, not to an
 * organisation: someone in two organisations that both notice the same
 * purpose objects once, and both entries show it.
 *
 * Everything here is about the person reading it. The list never carries
 * anything about anyone else: no counts, and nothing about other people's
 * objections.
 */
export type StudyNotice = {
  organisationName: string;
  /** The purpose's stable numeric code. Only live tool telemetry, the imported history and the work-pattern axes can ever be noticed. */
  code: number;
  /** The purpose's internal name. Never display text. */
  name: string | null;
  /** The name a notice purpose goes by on every surface. The server sends `Counted unless you object`. */
  label: string | null;
  /** Who processes this for the organisation. The server sends `Ascenda`. */
  processor: string | null;
  /** The organisation's recorded basis, as a key: `legitimate_interests`, `collective_agreement`, or another the client may not know. */
  basis: string;
  /** Plain words for `basis`, for a key this client doesn't know. Optional. */
  basisLabel: string | null;
  /** The organisation's own document: its title, date and reference. Ascenda keeps the reference, never the document. */
  documentTitle: string | null;
  documentDate: string | null;
  documentReference: string | null;
  /** The person at the organisation who recorded the basis. */
  signatoryName: string | null;
  /** Whether this person has objected. `null` when the reply didn't say. */
  objected: boolean | null;
  objectedAtUtc: string | null;
  /** When the notice reached this person: the later of their joining and the organisation's mode taking effect. */
  noticeFromUtc: string | null;
  /** When counting can begin: the notice date plus the notice period. */
  countingFromUtc: string | null;
};
