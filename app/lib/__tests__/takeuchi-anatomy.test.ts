// app/lib/__tests__/takeuchi-anatomy.test.ts — 竹内さんの文の解剖（純関数・文は作り物）
import { pickBalanced, parseAnatomy, anatomyConflicts, anatomyPrompt } from "../takeuchi-anatomy";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };

const rows = [
  ...Array.from({ length: 50 }, (_, i) => ({ id: `a${i}`, scene: "cost", purpose: "promise", sent_at: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}` })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`, scene: "ack", purpose: "ack", sent_at: `2026-10-0${i + 1}` })),
];
const p = pickBalanced(rows, 10, 5);
t("偏りなく（少ない組も入る・組の上限）", p.filter((r) => r.scene === "ack").length === 3 && p.filter((r) => r.scene === "cost").length === 5, p.map((r) => r.id));
const a = parseAnatomy('{"scene":"物件を送ってきた","purpose":"promise","main_point":"募集状況を確認する","worry_answer":null,"parts":["uke","main","close","zzz"],"why_order":"受けてから約束","omitted":[{"what":"写真","why":"AIX の番"}]}');
t("読み取り", !!a && a.parts.join() === "uke,main,close" && a.omitted.length === 1 && a.worry_answer === null, a);
t("知らない趣旨は読まない", parseAnatomy('{"purpose":"decline"}') === null);
const body = "かしこまりました！！\nお送り頂きました物件の募集状況確認させて頂きます！！\n何卒よろしくお願い致します！！";
t("札と合えば食い違いなし", a ? anatomyConflicts(a, body).length === 0 : false, a ? anatomyConflicts(a, body) : null);
t("趣旨の食い違いを拾う", a ? anatomyConflicts({ ...a, purpose: "appeal" }, body).some((x) => x.startsWith("趣旨")) : false);
t("指示は伏せ済みの物だけ", /伏せ済み/.test(anatomyPrompt({ maskedCustomer: "YUMAです", maskedBody: body, scene: "property_share" })));

console.log(`takeuchi-anatomy: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
