// scripts/audit-aix-missing-pickers.ts — 竹内さんの手打ちの「確認した結果」の文を、どの AIX のどのピッカーで送る物か当てはめ、
//   どのピッカーにも当たらない確認事項を「足りないピッカー・ボタンの候補」として数える（読むだけ・LLM なし）。
//
// 2026-10-22 竹内さんの決定（55575458）「それぞれのピッカーでの確認事項で足りないボタンなども見つけ出していく」／
//   （d04ed51b）「竹内も AIX で送れていない所がある」／（76c249e0）「押すのは竹内基準＝竹内さんの送信から学ぶ（スタッフの送信は学ばない）」。
//   ピッカーごとの確認事項は app/lib/aix-confirm-items.ts（AIX_CONFIRM_ITEMS）。網は候補を拾うだけ・足すかは竹内さんが決める（owner_questions にまとめて聞く）。
//
//   npx tsx --env-file=.env.local scripts/audit-aix-missing-pickers.ts [--days=120] [--min=2]          … 数えて見せる（書かない）
//   npx tsx --env-file=.env.local scripts/audit-aix-missing-pickers.ts --apply                         … 候補を owner_questions（kind question・話題「AIX のピッカー」）に足す（dedupe_key で二重にしない）
//   --items で ピッカーごとの確認事項の表だけ出す。LINE には何も送らない。お客様の名前・電話は伏せて短く切った一節だけ台帳に入れる。
import { createClient } from "@supabase/supabase-js";
import { AIX_CONFIRM_ITEMS, UNCOVERED_TOPICS, STAFF_FACT_END_RE, confirmTopicsOf, uncoveredTopicsOf, reportSentencesOf, renderConfirmItems } from "../app/lib/aix-confirm-items";
import { isTestConversation } from "../app/lib/test-conversations";
import { maskPII } from "../app/lib/pii-mask";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "120")) || 120;
const MIN = Number(arg("min", "2")) || 2;
const APPLY = argv.includes("--apply");

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };

