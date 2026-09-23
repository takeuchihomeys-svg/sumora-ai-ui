// Jev（TypeSafe AI）に「どの AIX か」「物件確認したなら何を確認するピッカーか」を選ばせ、
// スタッフが実際に押した AIX（aix_usage_logs）を正解に正答率を測る（読み取りのみ・DB は書かない）。
//
// 2026-09-23 竹内「AIX でどのピッカーを選択するかの部分は Jev で強化」「Jev がブレインの一部にいてそこから選択」
//   → 繋ぐ前に答え合わせ（設計知見「出口・判定は実データで線を引いてから入れる」）。
//
// 正解の作り方: aix_usage_logs の各行（押した AIX・check_pattern）について、押した時刻より前の会話（直近8通）を state にする。
//   ・お客様の発言は pii-pseudonym で仮名化してから渡す（別クラウド）。申込以降（applying/screening 等）の会話は除く。
//   ・ピッカーの答え合わせは「何を確認したか」の check_pattern（interior_photo・mgmt_* 等）だけ。結果のピッカー（available 等）は会話から分からない。
// 実行: npx tsx --env-file=.env.local scripts/eval-jev-aix.ts [--days=365] [--per-type=40] [--show=20]
//   TYPESAFE_API_KEY が無ければ何もしない。
import { createClient } from "@supabase/supabase-js";
import { createMasker } from "../app/lib/pii-pseudonym";
import { evaluateAixWithJev, CHECK_PATTERN_TO_TOPIC, TOPIC_CHECK_PATTERNS, JEV_AIX_OPTIONS } from "../app/lib/aix-jev";
import { isJevEnabled } from "../app/lib/jev-client";
import { isPostApplyStatus } from "../app/lib/llm-alt-provider";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "365"));
const PER_TYPE = Number(arg("per-type", "40"));
const SHOW = Number(arg("show", "20"));

type Log = { id: string; conversation_id: string; aix_type: string; check_pattern: string | null; created_at: string; conversation_status: string | null };

