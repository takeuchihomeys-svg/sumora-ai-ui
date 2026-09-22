// AIX の送信で「お世話になっております」が付いたのに、同じ日（JST）にそれより前のやり取りがあった物（読み取りのみ）
// 2026-09-22 竹内「お世話になっておりますの部分も今日お客さんとやりとりしているのに AIX で出てしまうことがある。
//   今日初めてのLINEだったらお世話になっておりますをつける／今日初めてじゃないときは使わない」
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-osewa-sameday.ts [DAYS=60]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const OSEWA_RE = /お世話になっております/;
const jstDay = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

async function main() {
  const days = Number(process.env.DAYS ?? 60);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }> = [];
  for (let p = 0; p < 40; p++) {
    const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof rows; rows.push(...r); if (r.length < 1000) break;
  }
  const by = new Map<string, typeof rows>();
  for (const m of rows) { if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }

  // 全スタッフ送信（手打ち／AIX）を「その日こちらの何通目か」「その日お客様と既にやり取りがあるか」で分ける
  type Cell = { n: number; osewa: number };
  const cell = new Map<string, Cell>();
  const add = (k: string, o: boolean) => { const c = cell.get(k) ?? { n: 0, osewa: 0 }; c.n++; if (o) c.osewa++; cell.set(k, c); };
  const examples: string[] = [];
  const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様)/g, "〈お客様〉").replace(/\s+/g, " ");
  for (const [cid, arr] of by) {
    let prevStaffText = "";
    arr.forEach((m, i) => {
      if (m.sender !== "staff") return;
      const t = (m.text ?? "").trim();
      if (!t || /^\s*(?:\[画像\]|\[動画\]|\[スタンプ\]|https?:\/\/\S+)\s*$/.test(t)) return;
      const day = jstDay(m.created_at);
      const before = arr.slice(0, i).filter((x) => jstDay(x.created_at) === day);
      // 同じ送信の画像・URL（数分前の [画像]）は「今日すでに送った」に数えない
      const MEDIA_RE = /^\s*(?:\[画像\]|\[動画\]|\[スタンプ\]|（室内イメージ）\s*)?(?:https?:\/\/\S+)?\s*$|^\s*\[画像\]/;
      const staffBefore = before.filter((x) => x.sender === "staff" && !(MEDIA_RE.test(x.text ?? "") && new Date(m.created_at).getTime() - new Date(x.created_at).getTime() < 10 * 60_000)).length;
      const custBefore = before.filter((x) => x.sender === "customer").length;
      const src = m.is_aix_generated ? "AIX" : "手打ち";
      const when = staffBefore > 0 ? "こちらが今日すでに送った後" : custBefore > 0 ? "今日お客様からだけ届いている（こちらは今日はじめて）" : "今日はじめてのやり取り";
      const o = OSEWA_RE.test(t.split("\n").slice(0, 2).join("\n"));
      add(`${src}｜${when}`, o);
      if (src === "AIX" && o && staffBefore > 0 && examples.length < 12) {
        const prev = [...before].reverse().find((x) => x.sender === "staff");
        examples.push(`会話${cid.slice(0, 8)} ${m.created_at.slice(5, 16)} 同じ日の前のこちら(${prev?.is_aix_generated ? "AIX" : "手打ち"} ${prev?.created_at.slice(11, 16)}):「${mask(prev?.text ?? "").slice(0, 40)}」→ AIX:「${mask(t).slice(0, 50)}」`);
      }
      prevStaffText = t;
    });
  }
  console.log(`=== 直近${days}日のこちらの送信（文のある通）: 冒頭2行に「お世話になっております」がある率 ===`);
  for (const [k, c] of [...cell.entries()].sort()) console.log(`   ${k.padEnd(44)} ${String(c.n).padStart(5)}通  ${pct(c.osewa, c.n)}（${c.osewa}通）`);
  console.log(`\n【AIX で、こちらが今日すでに送った後に付いた実例】`);
  for (const e of examples) console.log("  ", e);
}
main().catch((e) => { console.error(e); process.exit(1); });
