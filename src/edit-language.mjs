// Deterministic SEARCH/REPLACE edit language for bounded software patches.
// Groq Llama-70B, produced a correct edit for a real bounty this way; unified diffs and the
// tiny model did not). More reliable for free models than unified diffs, and applied by
// deterministic string replacement instead of fragile hunk headers.
//
// TOLERANT by design: models often write the file path after `<<<<<<<` instead of "SEARCH",
// so the parser accepts any suffix on the marker lines.

import { lstatSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const EDIT_SYSTEM_PROMPT =
  "You output ONLY edit blocks, nothing else. Each edit block is EXACTLY:\n" +
  "<<<<<<< SEARCH\n(exact existing lines, copied verbatim)\n=======\n(replacement lines)\n>>>>>>> REPLACE\n" +
  "The SEARCH text must match the file byte-for-byte. Include ONLY the exact lines you are changing plus minimal surrounding context — NEVER whole files, NEVER unchanged import lines. The REPLACE must not duplicate any line that already exists outside the SEARCH region.";

export function buildEditMessages({ task, filePath, source, failures = [] }) {
  const fail = failures.map((f) => f.test || f.apply).filter(Boolean).slice(-2).join("\n");
  return [
    { role: "system", content: EDIT_SYSTEM_PROMPT },
    { role: "user", content: `${task.title || ""}\n${task.body || ""}\n\nFile ${filePath}:\n${source}${fail ? `\n\nPrior failed attempts:\n${fail}` : ""}` },
  ];
}

/** Find the only complete line-delimited SEARCH match. A substring of a
 * longer line or an ambiguous duplicate is not admissible source identity. */
function exactLineOccurrence(source, needle) {
  let found = -1;
  for (let index = source.indexOf(needle); index !== -1; index = source.indexOf(needle, index + 1)) {
    const beginning = index === 0 || source[index - 1] === "\n";
    const ending = index + needle.length === source.length || source[index + needle.length] === "\n";
    if (!beginning || !ending) continue;
    if (found !== -1) return { reason: "ambiguous SEARCH matches multiple source locations" };
    found = index;
  }
  return found < 0 ? { reason: "SEARCH block not found as complete lines" } : { index: found };
}

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");

/** Apply generated SEARCH/REPLACE blocks as one source-local transaction.
 * Reject ambiguous matches, non-block prose, malformed delimiters and stale
 * source revisions. A refusal has no candidate result and no partial edits.
 *
 * expectedSourceSha256 is optional for legacy callers; write-authorized
 * callers must pass the SHA-256 from the source snapshot being edited.
 */
export function applyEditBlocks(source, text, { expectedSourceSha256 } = {}) {
  const fail = reason => ({ ok: false, count: 0, reason });
  if (typeof source !== "string" || typeof text !== "string")
    return fail("source and proposal must be strings");
  const sourceSha256 = sha256(source);
  if (expectedSourceSha256 !== undefined &&
      (typeof expectedSourceSha256 !== "string" ||
       !/^[0-9a-f]{64}$/u.test(expectedSourceSha256) ||
       expectedSourceSha256 !== sourceSha256))
    return fail("source changed since this edit was prepared");
  const block = /<<<<<<<[^\n]*\n([\s\S]*?)\n=======[^\n]*\n([\s\S]*?)\n>>>>>>>[^\n]*/gu;
  let result = source;
  let count = 0;
  let endOfPreviousBlock = 0;
  for (const match of text.matchAll(block)) {
    if (text.slice(endOfPreviousBlock, match.index).trim() !== "")
      return fail("proposal contains text outside SEARCH/REPLACE blocks");
    endOfPreviousBlock = match.index + match[0].length;
    const [search, replacement] = [match[1], match[2]];
    if (search.trim() === "")
      return fail("empty SEARCH is not an edit; use the distinct create action");
    const position = exactLineOccurrence(result, search);
    if (position.reason) return fail(position.reason);
    result = result.slice(0, position.index) + replacement +
      result.slice(position.index + search.length);
    count += 1;
  }
  if (text.slice(endOfPreviousBlock).trim() !== "")
    return fail("proposal contains text outside SEARCH/REPLACE blocks");
  if (count === 0) return fail("proposal must contain at least one complete edit block");
  return { ok: true, count, result, sourceSha256, resultSha256: sha256(result) };
}

// Creation is deliberately a different language act from SEARCH/REPLACE.  It
// validates the host-supplied, admitted workspace boundary but leaves the
// actual write and its verification/rollback with the process-node host.
export function prepareCreateArtifact({ workspace, path, content, writablePaths = [] } = {}) {
  const refuse = reason => ({ ok: false, reason });
  if (typeof workspace !== "string" || !workspace)
    return refuse("create requires an isolated workspace");
  // Filesystems and package tools can interpret redundant separators, Windows
  // separators and dot segments differently. Admit one normalized POSIX path.
  if (typeof path !== "string" || !path || isAbsolute(path) ||
      path.includes("\\") || path.includes("\0") ||
      path.split("/").some(segment => !segment || segment === "." || segment === ".." || segment === ".git"))
    return refuse("create path must be a confined normalized relative path");
  if (typeof content !== "string") return refuse("create requires string content");
  if (!Array.isArray(writablePaths) || !writablePaths.includes(path))
    return refuse(`create path is outside declared writable paths: ${path}`);

  let root;
  try {
    root = realpathSync(workspace);
    if (resolve(workspace) !== root || !statSync(root).isDirectory())
      return refuse("workspace must be an exact non-symlink directory");
  } catch {
    return refuse("create requires an existing isolated workspace");
  }
  const target = resolve(root, path);
  if (target === root || !target.startsWith(`${root}${sep}`) ||
      relative(root, target).startsWith(`..${sep}`))
    return refuse("create path escapes the isolated workspace");

  // existsSync follows symlinks and returns false for dangling links.
  // lstat every existing path component instead, refusing even dangling links
  // and any non-directory ancestor. The write host must recheck immediately
  // before its exclusive create; this pure planner does not reserve a path.
  let cursor = root;
  for (const [index, segment] of path.split("/").entries()) {
    cursor = resolve(cursor, segment);
    let node;
    try { node = lstatSync(cursor); }
    catch (error) {
      if (error?.code === "ENOENT") break;
      return refuse("create cannot inspect workspace path");
    }
    if (node.isSymbolicLink()) return refuse("create path contains a symbolic link");
    if (index === path.split("/").length - 1)
      return refuse("create requires a target absent from the isolated workspace");
    if (!node.isDirectory()) return refuse("create path ancestor is not a directory");
  }
  return { ok: true, path: target, content };
}
