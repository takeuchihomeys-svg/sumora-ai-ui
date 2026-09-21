// 表記の混ぜ方と「お待たせ致しました」が直ったか（YUMA・本番と同じ経路）
//
// 2026-09-21 竹内「実際のスタッフが送るような文が生成されていない可能性があるってこと？」→ 直した2点:
//   ① 漢字/ひらがなの混ぜ方（させて頂く 実送信32.5% 対 AI 7.4% など）を材料として渡す
//   ② 「お待たせ致しました」は許す場面で**書けていなかった**（property_check_result_unavailable 46.7% 対 0%）
//
// ⚠ 書き込みを伴う（YUMA に場面を入れて、確認後に必ず消す）。テスト会話 YUMA だけで動かす。
// 実行: REPS=2 npx tsx --env-file=.env.local scripts/yuma-notation-waited-test.ts
import { createClient } from "@supabase/supabase-js";
import { checkNotationMix } from "../app/lib/notation-mix";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WAITED = /お待たせ(?:致|いた)?しました/;
let cleanup: string[] = [];

/** AIX 本体（物件ピックアップ）— 「お待たせ」を許す場面 */
async function runAix(base: string) {
  const { data: conv } = await sb.from("conversations").select("customer_name, status, property_customer_id").eq("id", YUMA).maybeSingle();
  const c = (conv ?? {}) as Record<string, unknown>;
  // ⚠ 昇順 + limit は**古い方**から取る。YUMA は発言が多いので、昇順200件だと最新が1通も入らない
  //   （それで「前回お待たせだった」前提を作っても prevUsed=false のままだった）。降順で取って戻す。
  const { data: ms } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated")
    .eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(20);
  const recent_messages = ((ms ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({
    sender: String(m.sender), text: String(m.text ?? ""),
    imageUrl: (m.image_url as string | null) ?? undefined,
    rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated,
  }));
  const res = await fetch(`${BASE}/api/aix/action`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "property_send", base_message: base,
      customer_name: String(c.customer_name ?? "YUMA"), conversation_id: YUMA, recent_messages,
    }),
  });
  const j = await res.json() as Record<string, unknown>;
  return String(j.message_text ?? j.error ?? "");
}

const BASE_MSG = `YUMAさんお待たせ致しました！！

🌟スプランディッド難波 502号室

難波周辺からYUMAさんにオススメできるお部屋ピックアップさせて頂きました😊！！

お手隙の際にご査収ください😌！！`;

/** 直前のこちらの送信を差し替えて、その後で AIX を叩く（片付けまで） */
async function runAixWithPrev(prevStaffText: string, reps: number, label: string) {
  console.log(`\n${"═".repeat(76)}`);
  console.log(`【前提】この会話の直前のこちらの送信 = ${label}`);
  console.log(`   「${prevStaffText.split("\n")[0]}」`);
  let hit = 0;
  const kana: number[] = [];
  for (let i = 0; i < reps; i++) {
    // ⚠ 30分前で挿しても、YUMA の会話にそれより新しい発言があると「前回のこちらの送信」にならない。
    //   実際それで prevUsed=false のまま両ケース 0/5 になった（サーバーログ aix:waited-choice で発覚）。
    //   必ず**今**の時刻で挿して、こちらの最後の送信にする。
    const ins = await sb.from("messages").insert([
      { conversation_id: YUMA, sender: "staff", text: prevStaffText, created_at: new Date().toISOString() },
    ]).select("id");
    if (ins.error) { console.log(`   場面を作れず: ${ins.error.message}`); continue; }
    const made = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
    cleanup.push(...made);
    // 前提が本当に作れたか毎回確かめる（サーバーログ aix:waited-choice の prevUsed と突き合わせる）
    const { data: chk } = await sb.from("messages").select("sender, text")
      .eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(1);
    const lastNow = ((chk ?? []) as Array<{ sender: string; text: string }>)[0];
    if (!lastNow || lastNow.sender !== "staff" || lastNow.text !== prevStaffText) {
      console.log(`   ⚠ 前提が作れていない（こちらの最後の送信が入れた物ではない）: ${lastNow?.sender} / ${String(lastNow?.text ?? "").slice(0, 30)}`);
    }
    let out = "";
    try { out = await runAix(BASE_MSG); } catch (e) { out = `【エラー】${e instanceof Error ? e.message : String(e)}`; }
    await sb.from("messages").delete().in("id", made);
    cleanup = cleanup.filter((x) => !made.includes(x));
    const has = WAITED.test(out);
    if (has) hit++;
    const nm = checkNotationMix(out);
    const p = nm.find((x) => x.name.startsWith("させて頂く"));
    if (p) kana.push(p.kanaPct);
    console.log(`${"─".repeat(76)}`);
    console.log(`【${i + 1}回目】「お待たせ」${has ? "あり" : "なし"}`);
    console.log(`   ${out.replace(/\n/g, " ／ ").slice(0, 200)}`);
    await sleep(4000);
  }
  console.log(`   → 「お待たせ」が入った: ${hit}/${reps}`);
  return { hit, reps, kana };
}

const PREV_WAITED = "YUMAさんお待たせ致しました！！\n\n西区・港区周辺からYUMAさんにオススメできるお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！";
const PREV_NORMAL = "YUMAさんお世話になっております！！\n\n西区・港区周辺からYUMAさんにオススメできるお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！";

