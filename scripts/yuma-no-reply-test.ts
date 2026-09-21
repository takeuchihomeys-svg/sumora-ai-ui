// 「完全に締まっていたら下書きを作らない」が本番の経路で効くか（YUMA）
//
// 2026-09-21 竹内「文締めることなくて完全にしまってたら返信しなくて大丈夫」
//
// 本番は line-webhook → generate-draft-bg-async（ブレイン→生成）。
// 止まると conversations.ai_draft に "[返信不要]" が入る。
//
// ⚠ 書き込みを伴う（YUMA に場面の2通を入れて、確認後に必ず消す）。テスト会話 YUMA だけで動かす。
// 実行: npx tsx --env-file=.env.local scripts/yuma-no-reply-test.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cleanup: string[] = [];

/** 止まってほしい場面 / 止まってはいけない場面（どちらも実データの形） */
const SCENES: Array<{ id: string; staff: string; customer: string; want: "止まる" | "作る" }> = [
  {
    id: "①竹内さんのスクショ（締めだけ→短い了承）",
    staff: "はい！！\nその間もYUMAさん気になる点出てきましたらお気軽にご質問ください😊！！\n何卒よろしくお願い致します！！",
    customer: "はい！ありがとうございます",
    want: "止まる",
  },
  {
    id: "②見積書の後→お礼（9/12 実例）",
    staff: "こちら初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！\n何卒よろしくお願い致します！！",
    customer: "ありがとうございます！",
    want: "止まる",
  },
  {
    id: "③ピックアップの約束が残っている→了承",
    staff: "かしこまりました！！\n塚本・大国町エリアでもオススメ出来るお部屋ピックアップさせて頂きます！！\nピックアップ出来次第ご連絡させて頂きます😌！！",
    customer: "はい、よろしくお願いします",
    want: "作る",
  },
  {
    id: "④締めだけでもお客様が質問している",
    staff: "はい！！\nその間もYUMAさん気になる点出てきましたらお気軽にご質問ください😊！！\n何卒よろしくお願い致します！！",
    customer: "ありがとうございます！内覧っていつできますか？",
    want: "作る",
  },
];

async function arm() {
  await sb.from("conversations").update({
    last_sender: "customer", ai_draft: null, ai_draft_check: null,
    draft_attempted_at: null, draft_pending_at: null, draft_fail_count: 0, draft_last_error: null,
  }).eq("id", YUMA);
}
async function waitForResult(timeoutMs = 240_000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(3000);
    const { data, error } = await sb.from("conversations").select("ai_draft").eq("id", YUMA).maybeSingle();
    if (error) return `(読めない: ${error.message})`;
    const d = String((data as Record<string, unknown> | null)?.ai_draft ?? "");
    if (d && d !== "__SHOWN__") return d;
  }
  return "";
}

async function main() {
  let ok = 0, ng = 0;
  for (const s of SCENES) {
    const now = Date.now();
    const ins = await sb.from("messages").insert([
      { conversation_id: YUMA, sender: "staff", text: s.staff, created_at: new Date(now - 10 * 60_000).toISOString() },
      { conversation_id: YUMA, sender: "customer", text: s.customer, created_at: new Date(now - 60_000).toISOString() },
    ]).select("id");
    if (ins.error) { console.log(`【${s.id}】場面を作れず: ${ins.error.message}`); continue; }
    const made = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
    cleanup.push(...made);

    let skipped = "";
    for (let attempt = 0; attempt < 2; attempt++) {
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
    const draft = skipped ? "" : await waitForResult();

    await sb.from("messages").delete().in("id", made);
    cleanup = cleanup.filter((x) => !made.includes(x));
    await sb.from("conversations").update({ ai_draft: null, ai_draft_check: null, draft_attempted_at: null, draft_pending_at: null }).eq("id", YUMA);
    await sleep(8000);

    const stopped = draft === "[返信不要]";
    const judged = (s.want === "止まる") === stopped;
    if (judged) ok++; else ng++;
    console.log(`${"─".repeat(76)}`);
    console.log(`【${s.id}】期待「${s.want}」→ 実際「${stopped ? "止まった" : draft ? "作った" : `出なかった(${skipped || "タイムアウト/AIX誘導"})`}」 ${judged ? "✅" : "❌"}`);
    console.log(`   直前送信: ${s.staff.replace(/\n/g, " ／ ")}`);
    console.log(`   お客様  : ${s.customer}`);
    console.log(`   下書き  : ${draft.replace(/\n/g, " ／ ").slice(0, 160) || "（なし）"}`);
  }
  if (cleanup.length) await sb.from("messages").delete().in("id", cleanup);
  console.log(`\n${"─".repeat(76)}`);
  console.log(`=== まとめ: ${ok}/${ok + ng} 期待どおり（後片付けの残り ${cleanup.length}件）===`);
  console.log(`※ 終わったら: npx tsx --env-file=.env.local scripts/yuma-snapshot.ts restore`);
}
main().catch(async (e) => {
  if (cleanup.length) await sb.from("messages").delete().in("id", cleanup);
  console.error(e); process.exit(1);
});
