// scripts/yuma-real-line-send-test.ts
// 2026-10-02 竹内「YUMAで実際にLINEを送ってテストも行う。弱い部分見つけて強化する必要ある…とにかくぶつかるところや怪しい部分を見つけるのが必要」
//
// スタッフが体験する道を最後まで通す: お客様の通（YUMA に場面として入れる）→ ブレイン → 下書き（手元の開発サーバの /api/generate-reply・
//   書かない呼び方）→ 画面と同じ送信前の関門（draftToSendableText・detectPlaceholders）→ **本番の送信 API（/api/send-line-message）で
//   YUMA の LINE に実際に送る**（--send の時だけ）→ 届いた形の点検（下書きと送った文の差・LINE で崩れる形）。
//   ・送り先は YUMA だけ（送る直前に会話の行を読み直し、id・名前・line_user_id が YUMA の物で、同じ line_user_id の会話が1つだけかを毎回確かめる）
//   ・場面の通と送った通（messages）は自分の id だけ消す。送信の後で本番が書く記録（sent_facts・予定・AIX要対応）は前後を比べて報告し、
//     自分の送信に結び付く物だけ消す
//   ・試行錯誤は LLM_TEST_MODE=deepseek-all（送らない）、最後だけ LLM_TEST_FINAL_CLAUDE=1 --send（場面ごとに1回）
//
// 実行（手順書 memory/test_protocol_brain.md）:
//   開発サーバ（写し）: LLM_TEST_MODE=deepseek-all REPLAY_FLOOR_FILE=<file> LINE_STAFF_GROUP_ID=invalid npx next dev --webpack -p 3489
//   LLM_TEST_MODE=deepseek-all RLS_BASE=http://localhost:3489 REPLAY_FLOOR_FILE=<file> npx tsx --env-file=.env.local scripts/yuma-real-line-send-test.ts [--only=a,b]
//   最後: 開発サーバも本スクリプトも LLM_TEST_FINAL_CLAUDE=1 にして --send（＋ --probe で書式の点検の1通・--images で画像のまとめ送り1回）
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MSG_SEP } from "../app/lib/reply-context";
import { draftToSendableText } from "../app/lib/draft-text";
import { detectPlaceholders } from "../app/lib/validate-reply";
import { ALLOWED_EMOJIS } from "../app/lib/emoji-allowlist";
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";

type Analyze = typeof import("../app/lib/brain-core").analyzeConversation;
let h: LlmTestHarness | null = null;

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.RLS_BASE ?? "http://localhost:3489";
const PROD = "https://sumora-ai-ui.vercel.app";
const FLOOR_FILE = process.env.REPLAY_FLOOR_FILE ?? "";
const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ONLY = arg("only").split(",").filter(Boolean);
const SEND = args.includes("--send");
const PROBE = args.includes("--probe");
const IMAGES = args.includes("--images");
const DEDUPE_PROBE = args.includes("--dedupe-probe");
const LABEL = arg("label", `rls-${new Date().toISOString().slice(5, 16).replace(/[:T-]/g, "")}`);
const OUT_DIR = "scripts/.replay-out";

type Turn = { sender: "staff" | "customer"; text: string };
// 2026-10-02 ⑩: produce＝返信生成ではなく AIX の文を作って送る場面（hearing＝/api/aix/action の条件ヒアリング（導入＋フォーム）・apply＝申込フォーマット（同居人は入居人数から））
// 2026-10-02 ⑭: apply_confirm＝AIX【申込へ！】を自動反映（aix-autofill-readiness＝申込の形を会話から決める）で作る・viewing＝AIX【内覧調整】（候補は自動反映の3つ）
type Scene = { id: string; why: string; state: string; first?: boolean; turns: Turn[]; expect: Array<{ label: string; ok: (draft: string) => boolean }>; produce?: "hearing" | "apply" | "apply_confirm" | "viewing"; /** 2026-10-02: 表示名で呼ぶ場面（Sさん）。無ければ YUMA */ customerName?: string };
const FORM = "▶︎【お部屋お探し中！】\n\n（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒11月頃\n②【ご希望の家賃（◯万円〜◯万円）】⇒7万円くらい\n③【希望の広さ・間取り】⇒1Kか1DK\n④【希望築年数】特になし\n⑤【ご希望のエリア・駅名】⇒天満、扇町\n⑥【ご希望の駅徒歩分数】⇒10分\n⑦【初期費用の限度額】⇒20万\n⑧【その他ご要望あれば】⇒バストイレ別\n________________________\n※ 審査に不安な事がある方お気軽にお伝えください😊\n審査面柔軟にサポートさせて頂きます！";
const female = (t: string) => /♀|\u{1F469}/u.test(t);
const outsideAllow = (t: string) => {
  const allowed = new Set<string>(ALLOWED_EMOJIS);
  return [...t.matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]).filter((e) => !allowed.has(e) && /\p{Emoji_Presentation}/u.test(e));
};
const opener = (t: string) => (t.split("\n").map((l) => l.trim()).filter(Boolean).find((l) => !/お世話になっております|はじめまして/.test(l)) ?? "");

