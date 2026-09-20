// scripts/verify-apply-readiness.ts
// 実行: npx tsx --env-file=.env.local scripts/verify-apply-readiness.ts
//       （ローカル検証は VERIFY_BASE_URL=http://localhost:3000 を付ける）
//
// 2026-09-20 竹内「文おかしい文が出来ないかテストしておこなう いろんなパターンを想定してテスト行う」:
//   申込が近い合図（apply-readiness）を**本番と同じ経路**で通し、
//   ①覚え書きが本文に漏れていないか ②申込を迫る文になっていないか を実際の生成文で確かめる。
//
// 書き込みを伴うのでテスト会話「YUMA」だけを使う（竹内さんのルール）。
// 場面は body.recentMessages で作る（＝実データの「申込が近い並び」を再現する）。
export {};
import { detectApplyReadiness, buildApplyReadinessNote, type ApplyMsg } from "../app/lib/apply-readiness";

const BASE = process.env.VERIFY_BASE_URL ?? "https://sumora-ai-ui.vercel.app";
const CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"; // YUMA（竹内さん本人のテスト会話）
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

/** 想定する場面。実データの並びをそのまま使う */
const CASES: Array<{ name: string; state: string; message: string; msgs: ApplyMsg[] }> = [
  {
    // 前田さんの型: 申込の話まで来て「中を見ていない」で止まった → ここで内覧を挟めるか
    name: "申込が近い（見積書・割引・審査の質問・前向き）",
    state: "proposing",
    message: "ありがとうございます！ もう申し込みさせてもらおうかと思います！",
    msgs: [
      { sender: "staff", text: "お世話になっております！！ お部屋お送りさせて頂きます！！", createdAt: ago(4) },
      { sender: "customer", text: "ありがとうございます！ 内覧してみたいです", createdAt: ago(3) },
      { sender: "staff", text: "最大限割引しました初期費用の御見積書となります！！", createdAt: ago(2) },
      { sender: "customer", text: "いいですね！ この物件すごく気に入りました", createdAt: ago(2) },
      { sender: "customer", text: "審査はどれくらいかかりますか？ 必要な書類はありますか？", createdAt: ago(1) },
      { sender: "staff", text: "待ち合わせは現地エントランスにてお願い致します！！", createdAt: ago(1) },
    ],
  },
  {
    // ★一番危ない場面: 合図は強いのに**お客様は申込を言っていない**。ここで迫ったらアウト
    name: "申込が近いが、お客様は「検討します」（迫ってはいけない）",
    state: "proposing",
    message: "ありがとうございます！ 一度持ち帰って検討させて頂きます！",
    msgs: [
      { sender: "staff", text: "お世話になっております！！ お部屋お送りさせて頂きます！！", createdAt: ago(4) },
      { sender: "customer", text: "内覧してみたいです", createdAt: ago(3) },
      { sender: "staff", text: "最大限割引しました初期費用の御見積書となります！！", createdAt: ago(2) },
      { sender: "customer", text: "いいですね！ この物件気に入りました", createdAt: ago(2) },
      { sender: "customer", text: "審査ってどんな書類がいりますか？", createdAt: ago(1) },
      { sender: "staff", text: "待ち合わせは現地エントランスにてお願い致します！！", createdAt: ago(1) },
    ],
  },
  {
    // 前田さんの型そのもの: 見積書は出ているが**内覧していない**。抜けている手順を埋められるか
    name: "申込が近いが内覧が抜けている（前田さんの失注の型）",
    state: "proposing",
    message: "こちらのお部屋、申し込もうか迷っています",
    msgs: [
      { sender: "staff", text: "お世話になっております！！ お部屋お送りさせて頂きます！！", createdAt: ago(5) },
      { sender: "customer", text: "この物件いいですね", createdAt: ago(4) },
      { sender: "staff", text: "最大限割引しました初期費用の御見積書となります！！", createdAt: ago(3) },
      { sender: "customer", text: "ありがとうございます！ 入居日はいつからになりますか？", createdAt: ago(2) },
      { sender: "customer", text: "審査は厳しいですか？", createdAt: ago(1) },
      { sender: "staff", text: "独立系の保証会社となりますのでご安心ください！！", createdAt: ago(1) },
    ],
  },
  {
    // まだ早い場面。覚え書きは出ないはず（＝出ないことも確かめる）
    name: "まだ early（条件を聞いている途中）",
    state: "condition_hearing",
    message: "もう少し駅に近い所がいいです",
    msgs: [
      { sender: "staff", text: "お世話になっております！！ ご条件お聞かせください😊！！", createdAt: ago(3) },
      { sender: "customer", text: "1LDKで10万円以内を探しています", createdAt: ago(2) },
      { sender: "staff", text: "かしこまりました！！ お探しさせて頂きます！！", createdAt: ago(2) },
      { sender: "customer", text: "よろしくお願いします", createdAt: ago(1) },
    ],
  },
];

