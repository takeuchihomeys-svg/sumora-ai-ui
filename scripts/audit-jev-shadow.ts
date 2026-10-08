// Jev（TypeSafe AI）の**影の運用の記録**（jev_shadow_logs）から正答率を集計する（読み取りのみ・DB は書かない・Jev も呼ばない）。
//
// 2026-09-29 竹内さんの方針: 最初は影（本番の動きは変えず記録だけ）→ 正答率を測って上回った物だけ切り替え。
// 3 つの影を、それぞれの「正解」で答え合わせする:
//   ① aix_picker（ブレインが決めたボタンのピッカーを Jev が選ぶ）
//        正解 ＝ スタッフが実際に押した AIX（aix_usage_logs）のピッカー（check_pattern は「何を確認したか」の物だけ・send_mode・app_sub_mode）。
//        同じ会話で customer_msg_at の後 3 日以内に押した最初の同じボタン。ブレイン自身の check_pattern も同じ正解で測って並べる。
//   ② own_property（お客様の画像がこちらの送った物件か）
//        正解 ＝ スタッフの実際の返し（scripts/audit-own-property-image.ts と同じ語: 募集状況確認＝新しい物件／ご査収・御見積書・引き続き新着＝こちらの物件）
//   ③ classify_condition（お客様の発言が条件のメッセージか・Haiku の 4 択）
//        正解 ＝ (a) 決定論（isFilledSumoraForm）が確定させた回は硬い正解 (b) それ以外は「今の判定（Haiku）との一致」＝一致率であって正答率ではない。
//        食い違いは本文（仮名化）を出すので**人が目で読む**（設計知見「件数だけ見ない」）。入口の判断（通す／落とす）が同じかも別に数える。
// 実行: npx tsx --env-file=.env.local scripts/audit-jev-shadow.ts [--days=30] [--show=15]
import { createClient } from "@supabase/supabase-js";
import { createMasker } from "../app/lib/pii-pseudonym";
import { AIX_PICKER_CATALOG, CHECK_PATTERN_TO_TOPIC, TOPIC_CHECK_PATTERNS } from "../app/lib/aix-jev";
import { compareConditionClassify } from "../app/lib/condition-classify-jev";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "30"));
const SHOW = Number(arg("show", "15"));
const WINDOW_MS = 3 * 86400_000;
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

/** audit-own-property-image.ts と同じ正解の手がかり（スタッフの返し） */
const STAFF_CHECKED_RE = /募集状況(?:を)?確認|お送り頂きました|お送りいただきました|お部屋お送りいただき/;
const STAFF_OURS_RE = /ご査収|引き続き(?:新着|お部屋)|御見積書|お見積書|内覧|ご案内させて/;

type Row = {
  id: number; created_at: string; kind: string | null; conversation_id: string; customer_msg_at: string | null;
  brain_action: string | null; brain_check_pattern: string | null; brain_prob: number | null; brain_source: string | null;
  jev_picker_field: string | null; jev_picker: string | null; jev_picker_value: string | null; jev_picker_prob: number | null; jev_confidence: number | null; jev_ms: number | null;
  jev_action: string | null; jev_action_prob: number | null;
};