/** 監査で見つけたぶつかり（2026-10-02）の場面。お客様の言い回しは実送信の形のまま（名前は YUMA） */
const SCENES: Scene[] = [
  { id: "late", why: "謝罪＋遅れの連絡（旧: かしこまりました→とんでもございません に書き換え・27通）・女性の絵文字", state: "viewing",
    turns: [
      { sender: "staff", text: "YUMAさんお世話になっております！！\n本日14:00にスプランディッド本町グラン現地エントランス前にてお待ちしております😊！！" },
      { sender: "customer", text: "すみません道が混んでて10分ほど遅れます🙇‍♀️" },
    ],
    expect: [
      { label: "冒頭がとんでもございませんでない", ok: (d) => !/^とんでも/.test(opener(d)) },
      { label: "女性の絵文字なし", ok: (d) => !female(d) },
    ] },
  { id: "yesno", why: "はい／いいえで答える質問（旧: はい→かしこまりました に書き換え）", state: "proposing",
    turns: [
      { sender: "staff", text: "🌟エスリード長居 503\n家賃管理費込68,000円・御堂筋線「長居」駅徒歩3分、YUMAさんにかなりオススメ出来るお部屋となります😊！！\nお手隙の際にご査収ください😌！！" },
      { sender: "customer", text: "ありがとうございます！こちらの物件って仮押さえとかできるんでしょうか？" },
    ],
    expect: [{ label: "女性の絵文字なし", ok: (d) => !female(d) }] },
  { id: "apology", why: "謝っているだけ（受け止め＝とんでもございませんが正しい側）", state: "proposing",
    turns: [
      { sender: "staff", text: "かしこまりました！！\n天満・扇町周辺全域からYUMAさんにオススメできるお部屋ピックアップ出来次第お送りさせて頂きます！！" },
      { sender: "customer", text: "何度もすみません🙇‍♀️ お手数おかけしますがよろしくお願いします" },
    ],
    expect: [
      { label: "冒頭がかしこまりましたでない", ok: (d) => !/^かしこまりました/.test(opener(d)) },
      { label: "女性の絵文字なし", ok: (d) => !female(d) },
    ] },
  { id: "ack", why: "了承・お礼だけ（はい😊！！ごゆっくり…の型）", state: "proposing",
    turns: [
      { sender: "staff", text: "🌟クリエオーレ喜連 303\n谷町線平野駅徒歩8分・家賃管理費込74,000円の1LDKで、YUMAさんにかなりオススメ出来るお部屋となります！！\nお手隙の際にご査収ください😌！！" },
      { sender: "customer", text: "ありがとうございます！仕事終わりに見させて頂きます" },
    ],
    expect: [{ label: "冒頭がかしこまりましたでない", ok: (d) => !/^かしこまりました/.test(opener(d)) }] },
  { id: "first", why: "初回の条件フォーム（挨拶行・絵文字の重なり・条件の復唱）", state: "first_reply", first: true,
    turns: [{ sender: "customer", text: FORM }],
    expect: [
      { label: "はじめまして", ok: (d) => /はじめまして/.test(d) },
      { label: "くらいを書かない", ok: (d) => !/くらい/.test(d) },
    ] },
  // ── 2026-10-02 竹内さんの決定（⑩）: 条件ヒアリング（⑨ご入居人数の書き入れ）・分割の手数料・申込へ（同居人を入居人数から）──
  { id: "hearing_occ", why: "条件ヒアリング: 家賃が無い→フォーム9項目・エリア/間取り/⑨ご入居人数を書き入れ", state: "hearing", produce: "hearing",
    turns: [
      { sender: "customer", text: "はじめまして、お部屋探しています" },
      { sender: "staff", text: "YUMAさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n何卒よろしくお願い致します！！" },
      { sender: "customer", text: "難波周辺で1LDK、2人で住む予定です" },
    ],
    expect: [
      { label: "9項目", ok: (d) => /⑨ご入居人数/.test(d) && /⑧その他こだわり条件/.test(d) },
      { label: "⑨に2名", ok: (d) => /⑨ご入居人数　2名/.test(d) },
      { label: "⑤に難波周辺", ok: (d) => /⑤ご希望エリア・最寄り駅　難波周辺/.test(d) },
    ] },
  { id: "installment", why: "分割の質問（みこと 9/30 の形）→ カード払いなら分割可＋3.24%", state: "proposing",
    turns: [
      { sender: "staff", text: "YUMAさん\nジーメゾン石津町東アビテ 0201号室最大限割引しました初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！" },
      { sender: "customer", text: "ありがとうございます。\n初期費用分割は難しいですよね🥲" },
    ],
    expect: [
      { label: "カード払い", ok: (d) => /クレジット|カード/.test(d) },
      { label: "3.24%", ok: (d) => /3[.．]24/.test(d) },
      { label: "分割は難しいと書かない", ok: (d) => !/分割[^。\n]{0,8}難し/.test(d) },
    ] },
  { id: "apply_occ", why: "申込へ: 入居人数（大人2 子ども1）から同居ありのフォーマット", state: "proposing", produce: "apply",
    turns: [
      { sender: "customer", text: "住む人数は大人2 子ども1になる予定です" },
      { sender: "staff", text: "🌟ジーメゾン石津町東アビテ 0201号室\n家賃管理費込75,000円の1LDKで、YUMAさんにかなりオススメ出来るお部屋となります！！\nお手隙の際にご査収ください😌！！" },
      { sender: "customer", text: "ここで申し込みしたいです！" },
    ],
    expect: [{ label: "【同居人記入欄】あり", ok: (d) => /【同居人記入欄】/.test(d) }] },
  // ── 2026-10-02 竹内さんの決定（2回目）: 表示名の呼びかけを消さない・仮押さえは会社の事実・一般の費用の説明はゲートしない ──
  { id: "dispname", why: "表示名で呼ぶ（Sさん・旧は出口が消していた）", state: "proposing", customerName: "S",
    turns: [
      { sender: "staff", text: "Sさんお世話になっております！！\n🌟エスリード長居 503\n家賃管理費込68,000円・御堂筋線「長居」駅徒歩3分のお部屋となります！！\nお手隙の際にご査収ください😌！！" },
      { sender: "customer", text: "ありがとうございます！明日ゆっくり見てみます" },
    ],
    expect: [{ label: "呼びかけの残骸なし（さん・の方 で始まる行なし）", ok: (d) => !/(?:^|\n)(?:さん|の方)/.test(d) }] },
  { id: "kariosae", why: "仮押さえ（会社の事実: お申込みで抑える・保証会社の審査通過までキャンセル料なし）", state: "proposing",
    turns: [
      { sender: "staff", text: "🌟エスリード長居 503\n家賃管理費込68,000円・御堂筋線「長居」駅徒歩3分、YUMAさんにかなりオススメ出来るお部屋となります😊！！\nお手隙の際にご査収ください😌！！" },
      { sender: "customer", text: "エスリード長居の件ですが、仮おさえしてもらうのは可能でしょうか？？ 内覧はしたいです" },
    ],
    expect: [
      { label: "お申込みで抑える", ok: (d) => /申込/.test(d) && /抑え|押さえ|おさえ/.test(d) },
      { label: "保証会社の審査・キャンセル料", ok: (d) => /保証会社|キャンセル料/.test(d) },
      { label: "管理会社に確認で返さない", ok: (d) => !/管理会社に確認させて頂きます/.test(d) },
    ] },
  { id: "souba", why: "一般の費用の説明（家賃相場）を見積書の宣言に置き換えない", state: "proposing",
    turns: [
      { sender: "staff", text: "かしこまりました！！\n難波周辺全域からYUMAさんにオススメできる1LDKのお部屋ピックアップ出来次第お送りさせて頂きます！！" },
      { sender: "customer", text: "大体お願いするといつもなんばから少し遠いとこですよね。難波の1LDKって家賃相場どれくらいなんですか？" },
    ],
    expect: [
      { label: "見積書の宣言に置き換わっていない", ok: (d) => !/御見積書を作成しお送り/.test(d) },
      { label: "相場に答えている", ok: (d) => /相場|万円/.test(d) },
    ] },
  // ── 2026-10-02 ⑭ 竹内さんが YUMA の LINE で見つけた8つ（お客様の文は本番の実物・名前は YUMA）──
  { id: "apply_decide", why: "①申込を決めた（c000080f 8/26）→ AIX 申込へ は申込確定の2行（実送信「かしこまりました！！／S-RESIDENCE福島Luxe1308号室のお申込みさせていただきます😊！！」）", state: "viewing", produce: "apply_confirm",
    turns: [
      { sender: "staff", text: "YUMAさん本日お時間頂きありがとうございました！！\n1件目のS-RESIDENCE福島Luxe 1308号室、2件目のプレジオ十三 502号室ご内覧頂きました😊！！" },
      { sender: "customer", text: "昨日はありがとうございました。\n\n一つ目の福島駅の物件の申し込みをお願いしたいです。" },
    ],
    expect: [
      { label: "かしこまりました始まり", ok: (d) => /^かしこまりました/.test(d.trim()) },
      { label: "お申込みさせていただきます", ok: (d) => /お申し?込み?させて(?:頂|いただ)きます/.test(d) },
      { label: "嬉しく・書類の案内・お礼を書かない", ok: (d) => !/嬉しく|書類をご案内|ご連絡ありがとう/.test(d) },
      { label: "別の物件（プレジオ十三）を書かない", ok: (d) => !/プレジオ/.test(d) },
    ] },
  { id: "apply_pay", why: "②申込＋今月振り込み（288d474a 9/01）→ 入金で押さえるを書かない", state: "viewing", produce: "apply_confirm",
    turns: [
      { sender: "staff", text: "YUMAさん本日お時間頂きありがとうございました！！\nS-RESIDENCE江坂Eminence 601号室とプレジオ十三 502号室ご内覧頂きました😊！！" },
      { sender: "customer", text: "江坂の方よろしくお願いします\n審査一旦通してもらって行けそうでしたら今月お金振り込みます" },
    ],
    expect: [
      { label: "入金・振込を書かない", ok: (d) => !/入金|振込|振り込/.test(d) },
      { label: "プレジオ十三を書かない", ok: (d) => !/プレジオ/.test(d) },
      { label: "かしこまりました始まり", ok: (d) => /^かしこまりました/.test(d.trim()) },
    ] },
  { id: "bulk7", why: "⑤7件まとめて送られた → 全て確認・一括／空きがございましたら を書かない", state: "proposing",
    turns: [
      { sender: "staff", text: "かしこまりました！！\n難波周辺全域からYUMAさんにオススメできる1LDKのお部屋ピックアップ出来次第お送りさせて頂きます！！" },
      { sender: "customer", text: "自分でも探してみました！この7件空いてるか見てもらえますか？\nラ・シゴーニュ ウエスト 3階\nエスリード長居 503\nクリエオーレ喜連 303\nプレジオ十三 502\nエグゼ難波西Ⅱ 802\nジーメゾン石津町東アビテ 0201\nS-RESIDENCE江坂Eminence 601" },
    ],
    expect: [
      { label: "一括を書かない", ok: (d) => !/一括/.test(d) },
      { label: "空きがございましたら を書かない", ok: (d) => !/空き(?:が|の)?(?:ございましたら|ありましたら|あれば)/.test(d) },
    ] },
  { id: "pay_timing", why: "⑥支払いの時期（ab7ea742 9/25）→ それより前に〜の言い切り・お客様 を書かない", state: "proposing",
    turns: [
      { sender: "staff", text: "YUMAさん\nジーメゾン石津町東アビテ 0201号室最大限割引しました初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！" },
      { sender: "customer", text: "初期費用の支払いはいつですか？" },
    ],
    expect: [
      { label: "時期に答えている", ok: (d) => /入居日|請求書/.test(d) },
      { label: "それより前に〜を書かない", ok: (d) => !/それより前|それ以前/.test(d) },
      { label: "お客様を書かない", ok: (d) => !/お客様/.test(d) },
      { label: "入金で押さえるを書かない", ok: (d) => !/(?:入金|振込)[^。\n]{0,10}(?:押さえ|抑え)/.test(d) },
    ] },
  { id: "installment2", why: "⑥分割（みこと 9/30）→ カード払い＋3.24%・お客様 を書かない", state: "proposing",
    turns: [
      { sender: "staff", text: "YUMAさん\nエスリード長居 503号室最大限割引しました初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！" },
      { sender: "customer", text: "ありがとうございます。\n初期費用分割は難しいですよね🥲" },
    ],
    expect: [
      { label: "3.24%", ok: (d) => /3[.．]24/.test(d) },
      { label: "お客様を書かない", ok: (d) => !/お客様/.test(d) },
    ] },
  { id: "viewing3", why: "⑦内覧したい → AIX 内覧調整の候補は直近3つ", state: "proposing", produce: "viewing",
    turns: [
      { sender: "staff", text: "🌟エスリード長居 503\n家賃管理費込68,000円・御堂筋線「長居」駅徒歩3分、YUMAさんにかなりオススメ出来るお部屋となります😊！！\nお手隙の際にご査収ください😌！！" },
      { sender: "customer", text: "ここ内覧してみたいです！" },
    ],
    expect: [
      { label: "候補3つ", ok: (d) => (d.match(/\d{1,2}\/\d{1,2}/g) ?? []).length >= 3 },
      { label: "JSON の名残なし", ok: (d) => !/"\s*[,}]|\{"/.test(d) },
    ] },
  { id: "apply_after_confirm", why: "申込確定の2行の後 → 申込フォーマットは AIX で止める（自動で作らない・送らない）", state: "viewing", produce: "apply_confirm",
    turns: [
      { sender: "customer", text: "一つ目の福島駅の物件の申し込みをお願いしたいです。" },
      { sender: "staff", text: "かしこまりました！！\nS-RESIDENCE福島Luxe 1308号室お申込みさせていただきます😊！！" },
      { sender: "customer", text: "よろしくお願いします！" },
    ],
    expect: [{ label: "自動で作らない（staff_confirm）", ok: (d) => d === "__STOPPED__staff_confirm" }] },
  { id: "late_apology", why: "⑧謝る返事（スタッフの 80% が絵文字なし）", state: "proposing",
    turns: [
      { sender: "staff", text: "かしこまりました！！\nエスリード長居 503号室の募集状況、本日確認させて頂きます！！確認出来次第ご連絡させて頂きます！！" },
      { sender: "customer", text: "昨日確認するって言ってたと思うんですけど、まだですかね？" },
    ],
    expect: [{ label: "謝罪の場面", ok: (d) => /申し訳|失礼/.test(d) }] },
  { id: "ack_short", why: "⑧短い了承 → 短い返事は絵文字なしでよい（人の 58%）", state: "proposing",
    turns: [
      { sender: "staff", text: "かしこまりました！！\n明日管理会社の営業開始後に確認させて頂き、確認出来次第ご連絡させて頂きます！！" },
      { sender: "customer", text: "了解です！" },
    ],
    expect: [
      { label: "短い返事は顔の絵文字なし", ok: (d) => d.replace(/\s/g, "").length >= 25 || !/[😊😌✨]/u.test(d) },
    ] },
];