async function main() {
  if (!isJevEnabled()) {
    console.log("TYPESAFE_API_KEY が .env.local に無いので何もしない（鍵を入れてから実行）");
    return;
  }
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const { data: logsRaw, error } = await sb.from("aix_usage_logs")
    .select("id, conversation_id, aix_type, check_pattern, created_at, conversation_status")
    .gte("created_at", since).neq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(5000);
  if (error) throw error;
  const logs = (logsRaw ?? []) as Log[];
  // 種類ごとに新しい順で PER_TYPE 件（偏りを減らす）。申込以降は除く
  const byType = new Map<string, Log[]>();
  for (const l of logs) {
    if (!(l.aix_type in JEV_AIX_OPTIONS)) continue;
    if (isPostApplyStatus(l.conversation_status)) continue;
    const arr = byType.get(l.aix_type) ?? [];
    if (arr.length < PER_TYPE) { arr.push(l); byType.set(l.aix_type, arr); }
  }
  const sample = [...byType.values()].flat();
  console.log(`=== Jev の答え合わせ（aix_usage_logs ${DAYS}日・種類ごと最大${PER_TYPE}件・計${sample.length}件）===`);

  const { data: nameRows } = await sb.from("conversations").select("id, customer_name").limit(3000);
  const nameOf = new Map<string, string>();
  const knownNames: string[] = [];
  for (const r of ((nameRows ?? []) as Array<{ id: string; customer_name: string | null }>)) {
    const n = (r.customer_name ?? "").trim();
    nameOf.set(r.id, n);
    if (n) knownNames.push(n);
  }

  // 多数派の基準（何も見ずに一番多い AIX を答えた時の正答率）
  const total = sample.length;
  const majority = [...byType.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  console.log(`基準（常に「${majority?.[0]}」と答える）: ${majority ? ((majority[1].length / total) * 100).toFixed(1) : "-"}%\n`);

  let aixOk = 0, aixN = 0, topicOk = 0, topicN = 0, failed = 0;
  const confusion = new Map<string, number>();     // 正解→Jev
  const perType = new Map<string, { n: number; ok: number; probSum: number }>();
  const highConf: { n: number; ok: number } = { n: 0, ok: 0 }; // aixProb >= 0.8 の時
  const examplesWrong: string[] = [];

  for (const l of sample) {
    const { data: msgs } = await sb.from("messages").select("sender, text, created_at, is_aix_generated")
      .eq("conversation_id", l.conversation_id).lt("created_at", l.created_at).order("created_at", { ascending: false }).limit(8);
    const rows = ((msgs ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }>).reverse();
    if (rows.length === 0) continue;
    const partyName = nameOf.get(l.conversation_id) ?? "";
    const masker = createMasker({ conversationId: l.conversation_id, customerName: partyName || null, knownNames });
    const masked = rows.map((m) => ({ sender: m.sender, text: masker.maskBlock(m.text ?? ""), createdAt: m.created_at, isAix: !!m.is_aix_generated }));
    const { count: sentCount } = await sb.from("sent_properties").select("id", { count: "exact", head: true })
      .eq("conversation_id", l.conversation_id).lt("sent_at", l.created_at);
    const ev = await evaluateAixWithJev({ messages: masked, status: l.conversation_status, sentPropertyCount: sentCount ?? null, conversationId: l.conversation_id, timeoutMs: 15_000 });
    if (!ev) { failed++; continue; }
    const d = ev.decision;
    aixN++;
    const ok = d.aix === l.aix_type;
    if (ok) aixOk++;
    const pt = perType.get(l.aix_type) ?? { n: 0, ok: 0, probSum: 0 };
    pt.n++; if (ok) pt.ok++; pt.probSum += d.aixProb; perType.set(l.aix_type, pt);
    if (d.aixProb >= 0.8) { highConf.n++; if (ok) highConf.ok++; }
    if (!ok) {
      const k = `${l.aix_type} → ${d.aix}`;
      confusion.set(k, (confusion.get(k) ?? 0) + 1);
      if (examplesWrong.length < SHOW) {
        const last = masked.filter((m) => m.sender === "customer").slice(-1)[0]?.text ?? "";
        examplesWrong.push(`  ${l.conversation_id.slice(0, 8)} 正解=${l.aix_type}${l.check_pattern ? `(${l.check_pattern})` : ""} Jev=${d.aix}(${d.aixProb.toFixed(2)}) 客:「${last.replace(/\n/g, " ").slice(0, 60)}」`);
      }
    }
    // ピッカー（何を確認したか）の答え合わせ
    if (l.aix_type === "property_check_result" && l.check_pattern && TOPIC_CHECK_PATTERNS.has(l.check_pattern)) {
      topicN++;
      if (CHECK_PATTERN_TO_TOPIC[l.check_pattern] === d.checkTopic) topicOk++;
      else examplesWrong.push(`  ${l.conversation_id.slice(0, 8)} ピッカー 正解=${l.check_pattern} Jev=${d.checkTopic}(${d.checkTopicProb.toFixed(2)})`);
    }
  }

  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
  console.log(`AIX の正答率: ${aixOk}/${aixN} = ${pct(aixOk, aixN)}（失敗 ${failed}）`);
  console.log(`  確率 0.8 以上だけ: ${highConf.ok}/${highConf.n} = ${pct(highConf.ok, highConf.n)}（決定論に使える線の候補）`);
  console.log(`ピッカー（何を確認したか）の正答率: ${topicOk}/${topicN} = ${pct(topicOk, topicN)}`);
  console.log(`\n種類ごと:`);
  for (const [k, v] of [...perType.entries()].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(24)} ${String(v.ok).padStart(3)}/${String(v.n).padStart(3)} = ${pct(v.ok, v.n).padStart(6)}  平均確率 ${(v.probSum / v.n).toFixed(2)}`);
  console.log(`\n間違いの上位（正解 → Jev）:`);
  for (const [k, n] of [...confusion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(3)}  ${k}`);
  console.log(`\n間違いの実物（本名は仮名化済み）:`);
  for (const e of examplesWrong) console.log(e);
}
main().catch((e) => { console.error(e); process.exit(1); });
