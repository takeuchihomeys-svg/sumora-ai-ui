// scripts/audit-aix-draft-vs-sent.ts
// AIX の AI の下書き（ai_reply_examples.ai_draft）と、スタッフが実際に送った文（sent_reply）を AIX の種類ごとに並べて、
// 「どれだけ・どこを・どう直しているか」を数える（読むだけ・LLM なし・費用0・DB に書かない）。
//
// 2026-10-06 竹内「AIXテンプレートのズレの問題。質がかなり低い。ちゃんと実際に送っている文を見てズレに築く必要がある。
//   実際のLINEと比べて根本的にずれている部分をみつけて改善するようにする。足りていない部分あるか」
//
// ■ 材料: ai_reply_examples の entry_source='aix_action'（AixModal の runLearning が 送った文＋AI の下書き を保存）・ai_draft がある行
//   YUMA（テスト用）は外す。同じ会話・同じ送った文の重複は1つに。
// ■ 出す物（種類＝aix_action ごと）
//   ・組の数・そのまま送った率（空白・絵文字を除いて同じ）・文字の近さ（2文字組の Dice）・長さ（送った÷下書き）
//   ・行: 下書きの行のうち送った文に残った率・消された行の型・足された行の型（数字→#・〇〇さん に伏せて数える）
//   ・最初の行・最後の行（締め）が変わった率
//   ・言い回しの語の出方（下書き vs 送った）: 「AI くさい」候補の語の率の差
//   ・時期（直近14日 vs それ以前）
// ■ 個人情報: 名前（〜さん／様）・電話・メール・数字を伏せた行だけ出す。会話 ID は出さない
//
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-draft-vs-sent.ts [--days=180 | --since=2026-10-02] [--type=property_send] [--show=8] [--out=path.json]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "180"), 10);
const SHOW = parseInt(String(args.show ?? "8"), 10);
const ONLY = args.type ? String(args.type) : null;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "-");
async function all(build: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 1000): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 80; p++) {
    const { data, error } = await build(p * page, p * page + page - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < page) break;
  }
  return out;
}

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const norm = (s: string) => String(s ?? "").replace(EMOJI, "").replace(/[\s　]+/g, "").trim();
/** 伏せた行（型）: 名前・電話・メール・URL・数字・物件名らしい先頭の🌟行 */
export function maskLine(l: string): string {
  return String(l ?? "")
    .replace(EMOJI, "")
    .replace(/https?:\/\/\S+/g, "<URL>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<MAIL>")
    .replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "<TEL>")
    .replace(/[^\s、。！!？?・「」『』（）()]{1,12}(さん|様|さま)/g, "〇〇$1")
    .replace(/[0-9０-９][0-9０-９,，.．]*/g, "#")
    .replace(/[\s　]+/g, " ")
    .trim();
}
const lines = (s: string) => String(s ?? "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
function dice(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x && !y) return 1; if (!x || !y) return 0;
  const bg = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const A = bg(x), B = bg(y); let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v; for (const v of B.values()) nb += v;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0);
  return na + nb ? (2 * inter) / (na + nb) : 1;
}
/** 行が相手の文に「残った」か（行の近さ 0.8 以上の行が相手にある） */
const kept = (l: string, other: string[]) => other.some((o) => norm(o) === norm(l) || dice(o, l) >= 0.8);

// AI くさい候補の語（下書きと送った文で率を比べる。言い回しの決めつけはしない＝率の差だけ出す）
const PHRASES: Array<[string, RegExp]> = [
  ["お客様", /お客様/], ["ございます", /ございます/], ["させて頂きます", /させて(頂|いただ)きます/], ["ぜひ", /ぜひ|是非/],
  ["！！", /！！|!!/], ["😊", /😊/], ["😌", /😌/], ["✨", /✨/], ["🌟", /🌟/], ["かしこまりました", /かしこまりました/],
  ["ご査収", /ご査収/], ["ご案内させて", /ご案内させて/], ["お気軽に", /お気軽に/], ["お気に召され", /お気に召され/], ["何卒", /何卒/],
  ["かなり", /かなり/], ["オススメ", /オススメ|おすすめ|お勧め/], ["ご検討", /ご検討/], ["ご不明", /ご不明/], ["お待ちしております", /お待ちして(おり|い)ます/],
  ["となります", /となります/], ["でございます", /でございます/], ["弊社", /弊社/], ["〜ので", /ので/], ["箇条書き・", /^・/m],
  ["（オススメポイント）", /オススメポイント/], ["改行の数", /\n\n/],
];