/** LINE で崩れる・お客様に見せたくない形（送る文そのものを見る） */
function lineRenderRisks(t: string): string[] {
  const r: string[] = [];
  if (t.length > 5000) r.push(`5000字超（${t.length}）`);
  if (/\*\*[^*]+\*\*/.test(t)) r.push("Markdown の太字 **");
  if (/^\s{0,3}#{1,4}\s/m.test(t)) r.push("Markdown の見出し #");
  if (/^\s*[-*]\s+/m.test(t)) r.push("Markdown の箇条書き -");
  if (/\r/.test(t)) r.push("\\r（改行コード）");
  if (/\n{3,}/.test(t)) r.push("空行が2つ以上続く");
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t)) r.push("壊れた絵文字（サロゲートの片割れ）");
  if (/<<<|>>>|\[返信不要\]|【[^】]*(?:判定|分析|作業)[^】]*】/.test(t)) r.push("仕組みの印・作業メモ");
  if (female(t)) r.push("女性の絵文字");
  const oa = outsideAllow(t);
  if (oa.length) r.push(`入れてよい絵文字以外: ${oa.join("")}`);
  if (/[ \t]+\n/.test(t)) r.push("行末の空白");
  return r;
}

function secret(): string {
  const e = (process.env.INTERNAL_API_SECRET ?? "").trim();
  if (e) return e;
  const l = readFileSync(".env.prod", "utf8").split(/\r?\n/).find((x) => x.startsWith("INTERNAL_API_SECRET=")) ?? "";
  return l.slice("INTERNAL_API_SECRET=".length).trim().replace(/^"(.*)"$/, "$1");
}

