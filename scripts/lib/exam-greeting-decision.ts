// scripts/lib/exam-greeting-decision.ts — 竹内さんの決定（11/21「会話の続きの番は、その日最初の会話文でも挨拶を省く」）による変化を、試験で悪化と数えない
//
// 2026-11-21 作業員L（作業員H と決めた・案1）: 竹内さんの実送信（正解の文）は書き換えない。問題の spec に印（greetingDecision: "continuation_skip"）を置き、
//   採点の直前に、正解の文と AI の文の両方から冒頭の挨拶の行（「〇〇さんお世話になっております！！」）を外して比べる。前の答えにも同じ関数を当てる＝前を作り直さない。
//   印は spec に置くが SPEC_KEYS（問題の写しの hash）には入れない＝6問の写しと夜の基準は作り直さない（writer:"employee" と同じやり方）。
//   AIX の文の試験（exam-aix-text）は、問題の本文の会話（body.recentMessages）から続きの番かを greeting.aixContinuationSkip で決める（印は要らない）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyDailyGreeting } from "../../app/lib/daily-greeting";
import { aixContinuationSkip } from "../../app/lib/greeting";

export const GREETING_DECISION_SKIP = "continuation_skip";
let memo: Set<string> | null = null;
/** spec.json で greetingDecision="continuation_skip" の問題の id */
export function greetingSkipIds(specRows?: ReadonlyArray<{ id?: unknown; greetingDecision?: unknown }>): Set<string> {
  if (!specRows && memo) return memo;
  let rows = specRows;
  if (!rows) { try { rows = JSON.parse(readFileSync(join(process.cwd(), "scripts/brain-exam/spec.json"), "utf8")) as Array<{ id?: unknown; greetingDecision?: unknown }>; } catch { rows = []; } }
  const s = new Set((rows ?? []).filter((r) => r.greetingDecision === GREETING_DECISION_SKIP).map((r) => String(r.id)));
  if (!specRows) memo = s;
  return s;
}
/** 冒頭の挨拶の行を外す（外すだけ・名前の行は残す）。外したかも返す */
export function stripOpeningGreeting(text: string): { text: string; stripped: boolean } {
  const d = applyDailyGreeting(String(text ?? ""), { staffSentToday: true, greetingPhrase: "", name: "" });
  return { text: d.text, stripped: d.action === "removed" };
}
/** 試験の問題: 印がある時だけ外す */
export function goldTextForScoring(problemId: string, text: string, ids: Set<string> = greetingSkipIds()): { text: string; stripped: boolean } {
  return ids.has(problemId) ? stripOpeningGreeting(text) : { text: String(text ?? ""), stripped: false };
}
/** AIX の文の試験: 本文の会話が続きの番の時だけ、正解と生成の両方から外す */
export function aixPairForScoring(body: Record<string, unknown> | null | undefined, gold: string, gen: string): { gold: string; gen: string; stripped: boolean } {
  const rm = Array.isArray(body?.recentMessages) ? (body!.recentMessages as Array<{ sender?: string; text?: string; createdAt?: string; rawCreatedAt?: string }>) : [];
  if (!aixContinuationSkip(rm)) return { gold, gen, stripped: false };
  const a = stripOpeningGreeting(gold), b = stripOpeningGreeting(gen);
  return { gold: a.text, gen: b.text, stripped: a.stripped || b.stripped };
}
