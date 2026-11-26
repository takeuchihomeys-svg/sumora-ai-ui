// scripts/exam-preflight-queue.ts — 昼に、積んである試験の組を順に「部品が届くか」の確かめに通し、依頼に「比べる／届かず／録音なし／印なし」の印を付ける（台帳 #803）
// 2026-11-27 作業員L（統括役の決め）: LLM 0（--replay=strict）・本番 DB の読み 0（試験の会話の写しだけ）・PC の空きメモリが 1000MB を下回れば止める・試験の係とは別に回す。
//   既定は記録だけ（依頼の json に preflightMarks を書く・hold は付けない）＝悪化0を見てから止める（EXAM_PREFLIGHT_QUEUE_HOLD=on で「届かず」に hold を付ける・今は使わない）。
//   1組ずつ・問題は守りでない物だけ。同じ依頼で前に確かめた印があれば（同じ問題・同じ env）飛ばす。
// 実行: npx tsx scripts/exam-preflight-queue.ts [--cwd=<作業ツリー>] [--max-jobs=5] [--dry]
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { runPreflight, preflightVerdict, targetMarksOf } from "./exam-preflight-marks";
import type { ExamDictionary } from "./lib/exam-dictionary";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
export const MIN_FREE_MB = 1000;
type Job = { label: string; runner?: string; only?: string; guards?: string[]; env?: Record<string, string>; switch?: string; preflightMarks?: { key: string } };
/** この依頼を確かめるか（純関数）: 試験の組で・問題があり・同じ問題と env で前に確かめていない */
export function preflightKeyOf(j: Job): string { return `${j.only ?? ""}|${JSON.stringify(j.env ?? {})}`; }
export function needsPreflight(j: Job): boolean { return j.runner === "brain-exam" && !!j.only && j.preflightMarks?.key !== preflightKeyOf(j); }
export function switchesOfJob(j: Job): string[] {
  const fromEnv = Object.entries(j.env ?? {}).filter(([, v]) => String(v).trim().toLowerCase() === "on").map(([k]) => k);
  return fromEnv.length ? fromEnv : [...new Set(String(j.switch ?? "").match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])];
}

if (require.main === module) {
  const cwd = arg("cwd", join(process.cwd(), "..", "exam-night"));
  const ROOT = join(examCacheRoot(), "exam-queue");
  const dict = (() => { try { return JSON.parse(readFileSync(join(examCacheRoot(), "exam-dictionary.json"), "utf8")) as ExamDictionary; } catch { return null; } })();
  const files = existsSync(ROOT) ? readdirSync(ROOT).filter((f) => f.endsWith(".json") && f !== "config.json" && f !== "scene-map.json" && f !== "prod-env.json") : [];
  const max = Number(arg("max-jobs", "5")) || 5;
  let done = 0;
  for (const f of files.sort()) {
    if (done >= max) break;
    const p = join(ROOT, f);
    let j: Job; try { j = JSON.parse(readFileSync(p, "utf8")) as Job; } catch { continue; }
    if (!needsPreflight(j)) continue;
    const freeMb = Math.round(freemem() / 1048576);
    if (freeMb < MIN_FREE_MB) { console.log(`止めた: 空きメモリ ${freeMb}MB（${MIN_FREE_MB} 未満）`); break; }
    const sws = switchesOfJob(j);
    const ids = String(j.only).split(",").filter((x) => x && !(j.guards ?? []).includes(x));
    const targets = targetMarksOf(dict, sws);
    if (process.argv.includes("--dry")) { console.log(`- ${j.label}: ${ids.length}問・${sws.join(",")}・目当ての印 ${targets.join(",") || "なし"}`); done++; continue; }
    const t0 = Date.now();
    const r = targets.length ? runPreflight({ cwd, ids, env: { ...(j.env ?? {}) }, label: `pfq-${j.label}`.slice(0, 40) }) : { byId: Object.fromEntries(ids.map((x) => [x, null])), missed: 0, missedById: {} };
    const v = preflightVerdict(r.byId, targets, 3, r.missedById);
    const mark = { key: preflightKeyOf(j), at: new Date().toISOString(), verdict: v.verdict, targets, reached: v.reached, notReached: v.notReached, noRecord: v.noRecord, unknown: v.unknown, sec: Math.round((Date.now() - t0) / 1000), mode: "記録だけ" };
    // 係が取っていない（.json のまま）時だけ書く・書きかけを読ませない
    try { const cur = JSON.parse(readFileSync(p, "utf8")); writeFileSync(`${p}.tmp`, JSON.stringify({ ...cur, preflightMarks: mark }, null, 1)); renameSync(`${p}.tmp`, p); } catch { console.log(`  書けない（係が取った？）: ${f}`); }
    console.log(`- ${j.label}: ${v.verdict}・届いた ${v.reached.length}/${ids.length}・録音なし ${v.noRecord.length}・${mark.sec}秒`);
    done++;
  }
  console.log(`確かめた組 ${done}`);
}