/** 覚え書きが本文に漏れていないかの点検（実物の行を使う） */
function checkLeak(body: string, note: string): string[] {
  const bad: string[] = [];
  for (const line of note.split("\n")) {
    const core = line.replace(/^- /, "").slice(0, 14);
    if (core && body.includes(core)) bad.push(line);
  }
  if (/^\s*[-*#]/m.test(body)) bad.push("箇条書きの行が本文にある");
  if (/申込が近い|合図|判断の材料|点】/.test(body)) bad.push("覚え書きの語が本文にある");
  return bad;
}

async function main() {
  console.log(`── 生成先: ${BASE}  会話: YUMA\n`);
  for (const c of CASES) {
    const r = detectApplyReadiness(c.msgs, Date.now());
    const note = buildApplyReadinessNote(r);
    console.log(`═══ ${c.name} ═══`);
    console.log(`  判定: ${r.level} ${r.score}点 (${r.reason || "合図なし"})`);
    console.log(`  覚え書き: ${note ? `${note.split("\n").length}行` : "出さない"}`);

    const res = await fetch(`${BASE}/api/generate-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: c.message, state: c.state, conversationId: CONV, customerName: "YUMA",
        hasViewed: false, activeTaskTypes: [],
        recentMessages: c.msgs.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.createdAt, isAix: false })),
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const raw = await res.text();
    if (!res.ok) { console.log(`  ⚠ HTTP ${res.status}: ${raw.slice(0, 300)}\n`); continue; }

    let text = "";
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const dd = t.slice(5).trim();
      if (!dd || dd === "[DONE]") continue;
      try { const j = JSON.parse(dd) as { text?: string; delta?: string; content?: string }; text += j.text ?? j.delta ?? j.content ?? ""; }
      catch { /* 本文以外 */ }
    }
    if (!text) text = raw.replace(/^data:\s*/gm, "").trim();
    if (text.includes("<<<FINAL_CHECK")) text = text.slice(0, text.indexOf("<<<FINAL_CHECK"));
    if (text.startsWith("{")) { const nl = text.indexOf("\n"); if (nl > 0) text = text.slice(nl + 1); }
    text = text.trim();

    console.log("  ━━━━━━ 生成された文 ━━━━━━");
    console.log(text.split("\n").map((l) => `  ${l}`).join("\n"));
    console.log("  ━━━━━━━━━━━━━━━━━━━");
    const leaks = checkLeak(text, note || "- ダミー");
    console.log(`  ${leaks.length === 0 ? "✅" : "⚠"} 覚え書きの漏れ: ${leaks.length === 0 ? "なし" : leaks.join(" / ")}`);
    // 前田さんの失注の型: 合図が強い時に申込を迫っていないか
    const pushy = /お申込[みし]?(?:を)?(?:させて|進め|お願い|頂け|いただけ)|申込書|お申し込みください/.test(text);
    console.log(`  ${pushy ? "⚠" : "✅"} こちらから申込を迫っていない`);
    console.log("");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
