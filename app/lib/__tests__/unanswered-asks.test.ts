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

// 2026-11-27 統括役の頼みの3つ
t("答えた: 電話の AIX で返した", askStateOf(A("審査厳しいって聞いてたんですけど大丈夫ですか？"), [], [{ aix_type: "phone_call" }]) === "answered");
t("答えた: すぐ後の通が画像・通話リクエスト", askStateOf(A("アリバイの値段が知りたい"), [{ text: "【AIX】[画像]" }], []) === "answered" && askStateOf(A("審査は大丈夫ですか？"), [{ text: "[通話リクエスト] 電話をかけるボタン" }], []) === "answered");
t("受け取りの言葉は答えではない: ペットの問いに「かしこまりました！！家賃…」", askStateOf(A("ペットは飼えますか？"), [{ text: "かしこまりました！！家賃7万円以内でピックアップさせて頂きます！！" }], []) === "open");
// 2026-11-27 「前の通で答えた」から20件を目で読んで見つけた読み違い
t("読み違い①: 「ありがとうございます」の「ございます」は答えではない", askStateOf(A("夜職なのですが可能ですか?"), [{ text: "はじめまして😊！！この度ご連絡頂きありがとうございます！！担当の者です！！" }], []) === "open");
t("読み違い②: 約束の通の数字がお客様の数字の繰り返しだけなら約束（28万）", askStateOf(A("他のところで見積もりをだしてもらって、28万くらいやったんですけどもいくらになりますか?"), [{ text: "かしこまりました！！募集状況を確認させて頂きます！！28万円より抑えられるよう最大限交渉させて頂きます！！" }], []) === "promised");
t("読み違い③: URL の中の「?」は問いにしない", customerAsksOf("https://www.example.co.jp/chintai/b-1?id=2", "x").length === 0);
t("画像は答えになる種類だけ: 名義の問いに画像だけは答えていない", askStateOf(A("自分の名義では通りづらいですか?"), [{ text: "[画像]" }], []) === "open" && askStateOf(A("初期費用はいくらですか?"), [{ text: "[画像]" }], []) === "answered");
const at = (h: number) => new Date(Date.parse("2026-11-01T00:00:00Z") + h * 36e5).toISOString();
const wd = unansweredAsks({ msgs: [
  { sender: "customer", text: "初期費用はいくらですか？", created_at: at(1) },
  { sender: "staff", text: "こちらのお部屋もオススメです！！", created_at: at(2) },
  { sender: "customer", text: "やっぱり大丈夫です！", created_at: at(3) },
  { sender: "staff", text: "かしこまりました！！", created_at: at(4) },
  { sender: "customer", text: "内見したいです", created_at: at(5) },
], aix: [], nowMs: Date.parse(at(5)) + 1 });
t("外す: お客様が後で取り消した問い（やっぱり大丈夫です）", wd.length === 1 && wd[0].state === "withdrawn" && unansweredLine(wd, []) === "");
const st = unansweredAsks({ msgs: [
  { sender: "customer", text: "初期費用はいくらですか？", created_at: at(1) },
  { sender: "staff", text: "オススメです！！", created_at: at(2) },
  { sender: "customer", text: "ここも気になります", created_at: at(3) },
  { sender: "staff", text: "ありがとうございます！！", created_at: at(4) },
  { sender: "customer", text: "こちらも見たいです", created_at: at(5) },
  { sender: "staff", text: "かしこまりました！！", created_at: at(6) },
  { sender: "customer", text: "よろしくお願いします", created_at: at(7) },
], aix: [], nowMs: Date.parse(at(7)) + 1 });
t("別の欄: 後にお客様の塊が2つ以上来た古い問いは stale・1行に入れない", st.length === 1 && st[0].state === "stale" && unansweredLine(st, []) === "");
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
