// scripts/owner-base-nightly.ts — 竹内さんの土台の毎晩の取りこぼしの網（作業員9・11/11・LLM なし・DB は読むだけ）
//
// 竹内さんの決定（11/11・KB P1）「竹内から LINE で要望はいったとき、そこも含めて今後ブレインの統括に学習されていくようにもする」・KB 60931c54（竹内さんの土台）。
//   その日のセッションの記録（~/.claude/projects の sumora-ai-ui と screening-admin のフォルダの jsonl）から竹内さん本人の発言
//   （打った文字・画像の数・<pasted_content>・選択式の答え）を拾い、設計知見（現行の行）と記憶の feedback に文字の重なりで突き合わせ、
//   まだ無さそうな要望を「入れる案」の下書きとして .claude/exam-cache/owner-base-inbox/<JST日>.json に置く（git に入れない）。
//   最後の1組（番・AI がした事・なぜ・しない）は朝の拾い上げで人が読んで埋める＝ここでは機械で作らない。記録の生の文は外の LLM に送らない。
// 実行: npx tsx --env-file=.env.local scripts/owner-base-nightly.ts [--since=<ISO>] [--dry]
//   前回の続き: owner-base-inbox/state.json の lastTs（無ければ 24時間前から）
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const DRY = process.argv.includes("--dry");
// 置き場は本体の exam-cache（作業ツリーから流しても同じ所）。EXAM_CACHE_DIR で変えられる
const ROOT = join(process.env.EXAM_CACHE_DIR ?? join(homedir(), "sumora-ai-ui", ".claude", "exam-cache"), "owner-base-inbox");
const PROJECTS = join(homedir(), ".claude", "projects");
const DIRS = ["C--Users-------sumora-ai-ui", "C--Users-------sumora-screening-admin"];
const MEMORY = join(PROJECTS, "c--Users-------sumora-ai-ui", "memory");

import { shouldPick, bigrams, cover } from "./owner-base-nightly-pick";

export type InboxItem = {
  at: string; session: string; uuid: string | null; images: number; pasted: boolean; choice: boolean;
  words: string; prevA: string; nextA: string;
  cand: Array<{ id8: string; cover: number; title: string }>; memCand: Array<{ file: string; cover: number }>;
  verdict: "既にある" | "入れる案";
  // 朝に人が埋める（1回目の組と同じ列）
  scene: string; turn: string; ai: string; why: string; dont: string;
};

