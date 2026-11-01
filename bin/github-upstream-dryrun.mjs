#!/usr/bin/env node
// Dry-run the github-upstream sync jobs against the real GitHub API without
// creating, waking or updating anything. State (ETags) persists in --state,
// so a second run with the same file should be nearly all 304s.
//
//   GITHUB_TOKEN=$(cat ~/.paperclip/github-upstream-token) \
//   paperclip-github-upstream-dryrun \
//     --cards ./cards.json --config ./config.json --state ./dryrun-state.json
//
// cards.json: the follow-through tracker children, e.g. exported from the
//   Paperclip API subtree route and reduced to {id,parentId,originKind,
//   originId,labels,labelIds,description,workProducts,assigneeAgentId,
//   status,identifier}. May be [] on the first run.
// config.json: plugin instance config (repos, assignees, prefixes, ...).
//   dryRun is forced on; the token always comes from the environment or
//   --token-file, never from config.
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    cards: { type: "string" },
    config: { type: "string" },
    state: { type: "string" },
    "token-file": { type: "string" },
    "tracker-id": { type: "string" },
    company: { type: "string", default: "dry-run" },
  },
});

function fail(message) {
  process.stderr.write(`github-upstream-dryrun: ${message}\n`);
  process.exit(1);
}

const token =
  process.env.GITHUB_TOKEN ||
  (args["token-file"] && existsSync(args["token-file"]) ? readFileSync(args["token-file"], "utf8").trim() : "");
if (!token) fail("set GITHUB_TOKEN or --token-file");
if (!args.cards) fail("--cards is required");
if (!args.state) fail("--state is required");

const cards = JSON.parse(readFileSync(args.cards, "utf8"));
const fileConfig = args.config && existsSync(args.config) ? JSON.parse(readFileSync(args.config, "utf8")) : {};

const { runDryRun } = await import("../dist/dryrun.js");
const result = await runDryRun({
  companyId: args.company,
  token,
  config: fileConfig,
  cards,
  trackerId: args["tracker-id"],
  statePath: args.state,
});

for (const outcome of result.releaseOutcomes) {
  console.log(JSON.stringify({ job: "release-scan", ...outcome }));
}
for (const outcome of result.itemOutcomes) {
  console.log(JSON.stringify({ job: "item-scan", ...outcome }));
}
console.log(JSON.stringify({ job: "stats", runs: result.stats }));