/** 送る直前の宛先の確かめ（毎回 DB から読み直す）。YUMA 以外なら止める */
async function verifyDestination(): Promise<{ lineUserId: string; account: string }> {
  h!.assertYuma(YUMA, "LINE の送信");
  const { data, error } = await sb.from("conversations").select("id, customer_name, line_user_id, account, send_blocked_reason").eq("id", YUMA).single();
  if (error || !data) throw new Error(`宛先の会話を読めない: ${error?.message}`);
  const c = data as { id: string; customer_name: string | null; line_user_id: string | null; account: string | null; send_blocked_reason: string | null };
  if (c.id !== YUMA || c.customer_name !== "YUMA" || !c.line_user_id || c.send_blocked_reason) throw new Error(`宛先が YUMA でない／送れない: ${JSON.stringify({ id: c.id, name: c.customer_name, blocked: c.send_blocked_reason })}`);
  const { count } = await sb.from("conversations").select("id", { count: "exact", head: true }).eq("line_user_id", c.line_user_id);
  if (count !== 1) throw new Error(`同じ line_user_id の会話が ${count} 件（YUMA だけのはず）`);
  return { lineUserId: c.line_user_id, account: c.account ?? "sumora" };
}

async function realSend(payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; ids: string[]; error?: string }> {
  // 2026-10-02 竹内「テスト送信入っている。紛れないように」: 手元でも送信 API と同じ網（テストの印・JSON の名残は送らない）
  { const { detectOutgoingResidue } = await import("../app/lib/outgoing-residue"); const hits = detectOutgoingResidue(String(payload.message ?? "")); if (hits.length) return { ok: false, status: 0, ids: [], error: `outgoing_residue_local: ${hits.map((h) => h.label).join("・")}` }; }
  const dest = await verifyDestination();
  const body = { ...payload, line_user_id: dest.lineUserId, account: dest.account, conversation_id: YUMA };
  const res = await fetch(`${PROD}/api/send-line-message`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret()}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json().catch(() => ({})) as { ok?: boolean; sentMessageIds?: string[]; error?: string };
  return { ok: res.ok && !!j.ok, status: res.status, ids: j.sentMessageIds ?? [], error: j.error };
}

