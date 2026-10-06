// scripts/audit-confirm-target-property.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-confirm-target-property.ts [--days=180] [--show=80]
//
// 2026-10-06 竹内（R 事例「別の物件がはいりこんでしまっている…物件特定できる能力高める」）:
//   AIX【確認した（条件・交渉）】（設備・駐車場・ペット・初期費用・退去日・募集状況・オーナー 等）の [物件名] は LLM が会話から推測していた。
//   confirm-target-property.ts で会話から決定論で決める。過去の生成（aix_generate_log）と、確認結果の手打ちの報告に当てて、
//   決めた物件と、文に実際に出た物件名を並べる（目で読む）。読み取りのみ・LLM なし。出力は会話の文を含むので共有しない。
import { createClient } from "@supabase/supabase-js";
import { resolveConfirmTargetProperty, propertyKeyOf, staffLabelsOf } from "../app/lib/confirm-target-property";
import { confirmTopicForCheckPattern, classifyStaffTextFacts } from "../app/lib/action-ledger";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const days = Number(arg("days", "180"));
const show = Number(arg("show", "80"));
const since = new Date(Date.now() - days * 86400_000).toISOString();
const MGMT = ["vacate_date", "mgmt_initial_cost", "mgmt_parking", "mgmt_pet", "mgmt_equipment", "mgmt_availability", "nearby_parking", "owner_other", "mgmt_company"];

type Row = { conversation_id: string; at: string; text: string; cp: string | null; kind: "AIX生成" | "手打ち報告"; topic?: string | null };

async function main() {
  const rows: Row[] = [];
  const { data: gen } = await sb.from("aix_generate_log").select("conversation_id, created_at, generated_text, check_pattern")
    .gte("created_at", since).in("check_pattern", MGMT).limit(2000);
  for (const g of gen ?? []) if (g.conversation_id && g.generated_text) rows.push({ conversation_id: g.conversation_id, at: g.created_at, text: g.generated_text, cp: g.check_pattern, kind: "AIX生成" });
  // 手打ちの確認結果の報告（条件・設備の要件）
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, created_at, text, is_aix_generated").eq("sender", "staff").gte("created_at", since)
      .or("text.ilike.%管理会社%確認させて%,text.ilike.%管理会社%交渉させて%").order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    for (const m of data) {
      if (m.is_aix_generated) continue;
      const rep = classifyStaffTextFacts(m.text ?? "", m.created_at).find((e) => e.kind === "confirmation_reported");
      const o = rep?.detail?.object ?? "";
      if (!rep || !/設備|駐車場|ペット|初期費用|退去|入居時期|保証会社/.test(o)) continue;
      rows.push({ conversation_id: m.conversation_id, at: m.created_at, text: m.text ?? "", cp: null, kind: "手打ち報告", topic: o });
    }
    if (data.length < 1000) break;
  }
  const cache = new Map<string, Array<{ sender: string; text: string | null; created_at: string }>>();
  let resolved = 0, agree = 0, disagree = 0, textNoName = 0, unresolved = 0;
  const lines: string[] = [];
  for (const r of rows) {
    let all = cache.get(r.conversation_id);
    if (!all) {
      const { data } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", r.conversation_id).order("created_at").limit(3000);
      all = data ?? [];
      cache.set(r.conversation_id, all);
    }
    const before = all.filter((m) => m.created_at < r.at).map((m) => ({ sender: m.sender, text: m.text }));
    const topic = r.cp ? confirmTopicForCheckPattern(r.cp) : (r.topic ?? null);
    const t = resolveConfirmTargetProperty(before, { topic });
    // 文に出た、こちらが送った物件
    const flat = r.text.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
    const known = [...new Set(before.filter((m) => m.sender !== "customer").flatMap((m) => staffLabelsOf(m.text)))];
    const named = [...new Set([...known.filter((l) => { const b = propertyKeyOf(l).base; return b.length >= 3 && flat.includes(b); }), ...staffLabelsOf(r.text)])];
    const namedBases = [...new Set(named.map((l) => propertyKeyOf(l).base))];
    let verdict: string;
    if (!t) { unresolved++; verdict = "決めない"; }
    else {
      resolved++;
      const tb = propertyKeyOf(t.name).base;
      if (!namedBases.length) { textNoName++; verdict = "文に名前なし"; }
      else if (namedBases.length === 1 && namedBases[0] === tb) { agree++; verdict = "一致"; }
      else { disagree++; verdict = "★不一致"; }
    }
    lines.push(`${verdict}｜${r.kind}${r.cp ? `(${r.cp})` : ""}｜${r.conversation_id.slice(0, 8)} ${r.at.slice(0, 16)}｜決めた=${t ? `${t.name}〔${t.source}〕` : "-"}｜文の物件=${named.join("・") || "-"}\n   ${r.text.replace(/\n/g, " ／ ").slice(0, 170)}`);
  }
  lines.sort((a, b) => (a.startsWith("★") ? -1 : 0) - (b.startsWith("★") ? -1 : 0));
  for (const l of lines.slice(0, show)) console.log(l);
  console.log(`=== ${days}日: ${rows.length}通（AIX生成 ${rows.filter((r) => r.kind === "AIX生成").length}・手打ち報告 ${rows.filter((r) => r.kind === "手打ち報告").length}）｜決めた ${resolved}（文の物件と一致 ${agree}・不一致 ${disagree}・文に名前なし ${textNoName}）｜決めない ${unresolved} ===`);
}
main().catch((e) => { console.error(e); process.exit(1); });
