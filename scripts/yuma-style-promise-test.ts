// 何卒・絵文字・約束の場面（YUMA・本番と同じ generate-reply）
// 2026-09-22 竹内「①かしこまりました・何卒 ②絵文字 ③約束（約束する場面なら約束するようにブレインを強化）」
//   A: こちらが「確認出来次第ご連絡」と約束して130時間・報告なし → お客様「その後どうなりましたか？」
//   B: お客様の質問「こちら2年ごとに更新料かかりますか？」（何卒は実送信 5.6%・説明の行に絵文字 1.7%）
// ⚠ 書き込みを伴う（YUMA に場面を入れて、確認後に必ず消す）
// 実行: npx tsx --env-file=.env.local scripts/yuma-style-promise-test.ts [--runs=2]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const RUNS = Number((process.argv.find((a) => a.startsWith("--runs=")) ?? "--runs=2").split("=")[1]);
const MSG_SEP = "\n⁣\n";
const EMOJI_RE = /\p{Extended_Pictographic}/u;

type S = { sender: string; text: string; created_at: string };
async function run(label: string, scene: S[], check: (body: string) => string[]) {
  const ins = await sb.from("messages").insert(scene.map((m) => ({ conversation_id: YUMA, ...m }))).select("id");
  if (ins.error) { console.log("場面を作れず:", ins.error.message); return; }
  const made = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
  const cust = scene.filter((m, i) => m.sender === "customer" && scene.slice(i).every((x) => x.sender === "customer"));
  try {
    for (let i = 0; i < RUNS; i++) {
      let draft = "";
      try {
        const res = await fetch(`${BASE}/api/generate-reply`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: cust.map((m) => m.text).join(MSG_SEP), customerMessages: cust.map((m) => m.text),
            state: "proposing", conversationId: YUMA, customerName: "YUMA", hasViewed: false, activeTaskTypes: [],
            recentMessages: scene.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: false })),
          }),
          signal: AbortSignal.timeout(300_000),
        });
        const raw = await res.text(); const nl = raw.indexOf("\n");
        const meta = nl >= 0 ? (JSON.parse(raw.slice(0, nl)) as { ok?: boolean; reason?: string }) : { ok: false };
        draft = meta.ok ? raw.slice(nl + 1) : `（生成されず: ${(meta as { reason?: string }).reason ?? "?"}）`;
      } catch (e) { draft = `（エラー: ${e instanceof Error ? e.message : String(e)}）`; }
      const body = draft.replace(/\n?<<<[A-Z_]+:[\s\S]*?(?:>>>|$)/g, "").trim();
      console.log(`\n── ${label} ${i + 1}回目 ──\n${body.replace(/\n/g, " ／ ").slice(0, 300)}`);
      for (const c of check(body)) console.log(`   ${c}`);
    }
  } finally {
    await sb.from("messages").delete().in("id", made);
    await sb.from("conversations").update({ ai_draft: null, ai_draft_check: null }).eq("id", YUMA);
    console.log(`   後片付け: 場面 ${made.length}件を削除`);
  }
}

async function main() {
  const now = Date.now(); const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  await run("A 約束から130時間・催促", [
    { sender: "customer", text: "1度この物件で代理契約可能か確認していただけますでしょうか？", created_at: iso(131 * 3600_000) },
    { sender: "staff", text: "かしこまりました！！\n代理契約可能か管理会社に確認出来次第ご連絡させて頂きます😌！！", created_at: iso(130 * 3600_000) },
    { sender: "customer", text: "その後どうなりましたか？", created_at: iso(60_000) },
  ], (b) => [
    /確認|ご連絡|管理会社|代理契約/.test(b) ? "✅ 約束（代理契約の確認）に触れた" : "⚠ 約束に触れていない",
    /確認(?:させて(?:頂|いただ)きました|しました)ところ|可能となります|不可/.test(b) ? "⚠ 確認していない結果を書いた" : "✅ 結果を作っていない",
  ]);
  await run("B 質問への返事", [
    { sender: "staff", text: "YUMAさんお世話になっております！！\n天王寺周辺からオススメのお部屋ピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！", created_at: iso(26 * 3600_000) },
    { sender: "customer", text: "こちら2年ごとに更新料かかりますか？", created_at: iso(60_000) },
  ], (b) => {
    const lines = b.split("\n").map((l) => l.trim()).filter(Boolean);
    const explainWithEmoji = lines.filter((l) => EMOJI_RE.test(l) && /(?:となります|です|ございます)[！!]*\p{Extended_Pictographic}/u.test(l) && !/させて|ください|ありがとう/.test(l));
    return [
      /何卒よろしくお願い/.test(b) ? "△ 何卒あり（この場面の実送信 5.6%）" : "✅ 何卒なし",
      explainWithEmoji.length ? `△ 説明・報告の行に絵文字: ${explainWithEmoji.join(" ／ ")}` : "✅ 説明・報告の行に絵文字なし",
    ];
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
