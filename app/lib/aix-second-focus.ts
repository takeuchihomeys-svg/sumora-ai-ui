// app/lib/aix-second-focus.ts — 統括の重点（meta.conductor_focus）を AIX の2通目の書き手に1行で渡す（純関数・既定 off）
//
// 2026-11-21 作業員L（竹内さん「LINE の文生成のところとの連携も細かく強化する・徹底的に」・台帳 #466）:
//   本番の番（11/21 の24時間・同じ番10）で、統括の重点は10番中9番に値があり、返信の書き手には9/9 届いていたが、AIX の2通目（aix-template-generate）には
//   渡す配線が無かった（delivery-check の focus: aix2=b）。2通目の推す点・締めが、この番で一番大切にする事と別の向きになる余地があった。
//   渡すのは重点の名前と理由だけ（事実・物件名・金額は足さない＝2通目の材料はそのまま）。道（どのボタンか）は変えない。
// 切替 AIX_SECOND_FOCUS: 既定 off（=on で入れる）。
import { FOCUS_LABEL, type Focus } from "./conductor-focus";

type Env = Record<string, string | undefined>;
export function aixSecondFocusOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_SECOND_FOCUS ?? "").trim().toLowerCase() === "on";
}

const clip = (s: unknown, n: number) => Array.from(String(s ?? "").replace(/\s+/g, " ").trim()).slice(0, n).join("");

/** 2通目の書き手への1行（重点が無ければ ""） */
export function aixSecondFocusLine(meta: Record<string, unknown> | null | undefined): string {
  const cf = meta && typeof meta.conductor_focus === "object" && meta.conductor_focus ? (meta.conductor_focus as { focus?: unknown; why?: unknown }) : null;
  const f = String(cf?.focus ?? "").trim();
  if (!f) return "";
  const label = (FOCUS_LABEL as Record<string, string>)[f as Focus] ?? f;
  const why = clip(cf?.why, 60);
  return `\n【統括の重点（この番で一番大切にする事）】${label}${why ? `＝${why}` : ""}\n→ 2通目の推す点と締めの向きをこの重点に合わせる（事実・物件名・金額は足さない・ボタンの中身は変えない）`;
}
