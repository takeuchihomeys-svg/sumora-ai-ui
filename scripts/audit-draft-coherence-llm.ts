// 下書きの「まとまり」を DeepSeek で採点（少数・読み取りだけ）— 2026-10-09 竹内「単語をつなげただけのような部分がたまにある」
//
// 下書き（AI）と竹内さんの実送信を混ぜて、どちらか伏せたまま 1〜5 で採点させる（5＝一つの文章として自然につながる）。
//   型: parts（部品を並べただけ・文同士がつながらない）／abrupt（唐突なつなぎ・話題が飛ぶ）／dup（同じ事の繰り返し）／
//       broken（文が途中で切れる・壊れた文）／stiff（決まり文句の積み重ね・機械的）／none
// 個人情報: 申込・契約・本人確認・収入の語を含む組は外す・名前と番号は maskPII で伏せる・お客様の発言は渡さない（返信の文だけ）。
// 実行: npx tsx --env-file=.env.local scripts/audit-draft-coherence-llm.ts [--days=30] [--n=60]
import { createClient } from "@supabase/supabase-js";
import { maskPII } from "../app/lib/pii-mask";
import { writerFromText } from "../app/lib/staff-writer";
import { messageSimilarity } from "../app/lib/phrase-shape";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) ?? "");
const DSK = (process.env.DEEPSEEK_API_KEY ?? "").trim();
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const days = Number(arg("days", "30")), N = Number(arg("n", "60"));
const POST_APPLY_RE = /申込|申し込み|契約|本人確認|免許証|マイナンバー|年収|勤務先|生年月日|審査/;
let inTok = 0, outTok = 0, calls = 0;

const PROMPT = `あなたは日本語の文章の編集者です。下は不動産会社のスタッフがお客様に送る LINE の返信の文です（書いた人は伏せています）。
それぞれについて「一つの文章として自然にまとまっているか」だけを採点してください（内容の正しさ・敬語の好みは見ない）。
- score: 1〜5（5＝文同士が自然につながり一つの文章として読める／3＝つながりの弱い所が1か所／1＝部品を並べただけ・壊れた文がある）
- type: parts（部品を並べただけ・文同士がつながらない）／abrupt（唐突なつなぎ・話題が飛ぶ）／dup（同じ事の繰り返し）／broken（文が途中で切れる・壊れた文）／stiff（決まり文句の積み重ねで機械的）／none
- where: 一番気になる箇所（原文から15字以内・無ければ空）
JSON の配列だけを返す: [{"id":"..","score":n,"type":"..","where":".."}]`;

