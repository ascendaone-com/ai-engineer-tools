/**
 * The stretches of a shell command where a command name can appear: after
 * separators (`&&`, `||`, `;`, `|`, newlines, subshell parens) and after any
 * `NAME=value` environment prefixes, with heredoc bodies and quoted strings
 * removed first.
 *
 * Shared by the classifiers because they share the defect this prevents:
 * matching anywhere in the string classifies *mentions* of a command — a
 * heredoc body, a commit message — as the command itself. When shell syntax
 * gets too exotic for this to parse, the failure mode is dropping text — an
 * unclassified real action — never inventing one, which is the direction
 * every classifier here must err in.
 */
export function commandHeads(value: string): string[] {
  const stripped = stripQuoted(stripHeredocBodies(value));
  return stripped
    .split(/[;&|()\n]+/)
    .map((segment) => {
      let head = segment.trim();
      // `GH_TOKEN=x gh pr merge …` is still a gh command.
      for (;;) {
        const env = /^[a-z_][a-z0-9_]*=\S*\s+/.exec(head);
        if (!env) break;
        head = head.slice(env[0].length);
      }
      return head;
    })
    .filter((head) => head.length > 0);
}

/**
 * Remove each heredoc body (`<<EOF … EOF`), keeping the line that introduced
 * it. An unterminated heredoc swallows the rest of the string: everything
 * after the marker is body.
 */
function stripHeredocBodies(value: string): string {
  const marker = /<<-?\s*(["']?)(\w+)\1/;
  let kept = "";
  let rest = value;
  for (;;) {
    const opened = marker.exec(rest);
    if (!opened) return kept + rest;
    const introLineEnd = rest.indexOf("\n", opened.index + opened[0].length);
    if (introLineEnd === -1) return kept + rest;
    kept += rest.slice(0, introLineEnd + 1);
    const body = rest.slice(introLineEnd + 1);
    const terminator = new RegExp(`^\\s*${opened[2]}\\s*$`, "m").exec(body);
    if (!terminator) return kept;
    rest = body.slice(terminator.index + terminator[0].length);
  }
}

/**
 * Remove single- and double-quoted regions, so `echo 'gh issue close 88'`
 * has nothing but `echo` in command position. An unterminated quote swallows
 * the rest of the string, matching how the shell would still be reading it.
 */
function stripQuoted(value: string): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === "'") {
      const close = value.indexOf("'", i + 1);
      if (close === -1) return out;
      i = close + 1;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < value.length && value[j] !== '"') {
        j += value[j] === "\\" ? 2 : 1;
      }
      if (j >= value.length) return out;
      i = j + 1;
    } else if (ch === "\\") {
      out += value.slice(i, i + 2);
      i += 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}
