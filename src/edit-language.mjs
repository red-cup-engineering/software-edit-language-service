// Deterministic SEARCH/REPLACE edit language for bounded software patches.
// Groq Llama-70B, produced a correct edit for a real bounty this way; unified diffs and the
// tiny model did not). More reliable for free models than unified diffs, and applied by
// deterministic string replacement instead of fragile hunk headers.
//
// TOLERANT by design: models often write the file path after `<<<<<<<` instead of "SEARCH",
// so the parser accepts any suffix on the marker lines.

import { existsSync } from "node:fs";
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

// Apply one or more edit blocks to `source`. Returns { ok, count, result?, reason? }.
export function applyEditBlocks(source, text) {
  const re = /<<<<<<<[^\n]*\n([\s\S]*?)\n=======[^\n]*\n([\s\S]*?)\n>>>>>>>[^\n]*/g;
  let out = source, count = 0, m;
  while ((m = re.exec(String(text || "")))) {
    const search = m[1];
    const replace = m[2];
    if (search.trim() === "") return { ok: false, count, reason: "empty SEARCH is not an edit; use the distinct create action" };
    if (out.includes(search)) { out = out.replace(search, replace); count++; continue; }
    return { ok: false, count, reason: "SEARCH block not found verbatim" };
  }
  return { ok: count > 0, count, result: out };
}

// Creation is deliberately a different language act from SEARCH/REPLACE.  It
// validates the host-supplied, admitted workspace boundary but leaves the
// actual write and its verification/rollback with the process-node host.
export function prepareCreateArtifact({ workspace, path, content, writablePaths = [] } = {}) {
  if (typeof workspace !== "string" || !workspace) return { ok: false, reason: "create requires an isolated workspace" };
  if (typeof path !== "string" || !path || isAbsolute(path) || path.split(/[\\/]/u).includes("..")) {
    return { ok: false, reason: "create path must be a confined relative path" };
  }
  if (typeof content !== "string") return { ok: false, reason: "create requires string content" };
  if (!Array.isArray(writablePaths) || !writablePaths.includes(path)) return { ok: false, reason: `create path is outside declared writable paths: ${path}` };
  const root = resolve(workspace), target = resolve(root, path);
  if (target === root || !target.startsWith(`${root}${sep}`) || relative(root, target).startsWith(`..${sep}`)) {
    return { ok: false, reason: "create path escapes the isolated workspace" };
  }
  if (existsSync(target)) return { ok: false, reason: "create requires a target absent from the isolated workspace" };
  return { ok: true, path: target, content };
}
