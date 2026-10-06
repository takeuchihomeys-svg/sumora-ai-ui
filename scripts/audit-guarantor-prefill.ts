// scripts/audit-guarantor-prefill.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-guarantor-prefill.ts [--days=365] [--show=80]
//
// 2026-10-06 竹内（松浦 麻夜 事例「なぜ物件きかれてるのに反映されていないのか…資料に保証会社記載されているので読みとる」）:
//   AIX【保証会社について】の先入れ（guarantor-target.ts で物件・guarantor-material.ts で資料の保証会社）を、
//   過去のお客様の保証会社の質問に当てる。正解の代わりに、その質問の後のこちらの返信（手打ち・AIX）に書いた物件名と保証会社名と比べる。
//   ※ AIX【保証会社について】は送られた記録が 0 件（aix_usage_logs・sent_facts）＝スタッフは手で答えている。
//   読み取りのみ・LLM なし。出力は会話の文を含むので共有しない（物件名・会社名は伏せない）。
import { createClient } from "@supabase/supabase-js";
import { resolveGuarantorTargets, guarantorQuestionIndex, type GuarantorTargetMsg } from "../app/lib/guarantor-target";
import { loadMaterialGuarantor, loadGuarantorTargetMessages } from "../app/lib/guarantor-prefill-server";
import { companiesInSegment } from "../app/lib/guarantor-material";
import { staffLabelsOf, propertyKeyOf } from "../app/lib/confirm-target-property";
import { confirmObjectFromCustomerTurn } from "../app/lib/action-ledger";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const days = Number(arg("days", "365"));
const show = Number(arg("show", "80"));
const since = new Date(Date.now() - days * 86400_000).toISOString();
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

/** こちらの返信に書いた保証会社（マスタの名前・「〇〇という…保証会社」） */
function companiesInReply(text: string): string[] {
  const out = new Set<string>(companiesInSegment(text).filter((c) => c.known).map((c) => c.name));
  for (const m of text.normalize("NFKC").matchAll(/(?:保証会社(?:は|が)?\s*)?([^\s、。!！?？「」]{2,20}?)(?:株式会社)?という(?:[^\s、。]{0,8})?保証会社/g)) {
    const r = companiesInSegment(`保証会社利用必須 ${m[1]}`);
    for (const c of r) out.add(c.name);
  }
  return [...out];
}

