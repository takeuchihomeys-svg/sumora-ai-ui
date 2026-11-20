// scripts/audit-off-pattern.ts — 臨機応変の土台（#158）A1・A4・A5 の数え（読むだけ・LLM を呼ばない・費用0）
//
// 2026-11-21 作業員N（統括役の割り振り・竹内さん 11/15「臨機応変な対応の土台」・memory/foundation_flex_trust_1121.md）
//   A1: 場面の網に当たらない番（返信の場面が「その他」・場面の印が空・ブレインの場面 other）と、語の場面とブレインの場面が食い違う番の割合
//   A4: その番でスタッフがどう返したか（AIX の種類／聞き返し／電話／事実で答えた・受けた）を決まった語で分ける
//   A5: その番と普段の番で、下書きとスタッフの一致（line_watch_turns.verdict）の割合を比べる（型外の番だけ外れが多い＝決まりに無理に当てている疑い）
// 読む表: line_watch_turns だけ（お客様の文・名前は読まない・出さない）。DB を読むので 22時〜8時に1本だけ流す。
// 実行: npx tsx --env-file=.env.local scripts/audit-off-pattern.ts [--days=30] [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

/** 語の場面（scene_key の「返信:〇〇」の〇〇）→ ブレインの場面（kb.scene）の対応。対応の無い組を食い違いと数える */
export const WORD_TO_BRAIN: Record<string, string[]> = {
  "短い了承・お礼": ["ack"],
  "検討中": ["considering"],
  "質問": ["question"],
  "条件提示": ["conditions"],
  "物件を送ってきた": ["property_share"],
  "初期費用・見積": ["cost"],
  "内覧・日程": ["viewing"],
  "申込・審査": ["apply"],
};

export type StaffMove = "aix" | "phone" | "ask_back" | "answer" | "none";
/** スタッフの番の一手を決まった語で分ける（純関数）。AIX があれば AIX（電話の AIX は phone）・文が問いで終われば聞き返し・文があれば答え */
export function staffMoveOf(texts: Array<{ text?: string }> | null, aix: Array<{ aix_type?: string }> | null): StaffMove {
  const types = (aix ?? []).map((a) => String(a.aix_type ?? ""));
  if (types.some((t) => /phone|call|電話/.test(t))) return "phone";
  if (types.length) return "aix";
  const body = (texts ?? []).map((t) => String(t.text ?? "")).join("\n").trim();
  if (!body) return "none";
  const lines = body.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const askLine = lines.some((l) => /(?:でしょうか|ますか|ですか|ませんか)[？?！!😊😌🌟✨\s]*$/.test(l));
  return askLine ? "ask_back" : "answer";
}

export type OffKind = "scene_other" | "scene_empty" | "brain_other" | "word_brain_mismatch" | null;
export function offKindOf(sceneKey: string | null, kbScene: string | null): OffKind {
  const sk = String(sceneKey ?? "");
  if (!sk) return "scene_empty";
  const word = sk.startsWith("返信:") ? sk.slice(3) : null;
  if (word === "その他") return "scene_other";
  if (kbScene === "other") return "brain_other";
  if (word && kbScene && WORD_TO_BRAIN[word] && !WORD_TO_BRAIN[word].includes(kbScene)) return "word_brain_mismatch";
  return null;
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const days = Number(arg("days", "30")) || 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  type Row = { id: number; scene_key: string | null; kbscene: string | null; brain_reply_mode: string | null; staff_texts: Array<{ text?: string }> | null; staff_aix: Array<{ aix_type?: string }> | null; verdict: string | null; reason: string | null };
  const rows: Row[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await sb.from("line_watch_turns")
      .select("id,scene_key,kbscene:materials->brain->kb->>scene,brain_reply_mode,staff_texts,staff_aix,verdict,reason:verdict_detail->>reason")
      .gte("customer_turn_at", since).not("verdict", "is", null).neq("verdict", "na")
      .order("id").range(from, from + 499);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as unknown as Row[]));
    if ((data ?? []).length < 500) break;
  }
  const isMatch = (v: string | null) => v === "same" || v === "same_meaning";
  const groups = new Map<string, { n: number; match: number; moves: Record<string, number>; aixTypes: Record<string, number>; sample: number[] }>();
  const add = (k: string, r: Row) => {
    const g = groups.get(k) ?? { n: 0, match: 0, moves: {}, aixTypes: {}, sample: [] };
    g.n++; if (isMatch(r.verdict)) g.match++;
    const mv = staffMoveOf(r.staff_texts, r.staff_aix); g.moves[mv] = (g.moves[mv] ?? 0) + 1;
    for (const a of r.staff_aix ?? []) { const t = String(a.aix_type ?? "?"); g.aixTypes[t] = (g.aixTypes[t] ?? 0) + 1; }
    if (g.sample.length < 8) g.sample.push(r.id);
    groups.set(k, g);
  };
  const verdicts: Record<string, number> = {};
  for (const r of rows) {
    verdicts[r.verdict ?? "?"] = (verdicts[r.verdict ?? "?"] ?? 0) + 1;
    const off = offKindOf(r.scene_key, r.kbscene);
    add(off ?? "normal", r);
    if (off === "word_brain_mismatch") add(`mismatch:${r.scene_key}→${r.kbscene}`, r);
  }
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "-");
  console.log(`臨機応変の土台 A1・A4・A5（${days}日・見張りの番 ${rows.length}・判定 ${JSON.stringify(verdicts)}）`);
  const order = ["normal", "scene_empty", "scene_other", "brain_other", "word_brain_mismatch"];
  for (const k of [...order, ...[...groups.keys()].filter((k) => k.startsWith("mismatch:")).sort((a, b) => groups.get(b)!.n - groups.get(a)!.n).slice(0, 12)]) {
    const g = groups.get(k); if (!g) continue;
    console.log(`- ${k}: ${g.n}番（${pct(g.n, rows.length)}）・一致 ${pct(g.match, g.n)}・スタッフの一手 ${Object.entries(g.moves).map(([m, c]) => `${m} ${c}`).join(" ")}・AIX ${Object.entries(g.aixTypes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, c]) => `${t} ${c}`).join(" ")}・例 ${g.sample.join(",")}`);
  }
  const out = arg("out");
  if (out) writeFileSync(out, JSON.stringify({ days, n: rows.length, verdicts, groups: Object.fromEntries(groups) }, null, 1));
}

if (process.argv[1]?.endsWith("audit-off-pattern.ts")) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
