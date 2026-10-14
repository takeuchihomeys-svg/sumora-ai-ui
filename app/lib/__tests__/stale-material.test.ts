// app/lib/__tests__/stale-material.test.ts — 「資料が古い」の材料の印（純関数）
// 並びは本番の実物（22b2511e 10/11「あと以前送られせもらったここはもう埋まっちゃてますか？」＝エスリード中之島クロスゲート 302・23日前の資料）を写した
// 実行: npx tsx app/lib/__tests__/stale-material.test.ts
import { resolvePropertyThreads, buildPropertyThreadNote, type PtMsg, type PtAix } from "../property-thread";
import { staleMaterialOf, staleMaterialLine, staleMaterialDays } from "../stale-material";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, info === undefined ? "" : typeof info === "string" ? `\n${info}` : JSON.stringify(info)); } };

const img = (lmid: string, at: string, url: string): PtMsg => ({ sender: "staff", text: "[画像]", created_at: at, line_message_id: lmid, image_url: url, is_aix_generated: true });
const labels = new Map([["u1", "エスリード中之島クロスゲート 302号室"], ["u2", "ラグゼ本町 801号室"]]);
const sentAt = "2026-09-18T02:00:00Z";
const base = (custText: string, custAt: string, extra: { aix?: PtAix[]; more?: PtMsg[] } = {}) => resolvePropertyThreads({
  messages: [img("s1", sentAt, "u1"), img("s2", sentAt, "u2"), ...(extra.more ?? []),
    { sender: "customer", text: custText, created_at: custAt, line_message_id: "c1", quoted_message_id: "s1" }],
  imageLabels: labels, aix: extra.aix ?? [],
});
const lineOf = (n: string) => n.split("\n").find((l) => l.includes("資料が古い")) ?? "";

{
  const s = base("あと以前送られせもらったここはもう埋まっちゃてますか？", "2026-10-11T14:03:00Z");
  const n = buildPropertyThreadNote(s);
  t("23日前に送った物件の空きの質問 → 印が出る", /資料が古い: この物件は9\/18に資料をお送りしたきり（23日前）/.test(n), n);
  t("印は ▶ の物件の下（他の物件の行より前）", n.indexOf("資料が古い") > n.indexOf("▶ 今の番の物件: エスリード中之島クロスゲート") && /空きの話/.test(lineOf(n)), n);
}
{
  const s = base("ここまだ空いてますか？", "2026-09-21T02:00:00Z");
  t("3日前の資料は印なし", !/資料が古い/.test(buildPropertyThreadNote(s)));
}
{
  const s = base("こちら1度初期費用出していただきたいです！", "2026-09-25T03:00:00Z");
  t("7日ちょうど過ぎ・初期費用 → 印（初期費用の話）", /資料が古い[\s\S]*初期費用の話/.test(lineOf(buildPropertyThreadNote(s))), buildPropertyThreadNote(s));
}
{
  const s = base("こちら申し込みしたいです", "2026-10-01T03:00:00Z");
  t("申込（話題は other でも本文の申込）→ 印", /申込の話/.test(lineOf(buildPropertyThreadNote(s))), buildPropertyThreadNote(s));
}
{
  const s = base("ここの間取り詳しく教えてください", "2026-10-11T03:00:00Z");
  t("詳細の質問（空き・内覧・申込・初期費用でない）→ 印なし", !/資料が古い/.test(buildPropertyThreadNote(s)));
}
{
  // 間に物件確認（募集中）があれば、資料の時刻はその確認の時刻
  const aix: PtAix[] = [{ created_at: "2026-10-08T05:00:00Z", aix_type: "property_check_result", property_names: ["エスリード中之島クロスゲート 302号室"], prop_statuses: ["available"] }];
  const s = base("ここまだ空いてますか？", "2026-10-11T14:03:00Z", { aix });
  t("3日前に物件確認（募集中）→ 印なし", !/資料が古い/.test(buildPropertyThreadNote(s)), buildPropertyThreadNote(s));
  const aix2: PtAix[] = [{ created_at: "2026-09-30T05:00:00Z", aix_type: "property_check_result", property_names: ["エスリード中之島クロスゲート 302号室"], prop_statuses: ["available"] }];
  const s2 = base("ここまだ空いてますか？", "2026-10-11T14:03:00Z", { aix: aix2 });
  t("11日前に物件確認 → 印（最後に募集状況を確認したきり）", /9\/30に最後に募集状況を確認したきり（11日前）/.test(buildPropertyThreadNote(s2)), buildPropertyThreadNote(s2));
}
{
  // 資料の後に募集終了が分かっている → 台帳に書いてあるので印なし
  const aix: PtAix[] = [{ created_at: "2026-09-20T05:00:00Z", aix_type: "property_check_result", property_names: ["エスリード中之島クロスゲート 302号室"], prop_statuses: ["ended"] }];
  const s = base("ここまだ空いてますか？", "2026-10-11T14:03:00Z", { aix });
  t("募集終了が分かっている物件 → 印なし", !/資料が古い/.test(buildPropertyThreadNote(s)), buildPropertyThreadNote(s));
}
{
  // お客様が送ってきた物件（持ち込み）は対象外
  const r = { key: "x#1", ref: { building: "x", buildingKey: "x", room: "1", floor: null, display: "x 1号室" }, names: [], sentByUs: false, origin: "customer" as const,
    events: [{ at: "2026-09-01T00:00:00Z", kind: "customer_shared" as const, by: "named" as const }] };
  t("持ち込み物件 → null", staleMaterialOf(r, "2026-10-11T00:00:00Z", "まだ空いてますか", "vacancy") === null);
}
{
  const s = base("ここまだ空いてますか？", "2026-10-11T14:03:00Z");
  const r = s.rooms.find((x) => x.ref.display.startsWith("エスリード"))!;
  t("戻す: STALE_MATERIAL_NOTE=off → null", staleMaterialOf(r, "2026-10-11T14:03:00Z", "ここまだ空いてますか？", "vacancy", { STALE_MATERIAL_NOTE: "off" }) === null);
  t("線: STALE_MATERIAL_DAYS=30 → 23日は null", staleMaterialOf(r, "2026-10-11T14:03:00Z", "ここまだ空いてますか？", "vacancy", { STALE_MATERIAL_DAYS: "30" }) === null);
  t("線の既定は7日", staleMaterialDays({}) === 7);
  const m = staleMaterialOf(r, "2026-10-11T14:03:00Z", "ここまだ空いてますか？", "vacancy", {})!;
  t("文に竹内さんの方針が入る（確認する・しないの指示はしない）", /竹内さんの方針/.test(staleMaterialLine(m)) && !/AIX|【物件確認した】|必ず/.test(staleMaterialLine(m)), staleMaterialLine(m));
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exitCode = 1;
