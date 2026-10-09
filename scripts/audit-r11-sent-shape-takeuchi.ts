// scripts/audit-r11-sent-shape-takeuchi.ts — 11巡目: app/lib/sent-shape.ts の率・形（何卒・改行・空行・1行の字数・場面の何卒/絵文字）を
//   竹内さんの手打ち（messages.staff_writer='takeuchi'・AIX でない）だけで測り直す（読むだけ・LLM なし）。
//   旧の数字は従業員の送信・AIX の送信・定型の物件カードが混ざった 12,093通（書き手 B は何卒 2%・呼び名の後で改行 85〜92%）。
//   出す物: sent-shape.ts の TAKEUCHI_SHAPE に貼る JSON ＋ 文の数ごとの空行の率・条件の返信の行数/文の数/字数の幅
// 実行: npx tsx --env-file=.env.local scripts/audit-r11-sent-shape-takeuchi.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { classifySentKind, customerSceneOf, type SentKind, type CustomerScene } from "../app/lib/sent-shape";
import { isShortAckOnly } from "../app/lib/previous-send-note";
import { isConditionFormMessage } from "../app/lib/reply-context";
import { sentencesOf } from "../app/lib/text-diff-types";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "180"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const med = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const q = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const r1 = (x: number) => Math.round(x * 10) / 10;
const NANI = /何卒(?:よろしく|宜しく)お願い(?:致します|いたします|します)/;
const EMO = /\p{Extended_Pictographic}/u;
(async () => {
  const msgs: Array<{ conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null; staff_writer: string | null }> = [];
  for (let i = 0; ; i += 1000) { const r = await sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated, staff_writer").gte("created_at", new Date(Date.now() - DAYS * 864e5).toISOString()).order("created_at").order("id").range(i, i + 999); if (r.error) throw r.error; msgs.push(...(r.data ?? []) as typeof msgs); if ((r.data ?? []).length < 1000) break; }
  const by = new Map<string, typeof msgs>(); for (const m of msgs) { if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  const kinds = new Map<SentKind, { n: number; nani: number; lines: number[]; blanks: number[]; chars: number[] }>();
  const allLineChars: number[] = []; let multi = 0, multiBlank = 0, naniN = 0, naniLast = 0, total = 0;
  const bySent = new Map<string, [number, number]>();
  const scene = new Map<CustomerScene, { n: number; nani: number; emoji: number }>();
  const cond = { lines: [] as number[], sents: [] as number[], chars: [] as number[] };
  let firstForm = { n: 0, nani: 0, emoji: 0 };
  for (const [cid, list] of by) {
    if (isTestConversation(cid)) continue;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "staff" || m.is_aix_generated || m.staff_writer !== "takeuchi") continue;
      const t = (m.text ?? "").replace(/\r/g, "").trim(); if (!t) continue;
      total++;
      const k = classifySentKind(t);
      const ls = t.split("\n").map((l) => l.trim()).filter(Boolean);
      const blanks = (t.match(/\n[ \t　]*\n/g) ?? []).length;
      const v = kinds.get(k) ?? { n: 0, nani: 0, lines: [], blanks: [], chars: [] }; v.n++; if (NANI.test(t)) v.nani++; v.lines.push(ls.length); v.blanks.push(blanks); for (const l of ls) v.chars.push(l.replace(/\s/g, "").length); kinds.set(k, v);
      if (k !== "画像・URLのみ" && k !== "物件カード" && k !== "見積書") {
        for (const l of ls) allLineChars.push(l.replace(/\s/g, "").length);
        if (ls.length >= 2) { multi++; if (blanks) multiBlank++; }
        const ns = sentencesOf(t).length; const key = ns <= 2 ? "1〜2文" : ns <= 4 ? "3〜4文" : ns <= 6 ? "5〜6文" : "7文以上";
        const c = bySent.get(key) ?? [0, 0]; c[1]++; if (blanks) c[0]++; bySent.set(key, c);
      }
      if (NANI.test(t)) { naniN++; if (NANI.test(ls[ls.length - 1] ?? "")) naniLast++; }
      // お客様の発言の場面（返事のまとまりの最初の通だけ）
      if (i > 0 && list[i - 1].sender === "customer") {
        let j = i - 1; const c: string[] = []; while (j >= 0 && list[j].sender === "customer") { c.unshift(list[j].text ?? ""); j--; }
        const sc = customerSceneOf(c.join("\n"), { isConditionForm: isConditionFormMessage, isShortAck: isShortAckOnly });
        const s = scene.get(sc) ?? { n: 0, nani: 0, emoji: 0 }; s.n++; if (NANI.test(t)) s.nani++; if (EMO.test(t)) s.emoji++; scene.set(sc, s);
        if (sc === "条件フォーム受領" || sc === "条件提示") { cond.lines.push(ls.length); cond.sents.push(sentencesOf(t).length); cond.chars.push(t.replace(/\s/g, "").length); }
        if (sc === "条件フォーム受領" && !list.slice(0, i).some((x) => x.sender === "staff")) { firstForm.n++; if (NANI.test(t)) firstForm.nani++; if (EMO.test(t)) firstForm.emoji++; }
      }
    }
  }
  const out = {
    days: DAYS, total,
    nanitozoRate: Object.fromEntries([...kinds].map(([k, v]) => [k, r1((100 * v.nani) / v.n)])),
    nanitozoN: Object.fromEntries([...kinds].map(([k, v]) => [k, v.n])),
    shape: Object.fromEntries([...kinds].map(([k, v]) => [k, { lines: med(v.lines), blanks: med(v.blanks), lineChars: med(v.chars) }])),
    lineCharsMedian: med(allLineChars), lineCharsP90: q(allLineChars, 0.9),
    blankLineRate: r1((100 * multiBlank) / Math.max(1, multi)),
    nanitozoLastLineRate: r1((100 * naniLast) / Math.max(1, naniN)), nanitozoAll: r1((100 * naniN) / Math.max(1, total)),
    blankBySentences: Object.fromEntries([...bySent].map(([k, v]) => [k, `${Math.round((100 * v[0]) / v[1])}% (${v[1]})`])),
    sceneStyle: Object.fromEntries([...scene].map(([k, v]) => [k, { n: v.n, nanitozo: r1((100 * v.nani) / v.n), emoji: r1((100 * v.emoji) / v.n) }])),
    firstContactForm: { n: firstForm.n, nanitozo: r1((100 * firstForm.nani) / Math.max(1, firstForm.n)), emoji: r1((100 * firstForm.emoji) / Math.max(1, firstForm.n)) },
    conditionsReply: { lines: [q(cond.lines, 0.1), med(cond.lines), q(cond.lines, 0.9)], sentences: [q(cond.sents, 0.1), med(cond.sents), q(cond.sents, 0.9)], chars: [q(cond.chars, 0.1), med(cond.chars), q(cond.chars, 0.9)], n: cond.lines.length },
  };
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exitCode = 1; });