async function main() {
  const reps = Number(process.env.REPS ?? 2);
  console.log(`=== ① AIX【物件ピックアップ】— 「お待たせ」を許す場面（実送信 45.7%）===`);
  console.log(`実測で分かれた唯一の軸: 前回も使っていた → 55.8% ／ 使っていなかった → 22.6%`);
  const a = await runAixWithPrev(PREV_WAITED, reps, "「お待たせ致しました」だった");
  const b = await runAixWithPrev(PREV_NORMAL, reps, "「お世話になっております」だった");
  console.log(`\n${"─".repeat(76)}`);
  console.log(`   前回も「お待たせ」だった後  : ${a.hit}/${a.reps}（実送信 55.8%）`);
  console.log(`   前回そうでなかった後        : ${b.hit}/${b.reps}（実送信 22.6%）`);
  const waitedHit = a.hit + b.hit;
  const kanaRates = [...a.kana, ...b.kana];
  if (kanaRates.length) {
    const avg = kanaRates.reduce((x, y) => x + y, 0) / kanaRates.length;
    console.log(`   「させて頂く」のひらがな率: 平均 ${avg.toFixed(1)}%（実送信 32.5%・⚠ 材料は監査で止めたので動かなくて正しい）`);
  }

  // ② 通常返信（許さない場面）— お待たせが入らないこと
  console.log(`\n\n=== ② 通常返信 — 「お待たせ」は入らないはず（実送信 0.0%）===\n`);
  const staff = "かしこまりました！！\n塚本・大国町エリアでもオススメ出来るお部屋ピックアップさせて頂きます！！\nピックアップ出来次第ご連絡させて頂きます😌！！";
  const cust = "はい、よろしくお願いします";
  let replyWaited = 0, replyRuns = 0;
  const replyKana: number[] = [];
  for (let i = 0; i < reps; i++) {
    const now = Date.now();
    const ins = await sb.from("messages").insert([
      { conversation_id: YUMA, sender: "staff", text: staff, created_at: new Date(now - 10 * 60_000).toISOString() },
      { conversation_id: YUMA, sender: "customer", text: cust, created_at: new Date(now - 60_000).toISOString() },
    ]).select("id");
    if (ins.error) { console.log(`   場面を作れず: ${ins.error.message}`); continue; }
    const made = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
    cleanup.push(...made);
    await sb.from("conversations").update({
      last_sender: "customer", ai_draft: null, ai_draft_check: null,
      draft_attempted_at: null, draft_pending_at: null, draft_fail_count: 0, draft_last_error: null,
    }).eq("id", YUMA);
    let skipped = "";
    try {
      const res = await fetch(`${BASE}/api/generate-draft-bg-async`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: YUMA, source: "direct" }),
      });
      skipped = String(((await res.json()) as Record<string, unknown>).skipped ?? "");
    } catch (e) { skipped = String(e); }
    let draft = "";
    if (!skipped) {
      const t0 = Date.now();
      while (Date.now() - t0 < 240_000) {
        await sleep(3000);
        const { data } = await sb.from("conversations").select("ai_draft").eq("id", YUMA).maybeSingle();
        const d = String((data as Record<string, unknown> | null)?.ai_draft ?? "");
        if (d === "[AIX誘導中]" || d === "[返信不要]") { draft = ""; break; }
        if (d && d !== "__SHOWN__") { draft = d; break; }
      }
    }
    await sb.from("messages").delete().in("id", made);
    cleanup = cleanup.filter((x) => !made.includes(x));
    await sb.from("conversations").update({ ai_draft: null, ai_draft_check: null, draft_attempted_at: null, draft_pending_at: null }).eq("id", YUMA);
    await sleep(8000);
    const out = draft.replace(/\n?<<<[A-Z_]{3,}[\s\S]*?(?:>>>|$)/g, "").trim();
    console.log(`${"─".repeat(76)}`);
    if (!out) { console.log(`【${i + 1}回目】下書きなし（AIX誘導 or 返信不要）`); continue; }
    replyRuns++;
    if (WAITED.test(out)) replyWaited++;
    const nm = checkNotationMix(out);
    const p = nm.find((x) => x.name.startsWith("させて頂く"));
    if (p) replyKana.push(p.kanaPct);
    console.log(`【${i + 1}回目】「お待たせ」${WAITED.test(out) ? "あり ⚠" : "なし ✅"}`);
    console.log(`   ${out.replace(/\n/g, " ／ ").slice(0, 200)}`);
    if (nm.length) console.log(`   表記: ${nm.map((x) => `${x.name} かな${x.kanaPct.toFixed(0)}%(実送信${x.sentKanaPct}%)`).join(" ／ ")}`);
  }
  if (cleanup.length) await sb.from("messages").delete().in("id", cleanup);
  console.log(`\n${"─".repeat(76)}`);
  console.log(`=== まとめ ===`);
  console.log(`   AIX（許す場面）で「お待たせ」が入った: ${waitedHit}/${reps * 2}`);
  console.log(`   通常返信で「お待たせ」が入った      : ${replyWaited}/${replyRuns}（0が正しい）`);
  if (replyKana.length) console.log(`   通常返信の「させて頂く」ひらがな率: 平均 ${(replyKana.reduce((a, b) => a + b, 0) / replyKana.length).toFixed(1)}%`);
  console.log(`   後片付けの残り ${cleanup.length}件`);
  console.log(`※ 終わったら: npx tsx --env-file=.env.local scripts/yuma-snapshot.ts restore`);
}
main().catch(async (e) => {
  if (cleanup.length) await sb.from("messages").delete().in("id", cleanup);
  console.error(e); process.exit(1);
});
