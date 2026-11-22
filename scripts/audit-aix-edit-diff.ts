// scripts/audit-aix-edit-diff.ts — AIX の文をスタッフが直してから送った番で、AI の文（aix_usage_logs.generated_text）と送った文（messages.text）の差を型に分ける（読むだけ・LLM なし・費用0）
//
// 2026-11-21 作業員K2（台帳 #469・統括役: 物件ピックアップの文を竹内さんが 97% 直している＝文の一番大きな穴）。
//   型（1番に複数付く）: 名前だけ（お客様の名前・物件名の差だけ）／書き出し（1行目）／ピックアップの1行（「〜させて頂きました」の行）／推す点（・🌟（オススメポイント）の行）／
//     締め（最後の行）／足した行（AI に無い行が増えた）／消した行（AI の行が無くなった）／絵文字・記号だけ。
//   文の中身は出さない（--show の時だけ手元に頭30字・報告に写さない）。
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-edit-diff.ts [--days=30] [--type=property_send] [--writer=takeuchi|all] [--show]
import { createClient } from "@supabase/supabase-js";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const norm = (s: string) => s.normalize("NFKC").replace(/[\s　]/g, "");
const strip = (s: string) => norm(s).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}！!。、・✨🌟😊😌]/gu, "");
const lines = (s: string) => String(s ?? "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
const nameMask = (s: string) => norm(s).replace(/[^\s]{1,12}(?:さん|様)/g, "〈名〉").replace(/[ァ-ヶー一-龠A-Za-z0-9]{2,}(?:\d{2,4}号室|\s?\d{3,4})/g, "〈物件〉");

export function editKinds(ai: string, sent: string): string[] {
  if (norm(ai) === norm(sent)) return ["同じ"];
  if (strip(ai) === strip(sent)) return ["絵文字・記号だけ"];
  if (nameMask(ai) === nameMask(sent)) return ["名前だけ"];
  const A = lines(ai), S = lines(sent);
  const aSet = new Set(A.map(strip)), sSet = new Set(S.map(strip));
  const k: string[] = [];
  if (strip(A[0] ?? "") !== strip(S[0] ?? "")) k.push("書き出し");
  const pick = (xs: string[]) => xs.find((x) => /ピックアップ|させて頂きました|させていただきました/.test(x)) ?? "";
  if (strip(pick(A)) !== strip(pick(S))) k.push("ピックアップの1行");
  const pts = (xs: string[]) => xs.filter((x) => /^[・●◎✅]|オススメポイント|🌟/.test(x)).map(strip).join("|");
  if (pts(A) !== pts(S)) k.push("推す点");
  if (strip(A[A.length - 1] ?? "") !== strip(S[S.length - 1] ?? "")) k.push("締め");
  if (S.some((x) => !aSet.has(strip(x)))) k.push("足した・書き換えた行");
  if (A.some((x) => !sSet.has(strip(x)))) k.push("消した・書き換えた行");
  return k.length ? k : ["その他"];
}

/** 物件ピックアップした の直しの中身（竹内さんの直しを読んで決めた網・1番に複数） */
const STAFF_ONLY_RE = /退去予定|募集に出ておりません|物件限り|新着で募集|保証会社|現在募集され|申込が入/;
export function pickupEditFeatures(ai: string, sent: string): string[] {
  const pl = (x: string) => lines(x).find((l) => /ピックアップ|お送りさせて|お調べ/.test(l)) ?? "";
  const sep = (x: string) => (pl(x).match(/[・、]/g) ?? []).length;
  const f: string[] = [];
  if (/ご案内させて/.test(sent) && !/ご案内させて/.test(ai)) f.push("内覧の誘いの1行を足した");
  if (sep(sent) < sep(ai)) f.push("ピックアップの1行の条件を減らした");
  if (sep(sent) > sep(ai)) f.push("ピックアップの1行の条件を増やした");
  if (/お待たせ|夜分遅く/.test(sent) && !/お待たせ|夜分遅く/.test(ai)) f.push("書き出しの挨拶を足した・変えた");
  if (STAFF_ONLY_RE.test(sent) && !STAFF_ONLY_RE.test(ai)) f.push("スタッフだけが知る事を足した（退去予定・募集・新着・保証会社）");
  if (/類似|お送り頂/.test(sent) && !/類似|お送り頂/.test(ai)) f.push("お客様が送った物件に触れた");
  if (/となります/.test(ai) && !/となります/.test(sent)) f.push("束の説明の行を消した");
  if (/となります/.test(sent) && !/となります/.test(ai)) f.push("束の説明の行を足した");
  if (/😌/.test(ai) && !/😌/.test(sent)) f.push("😌を外した");
  return f;
}

if (require.main === module) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "30")) || 30, type = arg("type", "property_send"), writer = arg("writer", "takeuchi");
  const since = new Date(Date.now() - days * 864e5).toISOString();
  // aix_usage_logs.generated_text は送った後の文（直した後）なので、AI の元の文は AixModal が直した時だけ残す ai_template_candidates（source=aix_edit・original_text）から取る
  const { data, error } = await sb.from("aix_usage_logs").select("conversation_id, generated_text, line_message_id, was_edited, sent_at").eq("aix_type", type).gte("sent_at", since).not("line_message_id", "is", null).limit(500);
  if (error) throw new Error(error.message);
  const { data: cands } = await sb.from("ai_template_candidates").select("conversation_id, original_text, template_text, created_at").eq("source", "aix_edit").eq("action_type", type).gte("created_at", since).limit(1000);
  const cs = (cands ?? []) as Array<{ conversation_id: string | null; original_text: string | null; template_text: string | null; created_at: string }>;
  const rows = ((data ?? []) as Array<{ conversation_id: string; generated_text: string | null; line_message_id: string; was_edited: boolean | null; sent_at: string }>).filter((r) => r.conversation_id !== YUMA_CONVERSATION_ID)
    .map((r) => {
      const c = cs.filter((x) => x.conversation_id === r.conversation_id && Math.abs(Date.parse(x.created_at) - Date.parse(r.sent_at)) <= 10 * 6e4)
        .sort((a, b) => Math.abs(Date.parse(a.created_at) - Date.parse(r.sent_at)) - Math.abs(Date.parse(b.created_at) - Date.parse(r.sent_at)))[0];
      return { ...r, generated_text: c?.original_text ?? null };
    });
  const ids = rows.map((r) => r.line_message_id);
  const msgs = new Map<string, { text: string | null; staff_writer: string | null }>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data: m } = await sb.from("messages").select("line_message_id, text, staff_writer").in("line_message_id", ids.slice(i, i + 100));
    for (const x of (m ?? []) as Array<{ line_message_id: string; text: string | null; staff_writer: string | null }>) msgs.set(x.line_message_id, x);
  }
  const tally = new Map<string, number>(); let n = 0, edited = 0, noAi = 0;
  for (const r of rows) {
    const m = msgs.get(r.line_message_id); if (!m || (writer !== "all" && m.staff_writer !== writer)) continue;
    n++; if (r.was_edited) edited++;
    if (!r.generated_text) { noAi++; continue; }
    const ks = editKinds(r.generated_text, m.text ?? "");
    for (const k of ks) tally.set(k, (tally.get(k) ?? 0) + 1);
    if (type === "property_send") for (const k of pickupEditFeatures(r.generated_text, m.text ?? "")) tally.set(`中身: ${k}`, (tally.get(`中身: ${k}`) ?? 0) + 1);
    if (process.argv.includes("--show")) console.log(r.conversation_id.slice(0, 6), ks.join("・"), "| AI:", (r.generated_text ?? "").replace(/\s+/g, " ").slice(0, 30), "| 送:", (m.text ?? "").replace(/\s+/g, " ").slice(0, 30));
  }
  console.log(`${type}（${days}日・書き手 ${writer}）: ${n}番・was_edited ${edited}・AI の文が無い ${noAi}`);
  for (const [k, c] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${c}`);
})().catch((e) => { console.error(e); process.exit(1); });