async function grade(items: Array<{ id: string; text: string }>) {
  const body = items.map((x) => `### id=${x.id}\n${x.text}`).join("\n\n");
  const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${DSK}` },
    body: JSON.stringify({ model: "deepseek-v4-pro", max_tokens: 3000, temperature: 0, thinking: { type: "disabled" }, messages: [{ role: "system", content: PROMPT }, { role: "user", content: body }] }),
    signal: AbortSignal.timeout(180_000),
  });
  const j = await r.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens: number; completion_tokens: number } };
  calls++; inTok += j.usage?.prompt_tokens ?? 0; outTok += j.usage?.completion_tokens ?? 0;
  const t = String(j.choices?.[0]?.message?.content ?? "");
  const m = t.match(/\[[\s\S]*\]/);
  try { return JSON.parse(m ? m[0] : "[]") as Array<{ id: string; score: number; type: string; where: string }>; } catch { return []; }
}

async function main() {
  if (!DSK) throw new Error("DEEPSEEK_API_KEY がありません");
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data } = await sb.from("ai_reply_examples").select("id, ai_draft, sent_reply, was_ai_used, reply_context_snapshot, created_at")
    .eq("entry_source", "line_reply").gte("created_at", since).not("ai_draft", "is", null).order("created_at", { ascending: false }).limit(1500);
  const rows = ((data ?? []) as Array<Record<string, any>>).filter((r) => {
    const d = String(r.ai_draft ?? ""), s = String(r.sent_reply ?? "");
    return d.trim() && s.trim() && !POST_APPLY_RE.test(d + s) && writerFromText(s).writer === "takeuchi" && !/<<<FINAL/.test(d);
  });
  // そのまま送った組は採点しても同じ文になるので、直された組を多めに（半分ずつ）
  const edited = rows.filter((r) => String(r.ai_draft).trim() !== String(r.sent_reply).trim());
  const same = rows.filter((r) => String(r.ai_draft).trim() === String(r.sent_reply).trim());
  const pick = [...edited.slice(0, Math.ceil(N * 0.75)), ...same.slice(0, Math.floor(N * 0.25))];
  console.log(`材料: 竹内さんの送信と下書きの組 ${rows.length}（直された ${edited.length}・そのまま ${same.length}）→ 採点 ${pick.length}組`);
  const items: Array<{ id: string; text: string; who: "ai" | "human"; row: number }> = [];
  pick.forEach((r, i) => {
    items.push({ id: `a${i}`, text: maskPII(String(r.ai_draft)), who: "ai", row: i });
    if (String(r.ai_draft).trim() !== String(r.sent_reply).trim()) items.push({ id: `h${i}`, text: maskPII(String(r.sent_reply)), who: "human", row: i });
  });
  // 混ぜる（伏せる）
  const shuffled = [...items].sort((a, b) => (a.id.charCodeAt(1) * 7 + a.id.length * 13) % 11 - (b.id.charCodeAt(1) * 7 + b.id.length * 13) % 11 || (a.id < b.id ? -1 : 1));
  const ids = shuffled.map((x, k) => ({ ...x, gid: `t${k}` }));
  const scores = new Map<string, { score: number; type: string; where: string }>();
  for (let k = 0; k < ids.length; k += 12) {
    const batch = ids.slice(k, k + 12);
    const res = await grade(batch.map((x) => ({ id: x.gid, text: x.text })));
    for (const g of res) scores.set(g.id, g);
  }
  const ai = ids.filter((x) => x.who === "ai"), hu = ids.filter((x) => x.who === "human");
  const avg = (xs: typeof ids) => { const v = xs.map((x) => scores.get(x.gid)?.score).filter((n): n is number => typeof n === "number"); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : "-"; };
  const low = (xs: typeof ids) => xs.filter((x) => (scores.get(x.gid)?.score ?? 5) <= 3).length;
  console.log(`\n=== まとまりの点（1〜5）===`);
  console.log(`  AI の下書き ${ai.length}: 平均 ${avg(ai)}・3以下 ${low(ai)}`);
  console.log(`  竹内さんの送信 ${hu.length}: 平均 ${avg(hu)}・3以下 ${low(hu)}`);
  const typeCount = (xs: typeof ids) => { const m = new Map<string, number>(); for (const x of xs) { const t = scores.get(x.gid)?.type ?? "?"; if ((scores.get(x.gid)?.score ?? 5) <= 3) m.set(t, (m.get(t) ?? 0) + 1); } return [...m.entries()].map(([k, v]) => `${k} ${v}`).join("・"); };
  console.log(`  3以下の型: AI ${typeCount(ai)} ／ 人 ${typeCount(hu)}`);
  // 出所の手掛かりと近さ
  const cue = (r: Record<string, any>) => {
    const s = r.reply_context_snapshot ?? {};
    const out: string[] = [];
    if ((s.postprocess?.gateEdits ?? []).length) out.push("ゲート");
    if ((s.preRevisionCodes ?? []).length) out.push("最終チェックの指摘");
    if (/最大限割引させて頂き/.test(String(r.ai_draft))) out.push("初期費用の一文");
    return out.length ? out.join("+") : "手掛かりなし";
  };
  const byCue = new Map<string, { n: number; low: number; sum: number; sims: number[] }>();
  for (const x of ai) {
    const r = pick[x.row]; const sc = scores.get(x.gid)?.score; if (typeof sc !== "number") continue;
    const k = cue(r); const v = byCue.get(k) ?? { n: 0, low: 0, sum: 0, sims: [] };
    v.n++; v.sum += sc; if (sc <= 3) v.low++; v.sims.push(messageSimilarity(String(r.ai_draft), String(r.sent_reply))); byCue.set(k, v);
  }
  console.log(`\n=== 手掛かり別（AI の下書き）===`);
  for (const [k, v] of byCue) console.log(`  ${k}: ${v.n}件 平均 ${(v.sum / v.n).toFixed(2)}・3以下 ${v.low}`);
  const lowSims: number[] = [], hiSims: number[] = [];
  for (const x of ai) { const r = pick[x.row]; const sc = scores.get(x.gid)?.score ?? 5; (sc <= 3 ? lowSims : hiSims).push(messageSimilarity(String(r.ai_draft), String(r.sent_reply))); }
  const med = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)].toFixed(3) : "-"; };
  console.log(`\n=== 近さ（竹内さんの送信へ）: まとまり3以下 ${lowSims.length}件 中央値 ${med(lowSims)} ／ 4以上 ${hiSims.length}件 ${med(hiSims)} ===`);
  console.log(`\n=== AI の下書きで3以下の実例（伏せて・最大8件）===`);
  for (const x of ai.filter((x) => (scores.get(x.gid)?.score ?? 5) <= 3).slice(0, 8)) {
    const g = scores.get(x.gid)!; const r = pick[x.row];
    console.log(`  - [${g.score}・${g.type}・${cue(r)}] 「${g.where}」\n      下書き: ${x.text.replace(/\n/g, " ／ ").slice(0, 260)}\n      竹内さん: ${maskPII(String(r.sent_reply)).replace(/\n/g, " ／ ").slice(0, 200)}`);
  }
  const cost = inTok / 1e6 * 0.55 + outTok / 1e6 * 1.98;
  console.log(`\nmodel=deepseek-v4-pro 回数=${calls} 入力=${inTok} 出力=${outTok} 費用≈$${cost.toFixed(3)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