async function main() {
  if (argv.includes("--items")) { console.log(renderConfirmItems()); return; }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) throw new Error("SUPABASE_SERVICE_ROLE_KEY が要ります");
  const sb = createClient(url, key);
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs: Msg[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, staff_writer")
      .eq("staff_writer", "takeuchi").neq("sender", "customer").gte("created_at", since).order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    msgs.push(...((data ?? []) as Msg[]));
    if (!data || data.length < 1000) break;
  }
  const { data: convs } = await sb.from("conversations").select("id, customer_name, call_name");
  const namesOf = new Map(((convs ?? []) as Array<{ id: string; customer_name: string | null; call_name: string | null }>).map((c) => [c.id, [c.customer_name, c.call_name].filter(Boolean) as string[]]));
  const hand = msgs.filter((m) => !m.is_aix_generated && m.text && !isTestConversation(m.conversation_id));

  const mapped = new Map<string, number>();
  const unmapped = new Map<string, { n: number; convs: Set<string>; samples: string[] }>();
  let reports = 0;
  for (const m of hand) {
    for (const s of reportSentencesOf(m.text ?? "")) {
      reports++;
      // 文に話題の語が無い時は同じ通の他の文（「こちらの部分ですが…」の前の文）で見る
      const keys = confirmTopicsOf(s).length ? confirmTopicsOf(s) : confirmTopicsOf(m.text ?? "");
      if (keys.length) { for (const k of keys) mapped.set(k, (mapped.get(k) ?? 0) + 1); continue; }
      const topics = uncoveredTopicsOf(s).length ? uncoveredTopicsOf(s) : uncoveredTopicsOf(m.text ?? "");
      const topic = topics[0] ?? "その他（話題の語が無い）";
      const g = unmapped.get(topic) ?? { n: 0, convs: new Set<string>(), samples: [] };
      g.n++; g.convs.add(m.conversation_id);
      if (g.samples.length < 8) g.samples.push(maskPII(s, namesOf.get(m.conversation_id) ?? []).replace(/\s+/g, " ").slice(0, 70));
      unmapped.set(topic, g);
    }
  }
  // ② 報告の言い方でなくても、物件ごとに管理会社で確かめる話題（火災保険・更新料 等）を言い切っている文（ピッカーの網に当たらない物だけ）
  for (const m of hand) {
    for (const s of String(m.text ?? "").split(/\n+|(?<=[。！!])/).map((x) => x.trim()).filter((x) => x.length >= 6)) {
      if (reportSentencesOf(s).length || confirmTopicsOf(s).length || !STAFF_FACT_END_RE.test(s)) continue;
      const u = UNCOVERED_TOPICS.find((t) => t.staffFact && t.re.test(s.normalize("NFKC")));
      if (!u) continue;
      const g = unmapped.get(u.topic) ?? { n: 0, convs: new Set<string>(), samples: [] };
      g.n++; g.convs.add(m.conversation_id);
      if (g.samples.length < 8) g.samples.push(maskPII(s, namesOf.get(m.conversation_id) ?? []).replace(/\s+/g, " ").slice(0, 70));
      unmapped.set(u.topic, g);
    }
  }
  console.log(`=== 竹内さんの手打ち（${DAYS}日・AIX でない ${hand.length}通）の確認の結果の文 ${reports} ===`);
  console.log("■ ピッカーに当たる（AIX で送れたかもしれない手打ち）:");
  for (const c of AIX_CONFIRM_ITEMS) { const n = mapped.get(c.key) ?? 0; if (n) console.log(`  ${c.button}→${c.picker}: ${n}`); }
  console.log("■ どのピッカーにも当たらない確認事項（足りないピッカーの候補）:");
  const groups = [...unmapped.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [t, g] of groups) console.log(`  ${t}: ${g.n}文（${g.convs.size}会話）${g.samples.map((x) => `\n     「${x}」`).join("")}`);

  const cands = groups.filter(([t, g]) => g.n >= MIN && g.convs.size >= 2 && !/^その他/.test(t));
  if (!APPLY) { console.log(`\n候補 ${cands.length}件（--apply で owner_questions に足す・最小 ${MIN}文かつ2会話）`); return; }
  const { data: existing, error: exErr } = await sb.from("owner_questions").select("dedupe_key");
  if (exErr) throw new Error(exErr.message);
  const have = new Set(((existing ?? []) as Array<{ dedupe_key: string | null }>).map((r) => r.dedupe_key));
  const rows = cands.map(([t, g], i) => ({
    kind: "question",
    topic: "AIX のピッカー",
    question: `竹内さんが手打ちで送った「確認した結果」のうち『${t}』の話（${DAYS}日で ${g.n}文・${g.convs.size}会話）を受ける AIX のピッカーがありません。AIX【確認した（条件・交渉）→管理会社に確認した】に『${t}について』のピッカーを足しますか？ 例:「${g.samples[0] ?? ""}」`,
    options: ["足す（スタッフが確かめた結果を入れて送る）", "今のピッカーで送る（どれか教えてください）", "足さない（返信で答える・AIX の番ではない）"],
    recommended: "足す（スタッフが確かめた結果を入れて送る）",
    why: "スタッフだけが知る確認の結果は AIX で送る決まり（P0 4b744a33）。竹内さん自身が手打ちしている＝今の AIX に受け皿が無い（d04ed51b）",
    source_kind: "audit-aix-missing-pickers",
    source_ref: `messages staff_writer=takeuchi・${DAYS}日・確認の結果の文の網（aix-confirm-items.ts）`,
    status: "open",
    priority: 30 + i,
    dedupe_key: `aix-missing-picker:${t}`,
  })).filter((r) => !have.has(r.dedupe_key));
  if (rows.length) { const { error } = await sb.from("owner_questions").insert(rows); if (error) throw new Error(error.message); }
  console.log(`\nowner_questions に ${rows.length}件 足した（既にある ${cands.length - rows.length}件は触らない）`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
