// scripts/next-move-score.ts — 次の一手（行き先×強さ×時機）の当たりを測る道具（読むだけ・LLM/DB なし・費用0・作業員16・2026-11-12）
//   ① 竹内さんの198通（exam-cache/anatomy-seven/seven-all198.json＋anatomy-roles/roles-r1.json）から、場面ごとの次の一手の型を数える
//   ② 押す強さの手がかり（物件の残り×決める合図・検討・初回）の上限（next-move-types.strengthCeiling）を竹内さんの番に当て、上限を超えた番を数える（上限の線の確かめ）
//   ③ 今のブレインの答案（compose-understanding/brains-*.json の appeal_timing・turn_aims）と竹内さんの正解（gold-1111.json の leadTo）の行き先の当たりを数える
// 実行: npx tsx scripts/next-move-score.ts [--brains=<brains の json>] [--gold=<gold の json>] [--show=5]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { toNextDest, strengthFromSeven, timingOf, strengthOverCeiling, strengthCeiling, NEXT_DEST_LABEL, type NextDest, type NextMove, type PushCues } from "../app/lib/next-move-types";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ROOT = join(__dirname, "..", "..", "..", "..");
const CACHE = join(ROOT, ".claude", "exam-cache");
const SHOW = Number(arg("show", "3"));

type Seven = { id: string; scene: string; reads: Array<{ lead: string | null; push: { push: boolean; strength: "strong" | "mid" | "weak" | null; reason?: string } | null }> };
type Roles = { id: string; customer?: string; sentences?: string[]; background?: string };

const REMAIN_RE = /1部屋のみ|残り1|最後の1|お問い合わせ(?:が)?多|すぐ埋まる|埋まる前|先着|他(?:の)?(?:お)?申込/;
const DECIDE_RE = /決め|申込|申し込|抑え|押さえ|審査(?:かけ|掛け)|ここにし|ここがいい/;
const CONSIDER_RE = /検討|考えさせ|また連絡|相談/;
const FIRST_RE = /はじめまして|初めまして/;

export function takeuchiMove(s: Seven, r: Roles): NextMove & { cues: PushCues } {
  const text = (r.sentences ?? []).join("");
  const dest = toNextDest(s.reads[0]?.lead ?? null, "lead_to") ?? "none";
  const strength = strengthFromSeven(s.reads[0]?.push ?? null, text);
  const cust = r.customer ?? "";
  const cues: PushCues = { remaining: REMAIN_RE.test(text), decideSignal: DECIDE_RE.test(cust), considering: s.scene === "considering" || CONSIDER_RE.test(cust), firstContact: FIRST_RE.test(text), notHooked: false, takenWorry: /埋ま|取られ|無くな|なくな/.test(cust), viewingConstraint: /内見(?:は)?(?:でき|出来)|内覧(?:は)?(?:でき|出来)|[0-9０-９]+時まで|[0-9０-９]+日(?:か|と)[0-9０-９]+日/.test(cust) };
  return { dest, strength, timing: timingOf(dest, text), cues };
}

function main() {
  const S = JSON.parse(readFileSync(join(CACHE, "anatomy-seven", "seven-all198.json"), "utf8")) as Seven[];
  const R = new Map((JSON.parse(readFileSync(join(CACHE, "anatomy-roles", "roles-r1.json"), "utf8")) as Roles[]).map((r) => [r.id, r]));
  const byScene = new Map<string, Map<string, { n: number; ex: string[] }>>();
  let over = 0; const overEx: string[] = []; let n = 0;
  for (const s of S) {
    const r = R.get(s.id); if (!r) continue; n++;
    const m = takeuchiMove(s, r);
    const key = `${NEXT_DEST_LABEL[m.dest]}×${m.strength}×${m.timing}`;
    const sm = byScene.get(s.scene) ?? new Map(); byScene.set(s.scene, sm);
    const e = sm.get(key) ?? { n: 0, ex: [] }; e.n++; if (e.ex.length < SHOW) e.ex.push(String(r.customer ?? "").replace(/\s+/g, " ").slice(0, 30)); sm.set(key, e);
    if (strengthOverCeiling(m.strength, m.cues)) { over++; if (overEx.length < 12) overEx.push(`${s.scene} ${m.strength}>${strengthCeiling(m.cues).max}: ${String(s.reads[0]?.push?.reason ?? "").slice(0, 50)}`); }
  }
  console.log(`# 竹内さんの次の一手（${n}通）— 行き先×強さ×時機`);
  for (const [sc, sm] of byScene) {
    const rows = [...sm.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6);
    console.log(`\n## ${sc}`); for (const [k, v] of rows) console.log(`${v.n}\t${k}\t例: ${v.ex.join(" ／ ")}`);
  }
  console.log(`\n# 押す強さの上限の線の確かめ: 上限を超えた竹内さんの番 ${over}/${n}`);
  for (const l of overEx) console.log(`  ${l}`);

  // ③ 今のブレインの答案（行き先だけ・appeal_timing と turn_aims）
  const brainsF = arg("brains", join(ROOT, ".claude", "worktrees", "think-log-1112", "scripts", "compose-understanding", "brains-1112.json"));
  const goldF = arg("gold", join(ROOT, ".claude", "worktrees", "think-log-1112", "scripts", "compose-understanding", "gold-1111.json"));
  if (!existsSync(brainsF) || !existsSync(goldF)) { console.log("\n（ブレインの答案・正解の json が無い＝③は飛ばす）"); return; }
  const brains = JSON.parse(readFileSync(brainsF, "utf8")) as Array<{ id: string; brain: Record<string, unknown> }>;
  const gold = new Map((JSON.parse(readFileSync(goldF, "utf8")) as { turns: Array<{ id: string; leadTo: string | null }> }).turns.map((t) => [t.id, t]));
  let both = 0, hit = 0; const miss = new Map<string, number>();
  for (const b of brains) {
    const g = gold.get(b.id); if (!g) continue; both++;
    const gd = toNextDest(g.leadTo, "lead_to") ?? "none";
    const at = b.brain.appeal_timing as { kind?: string; level?: string } | undefined;
    const bd: NextDest = at?.kind === "apply" ? "apply" : at?.kind === "viewing" ? "viewing" : at?.kind === "estimate" ? "estimate" : "none";
    // ブレインの appeal_timing は押す先だけ（keep_send・answer_only・ask_send を持たない）＝押さない番は「none」で、竹内さんの keep_send・answer_only・door と同じと数える
    const same = bd === gd || (bd === "none" && ["keep_send", "answer_only", "door", "none", "wait_check"].includes(gd));
    if (same) hit++; else { const k = `${NEXT_DEST_LABEL[gd]}→${NEXT_DEST_LABEL[bd]}`; miss.set(k, (miss.get(k) ?? 0) + 1); }
  }
  console.log(`\n# 今のブレイン（appeal_timing）の行き先の当たり: ${hit}/${both}（押さない番は1つに数えた）`);
  for (const [k, v] of [...miss.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${v}\t竹内さん→ブレイン ${k}`);
}

if (require.main === module) main();
