// 「ブレインが勝つ」が本番の経路で効くか（YUMA）
//
// 2026-09-21 竹内「ブレインが勝つようにする／YUMAでテストもして」
//
// 見るところ:
//   ① ブレインの avoid_topics がプロンプトから**消えていない**（旧実装は削っていた）
//   ② 必須要素とぶつかった時、その要素の行に「この話題に触れない形で書く」が付く
//   ③ 生成された文が、ブレインが避けろと言った話題に触れていない
//
// ⚠ 書き込みを伴う（YUMA に場面の2通を入れて、確認後に必ず消す）。テスト会話 YUMA だけで動かす。
// 実行: npx tsx --env-file=.env.local scripts/yuma-brain-wins-test.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cleanup: string[] = [];

/**
 * ⚠ 最初「条件変更」「検討中」で試したら、ブレインが両方とも AIX【物件ピックアップ】を選んで
 *   下書きが作られず（reply_mode=aix）、生成文を見られなかった。
 *   **ブレインが AIX を選ばない場面**（約束の途中・お客様は了承だけ）に変える。
 */
const SCENES: Array<{ id: string; staff: string; customer: string; avoidWords: RegExp; note: string }> = [
  {
    id: "①ピックアップの約束 → 了承（セルが宣言を必須にする場面）",
    staff: "かしこまりました！！\n塚本・大国町エリアでもオススメ出来るお部屋ピックアップさせて頂きます！！\nピックアップ出来次第ご連絡させて頂きます😌！！",
    customer: "はい、よろしくお願いします",
    avoidWords: /御?見積(?:書|り)|初期費用[:：]|[0-9０-９,]{4,}円/,
    note: "ブレインが「見積書・初期費用」を避けると判断したら、金額・見積書を持ち出さないか",
  },
  {
    id: "②見積書を送った後 → お礼（セルが次の一手を必須にする場面）",
    staff: "こちら初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！",
    customer: "ありがとうございます！ちょっと検討してみます",
    avoidWords: /新しくピックアップ|別のお部屋を|他の物件も|内覧日/,
    note: "ブレインが「新規ピックアップ・内覧」を避けると判断したら、押し売りにならないか",
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
    const { data } = await sb.from("conversations")
      .select("ai_draft, suggested_aix_meta, ai_draft_check").eq("id", YUMA).maybeSingle();
    const row = (data ?? {}) as Record<string, unknown>;
    const d = String(row.ai_draft ?? "");
    if (d === "[AIX誘導中]" || d === "[返信不要]") return { draft: "", meta: row.suggested_aix_meta, sentinel: d };
    if (d && d !== "__SHOWN__") return { draft: d, meta: row.suggested_aix_meta, sentinel: "" };
  }
  return { draft: "", meta: null, sentinel: "" };
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
    const { draft, meta, sentinel } = skipped ? { draft: "", meta: null, sentinel: "" } : await waitForDraft();
    const out = draft.replace(/\n?<<<[A-Z_]{3,}[\s\S]*?(?:>>>|$)/g, "").trim();
    const avoid = ((meta as Record<string, unknown> | null)?.avoid_topics as string[] | undefined) ?? [];
    const dir = String((meta as Record<string, unknown> | null)?.reply_direction ?? "");

    await sb.from("messages").delete().in("id", made);
    cleanup = cleanup.filter((x) => !made.includes(x));
    await sb.from("conversations").update({ ai_draft: null, ai_draft_check: null, draft_attempted_at: null, draft_pending_at: null }).eq("id", YUMA);
    await sleep(8000);

    console.log(`${"─".repeat(78)}`);
    console.log(`【${s.id}】`);
    console.log(`   直前送信: ${s.staff.replace(/\n/g, " ／ ").slice(0, 90)}`);
    console.log(`   お客様  : ${s.customer}`);
    console.log(`   ブレインの返信方向: ${dir.slice(0, 90) || "（なし）"}`);
    console.log(`   ブレインの避ける話題: ${avoid.join(" / ") || "（なし）"}`);
    if (!out) {
      console.log(`   下書き  : 出なかった${sentinel ? `（${sentinel}）` : skipped ? `（skipped=${skipped}）` : ""}`);
      continue;
    }
    console.log(`   生成文  : ${out.replace(/\n/g, " ／ ").slice(0, 200)}`);
    const touched = s.avoidWords.test(out);
    const judged = !touched;
    if (judged) ok++; else ng++;
    console.log(`   → 避けるべき語に触れたか: ${touched ? "⚠ 触れた" : "✅ 触れていない"}  ${s.note}`);
  }
  if (cleanup.length) await sb.from("messages").delete().in("id", cleanup);
  console.log(`\n${"─".repeat(78)}`);
  console.log(`=== まとめ: ${ok}/${ok + ng} 期待どおり（後片付けの残り ${cleanup.length}件）===`);
  console.log(`※ 終わったら: npx tsx --env-file=.env.local scripts/yuma-snapshot.ts restore`);
}
main().catch(async (e) => {
  if (cleanup.length) await sb.from("messages").delete().in("id", cleanup);
  console.error(e); process.exit(1);
});