let cleanup: string[] = [];
const sentTexts: string[] = [];
const sentLineIds: string[] = [];
function writeFloor(floor: string | null, status = "proposing") {
  if (!FLOOR_FILE) return;
  writeFileSync(FLOOR_FILE, JSON.stringify(floor ? { conversationId: YUMA, floor, status } : {}));
}
async function insertRows(rows: Array<Record<string, unknown>>): Promise<Array<{ id: string; created_at: string; sender: string; text: string }>> {
  const ins = await sb.from("messages").insert(rows).select("id, created_at, sender, text");
  if (ins.error) throw new Error(`行を入れられず: ${ins.error.message}`);
  const out = (ins.data ?? []) as Array<{ id: string; created_at: string; sender: string; text: string }>;
  cleanup.push(...out.map((r) => r.id));
  return out;
}
async function removeOwn() {
  writeFloor(null);
  if (!cleanup.length) return;
  await sb.from("messages").delete().in("id", cleanup);
  cleanup = [];
}

/** 本番の送信の後に書かれる YUMA の記録（前後で比べる） */
async function sideRows(since: string) {
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const [t, col] of [["sent_facts", "created_at"], ["calendar_events", "created_at"], ["viewing_history", "created_at"], ["aix_action_items", "created_at"], ["sent_image_properties", "created_at"], ["brain_decision_logs", "created_at"]] as const) {
    const { data } = await sb.from(t).select("*").eq("conversation_id", YUMA).gte(col, since).limit(50);
    out[t] = (data ?? []) as Array<Record<string, unknown>>;
  }
  return out;
}

