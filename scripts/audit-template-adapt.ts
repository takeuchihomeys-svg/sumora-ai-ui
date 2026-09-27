// テンプレの「AI 最適化」と「✨ この会話に合った文を生成」の実データを1表にする（読み取りのみ・LLM は呼ばない）
// 2026-09-27 竹内「AIXのあとのひとことはAIXテンプレートの部分の、この会話にあった文を生成のところとなる／
//   実際のスタッフが送った文のように質を上げるために必要な部分を改善していく」
//
// 経路（コードで確かめた物）:
//   A. テンプレ1枚ごとの「✨ AIで最適化」→「最適化版を使う」（TemplateModal.handleAdapt → /api/generate-reply templateText・aixSourceMessage）
//      記録: template_selection_logs（adapted_text＝最適化した文・final_sent_text＝送った文）。AIX カテゴリのテンプレは
//      「そのまま使う」が AixModal を開くので、入力欄に入る AIX テンプレの文は必ずこの経路（was_adapted=true）
//   B. カテゴリ上部の「✨ この会話に合った文を生成」（handleAixContextGenerate → /api/aix-template-generate）
//      記録: aix_generate_log（conditions_snapshot.source='aix-template-generate'）。onSelect に templateId を渡さないので
//      template_selection_logs には残らない → 送った文はその後のこちらの送信に当てて探す
//
// 実行: npx tsx --env-file=.env.local scripts/audit-template-adapt.ts [--days=90] [--out=<dir>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isGroupConversationName } from "../app/lib/line-target";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "90"));
const OUT = arg("out", "");
const since = new Date(Date.now() - DAYS * 864e5).toISOString();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function page(table: string, cols: string, filter: (q: Any) => Any): Promise<Any[]> {
  const out: Any[] = [];
  for (let p = 0; p < 200; p++) {
    const { data, error } = await filter(sb.from(table).select(cols)).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(table, error.message); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}
const norm = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, "").trim();
/** 2文字の組の Dice 係数（0〜1） */
function sim(a: string | null | undefined, b: string | null | undefined): number {
  const x = norm(a), y = norm(b);
  if (!x && !y) return 1; if (!x || !y) return 0; if (x === y) return 1;
  const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const gx = grams(x), gy = grams(y); let inter = 0;
  for (const [g, n] of gx) inter += Math.min(n, gy.get(g) ?? 0);
  return (2 * inter) / Math.max(1, x.length - 1 + y.length - 1);
}
/** 手直しの量: 変わらず（空白以外同じ）／少し直した（類似 0.85 以上）／大きく直した／送らなかった */
function editLevel(gen: string | null, sent: string | null): string {
  if (!sent) return "送らなかった";
  if (norm(gen) === norm(sent)) return "変わらず";
  return sim(gen, sent) >= 0.85 ? "少し直した" : "大きく直した";
}
const MEDIA = /^\s*\[(画像|動画|スタンプ|ファイル|音声|位置情報)/;

async function main() {
  const convs = await page("conversations", "id,customer_name,line_source_type", (q) => q);
  const convMap = new Map<string, Any>(convs.map((c) => [c.id, c]));
  const excluded = (cid: string | null) => {
    if (!cid || isTestConversation(cid)) return true;
    const c = convMap.get(cid);
    return !c || isGroupConversationName(c.customer_name) || c.line_source_type === "group";
  };
  const templates = await page("templates", "id,category,label,text", (q) => q);
  const tmplMap = new Map<string, Any>(templates.map((t) => [t.id, t]));

  const logs = (await page("template_selection_logs", "id,created_at,conversation_id,conversation_status,template_id,template_category,was_adapted,was_modified_after_adapt,original_text,adapted_text,final_sent_text,aix_action_type,open_context,picker_mode,sequence_no", (q) => q.gte("created_at", since)))
    .filter((r) => !excluded(r.conversation_id));
  const gens = (await page("aix_generate_log", "id,created_at,conversation_id,action_type,status,generated_text,conditions_snapshot", (q) => q.gte("created_at", since).eq("conditions_snapshot->>source", "aix-template-generate")))
    .filter((r) => !excluded(r.conversation_id));

  const convIds = [...new Set([...logs, ...gens].map((r) => r.conversation_id as string))];
  const msgsBy = new Map<string, Any[]>();
  const aixBy = new Map<string, Any[]>();
  const sinceWide = new Date(Date.parse(since) - 7 * 864e5).toISOString();
  for (let i = 0; i < convIds.length; i += 40) {
    const ids = convIds.slice(i, i + 40);
    const ms = await page("messages", "conversation_id,sender,text,created_at,is_aix_generated", (q) => q.in("conversation_id", ids).gte("created_at", sinceWide));
    for (const m of ms) { const a = msgsBy.get(m.conversation_id) ?? []; a.push(m); msgsBy.set(m.conversation_id, a); }
    const ax = await page("aix_usage_logs", "conversation_id,aix_type,created_at,check_pattern,send_mode,app_sub_mode,generated_text", (q) => q.in("conversation_id", ids).gte("created_at", sinceWide));
    for (const m of ax) { const a = aixBy.get(m.conversation_id) ?? []; a.push(m); aixBy.set(m.conversation_id, a); }
  }
  const ctxBefore = (cid: string, at: string, n = 6) => (msgsBy.get(cid) ?? []).filter((m) => m.created_at < at).slice(-n)
    .map((m) => ({ at: m.created_at, who: m.sender === "customer" ? "お客様" : (m.is_aix_generated ? "こちら(AIX)" : "こちら"), text: String(m.text ?? "").slice(0, 400) }));
  const lastAix = (cid: string, at: string) => {
    const a = (aixBy.get(cid) ?? []).filter((x) => x.created_at <= at && Date.parse(at) - Date.parse(x.created_at) < 6 * 3600e3).slice(-1)[0];
    return a ? { aix_type: a.aix_type, at: a.created_at, minutes_before: Math.round((Date.parse(at) - Date.parse(a.created_at)) / 60000), picker: a.check_pattern ?? a.send_mode ?? a.app_sub_mode ?? null, text_head: String(a.generated_text ?? "").slice(0, 300) } : null;
  };
  /** 選んだ後 90 分以内のこちらの送信で、生成文（か記録の送った文）に一番近い物 */
  const findSent = (cid: string, at: string, ref: string) => {
    let best: Any = null; let bs = 0;
    for (const m of msgsBy.get(cid) ?? []) {
      if (m.sender !== "staff" || m.created_at < at || Date.parse(m.created_at) - Date.parse(at) > 90 * 60e3) continue;
      if (!m.text || MEDIA.test(m.text)) continue;
      const s = sim(ref, m.text); if (s > bs) { bs = s; best = m; }
    }
    return best && bs >= 0.45 ? { text: best.text as string, at: best.created_at as string, sim: Math.round(bs * 100) / 100 } : null;
  };

  const rowsA = logs.map((r) => {
    const t = tmplMap.get(r.template_id);
    const gen = (r.was_adapted ? (r.adapted_text ?? r.original_text) : r.original_text) as string | null;
    const matched = findSent(r.conversation_id, r.created_at, r.final_sent_text ?? gen ?? "");
    const sent = (r.final_sent_text as string | null) ?? matched?.text ?? null;
    const isAixCat = String(r.template_category ?? "").includes("AIX");
    return {
      id: r.id, at: r.created_at, conversation_id: r.conversation_id, customer_name: convMap.get(r.conversation_id)?.customer_name ?? null,
      path: r.open_context === "post_aix" ? "AIXの後の一言（バナー）" : (isAixCat ? `AIXテンプレ（${r.open_context ?? "不明"}）` : `通常テンプレ（${r.open_context ?? "不明"}）`),
      open_context: r.open_context, conversation_status: r.conversation_status, aix_action_type: r.aix_action_type, picker_mode: r.picker_mode, sequence_no: r.sequence_no,
      template_category: r.template_category, template_label: t?.label ?? null, template_text: t?.text ?? null,
      was_adapted: r.was_adapted,
      generated: gen,
      sent, sent_source: r.final_sent_text ? "final_sent_text" : (matched ? `messages(sim=${matched.sim})` : null), sent_msg_at: matched?.at ?? null,
      edit: editLevel(gen, sent),
      sim_template_to_generated: t?.text && gen ? Math.round(sim(t.text, gen) * 100) / 100 : null,
      sim_generated_to_sent: sent && gen ? Math.round(sim(gen, sent) * 100) / 100 : null,
      len: { template: t?.text?.length ?? null, generated: gen?.length ?? null, sent: sent?.length ?? null },
      last_aix: lastAix(r.conversation_id, r.created_at),
      context: ctxBefore(r.conversation_id, r.created_at),
    };
  });
  const rowsB = gens.map((g) => {
    const matched = findSent(g.conversation_id, g.created_at, g.generated_text ?? "");
    return {
      id: g.id, at: g.created_at, conversation_id: g.conversation_id, customer_name: convMap.get(g.conversation_id)?.customer_name ?? null,
      path: "✨この会話に合った文を生成", action_type: g.action_type, log_status: g.status,
      brain: g.conditions_snapshot?.brain ?? null, scenario: g.conditions_snapshot?.scenario ?? null, property_state: g.conditions_snapshot?.property_state ?? null,
      generated: g.generated_text, sent: matched?.text ?? null, sent_sim: matched?.sim ?? null, sent_msg_at: matched?.at ?? null,
      edit: editLevel(g.generated_text, matched?.text ?? null),
      last_aix: lastAix(g.conversation_id, g.created_at),
      context: ctxBefore(g.conversation_id, g.created_at),
    };
  });

  // ── 集計 ──
  const tally = (rows: Any[], key: (r: Any) => string) => {
    const m: Record<string, Record<string, number>> = {};
    for (const r of rows) { const k = key(r); m[k] ??= { 件数: 0, 変わらず: 0, 少し直した: 0, 大きく直した: 0, 送らなかった: 0 }; m[k].件数++; m[k][r.edit]++; }
    return Object.fromEntries(Object.entries(m).sort((a, b) => b[1].件数 - a[1].件数));
  };
  const count = (rows: Any[], key: (r: Any) => string) => rows.reduce((m: Record<string, number>, r) => { const k = key(r); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const summary = {
    days: DAYS, since,
    A_rows: rowsA.length, B_rows: rowsB.length,
    A_by_path: tally(rowsA, (r) => r.path),
    A_postaix_by_aix: tally(rowsA.filter((r) => r.open_context === "post_aix"), (r) => r.aix_action_type ?? "-"),
    A_postaix_by_template: tally(rowsA.filter((r) => r.open_context === "post_aix"), (r) => `${r.template_category} / ${r.template_label}`),
    A_aixcat_nonpost_by_template: tally(rowsA.filter((r) => r.open_context !== "post_aix" && String(r.template_category).includes("AIX")), (r) => `${r.open_context} / ${r.template_category} / ${r.template_label}`),
    A_was_adapted: count(rowsA, (r) => `${r.path}:${r.was_adapted}`),
    A_sent_source: count(rowsA, (r) => String(r.sent_source).replace(/\(sim=.*\)/, "")),
    A_by_month: count(rowsA, (r) => r.at.slice(0, 7)),
    B_by_action: tally(rowsB, (r) => r.action_type ?? "-"),
    B_log_status: count(rowsB, (r) => r.log_status),
    B_by_day: count(rowsB, (r) => r.at.slice(0, 10)),
  };
  console.log(JSON.stringify(summary, null, 1));
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "template-adapt-rows.json"), JSON.stringify(rowsA, null, 1));
    writeFileSync(join(OUT, "template-generate-rows.json"), JSON.stringify(rowsB, null, 1));
    writeFileSync(join(OUT, "template-adapt-summary.json"), JSON.stringify(summary, null, 1));
    console.log("saved to", OUT);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
