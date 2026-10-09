// scripts/audit-draft-fact-grounding.ts — 下書きの事実（日付・時刻・号室・物件名・設備）を材料と照らす決まり（app/lib/draft-fact-grounding.ts）を、
//   過去の AI の下書きと竹内さんの実送信に当てて、種類ごとに当たり数と実物を出す（読むだけ・LLM なし・$0）
//
// 2026-10-09 竹内「3. 書いた後に事実と1つずつ照らして見直す」の線引き。最初は「止めて記録するだけ」なので、誤検知（材料にあるのに根拠なしと言う）0 の種類だけ効かせる。
//   材料（その時刻より前の物だけ）: 会話の直近40通（お客様の画像の読み取り・AIX の本文を含む）・AIX の記録の本文と物件名・送った資料の読み取り（sent_image_properties の名前・号室・facts）・
//     見積書の記録・内覧の予定（viewings・viewing_history・calendar_events）・お客様の条件（property_customers）・会社の事実（company-facts の全部）。
//   竹内さんの実送信（AIX でない手打ち）で当たる物＝人が材料の外の事（管理会社に聞いた・カレンダーを見た）を書いた番＝AI が書けば作り話になる物の目安。
// 申込の書類の手前で切る（test-pii-guard）。テスト・社内の会話は外す。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-draft-fact-grounding.ts [--days=40] [--show=6] [--kind=date] [--json=scripts/.replay-out/draft-fact-grounding.json]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const one = (s: string, n = 110) => String(s ?? "").replace(/\s*\n\s*/g, " / ").slice(0, n);

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = Number(arg("days", "40")), show = Number(arg("show", "6")), onlyKind = arg("kind");
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { extractDraftFacts, buildGroundIndex, groundFact, aixForUngroundedFact } = await import("../app/lib/draft-fact-grounding");
  const { COMPANY_FACTS } = await import("../app/lib/company-facts");
  const { isTestConversation } = await import("../app/lib/test-conversations");
  const { cutBeforeApplicationMaterial } = await import("../app/lib/test-pii-guard");
  const { maskPII } = await import("../app/lib/pii-mask");
  const companyText = COMPANY_FACTS.map((f) => `${(f as { fact?: string }).fact ?? ""}`).join("\n");

  type Ex = { conversation_id: string; created_at: string; ai_draft: string | null; sent_reply: string | null };
  const ex = (await pageAll<Ex>((a, b) => sb.from("ai_reply_examples").select("conversation_id, created_at, ai_draft, sent_reply").eq("entry_source", "line_reply").gte("created_at", since).not("ai_draft", "is", null).range(a, b)))
    .filter((e) => !isTestConversation(e.conversation_id) && e.ai_draft && !/^__\w+__$/.test(e.ai_draft.trim()));
  type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };
  const human = (await pageAll<Msg>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated, staff_writer").eq("staff_writer", "takeuchi").eq("sender", "staff").gte("created_at", since).range(a, b)))
    .filter((m) => !m.is_aix_generated && m.text && !/^\s*\[/.test(m.text) && !isTestConversation(m.conversation_id));
  const convs = [...new Set([...ex.map((e) => e.conversation_id), ...human.map((h) => h.conversation_id)])];
  console.error(`下書き ${ex.length}・竹内さんの手打ち ${human.length}・会話 ${convs.length}`);

  type Row = { src: "draft" | "human"; cid: string; at: string; kind: string; value: string; sentence: string; grounded: boolean; uncertain?: boolean; sent?: string | null; aix?: string; aixPressed?: boolean | null };
  const rows: Row[] = [];
  let i = 0;
  for (const cid of convs) {
    if (++i % 40 === 0) console.error(`  ${i}/${convs.length}`);
    const [msgs, aix, sip, est, vw, vh, cal, conv] = await Promise.all([
      pageAll<Msg>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated, staff_writer").eq("conversation_id", cid).order("created_at").range(a, b)),
      pageAll<{ created_at: string; aix_type: string | null; generated_text: string | null; property_names: string[] | null }>((a, b) => sb.from("aix_usage_logs").select("created_at, aix_type, generated_text, property_names").eq("conversation_id", cid).range(a, b)),
      pageAll<{ created_at: string; image_url: string; property_name: string | null; room_no: string | null; facts: unknown }>((a, b) => sb.from("sent_image_properties").select("created_at, image_url, property_name, room_no, facts").eq("conversation_id", cid).range(a, b)),
      pageAll<{ created_at: string; property_name: string | null; room_no: string | null }>((a, b) => sb.from("estimate_records").select("created_at, property_name, room_no").eq("conversation_id", cid).range(a, b)),
      pageAll<{ created_at: string; viewing_date: string | null; viewing_time: string | null }>((a, b) => sb.from("viewings").select("created_at, viewing_date, viewing_time").eq("conversation_id", cid).range(a, b)),
      pageAll<{ created_at: string; scheduled_date: string | null; scheduled_time: string | null; property_name: string | null }>((a, b) => sb.from("viewing_history").select("created_at, scheduled_date, scheduled_time, property_name").eq("conversation_id", cid).range(a, b)),
      pageAll<{ created_at: string; start_at: string | null; title: string | null }>((a, b) => sb.from("calendar_events").select("created_at, start_at, title").eq("conversation_id", cid).range(a, b)),
      sb.from("conversations").select("customer_name, call_name, property_customer_id").eq("id", cid).maybeSingle(),
    ]);
    // 2026-10-09: 送った資料の画像の中身の行（image_details.lines＝向き・ペット・設備・現況・入居可能日）。--details=asof（既定・その時刻までに読んだ物）／all（今ある物全部＝読み直した後の上限）／off
    const detailMode = arg("details", "asof");
    const urls = [...new Set(sip.map((x) => x.image_url).filter(Boolean))];
    const details: Array<{ image_url: string; lines: unknown; read_at: string | null }> = [];
    if (detailMode !== "off") for (let q = 0; q < urls.length; q += 40) { const { data } = await sb.from("image_details").select("image_url, lines, read_at").in("image_url", urls.slice(q, q + 40)); details.push(...((data ?? []) as typeof details)); }
    const pcId = (conv.data as { property_customer_id?: string } | null)?.property_customer_id;
    const pc = pcId ? (await sb.from("property_customers").select("*").eq("id", pcId).maybeSingle()).data : null;
    const { kept } = cutBeforeApplicationMaterial(msgs);
    const cutAt = kept.length < msgs.length ? ms(msgs[kept.length]?.created_at) : Infinity;
    const jstTime = (iso: string | null) => { if (!iso) return ""; const d = new Date(Date.parse(iso) + 9 * 3600_000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
    const groundAt = (t: number): string => {
      const before = (kept as Msg[]).filter((m) => ms(m.created_at) < t);
      const last = before.slice(-40).map((m) => m.text ?? "").join("\n");
      const bf = <T extends { created_at: string }>(xs: T[]) => xs.filter((x) => ms(x.created_at) < t);
      return [
        last,
        ...bf(aix).map((a) => `${a.generated_text ?? ""}\n${(a.property_names ?? []).join("\n")}`),
        ...bf(sip).map((s) => `${s.property_name ?? ""} ${s.room_no ?? ""}号室\n${s.facts ? JSON.stringify(s.facts) : ""}`),
        ...details.filter((d) => detailMode === "all" || ms(d.read_at) < t).map((d) => (Array.isArray(d.lines) ? (d.lines as string[]).join("\n") : "")),
        ...bf(est).map((e) => `${e.property_name ?? ""} ${e.room_no ?? ""}号室`),
        ...bf(vw).map((v) => `${v.viewing_date ?? ""} ${v.viewing_time ?? ""}`),
        ...bf(vh).map((v) => `${v.scheduled_date ?? ""} ${v.scheduled_time ?? ""} ${v.property_name ?? ""}`),
        ...bf(cal).map((c) => `${jstTime(c.start_at)} ${c.title ?? ""}`),
        pc ? JSON.stringify(pc) : "",
        companyText,
      ].join("\n");
    };
    const names = [(conv.data as { customer_name?: string } | null)?.customer_name, (conv.data as { call_name?: string } | null)?.call_name];
    const check = (src: Row["src"], at: string, text: string, sent?: string | null) => {
      const t = ms(at);
      if (t >= cutAt) return; // 申込の書類の後は対象外
      const facts = extractDraftFacts(text).filter((f) => !onlyKind || f.kind === onlyKind);
      if (!facts.length) return;
      const g = buildGroundIndex(groundAt(t));
      for (const f of facts) { const h = groundFact(f, g); const sug = h.grounded ? null : aixForUngroundedFact(h, { estimateSent: est.some((e) => ms(e.created_at) < t) }); const btn = sug?.catalogKey.split("/")[0]; const pressed = sug ? aix.some((a) => a.aix_type === btn && Math.abs(ms(a.created_at) - t) < 3600_000) : null; rows.push({ aix: sug?.catalogKey, aixPressed: pressed, src, cid, at, kind: f.kind, value: f.value, sentence: maskPII(one(f.sentence, 120), names), grounded: h.grounded, uncertain: h.uncertain, sent: sent ? maskPII(one(sent, 120), names) : null }); }
    };
    for (const e of ex.filter((x) => x.conversation_id === cid)) check("draft", e.created_at, e.ai_draft ?? "", e.sent_reply);
    for (const h of human.filter((x) => x.conversation_id === cid)) check("human", h.created_at, h.text ?? "");
  }

  const kinds = ["date", "time", "room", "property_name", "facility", "area", "floor", "direction", "parking", "pet", "cost_item", "movein_immediate", "vacate", "cancel_fee"];
  console.log(`\n=== 下書きの事実の照らし（${days}日）===`);
  console.log("種類 | 下書き: 事実 / 根拠なし（あいまい） | 竹内さんの手打ち: 事実 / 根拠なし");
  for (const k of kinds) {
    const d = rows.filter((r) => r.src === "draft" && r.kind === k), h = rows.filter((r) => r.src === "human" && r.kind === k);
    console.log(`${k} | ${d.length} / ${d.filter((r) => !r.grounded).length}（${d.filter((r) => r.uncertain).length}） | ${h.length} / ${h.filter((r) => !r.grounded).length}`);
  }
  for (const k of kinds) {
    const bad = rows.filter((r) => r.src === "draft" && r.kind === k && !r.grounded);
    if (!bad.length) continue;
    console.log(`\n■ 下書きで根拠なし: ${k}（${bad.length}）`);
    for (const r of bad.slice(0, show)) console.log(`  - ${r.cid.slice(0, 8)} ${r.at.slice(0, 16)} 「${r.value}」 ${r.sentence}${r.sent ? `\n      送った文: ${r.sent}` : ""}`);
  }
  for (const k of kinds) {
    const bad = rows.filter((r) => r.src === "human" && r.kind === k && !r.grounded);
    if (!bad.length) continue;
    console.log(`\n□ 竹内さんの手打ちで材料の外: ${k}（${bad.length}・勧める AIX のボタンを前後1時間に押していた ${bad.filter((r) => r.aixPressed).length}）`);
    for (const r of bad.slice(0, Math.min(4, show))) console.log(`  - ${r.cid.slice(0, 8)} ${r.at.slice(0, 16)} 「${r.value}」→${r.aix}${r.aixPressed ? "（押した）" : ""} ${r.sentence}`);
  }
  // 勧める AIX（下書きの根拠なし）
  const dBad = rows.filter((r) => r.src === "draft" && !r.grounded);
  const byAix = new Map<string, number>(); for (const r of dBad) byAix.set(r.aix ?? "-", (byAix.get(r.aix ?? "-") ?? 0) + 1);
  console.log(`\n下書きの根拠なしに勧める AIX: ${[...byAix].map(([k, v]) => `${k} ${v}`).join("・") || "なし"}`);
  const out = arg("json");
  if (out) { writeFileSync(out, JSON.stringify(rows, null, 1)); console.error(`→ ${out}`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