async function readNew(file: string, sinceIso: string): Promise<Array<{ at: string; uuid: string | null; text: string; images: number; prevA: string; nextA: string }>> {
  const out: Array<{ at: string; uuid: string | null; text: string; images: number; prevA: string; nextA: string }> = [];
  let prevA = ""; let pend: (typeof out)[number] | null = null;
  const rl = createInterface({ input: createReadStream(file, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length < 20 || (!line.includes('"type":"assistant"') && !line.includes('"type":"user"'))) continue;
    let o: { type?: string; isSidechain?: boolean; isMeta?: boolean; timestamp?: string; uuid?: string; message?: { content?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    if (o.type === "assistant") {
      const c = o.message?.content; if (!Array.isArray(c)) continue;
      const t = (c as Array<{ type: string; text?: string }>).filter((x) => x.type === "text").map((x) => x.text ?? "").join("\n").trim();
      if (t) { prevA = t.slice(0, 300); if (pend && !pend.nextA) { pend.nextA = t.slice(0, 900); out.push(pend); pend = null; } }
      continue;
    }
    if (o.type !== "user" || o.isMeta || !o.timestamp || o.timestamp <= sinceIso) continue;
    const c = o.message?.content; let text = "", images = 0, tool = false;
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) for (const x of c as Array<{ type: string; text?: string }>) { if (x.type === "text") text += (text ? "\n" : "") + (x.text ?? ""); else if (x.type === "image") images++; else if (x.type === "tool_result") tool = true; }
    if (tool) continue;
    if (pend) out.push(pend);
    pend = { at: o.timestamp, uuid: o.uuid ?? null, text: text.slice(0, 4000), images, prevA, nextA: "" };
  }
  if (pend) out.push(pend);
  return out;
}

(async () => {
  mkdirSync(ROOT, { recursive: true });
  const stateF = join(ROOT, "state.json");
  const state = existsSync(stateF) ? (JSON.parse(readFileSync(stateF, "utf8")) as { lastTs?: string }) : {};
  const since = arg("since") ?? state.lastTs ?? new Date(Date.now() - 24 * 3600_000).toISOString();
  // 1) その日に更新された記録だけ
  const files: Array<{ f: string; s: string }> = [];
  for (const d of DIRS) {
    const dir = join(PROJECTS, d); if (!existsSync(dir)) continue;
    for (const n of readdirSync(dir)) if (n.endsWith(".jsonl") && statSync(join(dir, n)).mtime.toISOString() > since) files.push({ f: join(dir, n), s: n.slice(0, 8) });
  }
  const raw: Array<{ at: string; uuid: string | null; text: string; images: number; prevA: string; nextA: string; s: string }> = [];
  for (const { f, s } of files) for (const m of await readNew(f, since)) raw.push({ ...m, s });
  const seen = new Set<string>(); const msgs = raw.filter((m) => { const k = m.uuid ?? `${m.at}|${m.text.slice(0, 40)}`; if (seen.has(k)) return false; seen.add(k); return true; });
  // 2) 設計知見（現行の題＋本文）と記憶の feedback
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const kb: Array<{ id: string; title: string; b: Set<string> }> = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await sb.from("system_design_thinking").select("id,title,insight").eq("is_current", true).order("id").range(from, from + 499);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ id: string; title: string; insight: string | null }>) kb.push({ id: r.id, title: r.title, b: bigrams(`${r.title}${r.insight ?? ""}`) });
    if (!data || data.length < 500) break;
  }
  const mem = existsSync(MEMORY) ? readdirSync(MEMORY).filter((n) => /^(feedback|fact)_.*\.md$/.test(n)).map((n) => ({ file: n, b: bigrams(readFileSync(join(MEMORY, n), "utf8")) })) : [];
  // 3) 拾う・突き合わせる
  const items: InboxItem[] = [];
  for (const m of msgs) {
    const p = shouldPick(m.text, m.images); if (!p.pick) continue;
    const words = m.text.replace(/<\/?pasted_content[^>]*>/g, "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim().slice(0, 1500);
    const q = bigrams(words.slice(0, 500));
    const cand = kb.map((r) => ({ id8: r.id.slice(0, 8), cover: Math.round(cover(q, r.b) * 100) / 100, title: r.title.slice(0, 70) })).sort((a, b) => b.cover - a.cover).slice(0, 3);
    const memCand = mem.map((x) => ({ file: x.file, cover: Math.round(cover(q, x.b) * 100) / 100 })).sort((a, b) => b.cover - a.cover).slice(0, 2);
    items.push({ at: m.at, session: m.s, uuid: m.uuid, images: m.images, pasted: p.pasted, choice: p.choice, words, prevA: m.prevA, nextA: m.nextA, cand, memCand,
      verdict: (cand[0]?.cover ?? 0) >= 0.55 ? "既にある" : "入れる案", scene: "", turn: "", ai: "", why: "", dont: "" });
  }
  const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const lastTs = msgs.reduce((a, m) => (m.at > a ? m.at : a), since);
  const summary = { day, since, lastTs, files: files.length, said: msgs.length, picked: items.length, toAdd: items.filter((i) => i.verdict === "入れる案").length, withImages: items.filter((i) => i.images).length };
  console.log(JSON.stringify({ tag: "owner-base-nightly", ...summary }));
  if (DRY) return;
  writeFileSync(join(ROOT, `${day}.json`), JSON.stringify({ ...summary, items }, null, 1));
  writeFileSync(stateF, JSON.stringify({ lastTs, at: new Date().toISOString() }, null, 1));
})().catch((e) => { console.error(e); process.exitCode = 1; });