async function all<T>(build: (a: number, b: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const rows = await all<Row>((a, b) => sb.from("jev_shadow_logs")
    .select("id, created_at, kind, conversation_id, customer_msg_at, brain_action, brain_check_pattern, brain_prob, brain_source, jev_picker_field, jev_picker, jev_picker_value, jev_picker_prob, jev_confidence, jev_ms, jev_action, jev_action_prob")
    .gte("created_at", since).neq("conversation_id", YUMA).order("created_at", { ascending: true }).range(a, b));
  console.log(`=== Jev 影の運用の答え合わせ（jev_shadow_logs ${DAYS}日・${rows.length}行）===`);
  if (rows.length === 0) {
    console.log("  記録が無い（本番で影が動いた回がまだ無い・または鍵が入っていない）。llm_usage_logs の action='jev:*' も確認する");
    return;
  }
  const byKind = new Map<string, Row[]>();
  for (const r of rows) { const k = r.kind ?? (r.jev_action ? "aix_full" : "aix_picker"); byKind.set(k, [...(byKind.get(k) ?? []), r]); }
  for (const [k, v] of byKind) {
    const ms = v.map((r) => r.jev_ms ?? 0).sort((a, b) => a - b);
    console.log(`  ${k.padEnd(20)} ${String(v.length).padStart(4)}行  応答の中央値 ${ms[Math.floor(ms.length / 2)] ?? "-"}ms  最大 ${ms[ms.length - 1] ?? "-"}ms`);
  }
  // 失敗・時間切れ（llm_usage_logs）
  const { data: usage } = await sb.from("llm_usage_logs").select("action, status, error_type").like("action", "jev:%").gte("created_at", since).limit(5000);
  const u = (usage ?? []) as Array<{ action: string; status: number | null; error_type: string | null }>;
  const bad = u.filter((x) => x.status !== 200);
  console.log(`  llm_usage_logs jev:* ${u.length}行  失敗 ${bad.length}（${[...new Set(bad.map((x) => x.error_type))].join("・") || "なし"}）\n`);

  const { data: nameRows } = await sb.from("conversations").select("id, customer_name").limit(3000);
  const nameOf = new Map<string, string>();
  const knownNames: string[] = [];
  for (const r of ((nameRows ?? []) as Array<{ id: string; customer_name: string | null }>)) { const n = (r.customer_name ?? "").trim(); nameOf.set(r.id, n); if (n) knownNames.push(n); }
  const maskFor = (convId: string) => createMasker({ conversationId: convId, customerName: nameOf.get(convId) || null, knownNames });

  // ── ① aix_picker ──────────────────────────────────────────────────────────
  {
    const v = byKind.get("aix_picker") ?? [];
    console.log(`── ① ピッカー（ボタンはブレイン・ピッカーは Jev）${v.length}行 ──`);
    console.log(`  正解＝スタッフが実際に押した同じボタンのピッカー（customer_msg_at の後 3 日以内の最初）`);
    const stats = new Map<string, { n: number; jevOk: number; brainOk: number; brainHas: number; hiN: number; hiOk: number }>();
    const jevRight: string[] = [], jevWrong: string[] = [];
    let noTruth = 0;
    for (const r of v) {
      if (!r.brain_action || !(r.brain_action in AIX_PICKER_CATALOG)) continue;
      const at = r.customer_msg_at ?? r.created_at;
      const { data: presses } = await sb.from("aix_usage_logs").select("aix_type, check_pattern, send_mode, app_sub_mode, picker_choices, created_at")
        .eq("conversation_id", r.conversation_id).eq("aix_type", r.brain_action).gte("created_at", at).lte("created_at", new Date(new Date(at).getTime() + WINDOW_MS).toISOString())
        .order("created_at", { ascending: true }).limit(1);
      const p = (presses ?? [])[0] as { check_pattern: string | null; send_mode: string | null; app_sub_mode: string | null; picker_choices: Record<string, unknown> | null } | undefined;
      const field = AIX_PICKER_CATALOG[r.brain_action].field;
      // 正解の値（Jev の選択肢のキーに揃える）。check_pattern は「何を確認したか」の物だけ（結果のピッカーは会話から分からない）
      const truth = !p ? null
        : field === "check_pattern" ? (p.check_pattern && TOPIC_CHECK_PATTERNS.has(p.check_pattern) ? CHECK_PATTERN_TO_TOPIC[p.check_pattern] : null)
        : field === "send_mode" ? p.send_mode
        // 2026-10-08: 物件オススメは画面の6種（picker_choices.pickup_type）が正解
        : field === "pickup_type" ? (typeof p.picker_choices?.pickup_type === "string" ? p.picker_choices.pickup_type : null)
        : p.app_sub_mode;
      if (!truth) { noTruth++; continue; }
      const s = stats.get(r.brain_action) ?? { n: 0, jevOk: 0, brainOk: 0, brainHas: 0, hiN: 0, hiOk: 0 };
      s.n++;
      const jevOk = r.jev_picker === truth;
      if (jevOk) s.jevOk++;
      const brainPick = field === "check_pattern" ? (r.brain_check_pattern ? CHECK_PATTERN_TO_TOPIC[r.brain_check_pattern] ?? null : null) : null;
      if (brainPick) { s.brainHas++; if (brainPick === truth) s.brainOk++; }
      if ((r.jev_picker_prob ?? 0) >= 0.8) { s.hiN++; if (jevOk) s.hiOk++; }
      stats.set(r.brain_action, s);
      const line = `  ${r.conversation_id.slice(0, 8)} ${r.brain_action} 正解=${truth} Jev=${r.jev_picker}(${(r.jev_picker_prob ?? 0).toFixed(2)}) ブレイン=${brainPick ?? "-"}`;
      if (jevOk && brainPick && brainPick !== truth && jevRight.length < SHOW) jevRight.push(line);
      if (!jevOk && jevWrong.length < SHOW) jevWrong.push(line);
    }
    for (const [k, s] of stats) console.log(`  ${k.padEnd(24)} Jev ${s.jevOk}/${s.n} = ${pct(s.jevOk, s.n)}  確率0.8以上 ${s.hiOk}/${s.hiN} = ${pct(s.hiOk, s.hiN)}  ブレインの check_pattern ${s.brainOk}/${s.brainHas} = ${pct(s.brainOk, s.brainHas)}`);
    console.log(`  正解が無い（まだ押していない・結果のピッカー）${noTruth}行`);
    if (jevRight.length) { console.log(`  Jev が合っていてブレインが外した実例:`); jevRight.forEach((l) => console.log(l)); }
    if (jevWrong.length) { console.log(`  Jev が外した実例:`); jevWrong.forEach((l) => console.log(l)); }
    console.log();
  }

  // ── ② own_property ────────────────────────────────────────────────────────
  {
    const v = byKind.get("own_property") ?? [];
    console.log(`── ② 送った物件の判定（お客様の画像がこちらの送った物件か）${v.length}行 ──`);
    console.log(`  正解＝スタッフの返し（募集状況確認＝新しい物件／ご査収・御見積書・引き続き新着＝こちらの物件）`);
    let judged = 0, jevOk = 0, detOk = 0, hiN = 0, hiOk = 0;
    const lines: string[] = [];
    for (const r of v) {
      const at = r.customer_msg_at ?? r.created_at;
      const { data: staff } = await sb.from("messages").select("text, created_at").eq("conversation_id", r.conversation_id).eq("sender", "staff")
        .gte("created_at", at).lte("created_at", new Date(new Date(at).getTime() + WINDOW_MS).toISOString()).order("created_at", { ascending: true }).limit(3);
      const said = ((staff ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").join(" ");
      const truth = STAFF_CHECKED_RE.test(said) ? "新しい物件" : STAFF_OURS_RE.test(said) ? "こちらの物件" : null;
      if (!truth) continue;
      judged++;
      const jevSaid = r.jev_picker && r.jev_picker !== "none" ? "こちらの物件" : "新しい物件";
      const detSaid = r.brain_action === "same_room" ? "こちらの物件" : "新しい物件";
      const ok = jevSaid === truth;
      if (ok) jevOk++;
      if (detSaid === truth) detOk++;
      if ((r.jev_picker_prob ?? 0) >= 0.8) { hiN++; if (ok) hiOk++; }
      if (lines.length < SHOW) lines.push(`  ${r.conversation_id.slice(0, 8)} 正解=${truth} Jev=${jevSaid}${r.jev_picker_value ? `（${r.jev_picker_value}）` : ""}(${(r.jev_picker_prob ?? 0).toFixed(2)}) 決定論=${detSaid}${ok ? "" : "  ← Jev 外し"}\n      店: ${maskFor(r.conversation_id).mask(said).slice(0, 70)}`);
    }
    console.log(`  正解が分かる ${judged}行: Jev ${jevOk}/${judged} = ${pct(jevOk, judged)}  確率0.8以上 ${hiOk}/${hiN} = ${pct(hiOk, hiN)}  決定論 ${detOk}/${judged} = ${pct(detOk, judged)}`);
    lines.forEach((l) => console.log(l));
    console.log();
  }

  // ── ③ classify_condition ──────────────────────────────────────────────────
  {
    const v = byKind.get("classify_condition") ?? [];
    console.log(`── ③ お客様の発言の分類（Haiku の 4 択と並べる）${v.length}行 ──`);
    let n = 0, sameClass = 0, sameGate = 0, hard = 0, hardOk = 0, hiN = 0, hiSame = 0;
    const confusion = new Map<string, number>();
    const disagree: string[] = [];
    for (const r of v) {
      if (!r.brain_action || !r.jev_picker) continue;
      const a = compareConditionClassify({ brain_action: r.brain_action, brain_prob: r.brain_prob, brain_source: r.brain_source ?? "haiku", jev_picker: r.jev_picker, jev_picker_prob: r.jev_picker_prob });
      n++;
      if (a.sameClass) sameClass++;
      if (a.sameGate) sameGate++;
      if (a.hardTruth) { hard++; if (a.jevRightOnHard) hardOk++; }
      if ((r.jev_picker_prob ?? 0) >= 0.8) { hiN++; if (a.sameClass) hiSame++; }
      if (!a.sameClass) {
        const k = `${r.brain_source === "deterministic" ? "決定論" : "Haiku"}:${r.brain_action} → Jev:${r.jev_picker}`;
        confusion.set(k, (confusion.get(k) ?? 0) + 1);
        if (disagree.length < SHOW) {
          // 本文は記録していない（設計）。messages から引いて仮名化して出す
          let body = "";
          if (r.customer_msg_at) {
            const { data: m } = await sb.from("messages").select("text").eq("conversation_id", r.conversation_id).eq("sender", "customer").eq("created_at", r.customer_msg_at).limit(1).maybeSingle();
            body = maskFor(r.conversation_id).mask((m?.text as string | null) ?? "").replace(/\s+/g, " ").slice(0, 90);
          }
          disagree.push(`  ${r.conversation_id.slice(0, 8)} 今=${r.brain_action}(${r.brain_source ?? "haiku"} ${(r.brain_prob ?? 0).toFixed(2)}) Jev=${r.jev_picker}(${(r.jev_picker_prob ?? 0).toFixed(2)}) 入口${a.sameGate ? "同じ" : "違う"}\n      客: ${body}`);
        }
      }
    }
    console.log(`  4 択の一致 ${sameClass}/${n} = ${pct(sameClass, n)}（確率0.8以上 ${hiSame}/${hiN} = ${pct(hiSame, hiN)}）  入口（通す／落とす）の一致 ${sameGate}/${n} = ${pct(sameGate, n)}`);
    console.log(`  硬い正解（決定論で正式フォーマット）${hard}行: Jev ${hardOk}/${hard} = ${pct(hardOk, hard)}`);
    if (confusion.size) { console.log(`  食い違いの内訳（今の判定 → Jev）:`); for (const [k, c] of [...confusion].sort((a, b) => b[1] - a[1])) console.log(`    ${String(c).padStart(3)}  ${k}`); }
    if (disagree.length) { console.log(`  食い違いの実物（仮名化・目で読んでどちらが正しいか決める）:`); disagree.forEach((l) => console.log(l)); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
