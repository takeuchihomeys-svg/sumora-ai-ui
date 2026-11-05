// 試験の入力の違いの出所（scripts/lib/exam-input-drift.ts）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-input-drift.test.ts（全 PASS で exit 0）
// 本文は 11/04〜05 の録音（q015・q021・q166）の違った所をそのまま縮めた物
import { classifyDrift, splitSections, kindOfHeading, maskClock, tallyDrift } from "../exam-input-drift";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

const head = "指示の本文。JSON は {\"a\":1}\n";
const ledger = (n: number) => `【行動台帳（確定事実・我々が実際にしたこと／宣言しただけのこと）】物件送付${n}件／見積未\n`;
const recent = (s: string) => `【直近AIXアクション（新→旧順）】最新:${s}\n`;
const time = (wd: string) => `【時間情報】今日: <date>（${wd}） 今 <hm>\n`;
const ex = (s: string) => `【成約した会話の実際の返信例（現フェーズ:proposing優先）】\n- ${s}\n`;

ok("区切り: 頭と見出し", [...splitSections(head + ledger(1)).keys()].join("|") === "(頭)|【行動台帳（確定事実・我々が実際にしたこと／宣言しただけのこと）】");
ok("見出し: 台帳", kindOfHeading("【このお客様の確かな事実の帳面（いつ・どこから）】") === "ledger");
ok("見出し: 時計", kindOfHeading("【時間情報】") === "clock");
ok("見出し: DB", kindOfHeading("【関連ナレッジ（この会話に類似する過去の学習・RAG検索）】") === "db");
ok("時計を伏せる", maskClock("property_send[<md> <hm>・10分前]（水）") === maskClock("property_send[<md> <hm>・3分前]（木）"));

{
  const a = head + ledger(15) + time("水"), b = head + ledger(15) + time("水");
  const r = classifyDrift(a, b);
  ok("同じ", r.same && r.primary === null);
}
{
  const r = classifyDrift(head + ledger(15) + time("水"), head + ledger(36) + time("水"));
  ok("台帳の件数が違う（他の問題の行）→ ledger", !r.same && r.primary === "ledger" && r.kinds.ledger === 1);
}
{
  const r = classifyDrift(head + recent("property_send[<md> <hm>・10分前]"), head + recent("property_send[<md> <hm>・12分前]"));
  ok("台帳の中の経過だけ違う → clock", r.primary === "clock" && r.kinds.ledger === 0);
}
{
  const r = classifyDrift(head + time("水") + ex("A") , head + time("木") + ex("B"));
  ok("曜日と返信例 → db が主（clock も数える）", r.primary === "db" && r.kinds.clock === 1 && r.kinds.db === 1);
}
{
  const r = classifyDrift(head + ledger(1), "指示の本文。JSON は {\"a\":1,\"three_layer\":{}}\n" + ledger(1));
  ok("頭（指示・JSON の形）が違う → code", r.primary === "code");
}
{
  const r = classifyDrift(head + ledger(1), head + "【竹内さんの決定 No.20（<md>）】保証会社の言い方\n" + ledger(1));
  ok("新しい見出し（決定の注記）→ code", r.primary === "code");
}
{
  const r = classifyDrift(head + "【物件オススメ】x\n", head + "【物件オススメ】y\n");
  ok("RULES に無い見出しの中身だけ違う → other", r.primary === "other");
  const r2 = classifyDrift(head + "【物件オススメ】x\n", head + "【物件オススメ】y\n", { codeHeadings: ["【物件オススメ】"] });
  ok("差分のコードの見出し → code", r2.primary === "code");
}
{
  const t = tallyDrift([
    classifyDrift("a", "a"),
    classifyDrift(head + ledger(1), head + ledger(2)),
    classifyDrift(head + time("水"), head + time("木")),
    classifyDrift(head, "別の指示\n"),
  ]);
  ok("まとめ: 組・同じ・直せば使えた組", t.pairs === 4 && t.same === 1 && t.onlyNoise === 2 && t.byPrimary.code === 1, JSON.stringify(t));
}

console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
