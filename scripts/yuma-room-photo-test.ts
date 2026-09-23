// 「室内の写真が欲しい」→ ブレインが AIX【物件確認した→室内写真を確認した】をセットし、下書きに根拠の無い文が出ないかを YUMA で確かめる
//
// 2026-09-23 竹内「室内の写真が欲しいといわれたら AIX の物件確認したの室内写真確認したのピッカーから送る形。
//   ちゃんとここはブレインで判断できるように。根拠のないことなど AIX 回答できるから、そこの仕組に着眼して」
//
// 【見る物】
//   A. 本番と同じ経路（generate-draft-bg-async → ブレイン）: suggested_aix_meta の action / check_pattern / decision_source / two_choice_mode /
//      reply_mode。期待: property_check_result + interior_photo + signal:scene_S11_room_photo + two_choice_mode=true + reply_mode=aix（下書きは [AIX誘導中]）
//   B. 手動経路（generate-reply 直接・DeepSeek）: ブレインの判断を読んだ下書きが、写真の有無の断定・撮影の約束・URL を書かないか
//
// ⚠ 書き込みを伴う。始める前に yuma-snapshot.ts save、終わったら restore。
//   副作用の片付け: 入れたメッセージ・aix_action_items（AIX要対応）・brain_decision_logs を消す（売上番長グループへの通知だけは戻せない）。
// 実行: npx tsx --env-file=.env.local scripts/yuma-room-photo-test.ts [REPS=2]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CUSTOMER = "これ室内写真欲しいです";
// 根拠の無い文（今日の実物: 「室内写真は現在ご用意出来ていない為、私の方で撮影しお送りさせて頂きます」）
const FORBID = /(?:ご用意(?:出来|でき)て(?:い|お)(?:ない|りません|いません|らず)|写真(?:は|が)(?:ございません|ありません|無い)|撮影(?:は|を)?(?:行|して)(?:え|い)?て(?:おりません|いません|おらず)|私の方で撮影|撮影し(?:て)?お送り|確認出来次第ご連絡|https?:\/\/)/;
const WANT = /(?:お写真|写真|画像)[^\n]{0,12}(?:お送り|送らせて)/;
let cleanupMsgIds: string[] = [];
const startedAt = new Date().toISOString();