async function main() {
  h = await setupLlmTest("yuma-real-line-send-test");
  const analyzeConversation: Analyze = (await import("../app/lib/brain-core")).analyzeConversation;
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  if (!FLOOR_FILE) console.warn("⚠ REPLAY_FLOOR_FILE なし＝YUMA の過去の記録が場面に混ざる");
  if (SEND && h.run !== "final-claude") throw new Error("--send は最後の確かめ（LLM_TEST_FINAL_CLAUDE=1）の時だけ");
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const outFile = `${OUT_DIR}/${LABEL}.jsonl`;
  writeFileSync(outFile, "");
  const t0 = new Date().toISOString();
  await h.waitUntilYumaQuiet([]);
  const list = SCENES.filter((s) => !ONLY.length || ONLY.includes(s.id));
  console.log(`=== YUMA 実送信テスト ${list.length}場面 label=${LABEL} send=${SEND} base=${BASE} ===`);
  let sendSeq = 0;
  for (const sc of list) {
    try {
      h.assertSceneSafe(sc.turns.map((t) => t.text), sc.id);
      await h.waitUntilYumaQuiet(cleanup);
      const times = h.sceneTimes(sc.turns.length + 1, { offsetMin: 30 + sendSeq * 5, stepSec: 60 });
      const rows = await insertRows(sc.turns.map((t, i) => ({
        conversation_id: YUMA, sender: t.sender, text: t.text, is_aix_generated: false, line_message_id: `rls-${randomUUID()}`, created_at: times[i],
      })));
      writeFloor(new Date(Date.parse(rows[0].created_at) - 1000).toISOString(), sc.first ? "hearing" : sc.state);
      await new Promise((r) => setTimeout(r, 1200));
      const meta = await runInDeepseekScope(async () => {
        setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } });
        return analyzeConversation(YUMA, true, sc.first ? "hearing" : sc.state, null, "brain", { autoSendEnabled: false, customerName: sc.customerName ?? "YUMA", prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null });
      }) as Record<string, unknown> | null;
      const m = meta ?? {};
      if (sc.produce) {
        // AIX の文を作る（送る時はスタッフが AIX から送るのと同じ本文）
        const custAll = sc.turns.filter((t) => t.sender === "customer").map((t) => t.text);
        let texts: string[] = [];
        if (sc.produce === "hearing") {
          const r = await fetch(`${BASE}/api/aix/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
            action: "condition_hearing", account: "sumora", conversation_id: YUMA, customer_name: "YUMA",
            recent_messages: rows.map((r) => ({ sender: r.sender, text: r.text, createdAt: r.created_at, rawCreatedAt: r.created_at, isAix: false })),
          }), signal: AbortSignal.timeout(240_000) });
          const j = await r.json().catch(() => ({})) as Record<string, unknown>;
          texts = [String(j.message_text ?? ""), String(j.hearing_form ?? "")].filter((x) => x.trim());
        } else if (sc.produce === "apply_confirm" || sc.produce === "viewing") {
          const { classifyAixAutofill } = await import("../app/lib/aix-autofill-readiness");
          const action = sc.produce === "viewing" ? "viewing_invite" : "application_push";
          const pname = sc.id === "apply_decide" ? "S-RESIDENCE福島Luxe 1308号室" : sc.id === "apply_pay" ? "S-RESIDENCE江坂Eminence 601号室" : sc.id === "viewing3" ? "エスリード長居 503号室" : null;
          const fill = classifyAixAutofill({ action, customerText: custAll[custAll.length - 1] ?? "", staffTexts: sc.turns.filter((t) => t.sender === "staff").map((t) => t.text), propertyName: pname });
          console.log(`  自動反映: ${JSON.stringify(fill.request)}（${fill.level}・autoSend=${fill.autoSend.ok}）${fill.blockers.length ? ` 止める理由: ${fill.blockers.join("・")}` : ""}`);
          // 2026-10-02 竹内「AIXで止めておく」: 自動反映が作らない（申込フォーマット等）物は作らず送らない
          if (!fill.request) { const checks = sc.expect.map((e) => `${e.ok(`__STOPPED__${fill.level}`) ? "✓" : "✗"}${e.label}`); console.log(`\n【${sc.id}】${sc.why}\n  ブレイン: ${String(m.action ?? "-")}\n  AIX: 作らない（${fill.level}）\n  期待: ${checks.join(" ")}`); appendFileSync(outFile, JSON.stringify({ id: sc.id, brain: m.action ?? null, stopped: fill.level, checks }) + "\n"); continue; }
          const r = await fetch(`${BASE}/api/aix/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
            action, account: "sumora", conversation_id: YUMA, customer_name: "YUMA", conversation_status: sc.state,
            recent_messages: rows.map((r) => ({ sender: r.sender, text: r.text, createdAt: r.created_at, rawCreatedAt: r.created_at, isAix: false })),
            ...(fill.request ?? {}),
          }), signal: AbortSignal.timeout(240_000) });
          const j = await r.json().catch(() => ({})) as Record<string, unknown>;
          if (j.error) console.log(`  AIX ERROR ${String(j.error).slice(0, 200)}`);
          texts = [String(j.message_text ?? "")].filter((x) => x.trim());
        } else {
          const { detectCoResidentWithOccupants } = await import("../app/lib/co-resident");
          const { buildApplicationFormat } = await import("../app/lib/application-format");
          const v = detectCoResidentWithOccupants(custAll, [], null);
          console.log(`  同居人: ${JSON.stringify(v)}`);
          texts = v.value === "unknown" ? [] : [buildApplicationFormat(v.value, "emergency")];
        }
        const joined = texts.join("\n／\n");
        const checks = sc.expect.map((e) => `${e.ok(joined) ? "✓" : "✗"}${e.label}`);
        console.log(`\n【${sc.id}】${sc.why}\n  ブレイン: ${String(m.action ?? "-")} src=${String(m.decision_source ?? "-")}\n  AIX の文: ${joined.replace(/\n/g, " ⏎ ").slice(0, 700)}\n  LINE の崩れ: ${texts.flatMap(lineRenderRisks).join(" / ") || "なし"}\n  期待: ${checks.join(" ")}`);
        const sentIds: string[] = [];
        if (SEND && texts.length) {
          for (const tx of texts) {
            const sent = await realSend({ message: tx, origin: "manual" });
            sendSeq++;
            console.log(`  ▶ 本番の送信: ${sent.ok ? `届いた（LINE id ${sent.ids.join(",")}）` : `失敗 ${sent.status} ${sent.error}`}`);
            if (sent.ok) {
              sentTexts.push(tx); sentLineIds.push(...sent.ids); sentIds.push(...sent.ids);
              await insertRows([{ conversation_id: YUMA, sender: "staff", text: tx, is_aix_generated: true, line_message_id: sent.ids[0] ?? `rls-${randomUUID()}`, created_at: times[times.length - 1] }]);
            }
          }
        }
        appendFileSync(outFile, JSON.stringify({ id: sc.id, brain: m.action ?? null, aix: texts, checks, sent: sentIds }) + "\n");
        continue;
      }
      const custUnits = sc.turns.slice(sc.turns.map((t) => t.sender).lastIndexOf("staff") + 1).filter((t) => t.sender === "customer").map((t) => t.text);
      const body = {
        message: custUnits.join(MSG_SEP), customerMessages: custUnits, state: sc.state, conversationId: YUMA, customerName: sc.customerName ?? "YUMA",
        hasViewed: false, activeTaskTypes: [], hasStaffReplied: !sc.first,
        recentMessages: rows.map((r) => ({ sender: r.sender, text: r.text, createdAt: r.created_at, isAix: false })),
        brainMetaDirect: { meta: m, customerName: sc.customerName ?? "YUMA", conversationDirection: (m.conversation_direction as Record<string, unknown> | undefined) ?? null, brainAnalyzedAt: new Date().toISOString() },
        shadowNoWrite: true,
      };
      const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
      const raw = await res.text();
      const nl = raw.indexOf("\n");
      let text = raw;
      try { JSON.parse(raw.slice(0, nl)); text = raw.slice(nl + 1); } catch { /* 1行目が本文 */ }
      const fcm = text.match(/<<<FINAL_CHECK:([\s\S]*?)>>>/);
      let fc: Record<string, unknown> | null = null; try { fc = fcm ? JSON.parse(fcm[1]) : null; } catch { fc = null; }
      const draft = text.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
      // 画面と同じ送信前の関門
      const sendable = draftToSendableText(draft);
      const placeholders = sendable ? detectPlaceholders(sendable) : [];
      const toSend = sendable?.trim() ?? "";
      const risks = lineRenderRisks(toSend);
      const checks = sc.expect.map((e) => `${e.ok(toSend) ? "✓" : "✗"}${e.label}`);
      const blocks = ((fc?.issues as Array<Record<string, unknown>> | undefined) ?? []).filter((i) => i.severity === "block").map((i) => String(i.code));
      console.log(`\n【${sc.id}】${sc.why}\n  ブレイン: ${String(m.action ?? "-")} / ${String(m.reply_direction ?? "").slice(0, 60)}\n  下書き: ${draft.replace(/\n/g, " ⏎ ")}\n  送信前の関門: ${sendable === null ? "✗ 送れない（社内向け・生成失敗）" : sendable.trim() === draft ? "差なし" : "整形あり"}${placeholders.length ? ` ✗未置換 ${placeholders.join(" ")}` : ""}\n  最終チェックの block: ${blocks.join(",") || "なし"}\n  LINE の崩れ: ${risks.join(" / ") || "なし"}\n  期待: ${checks.join(" ")}`);
      let sent: Awaited<ReturnType<typeof realSend>> | null = null;
      if (SEND && toSend && !placeholders.length) {
        sent = await realSend({ message: toSend, origin: "manual" });
        sendSeq++;
        console.log(`  ▶ 本番の送信: ${sent.ok ? `届いた（LINE id ${sent.ids.join(",")}）` : `失敗 ${sent.status} ${sent.error}`}`);
        if (sent.ok) {
          sentTexts.push(toSend); sentLineIds.push(...sent.ids);
          await insertRows([{ conversation_id: YUMA, sender: "staff", text: toSend, is_aix_generated: false, line_message_id: sent.ids[0] ?? `rls-${randomUUID()}`, created_at: times[times.length - 1] }]);
        }
      }
      appendFileSync(outFile, JSON.stringify({ id: sc.id, brain: m.action ?? null, draft, sendable, placeholders, risks, checks, blocks, sent }) + "\n");
    } catch (e) {
      console.log(`【${sc.id}】ERROR ${String(e).slice(0, 300)}`);
    } finally {
      await removeOwn();
    }
  }
  // 書式の点検の1通（スタッフの実送信の形: 空行・見出しの🌟・絵文字・長い URL・全角の記号）
  if (SEND && PROBE) {
    // 2026-10-02 竹内「テスト送信入っている。紛れないように」: テストの印・ラベルを本文に入れない（実物と同じ形の文だけ送る。送信 API の最後の網 outgoing-residue.ts も印を止める）
    const probe = "YUMAさんお世話になっております！！\n\n🌟エスリード長居 503\n家賃管理費込68,000円・御堂筋線「長居」駅徒歩3分\n\nお手隙の際にご査収ください😌！！\nhttps://suumo.jp/chintai/jnc_000000000000/?bc=100000000000\n①②③ ㎡ ～ ￥11,000（税込）";
    const r = await realSend({ message: probe, origin: "manual" });
    console.log(`\n【probe】書式の点検: ${r.ok ? `届いた（${r.ids.join(",")}）` : `失敗 ${r.status} ${r.error}`}\n  LINE の崩れ（送った文の点検）: ${lineRenderRisks(probe).join(" / ") || "なし"}`);
    if (r.ok) { sentTexts.push(probe); sentLineIds.push(...r.ids); }
  }
  // 2026-10-02 竹内「1通の中で同じ絵文字を重ねない（全部😊の文も）」: 出口（dedupeRepeatedEmoji＝返信・AIX の最後と同じ関数）を通した文を送る
  if (SEND && DEDUPE_PROBE) {
    const { dedupeRepeatedEmoji } = await import("../app/lib/emoji-repeat");
    const raw = "YUMAさん、お部屋お送り頂きありがとうございます😊！！\nこちらのお部屋の募集状況確認させて頂きます😊！！\n確認出来次第ご連絡させて頂きますので、お手隙の際にご確認ください😊！！\n何卒よろしくお願い致します🙇‍♀️";
    const fixed = dedupeRepeatedEmoji(raw);
    const r = await realSend({ message: fixed.text, origin: "manual" });
    console.log(`\n【dedupe】出口の前: ${raw.replace(/\n/g, " ⏎ ")}\n  出口の後: ${fixed.text.replace(/\n/g, " ⏎ ")}\n  送信: ${r.ok ? `届いた（${r.ids.join(",")}）` : `失敗 ${r.status} ${r.error}`}・LINE の崩れ: ${lineRenderRisks(fixed.text).join(" / ") || "なし"}`);
    if (r.ok) { sentTexts.push(fixed.text); sentLineIds.push(...r.ids); }
  }
  // 画像のまとめ送り（AIX の物件ピックアップと同じ形: 画像2枚＋本文を1回の送信に）
  if (SEND && IMAGES) {
    const { data: imgs } = await sb.from("messages").select("image_url").eq("conversation_id", YUMA).eq("sender", "staff").not("image_url", "is", null).order("created_at", { ascending: false }).limit(2);
    const urls = ((imgs ?? []) as Array<{ image_url: string }>).map((x) => x.image_url).filter(Boolean);
    if (urls.length) {
      const text = "お手隙の際にご査収ください😌！！";
      const r = await realSend({ image_urls: urls, message: text, origin: "aix", aix_type: "property_send" });
      console.log(`\n【images】画像${urls.length}枚＋本文: ${r.ok ? `届いた（${r.ids.length}通: ${r.ids.join(",")}）` : `失敗 ${r.status} ${r.error}`}`);
      if (r.ok) { sentTexts.push(text); sentLineIds.push(...r.ids); }
    }
  }
  if (SEND) {
    // 本番の送信の後（after）に書かれた YUMA の記録を待って比べる
    await new Promise((r) => setTimeout(r, 45_000));
    const side = await sideRows(t0);
    console.log("\n=== 送信の後に本番が書いた YUMA の記録（この回以降） ===");
    for (const [t, rows] of Object.entries(side)) console.log(`  ${t}: ${rows.length}行 ${rows.slice(0, 4).map((r) => JSON.stringify(r).slice(0, 160)).join(" | ")}`);
    writeFileSync(`${OUT_DIR}/${LABEL}-side.json`, JSON.stringify({ t0, sentTexts, sentLineIds, side }, null, 1));
  }
  console.log(`\n出力: ${outFile}`);
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await removeOwn(); if (h) await h.finish().catch((e) => console.warn("finish:", String(e))); setTimeout(() => process.exit(process.exitCode ?? 0), 800); });
