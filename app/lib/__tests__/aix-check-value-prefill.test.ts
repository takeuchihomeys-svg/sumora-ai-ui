// AIX の2通目の材料に、この番の 物件確認した の値（物件名×状況）を足す（app/lib/second-message-materials.ts・AIX_CHECK_VALUE_PREFILL）のテスト
// 記録の形は aix_usage_logs の実物（物件名は伏せた・状況の値はそのまま）
// 実行: npx tsx app/lib/__tests__/aix-check-value-prefill.test.ts
import { aixCheckValuePrefillOn, checkValueLines, buildSecondMaterialsNote, sentThisTurn } from "../second-message-materials";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => { if (c) pass++; else { fail++; console.log(`✗ ${n} ${d}`); } };
const now = Date.parse("2026-11-12T08:00:00Z");
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();

ok("既定 off", aixCheckValuePrefillOn({}) === false && aixCheckValuePrefillOn({ AIX_CHECK_VALUE_PREFILL: "on" }) === true);
{ // 実物: 2件とも募集中（LIVIAZ・リブリの形）
  const v = checkValueLines([{ property_names: ["物件A 813号室", "物件B 306号室"], prop_statuses: ["available", "available"], check_pattern: "available", created_at: at(2) }], now);
  ok("物件名×状況の行", JSON.stringify(v) === JSON.stringify(["物件A 813号室: 募集中", "物件B 306号室: 募集中"]), JSON.stringify(v));
}
{ // 実物: 文は「募集中・1番手で申込あり＝2番手」なのに prop_statuses は unavailable（粗い値）
  const v = checkValueLines([{ property_names: ["物件C 208号室"], prop_statuses: ["unavailable"], check_pattern: "available", created_at: at(5) }], now);
  ok("unavailable は「募集中ではない（申込あり・募集終了を含む）」と書く（粗い値のまま言い切らない）", v[0] === "物件C 208号室: 募集中ではない（申込あり・募集終了を含む）", v[0]);
}
ok("この番（3時間）より前の記録は入れない", checkValueLines([{ property_names: ["物件D"], prop_statuses: ["available"], created_at: at(200) }], now).length === 0);
ok("状況の値が無い物件は「書かない」と出す", checkValueLines([{ property_names: ["物件E"], prop_statuses: [], created_at: at(1) }], now)[0] === "物件E: （状況の値なし＝書かない）");
ok("同じ物件は新しい記録の1行だけ", checkValueLines([{ property_names: ["物件F"], prop_statuses: ["available"], created_at: at(1) }, { property_names: ["物件F"], prop_statuses: ["unavailable"], created_at: at(30) }], now).join() === "物件F: 募集中");
{
  const sent = sentThisTurn({ actionType: "property_check_result", turnStaff: ["物件A 813号室現在募集中となります！！"] });
  const note = buildSecondMaterialsNote({ checkValues: ["物件A 813号室: 募集中"], sent, asks: [], promises: [], answers: [] });
  ok("材料の文に値の欄と〇〇の決まり", /この番の確認の結果（値/.test(note) && /〇〇と書く/.test(note) && /物件A 813号室: 募集中/.test(note), note);
  const off = buildSecondMaterialsNote({ sent, asks: [], promises: [], answers: [] });
  ok("値が無い時（off）は今と同じ文", !/この番の確認の結果（値/.test(off));
}
console.log(`aix-check-value-prefill: ${pass} passed, ${fail} failed`); if (fail) process.exit(1);
