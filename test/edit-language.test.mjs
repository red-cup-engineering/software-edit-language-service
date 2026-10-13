import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { applyEditBlocks, buildEditMessages, EDIT_SYSTEM_PROMPT, prepareCreateArtifact } from "../src/edit-language.mjs";

const src = "const id = `usr_${Date.now()}`;\nconst sub = `usr_${Date.now()}`;\n";

test("applies a clean SEARCH/REPLACE block", () => {
  const text = "<<<<<<< SEARCH\nconst sub = `usr_${Date.now()}`;\n=======\nconst sub = id;\n>>>>>>> REPLACE";
  const r = applyEditBlocks(src, text);
  assert.equal(r.ok, true);
  assert.match(r.result, /const sub = id;/);
});

test("tolerates a filename suffix on the markers (the real Groq failure mode)", () => {
  const text = "<<<<<<< path/to/file.js\nconst sub = `usr_${Date.now()}`;\n=======\nconst sub = id;\n>>>>>>> REPLACE";
  const r = applyEditBlocks(src, text);
  assert.equal(r.ok, true);
  assert.match(r.result, /const sub = id;/);
});

test("fails cleanly when SEARCH is not byte-exact", () => {
  const text = "<<<<<<< SEARCH\nnot in the file\n=======\nx\n>>>>>>> REPLACE";
  const r = applyEditBlocks(src, text);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not found/);
});

test("empty SEARCH is refused instead of becoming a creation bypass", () => {
  const text = "<<<<<<< SEARCH\n\n=======\nWHOLE NEW FILE\n>>>>>>> REPLACE";
  const r = applyEditBlocks(src, text);
  assert.equal(r.ok, false);
  assert.match(r.reason, /distinct create action/);
});

test("prepareCreateArtifact admits only an absent explicitly writable confined target", () => {
  const workspace = mkdtempSync(join(tmpdir(), "union-edit-create-"));
  const admitted = prepareCreateArtifact({ workspace, path: "test/new.mjs", content: "export {};\n", writablePaths: ["test/new.mjs"] });
  assert.equal(admitted.ok, true);
  assert.equal(admitted.content, "export {};\n");
  assert.equal(prepareCreateArtifact({ workspace, path: "test/new.mjs", content: 1, writablePaths: ["test/new.mjs"] }).ok, false);
  assert.equal(prepareCreateArtifact({ workspace, path: "../escape.mjs", content: "x", writablePaths: ["../escape.mjs"] }).ok, false);
  assert.equal(prepareCreateArtifact({ workspace, path: "test/other.mjs", content: "x", writablePaths: ["test/new.mjs"] }).ok, false);
  writeFileSync(join(workspace, "existing.mjs"), "export {};\n");
  assert.equal(prepareCreateArtifact({ workspace, path: "existing.mjs", content: "x", writablePaths: ["existing.mjs"] }).ok, false);
});

test("buildEditMessages carries the strict format prompt + file", () => {
  const msgs = buildEditMessages({ task: { title: "fix", body: "b" }, filePath: "a.js", source: "code" });
  assert.equal(msgs[0].content, EDIT_SYSTEM_PROMPT);
  assert.match(msgs[1].content, /File a\.js/);
});

test("generated edits reject ambiguous repeated source lines instead of silently choosing the first", () => {
  const source = "const x = 1;\nconst x = 1;\n";
  const patch = "<<<<<<< SEARCH\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> REPLACE";
  const result = applyEditBlocks(source, patch);
  assert.equal(result.ok, false);
  assert.equal(result.count, 0);
  assert.equal(Object.hasOwn(result, "result"), false);
  assert.match(result.reason, /ambiguous/);
});

test("generated SEARCH must match whole source lines and not arbitrary substrings", () => {
  const source = "const username = user;\n";
  const patch = "<<<<<<< SEARCH\nname = user;\n=======\nname = other;\n>>>>>>> REPLACE";
  const result = applyEditBlocks(source, patch);
  assert.equal(result.ok, false);
  assert.match(result.reason, /complete lines/);
});

test("multi-block generation refuses all partial output when a later block fails", () => {
  const source = "const a = 1;\nconst b = 2;\n";
  const proposal = "<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 3;\n>>>>>>> REPLACE\n" +
    "<<<<<<< SEARCH\nconst c = 99;\n=======\nconst c = 1;\n>>>>>>> REPLACE";
  const result = applyEditBlocks(source, proposal);
  assert.equal(result.ok, false);
  assert.equal(result.count, 0);
  assert.equal(Object.hasOwn(result, "result"), false);
  assert.equal(source, "const a = 1;\nconst b = 2;\n");
});

test("editing a stale revision is rejected and exact SHA-pinned multi-block edits succeed", () => {
  const source = "let a = 1;\nlet b = 2;\n";
  const digest = createHash("sha256").update(source).digest("hex");
  const patch = "<<<<<<< SEARCH\nlet a = 1;\n=======\nlet a = 3;\n>>>>>>> REPLACE\n" +
    "<<<<<<< SEARCH\nlet b = 2;\n=======\nlet b = 4;\n>>>>>>> REPLACE";
  const ok = applyEditBlocks(source, patch, { expectedSourceSha256: digest });
  assert.equal(ok.ok, true);
  assert.equal(ok.count, 2);
  assert.equal(ok.result, "let a = 3;\nlet b = 4;\n");
  assert.equal(ok.sourceSha256, digest);
  assert.equal(ok.resultSha256, createHash("sha256").update(ok.result).digest("hex"));
  const stale = applyEditBlocks(source + "changed", patch, { expectedSourceSha256: digest });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /source changed/);
});

test("model commentary and malformed edit delimiters cannot accompany a source mutation", () => {
  const patch = "<<<<<<< SEARCH\nconst id = \`usr_\${Date.now()}\`;\n=======\nconst id = 1;\n>>>>>>> REPLACE";
  for (const proposal of ["Here is the fix:\n" + patch, patch + "\nplease approve",
    "<<<<<<< SEARCH\nconst id = 1;\n=======\nconst id = 2;"]) {
    const result = applyEditBlocks(src, proposal);
    assert.equal(result.ok, false);
    assert.equal(result.count, 0);
  }
});

test("create refuses symlink ancestors and dangling symlinks, not only existing regular targets", () => {
  const workspace = mkdtempSync(join(tmpdir(), "edit-symlink-workspace-"));
  const outside = mkdtempSync(join(tmpdir(), "edit-symlink-outside-"));
  symlinkSync(outside, join(workspace, "linked"));
  symlinkSync(join(outside, "missing.mjs"), join(workspace, "dangling.mjs"));
  mkdirSync(join(workspace, "ordinary"));
  writeFileSync(join(workspace, "ordinary", "present.mjs"), "already present");
  const make = path => prepareCreateArtifact({workspace, path, content:"export {};\n", writablePaths:[path]});
  for (const path of ["linked/new.mjs", "dangling.mjs", "ordinary/present.mjs",
    "ordinary//new.mjs", "ordinary/./new.mjs", "ordinary/../new.mjs",
    ".git/config", "ordinary\\\\escape.mjs"]) {
    assert.equal(make(path).ok, false, path);
  }
  assert.equal(make("ordinary/new.mjs").ok, true);
  const alias = join(outside, "workspace-alias");
  symlinkSync(workspace, alias);
  assert.equal(prepareCreateArtifact({workspace:alias,path:"new.mjs",content:"ok",writablePaths:["new.mjs"]}).ok,false);
});
