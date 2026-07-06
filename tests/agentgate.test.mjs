import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseArgs, statusFromResults, resolveProjectPath } from "../scripts/agentgate.mjs";

test("parseArgs reads validate command options", () => {
  const parsed = parseArgs([
    "validate",
    "--target",
    "targets/filesystem.mcp.json",
    "--scenarios",
    "scenarios/filesystem",
    "--out",
    "runs/latest"
  ]);

  assert.equal(parsed.command, "validate");
  assert.equal(parsed.target, "targets/filesystem.mcp.json");
  assert.equal(parsed.scenarios, "scenarios/filesystem");
  assert.equal(parsed.out, "runs/latest");
});

test("statusFromResults fails if any scenario fails", () => {
  assert.equal(statusFromResults([{ status: "pass" }, { status: "fail" }]), "fail");
});

test("resolveProjectPath anchors paths inside the project", () => {
  assert.equal(resolveProjectPath("fixtures/fs-root").endsWith(path.join("fixtures", "fs-root")), true);
});