async function armConversation() {
  await sb.from("conversations").update({
    last_sender: "customer", ai_draft: null, ai_draft_check: null,
    draft_attempted_at: null, draft_pending_at: null, draft_fail_count: 0, draft_last_error: null,
  }).eq("id", YUMA);
}
async function waitForBrain(timeoutMs = 240_000): Promise<{ draft: string; meta: Record<string, unknown> | null }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(3000);
    const { data } = await sb.from("conversations").select("ai_draft, suggested_aix_meta").eq("id", YUMA).maybeSingle();
    const row = (data ?? {}) as Record<string, unknown>;
    const d = String(row.ai_draft ?? "");
    const meta = (row.suggested_aix_meta as Record<string, unknown> | null) ?? null;
    if (d === "[AIX誘導中]" || (d && d !== "__SHOWN__")) return { draft: d === "[AIX誘導中]" ? "" : d, meta };
  }
  const { data } = await sb.from("conversations").select("suggested_aix_meta").eq("id", YUMA).maybeSingle();
  return { draft: "", meta: ((data ?? {}) as Record<string, unknown>).suggested_aix_meta as Record<string, unknown> | null };
}
async function cleanup() {
  if (cleanupMsgIds.length) { await sb.from("messages").delete().in("id", cleanupMsgIds); console.log(`片付け: messages ${cleanupMsgIds.length}件`); cleanupMsgIds = []; }
  const { data: items } = await sb.from("aix_action_items").select("id").eq("conversation_id", YUMA).gte("created_at", startedAt);
  const ids = ((items ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length) { await sb.from("aix_action_items").delete().in("id", ids); console.log(`片付け: aix_action_items ${ids.length}件（AIX要対応）`); }
  const { data: decs } = await sb.from("brain_decision_logs").select("id").eq("conversation_id", YUMA).gte("created_at", startedAt);
  const dids = ((decs ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (dids.length) { await sb.from("brain_decision_logs").delete().in("id", dids); console.log(`片付け: brain_decision_logs ${dids.length}件`); }
  const { data: tasks } = await sb.from("line_tasks").select("id").eq("conversation_id", YUMA).eq("status", "pending").gte("created_at", startedAt);
  const tids = ((tasks ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (tids.length) { await sb.from("line_tasks").update({ status: "done" }).in("id", tids); console.log(`片付け: line_tasks ${tids.length}件を done`); }
}

async function main() {
  const reps = Number(process.env.REPS ?? 2);
  const { data: conv } = await sb.from("conversations").select("status, customer_name, has_viewed").eq("id", YUMA).maybeSingle();
  const c = (conv ?? {}) as Record<string, unknown>;
  console.log(`=== YUMA [${String(c.status)}]「${CUSTOMER}」× ${reps}回 ===\n`);

  let brainOk = 0, twoOk = 0, draftOk = 0, draftBad = 0, draftEmpty = 0;
  for (let k = 0; k < reps; k++) {
    const ins = await sb.from("messages").insert([
      { conversation_id: YUMA, sender: "customer", text: CUSTOMER, created_at: new Date(Date.now() - 60_000).toISOString() },
    ]).select("id");
    if (ins.error) { console.log(`場面を作れず: ${ins.error.message}`); continue; }
    cleanupMsgIds.push(...((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id));

    // A. 本番と同じ経路（bg-async → ブレイン）
    let skipped = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      await armConversation();
      try {
        const res = await fetch(`${BASE}/api/generate-draft-bg-async`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: YUMA, source: "direct" }) });
        skipped = String(((await res.json()) as Record<string, unknown>).skipped ?? "");
      } catch (e) { skipped = `fetch失敗:${e instanceof Error ? e.message : String(e)}`; }
      if (skipped !== "in_progress") break;
      await sleep(20_000);
    }
    const { draft: autoDraft, meta } = await waitForBrain();
    const action = String(meta?.action ?? "");
    const cp = String(meta?.check_pattern ?? "");
    const src = String(meta?.decision_source ?? "");
    const two = meta?.two_choice_mode === true;
    const mode = String(meta?.reply_mode ?? "");
    const label = String(meta?.reply_direction_label ?? "");
    const good = action === "property_check_result" && cp === "interior_photo";
    if (good) brainOk++;
    if (two) twoOk++;
    console.log(`[${k + 1}] A ブレイン: ${good ? "✓" : "✗"} action=${action || "(なし)"} check_pattern=${cp || "-"} source=${src || "-"} two_choice=${two} reply_mode=${mode} label=${label || "-"} skipped=${skipped || "-"}`);
    console.log(`      自動の下書き: ${autoDraft ? `⚠ 出た「${autoDraft.replace(/\n/g, " / ").slice(0, 120)}」` : "なし（[AIX誘導中]＝自動の下書きは作らない）"}`);
    console.log(`      note: ${String(meta?.note ?? "").slice(0, 120)}`);

    // B. 手動経路（generate-reply 直接・DeepSeek）— ブレインの判断（suggested_aix_meta）を読んだ下書き
    const { data: msgs } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(20);
    const recentMessages = ((msgs ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({
      sender: String(m.sender), text: String(m.text ?? ""), imageUrl: (m.image_url as string | null) ?? undefined, createdAt: String(m.created_at), isAix: !!m.is_aix_generated,
    }));
    let text = "";
    try {
      const res = await fetch(`${BASE}/api/generate-reply`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: CUSTOMER, customerMessages: [CUSTOMER], state: String(c.status ?? "proposing"), conversationId: YUMA, customerName: String(c.customer_name ?? "YUMA"), hasViewed: !!c.has_viewed, activeTaskTypes: [], recentMessages }),
      });
      const raw = await res.text();
      const nl = raw.indexOf("\n");
      text = nl >= 0 ? raw.slice(nl + 1) : raw;
    } catch (e) { text = `【エラー】${e instanceof Error ? e.message : String(e)}`; }
    const draft = text.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
    if (!draft || /^【エラー】/.test(draft) || /^\[/.test(draft)) { draftEmpty++; console.log(`      B 手動の下書き: 出なかった（${draft.slice(0, 60)}）`); }
    else {
      const bad = FORBID.test(draft);
      const want = WANT.test(draft);
      if (bad) draftBad++; else draftOk++;
      console.log(`      B 手動の下書き: ${bad ? "⚠ 根拠の無い文／禁止の形がある" : "✓ 断定・撮影の約束・URL なし"}${want ? "（受付の一文あり）" : "（受付の一文は無い）"}`);
      console.log(`         「${draft.replace(/\n/g, " / ").slice(0, 200)}」`);
    }
    await cleanup();
  }
  console.log(`\n=== 結果（${reps}回） ===`);
  console.log(`   A ブレインが property_check_result + interior_photo をセット ${brainOk}/${reps}（2択 ${twoOk}/${reps}）`);
  console.log(`   B 手動の下書き: 問題なし ${draftOk} ／ ⚠ 根拠の無い文 ${draftBad} ／ 出なかった ${draftEmpty}`);
  console.log(`   ※ 売上番長グループへの「AIX要対応」通知は戻せない（aix_action_items の行は消した）`);
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await cleanup(); });
