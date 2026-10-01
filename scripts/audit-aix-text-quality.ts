// scripts/audit-aix-text-quality.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-text-quality.ts      （DAYS=14 既定・読み取りのみ）
//       SHOW=5 …… 種類ごとに見せる実物の数
//
// 2026-10-01 竹内「他のAIXボタンでもちゃんとできているのかや、文がちゃんとできているのかも踏まえて調査する」
//   AIX ごとに、AI が作った文（aix_usage_logs.generated_text）と、返信の下書き（ai_reply_examples.ai_draft）に、
//   決まりで禁じている形が残っていないかを数え、当たった実物を読む:
//     ①「お待たせ」（feedback_no_omatase: 返信でも AIX でも使わない）
//     ② 作業メモ（feedback_no_meta_in_draft: meta-narration の判定）
//     ③ 同じ絵文字の2重（emoji-repeat・10/01 から出口あり）
//     ④ 内覧が決まった前提の言い方（viewing-premature。待ち合わせ場所・内覧後の挨拶は対象外）
//     ⑤ 本人確認書類の中身（免許証番号・生年月日の書き写し）
//   件数だけで決めず、当たった文を目で読む（決まりの例外＝正しく使っている文が混ざる）
import { createClient } from "@supabase/supabase-js";
import { isWorkNoteLine, isMetaNarrationLine, META_BLOCK_HEADING_RE } from "../app/lib/meta-narration";
import { dedupeRepeatedEmoji } from "../app/lib/emoji-repeat";
import { findPrematureViewing } from "../app/lib/viewing-premature";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 14);
const SHOW = Number(process.env.SHOW ?? 4);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const SINCE = new Date(Date.now() - DAYS * 86400_000).toISOString();
const VIEWING_OK_TYPES = new Set(["meeting_place", "greeting_viewing", "viewing_invite"]);
const ID_LEAK_RE = /(?:免許証番号|第\s*\d{12}\s*号|生年月日\s*[:：]?\s*(?:昭和|平成|令和|19|20)\d)/;

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 100; p++) { const { data, error } = await q(p * 1000, p * 1000 + 999); if (error) throw new Error(error.message); const r = data ?? []; out.push(...r); if (r.length < 1000) break; }
  return out;
}
const one = (s: string, n = 160) => s.replace(/\n+/g, " / ").slice(0, n);

type Hit = { kind: string; type: string; conv: string; text: string; ev: string };
function check(type: string, conv: string, text: string): Hit[] {
  const hits: Hit[] = [];
  if (/お待たせ/.test(text)) hits.push({ kind: "①お待たせ", type, conv, text, ev: (text.match(/[^\n]*お待たせ[^\n]*/) ?? [""])[0] });
  const lines = text.split("\n");
  const meta = lines.find((l) => l.trim() && (isWorkNoteLine(l) || isMetaNarrationLine(l) || META_BLOCK_HEADING_RE.test(l)));
  if (meta) hits.push({ kind: "②作業メモ", type, conv, text, ev: meta });
  const em = dedupeRepeatedEmoji(text);
  if (em.changes.length) hits.push({ kind: "③絵文字の2重", type, conv, text, ev: em.changes.map((c) => `${c.from}→${c.to || "なし"}「${one(c.sentence, 50)}」`).join(" ") });
  if (!VIEWING_OK_TYPES.has(type)) {
    const pv = findPrematureViewing(text);
    if (pv.length) hits.push({ kind: "④内覧の先走り", type, conv, text, ev: pv.map((p) => p.sentence).join(" ／ ") });
  }
  if (ID_LEAK_RE.test(text)) hits.push({ kind: "⑤本人確認書類", type, conv, text, ev: (text.match(ID_LEAK_RE) ?? [""])[0] });
  return hits;
}

async function main() {
  const aix = (await pageAll<{ conversation_id: string; aix_type: string; generated_text: string | null; was_edited: boolean | null }>((f, t) =>
    sb.from("aix_usage_logs").select("conversation_id, aix_type, generated_text, was_edited").gte("created_at", SINCE).not("generated_text", "is", null).order("created_at").range(f, t)))
    .filter((r) => r.conversation_id !== YUMA && (r.generated_text ?? "").trim());
  const drafts = (await pageAll<{ conversation_id: string | null; ai_draft: string | null; sent_reply: string | null; entry_source: string | null }>((f, t) =>
    sb.from("ai_reply_examples").select("conversation_id, ai_draft, sent_reply, entry_source").gte("created_at", SINCE).not("ai_draft", "is", null).order("created_at").range(f, t)))
    .filter((r) => r.conversation_id !== YUMA && (r.ai_draft ?? "").trim());

  const all: Hit[] = [];
  const perType = new Map<string, number>();
  for (const r of aix) { perType.set(r.aix_type, (perType.get(r.aix_type) ?? 0) + 1); all.push(...check(r.aix_type, r.conversation_id, r.generated_text ?? "")); }
  for (const r of drafts) { const ty = `下書き(${r.entry_source ?? "-"})`; perType.set(ty, (perType.get(ty) ?? 0) + 1); all.push(...check(ty, r.conversation_id ?? "", r.ai_draft ?? "")); }

  console.log(`== ${DAYS}日: AIX の生成文 ${aix.length}件・返信の下書き ${drafts.length}件 ==`);
  const types = [...perType.keys()].sort((a, b) => (perType.get(b) ?? 0) - (perType.get(a) ?? 0));
  const kinds = ["①お待たせ", "②作業メモ", "③絵文字の2重", "④内覧の先走り", "⑤本人確認書類"];
  console.log(`種類\t件数\t${kinds.join("\t")}`);
  for (const ty of types) console.log(`${ty}\t${perType.get(ty)}\t${kinds.map((k) => all.filter((h) => h.type === ty && h.kind === k).length).join("\t")}`);
  for (const k of kinds) {
    const hs = all.filter((h) => h.kind === k);
    if (!hs.length) continue;
    console.log(`\n--- ${k} ${hs.length}件（実物） ---`);
    for (const h of hs.slice(0, SHOW * 3)) console.log(`  [${h.type}] ${h.conv.slice(0, 8)} 「${one(h.ev, 140)}」`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
