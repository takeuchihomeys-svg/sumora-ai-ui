// 今の仕組みで生成される文の質を YUMA で確かめる（本番と同じ経路）
//
// 2026-09-21 竹内「これでブレインの考え方が優先されてファイナルチェックは文字の誤字や禁止用語入れない
//   ハルシネーション防ぐ部分に限定されて質よくなったかな？」
//
// 見るところ（今日入れた直しが全部乗っているか）:
//   ① 最終チェックの指摘が「誤字・禁止語・ハルシネーション」だけか（文体の指摘が出ていないか）
//   ② 直前に自分が送った文の焼き直しになっていないか（previous-send-note）
//   ③ 「何卒よろしくお願い致します」の有無が場面に合っているか（sent-shape）
//   ④ 改行・1行の長さが実送信の型に近いか（sent-shape）
//   ⑤ 開口語が実送信でほぼ0の形になっていないか（opener-rates）
//   ⑥ 完全に締まっている場面では下書きを作らない（previous-send-note）
//
// 設計知見「生成の直しは同じ場面を3回以上回して平均で見る」→ REPS=2 以上を推奨。
//
// ⚠ 書き込みを伴う（YUMA に場面の2通を入れて、確認後に必ず消す）。テスト会話 YUMA だけで動かす。
// 実行: REPS=2 npx tsx --env-file=.env.local scripts/yuma-quality-test.ts
import { createClient } from "@supabase/supabase-js";
import { messageSimilarity } from "../app/lib/phrase-shape";
import { classifySentKind, checkSentShape, NANITOZO_RATE, LINE_CHARS_P90 } from "../app/lib/sent-shape";
import { openerLabelOf } from "../app/lib/opener-rates";
import { classifyIssueScope } from "../app/lib/final-check-scope";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cleanup: string[] = [];

/** 実データから取った場面（想像で作らない） */
const SCENES: Array<{ id: string; staff: string; customer: string; want?: "下書き" | "返信不要" }> = [
  {
    id: "①ピックアップの約束→了承",
    staff: "かしこまりました！！\n塚本・大国町エリアでもオススメ出来るお部屋ピックアップさせて頂きます！！\nピックアップ出来次第ご連絡させて頂きます😌！！",
    customer: "はい、よろしくお願いします",
    want: "下書き",
  },
  {
    id: "②内覧日が確定した後→了承（9/02 実例）",
    staff: "かしこまりました！！\n9/8（火）ご案内させて頂きます！！\n\n9/8 15:00にウェルスクエア池田井口堂 \n現地エントランスお待ち合わせで何卒よろしくお願い致します！！",
    customer: "はい！",
    want: "下書き",
  },
  {
    id: "③締めだけ→短い了承（竹内さんのスクショ）",
    staff: "はい！！\nその間もYUMAさん気になる点出てきましたらお気軽にご質問ください😊！！\n何卒よろしくお願い致します！！",
    customer: "はい！ありがとうございます",
    want: "返信不要",
  },
  {
    id: "④お客様が質問している（必ず返す場面）",
    staff: "はい！！\nその間もYUMAさん気になる点出てきましたらお気軽にご質問ください😊！！",
    customer: "ありがとうございます！ちなみに保証会社ってどこになりますか？",
    want: "下書き",
  },
];

async function arm() {
  await sb.from("conversations").update({
    last_sender: "customer", ai_draft: null, ai_draft_check: null,
    draft_attempted_at: null, draft_pending_at: null, draft_fail_count: 0, draft_last_error: null,
  }).eq("id", YUMA);
}
async function waitForDraft(timeoutMs = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(3000);
    const { data } = await sb.from("conversations").select("ai_draft, ai_draft_check").eq("id", YUMA).maybeSingle();
    const row = (data ?? {}) as Record<string, unknown>;
    const d = String(row.ai_draft ?? "");
    if (d === "[AIX誘導中]" || d === "[返信不要]") return { draft: "", check: row.ai_draft_check, sentinel: d };
    if (d && d !== "__SHOWN__") return { draft: d, check: row.ai_draft_check, sentinel: "" };
  }
  return { draft: "", check: null, sentinel: "" };
}

type Issue = { code?: string; severity?: string; message?: string };

