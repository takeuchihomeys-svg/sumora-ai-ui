// npx tsx app/lib/__tests__/takeuchi-exemplar-server.test.ts
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exemplarNoteFor } from "../takeuchi-exemplar-server";

const dir = mkdtempSync(join(tmpdir(), "w10-ex-"));
const p = join(dir, "bank.json");
writeFileSync(p, JSON.stringify([
  { id: "a1", scene: "question", latent: "none", lead: "answer_only", customer: "2階だと虫とかって入ってきますかね？", sentences: [{ text: "x", role: "answer", why: "結論を先に", brainField: "main" }] },
  { id: "a2", scene: "question", latent: "none", lead: "answer_only", customer: "駐車場はありますか", sentences: [{ text: "y", role: "answer", why: "有無を言い切る", brainField: "main" }, { text: "z", role: "worry", why: "近くのパーキング", brainField: "latent" }] },
]));
const meta = { reply_direction: "2階は虫が入りやすいと正直に答える" };
// off なら null
assert.equal(exemplarNoteFor({ scene: "question", customerText: "駐車場は？", meta }, { TAKEUCHI_EXEMPLAR_BANK: p }), null);
// on・束あり
const r = exemplarNoteFor({ scene: "question", customerText: "駐車場は？", meta }, { TAKEUCHI_EXEMPLAR: "on", TAKEUCHI_EXEMPLAR_BANK: p });
assert.ok(r && r.note.includes("文は写さない"));
assert.match(r!.key, /^question\|.+\|answer_only$/);
// 同じ発言の手本は使わない（試験で正解の番を手本にしない）
const r2 = exemplarNoteFor({ scene: "question", customerText: "2階だと虫とかって入ってきますかね？", meta }, { TAKEUCHI_EXEMPLAR: "on", TAKEUCHI_EXEMPLAR_BANK: p });
assert.equal(r2?.id, "a2");
// 束が無ければ null（本番は表ができるまで今と同じ）
assert.equal(exemplarNoteFor({ scene: "question", customerText: "x", meta }, { TAKEUCHI_EXEMPLAR: "on" }), null);
console.log("takeuchi-exemplar-server: 4 pass");
