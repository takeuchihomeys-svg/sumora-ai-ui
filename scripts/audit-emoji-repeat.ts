// 同じ絵文字を1通の中で繰り返すか（読み取りのみ・LLM なし）
// 2026-10-01 竹内「同じ絵文字を2重で使っているが、このような形に実際していない。もう一つの絵文字を使うか、絵文字を省いている。状況によって異なる」
//   実物: YUMA 9:31 の物件オススメの2通目「…オススメ出来るお部屋となります😊！！\n\nお気に召されましたら…ご案内させて頂きます😊！！」
//
// ① スタッフの文（messages・sender=staff・AIX でない・YUMA とグループを除く・DAYS 日）で、文の終わり（！！・。）の数が2以上の通について
//    絵文字の付いた文の数（0/1/2+）と、2つ以上付いた通の絵文字が「全部同じ」か「違う物が混ざる」か
// ② AI の下書き（ai_reply_examples の ai_draft）と、それを直して送った文（sent_reply）で同じ数を並べる（AI の癖か）
// ③ 2通目（「お送りさせて頂きましたお部屋の中でも特に」「中でも特に」「オススメ出来るお部屋」）と締めの定型（お気に召されましたら／ご査収）だけで同じ数
// 実行: npx tsx --env-file=.env.local scripts/audit-emoji-repeat.ts   （DAYS=180・SHOW=8）
import { createClient } from "@supabase/supabase-js";
import { splitSentences } from "../app/lib/second-message-style";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 180);
const SHOW = Number(process.env.SHOW ?? 8);
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
const EMOJI_RE = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu;
const SECOND_RE = /中でも特に|オススメ出来るお部屋|オススメできるお部屋/;
const CLOSING_RE = /お気に召されましたら|ご査収/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;
async function pageAll(build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** 文ごとの絵文字（🌟の物件見出しは数えない＝見出しの印で文の飾りではない） */
function emojiBySentence(text: string): string[][] {
  return splitSentences(text)
    .filter((s) => !/^🌟/.test(s))
    .map((s) => [...s.matchAll(EMOJI_RE)].map((m) => m[0].replace(/️/g, "")));
}

type Kind = "none" | "one" | "same" | "mixed";
function classify(text: string): { kind: Kind; sentences: number; withEmoji: number; seq: string } | null {
  const by = emojiBySentence(text);
  const sentences = by.length;
  if (sentences < 2) return null;
  const withEmoji = by.filter((e) => e.length > 0).length;
  const firsts = by.filter((e) => e.length > 0).map((e) => e[0]);
  const kind: Kind = withEmoji === 0 ? "none" : withEmoji === 1 ? "one" : new Set(firsts).size === 1 ? "same" : "mixed";
  return { kind, sentences, withEmoji, seq: by.map((e) => e.join("") || "・").join(" ") };
}

function tally(label: string, texts: string[], show = 0) {
  const c: Record<Kind, number> = { none: 0, one: 0, same: 0, mixed: 0 };
  const ex: Record<Kind, string[]> = { none: [], one: [], same: [], mixed: [] };
  let n = 0;
  for (const t of texts) {
    const r = classify(t);
    if (!r) continue;
    n++;
    c[r.kind]++;
    if (ex[r.kind].length < show) ex[r.kind].push(`[${r.seq}] ${t.replace(/\s+/g, " ").slice(0, 150)}`);
  }
  const p = (x: number) => (n ? `${((x / n) * 100).toFixed(1)}%` : "-");
  const multi = c.same + c.mixed;
  console.log(`\n■ ${label}  文が2つ以上の通 ${n}`);
  console.log(`  絵文字なし ${c.none}（${p(c.none)}）／1文だけ ${c.one}（${p(c.one)}）／2文以上: 同じ ${c.same}（${p(c.same)}）・違う物が混ざる ${c.mixed}（${p(c.mixed)}）`);
  if (multi) console.log(`  2文以上に付けた通のうち 同じ絵文字だけ ${((c.same / multi) * 100).toFixed(1)}%`);
  if (show) for (const k of ["same", "mixed", "one"] as Kind[]) for (const e of ex[k]) console.log(`   ${k}: ${e}`);
  return { n, ...c };
}

async function main() {
  const msgs = await pageAll((f, t) => sb.from("messages").select("id, conversation_id, text, created_at")
    .eq("sender", "staff").eq("is_aix_generated", false).gte("created_at", since).neq("conversation_id", YUMA)
    .order("created_at", { ascending: true }).order("id", { ascending: true }).range(f, t));
  const texts = msgs.map((m) => String(m.text ?? "")).filter((t) => t && !/^\[画像\]$/.test(t) && !/https?:\/\//.test(t));
  console.log(`スタッフの文（AIX でない）${texts.length}通・${DAYS}日`);
  tally("① スタッフの文 全体", texts);
  tally("③ 2通目（オススメの後の一言）", texts.filter((t) => SECOND_RE.test(t)), SHOW);
  tally("③' 2通目で締めの定型あり", texts.filter((t) => SECOND_RE.test(t) && CLOSING_RE.test(t)), SHOW);

  // 締めの定型の文に絵文字がある時、その前の文はどうか（同じ／違う／無し）
  const before: Record<string, number> = {};
  const beforeEx: Record<string, string[]> = {};
  for (const t of texts.filter((x) => SECOND_RE.test(x) && CLOSING_RE.test(x))) {
    const sents = splitSentences(t).filter((s) => !/^🌟/.test(s));
    const ci = sents.findIndex((s) => CLOSING_RE.test(s));
    if (ci < 1) continue;
    const ce = [...sents[ci].matchAll(EMOJI_RE)].map((m) => m[0].replace(/️/g, ""))[0];
    const pe = [...sents[ci - 1].matchAll(EMOJI_RE)].map((m) => m[0].replace(/️/g, ""))[0];
    const ctype = /ご査収/.test(sents[ci]) ? "ご査収" : /申込|抑え/.test(sents[ci]) ? "申込誘導" : /案内|内覧/.test(sents[ci]) ? "内覧誘導" : "他";
    const gap = /\n\s*\n/.test(t.slice(t.indexOf(sents[ci - 1]) + sents[ci - 1].length, t.indexOf(sents[ci]))) ? "段落を空ける" : "続けて";
    const k = `${ctype}・${gap} 締め:${ce ?? "なし"} ／ 直前の文:${pe ? (pe === ce ? "同じ" : `違う(${pe})`) : "なし"}`;
    before[k] = (before[k] ?? 0) + 1;
    (beforeEx[k] ??= []).length < 3 && beforeEx[k].push(t.replace(/\s+/g, " ").slice(0, 160));
  }
  console.log("\n■ 2通目の締めの文と、その直前の文の絵文字");
  for (const [k, v] of Object.entries(before).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v}  ${k}`);
    for (const e of beforeEx[k]) console.log(`      ${e}`);
  }

  // ② AI の下書きと送った文
  const ex = await pageAll((f, t) => sb.from("ai_reply_examples").select("id, ai_draft, sent_reply, created_at")
    .gte("created_at", since).not("ai_draft", "is", null).not("sent_reply", "is", null)
    .order("created_at", { ascending: true }).order("id", { ascending: true }).range(f, t));
  tally("② AI の下書き", ex.map((r) => String(r.ai_draft)));
  tally("② 同じ組の送った文", ex.map((r) => String(r.sent_reply)));
  // 下書きが「同じ絵文字を2文以上」だった組で、送った文はどうしたか
  const fate: Record<string, number> = {};
  const fateEx: Record<string, string[]> = {};
  for (const r of ex) {
    const a = classify(String(r.ai_draft));
    if (!a || a.kind !== "same") continue;
    const s = classify(String(r.sent_reply));
    const k = s ? s.kind : "1文以下";
    fate[k] = (fate[k] ?? 0) + 1;
    (fateEx[k] ??= []).length < 3 && fateEx[k].push(`AI[${a.seq}] → 送[${s?.seq ?? ""}] ${String(r.sent_reply).replace(/\s+/g, " ").slice(0, 120)}`);
  }
  console.log("\n■ 下書きが同じ絵文字を2文以上 → 送った文");
  for (const [k, v] of Object.entries(fate).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v}  ${k}`);
    for (const e of fateEx[k]) console.log(`      ${e}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
