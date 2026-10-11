import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
