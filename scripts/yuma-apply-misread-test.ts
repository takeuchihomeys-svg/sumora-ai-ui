// 「お願いします🤭」を申込と取らないか（YUMA・本番と同じ generate-reply）＋ LLM に材料が届いているか（llm_usage_logs）
// 2026-09-22 竹内（みなみさん事例）「また申込ととってしまっている。原因見つけて改善する」
//   原因: 伏せ字処理が材料の塊ごと「[お申込み情報を受け取りました]」に差し替え、LLM に会話もブレインの判断も届いていなかった
// ⚠ 書き込みを伴う（YUMA に場面を入れて、確認後に必ず消す）
// 実行: npx tsx --env-file=.env.local scripts/yuma-apply-misread-test.ts [--runs=2]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const RUNS = Number((process.argv.find((a) => a.startsWith("--runs=")) ?? "--runs=2").split("=")[1]);

async function main() {
  const now = Date.now(); const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const scene = [
    { sender: "staff", text: "【ペット飼育時条件】\n①南堀江アパートメントグランデ ペット飼育時敷金1ヶ月\n②コバルト心斎橋EAST １頭につき3000円 ※現在リノベーション工事中", created_at: iso(40 * 60_000) },
    { sender: "customer", text: "コバルト心斎橋EASTは\nまだ内見も出来なさそうな感じですか？？\nもしまだなら工事終わったら内見してみたいんですが😌", created_at: iso(10 * 60_000) },
    { sender: "staff", text: "かしこまりました！！\n確認させて頂きます😊！！", created_at: iso(5 * 60_000) },
    { sender: "customer", text: "お願いします🤭", created_at: iso(60_000) },
  ];
  const ins = await sb.from("messages").insert(scene.map((m) => ({ conversation_id: YUMA, ...m }))).select("id");
  if (ins.error) { console.log("場面を作れず:", ins.error.message); return; }
  const made = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
  try {
    for (let i = 0; i < RUNS; i++) {
      const t0 = new Date().toISOString();
      let draft = "";
      try {
        const res = await fetch(`${BASE}/api/generate-reply`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "お願いします🤭", customerMessages: ["お願いします🤭"], state: "proposing", conversationId: YUMA, customerName: "YUMA", hasViewed: false, activeTaskTypes: [],
            recentMessages: scene.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: false })),
          }),
          signal: AbortSignal.timeout(300_000),
        });
        const raw = await res.text(); const nl = raw.indexOf("\n");
        const meta = nl >= 0 ? (JSON.parse(raw.slice(0, nl)) as { ok?: boolean; reason?: string }) : { ok: false };
        draft = meta.ok ? raw.slice(nl + 1) : `（生成されず: ${(meta as { reason?: string }).reason ?? "?"}）`;
      } catch (e) { draft = `（エラー: ${e instanceof Error ? e.message : String(e)}）`; }
      const body = draft.replace(/\n?<<<[A-Z_]+:[\s\S]*?(?:>>>|$)/g, "").trim();
      const { data: u } = await sb.from("llm_usage_logs").select("model, input_uncached, cache_read, cache_write").eq("route", "/api/generate-reply").eq("conversation_id", YUMA).gte("created_at", t0).order("created_at");
      const main = ((u ?? []) as Array<{ model: string; input_uncached: number; cache_read: number; cache_write: number }>).filter((r) => /deepseek-v4-pro|sonnet|opus/.test(r.model));
      console.log(`\n── ${i + 1}回目 ──\n${body.replace(/\n/g, " ／ ").slice(0, 240)}`);
      console.log(`   ${/申込|お申込/.test(body) ? "⚠ 申込の語あり" : "✅ 申込の語なし"} ／ LLM: ${main.map((r) => `${r.model} 動的部分=${r.input_uncached} キャッシュ=${r.cache_read}`).join(" ・ ") || "（記録なし）"}`);
    }
  } finally {
    await sb.from("messages").delete().in("id", made);
    await sb.from("conversations").update({ ai_draft: null, ai_draft_check: null }).eq("id", YUMA);
    console.log(`\n   後片付け: 場面 ${made.length}件を削除`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
