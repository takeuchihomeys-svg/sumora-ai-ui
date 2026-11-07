// 返信の番だけの文の質の週ごとの物差し（2026-11-07 作業員9）
// 実行: npx tsx app/lib/__tests__/reply-quality-weekly.test.ts
import { jstWeekOf, lowKindOf, weeklyReplyQuality, nearestStaffMessage, weeklyTable, bigramCover, turnRepliesOf, type QualityRow } from "../reply-quality-weekly";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };

t("JST の週: 日曜 23時 JST は前の月曜", jstWeekOf("2026-11-08T14:00:00Z") === "2026-11-02");
t("JST の週: 月曜 0時 JST は今週", jstWeekOf("2026-11-08T15:00:00Z") === "2026-11-09");
t("外れの型: 片方だけ確認の約束＝ブレイン", lowKindOf({ draft: "確認出来次第ご連絡させて頂きます！！", sent: "最短で11月20日ごろ入居可能です！！" }) === "brain");
t("外れの型: 両方約束なし＝書き手", lowKindOf({ draft: "はい😊！！お近くのコインパーキングにお停めください！！物件の駐車場はございません", sent: "お近くのコインパーキングに駐車の程よろしくお願いいたします！！" }) === "writer");
t("外れの型: 両方ピックアップ＝書き手", lowKindOf({ draft: "ピックアップし お送り", sent: "ピックアップさせて頂きます" }) === "writer");
const base = { draft: "a", sent: "b" };
const rows: QualityRow[] = [
  { ...base, sentAt: "2026-11-03T01:00:00Z", similarity: 0.9, writer: "takeuchi", aix: false },
  { ...base, sentAt: "2026-11-03T02:00:00Z", similarity: 0.5, writer: "takeuchi", aix: false },
  { ...base, sentAt: "2026-11-03T03:00:00Z", similarity: 0.1, writer: "takeuchi", aix: true },
  { ...base, sentAt: "2026-11-03T04:00:00Z", similarity: 0.2, writer: "employee", aix: false },
  { ...base, sentAt: "2026-10-27T04:00:00Z", similarity: 0.8, writer: "takeuchi", aix: null },
];
const s = weeklyReplyQuality(rows);
t("週ごと: 2週・古い順", s.length === 2 && s[0].week === "2026-10-26" && s[1].week === "2026-11-02", s);
t("AIX の番と従業員は除く", s[1].n === 2 && s[1].avg === 0.7 && s[1].lowPct === 50 && s[1].lowWriter === 1, s[1]);
t("一番近いスタッフの通（3分以内）", nearestStaffMessage("2026-11-03T01:00:00Z", [{ created_at: "2026-11-03T01:02:00Z", k: 1 }, { created_at: "2026-11-03T00:59:30Z", k: 2 }])?.k === 2);
t("3分を超えたら無し", nearestStaffMessage("2026-11-03T01:00:00Z", [{ created_at: "2026-11-03T01:04:00Z" }]) === null);
t("表の形", weeklyTable(s).split("\n").length === 4);
// 11/07 分けた番の欄（実物の形を伏せた物）
const conv = [
  { created_at: "2026-11-03T00:00:00Z", sender: "customer", text: "車で来ているのですが、停めれる場所はありますか?", is_aix_generated: false },
  { created_at: "2026-11-03T00:05:00Z", sender: "staff", text: "かしこまりました！！", is_aix_generated: false },
  { created_at: "2026-11-03T00:06:00Z", sender: "staff", text: "[AIX]", is_aix_generated: true },
  { created_at: "2026-11-03T00:07:00Z", sender: "staff", text: "お近くのコインパーキングに駐車の程よろしくお願いいたします！！", is_aix_generated: false },
  { created_at: "2026-11-03T01:00:00Z", sender: "staff", text: "遅い通", is_aix_generated: false },
  { created_at: "2026-11-03T02:00:00Z", sender: "customer", text: "次", is_aix_generated: false },
];
const tr = turnRepliesOf("2026-11-03T00:05:10Z", conv);
t("番の返信: AIX と30分後を除く", tr.length === 2 && tr[1].startsWith("お近く"), tr);
t("重なり: 全部入れば1・空は null", bigramCover("かしこまりました！！", "かしこまりました！！") === 1 && bigramCover("", "") === null);
const sp = weeklyReplyQuality([{ sentAt: "2026-11-03T00:05:10Z", similarity: 0.7, draft: "かしこまりました！！", sent: "かしこまりました！！", writer: "takeuchi", aix: false, turnReplies: tr }]);
t("分けた番の欄: 1通目は全部入り・全部つないだ物は低い", sp[0].split?.n === 1 && sp[0].split?.coverFirst === 1 && (sp[0].split?.coverAll ?? 1) < 0.6, sp[0].split);
t("表に分けた番の列", weeklyTable(sp).includes("分けた番"));
t("turnReplies が無い行だけなら列を出さない", !weeklyTable(s).includes("分けた番"));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
