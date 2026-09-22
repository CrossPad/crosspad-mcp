// eval/hil-triage-live.mjs — run crosspad_hil_triage's questions against real
// report.json files, to see what Jev says about reports whose cause is known.
//
//   npm run build && TYPESAFE_API_KEY=... node eval/hil-triage-live.mjs <report.json|workdir>...
//
// Prints one row per report: exit code, the tool's verdict, Jev's cause with
// its probability, and the two noul answers. Advisory output; compare it with
// what you know about each run.
import fs from "node:fs";
import path from "node:path";
import { buildState, buildQuestions, resolveReportPath, TYPESAFE_ENDPOINT, API_KEY_ENV } from "../dist/tools/hil-triage.js";

const key = process.env[API_KEY_ENV];
if (!key) {
  console.error(`${API_KEY_ENV} is not set`);
  process.exit(2);
}
const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: node eval/hil-triage-live.mjs <report.json|workdir>...");
  process.exit(2);
}

for (const t of targets) {
  const reportPath = resolveReportPath(t);
  const doc = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const body = { state: buildState(doc, reportPath, 60), model: "jev-latest", questions: buildQuestions() };
  const res = await fetch(TYPESAFE_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.log(`${path.basename(path.dirname(reportPath))}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    continue;
  }
  const j = await res.json();
  const c = j.answers.cause;
  const p = Object.entries(c.probabilities).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ");
  console.log(
    `${path.basename(path.dirname(reportPath)).padEnd(34)} exit=${doc.exit_code} ` +
      `cause=${c.choice} (conf ${c.confidence.toFixed(2)}) [${p}] ` +
      `exit_code_consistent=${j.answers.exit_code_consistent.noul.toFixed(2)} ` +
      `board_reset=${j.answers.board_reset.noul.toFixed(2)} ` +
      `tokens=${j.usage?.input_tokens ?? "?"}`,
  );
  console.log(`  summary: ${String(doc.summary).split("\n")[0].slice(0, 110)}`);
}