(async () => {
  const since = args.since ? new Date(String(args.since)).toISOString() : new Date(Date.now() - DAYS * 864e5).toISOString();
  const rows = (await all((a, b) => {
    let q = sb.from("ai_reply_examples").select("id, conversation_id, aix_action, entry_source, ai_draft, sent_reply, created_at, ai_similarity")
      .eq("entry_source", String(args.source ?? "aix_action")).not("ai_draft", "is", null).gte("created_at", since);
    if (ONLY) q = q.eq("aix_action", ONLY);
    return q.order("id").range(a, b) as never;
  })).filter((r) => r.conversation_id !== YUMA_CONVERSATION_ID && String(r.ai_draft ?? "").trim() && String(r.sent_reply ?? "").trim());
  // 重複（同じ会話・同じ送った文）
  const seen = new Set<string>();
  const pairs = rows.filter((r) => { const k = `${r.conversation_id}#${norm(r.sent_reply)}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const byType = new Map<string, Row[]>();
  for (const r of pairs) { const k = String(r.aix_action); if (!byType.has(k)) byType.set(k, []); byType.get(k)!.push(r); }
  const recentCut = Date.now() - 14 * 864e5;
  const out: Row = { days: DAYS, types: {} };
  console.log(`=== AIX の下書き vs 送った文（${DAYS}日・組 ${pairs.length}・種類 ${byType.size}）===`);
  console.log(`種類                          組   そのまま  近さ  長さ比  行が残る  最初の行変更  最後の行変更 | 直近14日: 組 そのまま 近さ`);
  const summary: Row[] = [];
  for (const [t, xs] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
    if (xs.length < 5) continue;
    let same = 0, sim = 0, lenR = 0, keptR = 0, firstCh = 0, lastCh = 0;
    const removed = new Map<string, number>(), added = new Map<string, number>();
    const phraseD: Record<string, [number, number]> = {};
    for (const r of xs) {
      const d = String(r.ai_draft), s = String(r.sent_reply);
      if (norm(d) === norm(s)) same++;
      sim += dice(d, s);
      lenR += norm(s).length / Math.max(1, norm(d).length);
      const dl = lines(d), sl = lines(s);
      const k = dl.filter((l) => kept(l, sl)).length; keptR += dl.length ? k / dl.length : 1;
      if (dl[0] && sl[0] && !(norm(dl[0]) === norm(sl[0]) || dice(dl[0], sl[0]) >= 0.8)) firstCh++;
      const dLast = dl.at(-1), sLast = sl.at(-1);
      if (dLast && sLast && !(norm(dLast) === norm(sLast) || dice(dLast, sLast) >= 0.8)) lastCh++;
      for (const l of dl) if (!kept(l, sl)) { const m = maskLine(l); if (m.length >= 4) removed.set(m, (removed.get(m) ?? 0) + 1); }
      for (const l of sl) if (!kept(l, dl)) { const m = maskLine(l); if (m.length >= 4) added.set(m, (added.get(m) ?? 0) + 1); }
      for (const [p, re] of PHRASES) { phraseD[p] ??= [0, 0]; if (re.test(d)) phraseD[p][0]++; if (re.test(s)) phraseD[p][1]++; }
    }
    const n = xs.length;
    const rec = xs.filter((r) => Date.parse(r.created_at) >= recentCut);
    const rSame = rec.filter((r) => norm(r.ai_draft) === norm(r.sent_reply)).length, rSim = rec.reduce((a, r) => a + dice(r.ai_draft, r.sent_reply), 0);
    const row = { type: t, n, same: same / n, sim: sim / n, lenRatio: lenR / n, keptLines: keptR / n, firstChanged: firstCh / n, lastChanged: lastCh / n, recent: { n: rec.length, same: rec.length ? rSame / rec.length : null, sim: rec.length ? rSim / rec.length : null } };
    summary.push(row);
    console.log(`${t.padEnd(30)}${String(n).padStart(4)}  ${pct(row.same).padStart(5)}  ${row.sim.toFixed(2)}  ${row.lenRatio.toFixed(2)}   ${pct(row.keptLines).padStart(5)}     ${pct(row.firstChanged).padStart(5)}        ${pct(row.lastChanged).padStart(5)}   | ${String(rec.length).padStart(3)} ${pct(row.recent.same ?? NaN).padStart(5)} ${row.recent.sim == null ? "-" : row.recent.sim.toFixed(2)}`);
    const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, SHOW);
    (out.types as Row)[t] = { ...row, removed: top(removed), added: top(added), phrases: phraseD };
  }
  // 種類ごとの詳細
  for (const s of summary) {
    const d = (out.types as Row)[s.type];
    console.log(`\n── ${s.type}（${s.n}組）`);
    console.log(`  消された行（型・回数）:`); for (const [l, c] of d.removed) console.log(`    ${String(c).padStart(3)} ${l.slice(0, 90)}`);
    console.log(`  足された行（型・回数）:`); for (const [l, c] of d.added) console.log(`    ${String(c).padStart(3)} ${l.slice(0, 90)}`);
    const ph = Object.entries(d.phrases as Record<string, [number, number]>).filter(([, [a, b]]) => Math.abs(a - b) >= Math.max(3, s.n * 0.1)).map(([p, [a, b]]) => `${p} 下書き${pct(a / s.n)}→送った${pct(b / s.n)}`);
    if (ph.length) console.log(`  語の差（下書き→送った）: ${ph.join("・")}`);
  }
  if (args.out) writeFileSync(String(args.out), JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