async function main() {
  // お客様の保証会社の質問
  const qs: Array<{ id: string; conversation_id: string; created_at: string; text: string }> = [];
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, created_at, text").eq("sender", "customer")
      .gte("created_at", since).ilike("text", "%保証会社%").order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    for (const m of data ?? []) {
      if (m.conversation_id === YUMA) continue;
      const hit = confirmObjectFromCustomerTurn(m.text);
      if (hit?.object === "保証会社") qs.push(m as typeof qs[number]);
    }
    if ((data ?? []).length < 1000) break;
  }
  // 同じ会話の続いた質問は最後の1通だけ
  const uniq = qs.filter((q, i) => !(qs[i + 1] && qs[i + 1].conversation_id === q.conversation_id && Date.parse(qs[i + 1].created_at) - Date.parse(q.created_at) < 30 * 60_000));
  const convPc = new Map<string, string | null>();
  let decided = 0, matFound = 0, named = 0, multiple = 0, unnamed = 0, noMat = 0;
  let replyHasCompany = 0, agree = 0, disagree = 0, propAgree = 0, propDisagree = 0;
  const lines: string[] = [];
  for (const q of uniq) {
    const msgs: GuarantorTargetMsg[] = await loadGuarantorTargetMessages(q.conversation_id, { before: q.created_at, limit: 80 });
    if (guarantorQuestionIndex(msgs) < 0) continue;
    const tg = resolveGuarantorTargets(msgs);
    if (!convPc.has(q.conversation_id)) {
      const { data } = await sb.from("conversations").select("property_customer_id").eq("id", q.conversation_id).maybeSingle();
      convPc.set(q.conversation_id, (data as { property_customer_id?: string | null } | null)?.property_customer_id ?? null);
    }
    // こちらの返信（質問の後・次のお客様の連投の後の返信まで・72時間以内）
    const { data: after } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", q.conversation_id)
      .gt("created_at", q.created_at).lte("created_at", new Date(Date.parse(q.created_at) + 72 * 3600_000).toISOString()).order("created_at").limit(30);
    const replies = ((after ?? []) as Array<{ sender: string; text: string | null }>).filter((m) => m.sender !== "customer").slice(0, 4).map((m) => m.text ?? "");
    const replyCompanies = [...new Set(replies.flatMap((r) => companiesInReply(r)))];
    const replyProps = [...new Set(replies.flatMap((r) => staffLabelsOf(r)).map((l) => propertyKeyOf(l).base))];
    if (replyCompanies.length) replyHasCompany++;
    const cardDescs: string[] = [];
    let anyMat = false, anyNamed = false;
    const ourCompanies: string[] = [];
    if (tg.names.length) decided++;
    for (const n of tg.names.slice(0, 10)) {
      const m = await loadMaterialGuarantor({ conversationId: q.conversation_id, propertyCustomerId: convPc.get(q.conversation_id) ?? null, label: n }).catch(() => null);
      if (m) anyMat = true;
      const st = m?.result.status ?? "no_material";
      if (st === "named") { anyNamed = true; ourCompanies.push(m!.result.companies[0].name); }
      cardDescs.push(`${n}=${st === "named" ? m!.result.companies[0].name : st === "multiple" ? `複数(${m!.result.companies.map((c) => c.name).join("/")})` : st}${m ? `〔${m.source}〕` : ""}`);
    }
    if (tg.names.length) {
      if (anyMat) matFound++; else noMat++;
      if (anyNamed) named++;
      else if (cardDescs.some((d) => d.includes("複数"))) multiple++;
      else if (anyMat) unnamed++;
    }
    let verdict = tg.names.length ? "決めた" : "決めない";
    if (ourCompanies.length && replyCompanies.length) {
      const ok = ourCompanies.every((c) => replyCompanies.includes(c));
      if (ok) { agree++; verdict = "会社一致"; } else { disagree++; verdict = "★会社不一致"; }
    }
    if (tg.names.length && replyProps.length) {
      const ourBases = tg.names.map((n) => propertyKeyOf(n).base);
      if (replyProps.some((b) => ourBases.includes(b))) propAgree++; else { propDisagree++; verdict += "／★物件不一致"; }
    }
    lines.push(`${verdict}｜${q.conversation_id.slice(0, 8)} ${q.created_at.slice(0, 16)}｜Q「${q.text.replace(/\n/g, " ").slice(0, 50)}」\n   物件: ${tg.names.length ? `${tg.source}` : `- ${tg.reason}`}｜${cardDescs.join("｜") || "-"}\n   返信の会社=${replyCompanies.join("・") || "-"}｜返信の物件=${replyProps.join("・") || "-"}｜返信「${(replies.find((r) => /保証/.test(r)) ?? replies[0] ?? "").replace(/\n/g, " ／ ").slice(0, 110)}」`);
  }
  lines.sort((a, b) => (b.includes("★") ? 1 : 0) - (a.includes("★") ? 1 : 0));
  for (const l of lines.slice(0, show)) console.log(l);
  const n = lines.length;
  console.log(`\n=== ${days}日・保証会社の質問 ${n}件（YUMA 除く・30分以内の連投は1件）`);
  console.log(`物件が決まった ${decided}（${Math.round((decided / Math.max(1, n)) * 100)}%）｜うち資料あり ${matFound}・資料なし ${noMat}｜資料から会社1社 ${named}・複数 ${multiple}・会社名なし ${unnamed}`);
  console.log(`返信に会社名 ${replyHasCompany}｜先入れの会社と返信の会社: 一致 ${agree}・不一致 ${disagree}｜決めた物件と返信の物件: 一致 ${propAgree}・不一致 ${propDisagree}`);
  await materialCoverage();
}

/** 送った物件の資料から保証会社が読める率（直近の送付・送った画像の読み取りと売上サポの行） */
async function materialCoverage() {
  const mdays = Number(arg("mdays", "10"));
  const msince = new Date(Date.now() - mdays * 86400_000).toISOString();
  const { data: sent } = await sb.from("sent_image_properties").select("conversation_id, property_name, room_no, created_at")
    .gte("created_at", msince).neq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(1000);
  const seen = new Set<string>();
  const st: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const samples: string[] = [];
  for (const s of (sent ?? []) as Array<{ conversation_id: string; property_name: string | null; room_no: string | null }>) {
    if (!s.property_name || !s.room_no) continue;
    const k = `${s.conversation_id}|${propertyKeyOf(`${s.property_name} ${s.room_no}号室`).key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const m = await loadMaterialGuarantor({ conversationId: s.conversation_id, propertyCustomerId: null, label: `${s.property_name} ${s.room_no}号室` }).catch(() => null);
    const status = m?.result.status ?? "no_material";
    st[status] = (st[status] ?? 0) + 1;
    if (status === "named") { const ty = m!.result.companies[0].known ? m!.result.companies[0].type : "マスタ外"; byType[ty] = (byType[ty] ?? 0) + 1; }
    if (samples.length < Number(arg("msamples", "40")) && (status === "named" || status === "multiple")) samples.push(`${status}｜${s.property_name} ${s.room_no}｜${m!.result.companies.map((c) => `${c.name}(${c.type})`).join("・")}〔${m!.source}〕 ← ${m!.result.evidence[0]?.slice(0, 60)}`);
  }
  console.log(`\n=== 資料の保証会社（直近${mdays}日に送った物件 ${seen.size}件・会話×部屋で1件）: ${JSON.stringify(st)}｜1社の内訳 ${JSON.stringify(byType)}`);
  for (const x of samples) console.log("  " + x);
}
main().catch((e) => { console.error(e); process.exit(1); });
