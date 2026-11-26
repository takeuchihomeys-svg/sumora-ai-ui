// app/lib/__tests__/unanswered-asks.test.ts — 聞かれたのに答えていない事の照らし（#814・2026-11-27 作業員A）
//   実行: npx tsx app/lib/__tests__/unanswered-asks.test.ts
//   問いの文は写し（problems.json）の竹内さん本人の番から（お客様の名前・物件名は入れない）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { customerAsksOf, topicOf, askStateOf, unansweredAsks, unansweredLine, unansweredLineOn } from "../unanswered-asks";
import { SWITCH_TARGET_MARK } from "../../../scripts/lib/exam-snapshot-need";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const A = (q: string) => ({ quote: q, topic: topicOf(q), at: "2026-11-01T00:00:00Z" });

// 問いを拾う
t("問い: ？・ですか・教えて・知りたい を文ごとに拾う", customerAsksOf("ありがとうございます。初期費用はいくらですか？あと入居可能時期を知りたい", "x").length === 2);
t("問いでない: お礼・挨拶・了承", customerAsksOf("ありがとうございます！よろしくお願いします", "x").length === 0 && customerAsksOf("お世話になっております。お元気ですか？", "x").length === 0);
t("種類: 費用・時期・空き・内覧・手続き", topicOf("初期費用はいくらですか") === "cost" && topicOf("18時半可能ですか?") === "when" && topicOf("最新の空室状況を知りたい") === "availability" && topicOf("内見行けますか?") === "viewing" && topicOf("ブラックでも通る可能性ありますか?") === "procedure");

// 照らし（実物の型）
t("答えた: 費用の問いに金額のある通", askStateOf(A("初期費用156980なんですか?"), [{ text: "はい！！初期費用は156,980円となります！！" }], []) === "answered");
t("答えた: 費用の問いに見積の AIX", askStateOf(A("初期費用はいくらですか？"), [], [{ aix_type: "estimate_sheet" }]) === "answered");
t("答えた: はい・いいえの問いにすぐ後の「はい！！」", askStateOf(A("18時半可能ですか?"), [{ text: "はい！！18時半で大丈夫です😊" }], []) === "answered");
t("約束: 「確認させて頂きます」だけの通は答えではなく約束", askStateOf(A("物件の中身が見やすいホームページとかありますか?"), [{ text: "かしこまりました！！ 確認させて頂きます😊！！" }], []) === "promised");
t("漏れ: 費用の問いに物件の AIX だけ（exchange-ledger は答えた扱いにしていた型）", askStateOf(A("初期費用はいくらですか？"), [{ text: "こちらのお部屋もオススメです！！" }], [{ aix_type: "property_send" }]) === "open");
t("漏れ: 場所の問いに約束も答えも無い通", askStateOf(A("大阪市で多少治安悪いとこだとどこになりますか?"), [{ text: "こちらのお部屋もオススメです！！" }], []) === "open");

// 会話で: 今の番の問いは入れない・前の番の答えていない問いだけ
const msgs = [
  { sender: "customer", text: "初期費用はいくらですか？", created_at: "2026-11-01T01:00:00Z" },
  { sender: "staff", text: "こちらのお部屋もオススメです！！", created_at: "2026-11-01T02:00:00Z" },
  { sender: "customer", text: "内見できますか？", created_at: "2026-11-01T03:00:00Z" },
];
const ua = unansweredAsks({ msgs, aix: [], nowMs: Date.parse("2026-11-01T03:00:01Z") });
t("会話: 前の番の費用の問いは漏れ・今の番の内見の問いは入れない", ua.length === 1 && ua[0].topic === "cost" && ua[0].state === "open");
const line = unansweredLine(ua, [{ kindJa: "募集状況の確認", sentence: "募集状況確認させて頂きます", at: "2026-11-01T02:00:00Z", overdue: true }]);
t("1行: 【まだ答えていない事】に問いと約束・決めるのはあなた", line.startsWith("まだ答えていない事") && line.includes("お客様の問い（費用）") && line.includes("こちらの約束（募集状況の確認）") && line.includes("期限を過ぎた") && line.includes("決めるのはあなた"));
t("1行: 何も無ければ空", unansweredLine([], []) === "");

// スイッチ・印・配線
t("既定 off", !unansweredLineOn({}) && unansweredLineOn({ UNANSWERED_ASKS_LINE: "on" }));
t("届きの印: SWITCH_TARGET_MARK に unanswered", SWITCH_TARGET_MARK.UNANSWERED_ASKS_LINE === "unanswered");
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: on の時だけ・印 unanswered・控えの行 unanswered・申込以降は入れない", bc.includes("ua.unansweredLineOn()") && bc.includes("materialMarks.unanswered") && bc.includes(`key: "unanswered"`) && /if \(conversationId && !isPostApplyStatus\(convStatus\)\) \{\s*\n\s*try \{\s*\n\s*const ua = /.test(bc.replace(/\r\n/g, "\n")));
console.log(`unanswered-asks: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