async function main() {
  const reps = Number(process.env.REPS ?? 1);
  let styleShown = 0, factShown = 0, reuse = 0, longLine = 0, rareOpener = 0, nanitozoOdd = 0, judged = 0, want = 0;
  const sims: number[] = [];

  const runs = SCENES.flatMap((s) => Array.from({ length: reps }, (_, k) => ({ ...s, id: reps > 1 ? `${s.id}[${k + 1}]` : s.id })));
  for (const s of runs) {
    const now = Date.now();
    const ins = await sb.from("messages").insert([
      { conversation_id: YUMA, sender: "staff", text: s.staff, created_at: new Date(now - 10 * 60_000).toISOString() },
      { conversation_id: YUMA, sender: "customer", text: s.customer, created_at: new Date(now - 60_000).toISOString() },
    ]).select("id");
    if (ins.error) { console.log(`【${s.id}】場面を作れず: ${ins.error.message}`); continue; }
    const made = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
    cleanup.push(...made);

    let skipped = "";
    for (let a = 0; a < 2; a++) {
      await arm();
      try {
        const res = await fetch(`${BASE}/api/generate-draft-bg-async`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation_id: YUMA, source: "direct" }),
        });
        skipped = String(((await res.json()) as Record<string, unknown>).skipped ?? "");
      } catch (e) { skipped = `fetch失敗:${e instanceof Error ? e.message : String(e)}`; }
      if (skipped !== "in_progress") break;
      await sleep(20_000);
    }
    const { draft, check, sentinel } = skipped ? { draft: "", check: null, sentinel: "" } : await waitForDraft();
    const out = draft.replace(/\n?<<<[A-Z_]{3,}[\s\S]*?(?:>>>|$)/g, "").trim();

    await sb.from("messages").delete().in("id", made);
    cleanup = cleanup.filter((x) => !made.includes(x));
    await sb.from("conversations").update({ ai_draft: null, ai_draft_check: null, draft_attempted_at: null, draft_pending_at: null }).eq("id", YUMA);
    await sleep(8000);

    console.log(`${"─".repeat(78)}`);
    console.log(`【${s.id}】`);
    console.log(`   お客様  : ${s.customer}`);
    if (s.want) {
      judged++;
      const got = sentinel === "[返信不要]" ? "返信不要" : out ? "下書き" : "（出なかった）";
      const ok = got === s.want;
      if (ok) want++;
      console.log(`   期待「${s.want}」→ 実際「${got}」 ${ok ? "✅" : "❌"}${sentinel && sentinel !== "[返信不要]" ? `（${sentinel}）` : ""}`);
    }
    if (!out) continue;
    console.log(`   生成文  : ${out.replace(/\n/g, " ／ ").slice(0, 200)}`);

    // ① 最終チェックの指摘
    const issues = ((check as { issues?: Issue[] } | null)?.issues ?? []);
    const st = issues.filter((i) => classifyIssueScope(i.code) === "style");
    const ft = issues.filter((i) => classifyIssueScope(i.code) !== "style");
    styleShown += st.length; factShown += ft.length;
    console.log(`   最終チェック: 合計${issues.length}件  事実・安全${ft.length}件  文体${st.length}件${st.length ? "  ⚠ 文体が残っている" : ""}`);
    for (const i of issues) console.log(`     [${classifyIssueScope(i.code)}] ${i.code}: ${String(i.message ?? "").slice(0, 80)}`);

    // ② 焼き直し
    const sim = messageSimilarity(out, s.staff);
    sims.push(sim);
    if (sim >= 0.70) reuse++;
    // ③④ 何卒・改行
    const shape = checkSentShape(out);
    const rate = NANITOZO_RATE[classifySentKind(out)];
    const odd = shape.hasNanitozo && rate < 2.0;
    if (odd) nanitozoOdd++;
    if (shape.longLines.length) longLine++;
    // ⑤ 開口語
    const op = openerLabelOf(out);
    console.log(`   直前との近さ ${sim.toFixed(2)}${sim >= 0.7 ? " ⚠焼き直し" : ""}`
      + ` ／ 種類「${shape.kind}」何卒${shape.hasNanitozo ? `あり(実測${rate}%)${odd ? " ⚠" : ""}` : "なし"}`
      + ` ／ ${shape.lines}行・長い行${shape.longLines.length}本 ／ 書き出し「${op}」`);
  }

  if (cleanup.length) await sb.from("messages").delete().in("id", cleanup);
  const avg = sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : 0;
  console.log(`\n${"─".repeat(78)}`);
  console.log(`=== まとめ ===`);
  console.log(`   期待どおりの分岐       ${want}/${judged}`);
  console.log(`   最終チェックの指摘     事実・安全 ${factShown}件 / 文体 ${styleShown}件（文体は0が正しい）`);
  console.log(`   直前との近さ 平均      ${avg.toFixed(3)}（焼き直し ${reuse}件）`);
  console.log(`   ${LINE_CHARS_P90}字を超える行があった   ${longLine}件`);
  console.log(`   実送信ほぼ0の場面で何卒 ${nanitozoOdd}件`);
  console.log(`   後片付けの残り ${cleanup.length}件`);
  console.log(`※ 終わったら: npx tsx --env-file=.env.local scripts/yuma-snapshot.ts restore`);
}
main().catch(async (e) => {
  if (cleanup.length) await sb.from("messages").delete().in("id", cleanup);
  console.error(e); process.exit(1);
});
