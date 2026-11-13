// 試験の近い番を元の番の状況の文で引く（scripts/lib/exam-near-origin.ts）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-near-origin.test.ts（全 PASS で exit 0）
// 実物の形: nop9-b の q399（元の番 2026-09-12T10:20:28.854Z・本番の行は 25秒前 10:20:04.081Z）・q402（一番近い行が 117分後＝別の番）
import { pickOriginRow, originBody, originEligible, nearOriginVectorOn } from "../exam-near-origin";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

ok("既定 off", !nearOriginVectorOn({}) && nearOriginVectorOn({ EXAM_NEAR_ORIGIN_VECTOR: "on" }));
const q399 = [{ source_key: "msg:fef6bdc8", turn_at: "2026-09-12T10:20:04.081Z", has_emb: true }, { source_key: "msg:other", turn_at: "2026-09-12T12:00:00Z", has_emb: true }];
ok("元の番に一番近い行（10分以内）", pickOriginRow(q399, "2026-09-12T10:20:28.854Z")?.source_key === "msg:fef6bdc8");
ok("117分離れた行は別の番＝使わない（q402 の形）", pickOriginRow([{ source_key: "msg:c5bf", turn_at: "2026-09-15T03:26:11.829Z", has_emb: true }], "2026-09-15T01:28:53.69Z") === null);
ok("埋め込みの無い行は使わない", pickOriginRow([{ source_key: "msg:x", turn_at: "2026-09-12T10:20:28Z", has_emb: false }], "2026-09-12T10:20:28.854Z") === null);

const body = JSON.stringify({ query_embedding: "[0.1,0.2]", p_before: "2026-11-13T10:00:00Z", p_exclude_conv: "dfca2838", p_exclude_pc: "pc1", match_count: 40, max_distance: 0.2, p_writer: "takeuchi" });
const nb = JSON.parse(originBody(body, "[0.9,0.8]", { conv: "3890f691", at: "2026-09-12T10:20:28.854Z" }));
ok("埋め込みは元の番の物・元の会話を外す・p_before は元の時刻", nb.query_embedding === "[0.9,0.8]" && nb.p_exclude_conv === "3890f691" && nb.p_before === "2026-09-12T10:20:28.854Z");
ok("他の欄はそのまま", nb.match_count === 40 && nb.max_distance === 0.2 && nb.p_writer === "takeuchi" && nb.p_exclude_pc === "pc1");
ok("JSON でない本文はそのまま", originBody("x", "[1]", { conv: "c", at: "2026-01-01T00:00:00Z" }) === "x");

const gate = new Map([["q999", "申込の書類以降"]]);
ok("近い番の RPC で元の番と問題がある頼みだけ", originEligible({ name: "match_conductor_focus", oconv: "c", oat: "2026-09-12T10:20:28Z", pid: "q399" }, gate));
ok("申込以降で外した問題は差し替えない", !originEligible({ name: "match_conductor_focus", oconv: "c", oat: "2026-09-12T10:20:28Z", pid: "q999" }, gate));
ok("元の番の印の無い古い頼みは差し替えない", !originEligible({ name: "match_conductor_focus", oconv: null, oat: null, pid: "q399" }, gate));
ok("他の読みは差し替えない", !originEligible({ name: "conductor_turn_vectors", oconv: "c", oat: "2026-09-12T10:20:28Z", pid: "q399" }, gate));

console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
