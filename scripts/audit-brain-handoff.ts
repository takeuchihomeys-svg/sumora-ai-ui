// ブレインの判断が「判断どおりに」返信生成へ渡っているか（読み取りのみ・LLM を呼ばない）
//
// 2026-09-20 竹内「ブレインの動きもちゃんとみて／ブレインの判断通りにうごくか、
//   ちゃんと AIX-META わたされているか／エラー起きないか／徹底的に調査」
//
// 設計知見:
//   「同じ材料でも渡し方で正誤が変わる — 返信生成で積み上げた安全装置は、同じ材料を使う全経路に同じ関数で配る」
//   「分析の言葉と送る言葉は別物 — ブレインの項目は判断材料であって本文の素材ではない」
//   → 整形は brain-strategy-note.ts の1関数に集約済み。**それが実データで正しく効くか**を全件で当てる。
//
// 見るもの:
//   ① 例外が出ないか（全会話で buildBrainStrategyNote / resolveReplyAixDecision を実行）
//   ② AIX-META の充足（action / reply_direction / analyzed_msg_ts があるか）
//   ③ 鮮度（T1/T2/T3）の分布と、fresh=false で鮮度従属フィールドが**落ちている**か
//   ④ ブレインが action を出した時に AIX が提案されるか（判断どおりに動くか）
//   ⑤ 分析の言葉（latent_intent / winning_pattern）が生のまま本文の素材として渡っていないか
import { createClient } from "@supabase/supabase-js";
import { buildBrainStrategyNote, describeBrainStrategyNote, FRESH_DEPENDENT_FIELDS, type BrainStrategyMeta } from "../app/lib/brain-strategy-note";
import { resolveReplyAixDecision } from "../app/lib/aix-reply-set";
import { detectBrainTier } from "../app/lib/brain-fetch-spec";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const { data } = await sb.from("conversations")
    .select("id, customer_name, status, suggested_aix_meta, last_brain_meta, brain_analyzed_at, ai_draft, updated_at")
    .order("updated_at", { ascending: false }).limit(400);
  const convs = (data ?? []) as unknown as Array<Record<string, unknown>>;
  console.log(`=== 会話 ${convs.length}件（更新の新しい順）===\n`);

  // 各会話の最後のお客様発言の時刻（鮮度の判定に使う）
  const ids = convs.map((c) => String(c.id));
  const lastCust = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 40) {
    const { data: ms } = await sb.from("messages").select("conversation_id, created_at")
      .in("conversation_id", ids.slice(i, i + 40)).eq("sender", "customer")
      .order("created_at", { ascending: false });
    for (const m of ((ms ?? []) as Array<{ conversation_id: string; created_at: string }>)) {
      if (!lastCust.has(m.conversation_id)) lastCust.set(m.conversation_id, m.created_at);
    }
  }

  let errors = 0;
  const errSamples: string[] = [];
  let hasMeta = 0, hasAction = 0, hasDirection = 0, hasTs = 0;
  const tierCount = new Map<string, number>();
  const reasonCount = new Map<string, number>();
  let noTsWithAction = 0;
  const noTsSamples: string[] = [];
  const actionCount = new Map<string, number>();
  let aixProposed = 0, aixNone = 0, aixStale = 0;
  let rawAnalysisLeak = 0;
  const leakSamples: string[] = [];
  let freshDropOk = 0, freshDropNg = 0;

  for (const c of convs) {
    const meta = (c.suggested_aix_meta ?? c.last_brain_meta ?? null) as Record<string, unknown> | null;
    const cid = String(c.id);
    if (meta) hasMeta++;
    if (meta?.action) { hasAction++; actionCount.set(String(meta.action), (actionCount.get(String(meta.action)) ?? 0) + 1); }
    if (meta?.reply_direction) hasDirection++;
    if (meta?.analyzed_msg_ts) hasTs++;

    // ③ 鮮度（本番と同じ呼び方: 引数2つ。最初オブジェクト1つで呼んで全件 T2 になった＝測定のバグ）
    const tier = detectBrainTier(meta as never, lastCust.get(cid) ?? null);
    const t = tier.tier;
    tierCount.set(t, (tierCount.get(t) ?? 0) + 1);
    reasonCount.set(tier.reason, (reasonCount.get(tier.reason) ?? 0) + 1);
    // ★ 判断も action もあるのに analyzed_msg_ts が無いだけで古い扱いになっている＝材料の取りこぼし
    if (tier.reason === "no_ts" && meta?.action) {
      noTsWithAction++;
      if (noTsSamples.length < 6) noTsSamples.push(`  ${c.customer_name} [${c.status}] action=${meta.action} 方向=${String(meta.reply_direction ?? "-").slice(0, 40)}`);
    }
    const fresh = tier.brainFreshForMessage;

    // ① 例外が出ないか（本番と同じ呼び方）
    try {
      const note = buildBrainStrategyNote(meta as BrainStrategyMeta | null, { fresh, customerName: String(c.customer_name ?? "") } as never);
      void describeBrainStrategyNote(meta as BrainStrategyMeta | null, { fresh });

      // ③ fresh=false の時、鮮度従属フィールドが本当に落ちているか
      if (meta && !fresh) {
        let leaked = false;
        for (const f of FRESH_DEPENDENT_FIELDS) {
          const v = meta[f];
          if (typeof v === "string" && v.length >= 6 && note.includes(v.slice(0, 12))) { leaked = true; break; }
        }
        if (leaked) freshDropNg++; else freshDropOk++;
      }

      // ⑤ 分析の言葉が生で渡っていないか（latent_intent / winning_pattern をそのまま本文の素材にしない）
      if (meta && fresh) {
        for (const f of ["latent_intent", "winning_pattern"] as const) {
          const v = meta[f];
          if (typeof v === "string" && v.length >= 20 && note.includes(v)) {
            // 生のまま入っている＝「必ず本文に含めろ」型の強制が復活していないか見る
            if (/必ず|最低1つ|含めること|応用すること/.test(note)) {
              rawAnalysisLeak++;
              if (leakSamples.length < 4) leakSamples.push(`  ${c.customer_name}: ${f}「${v.slice(0, 50)}」が強制で入っている`);
            }
          }
        }
      }
    } catch (e) {
      errors++;
      if (errSamples.length < 6) errSamples.push(`  ${c.customer_name} (${cid.slice(0, 8)}): ${e instanceof Error ? e.message : String(e)}`);
    }

    // ④ ブレインの判断どおりに AIX が提案されるか
    try {
      const d = resolveReplyAixDecision({
        conversationStatus: String(c.status ?? ""),
        isFirstReply: false,
        brainDecision: meta ? { fresh, action: String(meta.action ?? ""), note: String(meta.note ?? ""), checkPattern: null } : null,
        unresolvedBlock: null,
      } as never);
      if (d?.aix) aixProposed++; else aixNone++;
      if (d?.brainStale) aixStale++;
    } catch (e) {
      errors++;
      if (errSamples.length < 6) errSamples.push(`  [AIX] ${c.customer_name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const p = (n: number) => `${((n / convs.length) * 100).toFixed(1)}%`;
  console.log(`① 例外: **${errors}件**`);
  for (const s of errSamples) console.log(s);

  console.log(`\n② AIX-META の充足`);
  console.log(`   判断がある（suggested または last）: ${hasMeta}件 (${p(hasMeta)})`);
  console.log(`   action がある                     : ${hasAction}件 (${p(hasAction)})`);
  console.log(`   reply_direction がある            : ${hasDirection}件 (${p(hasDirection)})`);
  console.log(`   analyzed_msg_ts がある（鮮度の判定に必須）: ${hasTs}件 (${p(hasTs)})`);

  console.log(`\n③ 鮮度（tier）`);
  for (const [k, n] of [...tierCount.entries()].sort()) console.log(`   ${k}: ${n}件 (${p(n)})`);
  console.log(`   fresh=false で鮮度従属フィールドが落ちている: ${freshDropOk}件 / 漏れている: **${freshDropNg}件**`);
  console.log(`\n   --- 古い扱いになった理由 ---`);
  for (const [k, n] of [...reasonCount.entries()].sort((a, b) => b[1] - a[1])) {
    const ja = { fresh: "新しい（T1）", stale_ts: "お客様の発言の方が新しい（正しく古い）", no_ts: "**analyzed_msg_ts が無い**", meta_null: "判断そのものが無い" }[k] ?? k;
    console.log(`     ${String(n).padStart(3)}件  ${ja}`);
  }
  console.log(`\n   ★ 判断も action もあるのに analyzed_msg_ts が無いだけで古い扱い: **${noTsWithAction}件**`);
  console.log(`     （鮮度が分からない＝ AIX も鮮度従属フィールドも捨てられる＝ブレインの判断が届かない）`);
  for (const s of noTsSamples) console.log(s);

  console.log(`\n④ ブレインの判断どおりに AIX が提案されるか`);
  console.log(`   AIX を提案: ${aixProposed}件 / 提案しない: ${aixNone}件 / 判断が古い: ${aixStale}件`);
  console.log(`   ブレインが出した action の分布:`);
  for (const [k, n] of [...actionCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`     ${String(n).padStart(3)}件  ${k || "(空)"}`);

  console.log(`\n⑤ 分析の言葉が「必ず本文に含めろ」で渡っていないか: **${rawAnalysisLeak}件**`);
  for (const s of leakSamples) console.log(s);
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
