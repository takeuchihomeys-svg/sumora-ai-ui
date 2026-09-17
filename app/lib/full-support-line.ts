// app/lib/full-support-line.ts
// 「見つかるまで全力でサポートさせて頂きます」は同じ会話・同じ日に1回だけ（純関数・DB 依存なし）。
//
// 2026-09-18 竹内（ゆうこ事例）「**全力でサポート送りまくったら言葉に説得力がでなくなる**ので、
//   今日一度全力サポート出していたし、ピックアップした物件がない形ってのは文見たらわかるとおもうから、
//   このように**新着物件といれて**、**引き続き何卒よろしくお願い致します**で締める形とする。
//   そうすれば言葉に意味が出るから」
//
// 実送信（ゆうこ 9/17 22:24）:
//   「かしこまりました！！／新大阪よりもう少し駅近な物件も含めて、御堂筋線周辺全域から5階以上・
//     エレベーター必須でゆうこさんにオススメできるお部屋お送りさせて頂きます！！／
//     **新着でオススメ出来るお部屋募集に出次第お送りさせていただきます！！**／
//     **引き続き何卒よろしくお願い致します！！**」
//   ＝この日すでに全力サポートを1回送っていたので、2回目は入れずに新着の約束と締めで終えている。
//
// 実データ（365日・スタッフ実送信）:
//   全力サポートの行 282行／174会話／256（会話×日）。**会話×日ごとの回数**は
//     1回 … 231（90%）／2回 … 24／3回 … 1
//   ＝同じ会話・同じ日に1回までが実運用。
//   代わりの締め: 「新着で〜（出|で）次第お送り」70件・「引き続き何卒よろしくお願い致します」33件。
//   生成と実送信の差分（365日）: 下書きにあり220件・実送信にあり217件で総数は同じだが、
//   スタッフが消した52件・足した49件＝**入れる場面がズレている**（回数ではなく場所の問題）。

import { FULL_SUPPORT_LINE_RE } from "./aix-send-phrasing";

/** 実送信33件の締め（全力サポートを落として締めが無くなった時に足す） */
export const CONTINUE_CLOSING_LINE = "引き続き何卒よろしくお願い致します！！";
/** 既に締めがあるか（何卒・よろしくお願い・ご連絡ください・ご査収） */
const HAS_CLOSING_RE = /何卒|(?:よろしく|宜しく)お願い|ご連絡ください|お申し付け|ご査収/;

type MsgLike = { sender?: string | null; text?: string | null; created_at?: string | null; createdAt?: string | null };

/** JST の日付（YYYY-MM-DD） */
function jstDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 9 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** この会話で今日すでに全力サポートを送っているか（今日の判定は JST） */
export function sentFullSupportToday(messages: readonly MsgLike[], nowMs: number = Date.now()): boolean {
  const today = jstDay(new Date(nowMs).toISOString());
  if (!today) return false;
  return messages.some((m) => {
    if ((m.sender ?? "") !== "staff") return false;
    const t = (m.text ?? "").trim();
    if (!t || !FULL_SUPPORT_LINE_RE.test(t)) return false;
    return jstDay(m.created_at ?? m.createdAt ?? null) === today;
  });
}

export type FullSupportResult = { text: string; removed: string[] };

/**
 * 今日2回目以降なら全力サポートの行を落とす。落として締めが無くなったら
 * 「引き続き何卒よろしくお願い致します！！」を足す（実送信33件の締め）。
 * alreadyToday=false の時は触らない（1回目は入れてよい）。
 */
export function stripRepeatedFullSupport(text: string, alreadyToday: boolean): FullSupportResult {
  const src = text ?? "";
  if (!alreadyToday || !src.trim()) return { text: src, removed: [] };
  const removed: string[] = [];
  const kept = src.split("\n").filter((line) => {
    if (!FULL_SUPPORT_LINE_RE.test(line)) return true;
    removed.push(line.trim());
    return false;
  });
  if (removed.length === 0) return { text: src, removed: [] };
  let out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!out) return { text: src, removed: [] }; // 全部落ちたら元のまま（安全側）
  if (!HAS_CLOSING_RE.test(out)) out += `\n${CONTINUE_CLOSING_LINE}`;
  return { text: out, removed };
}

/** 生成の指示（今日すでに送っている時だけ渡す） */
export function buildFullSupportNote(alreadyToday: boolean): string {
  if (!alreadyToday) return "";
  return [
    "【「全力でサポート」はこの会話で今日すでに送っている — もう書かない】",
    "・「〇〇さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます」等の宣言は書かない（同じ日に繰り返すと言葉の重みが無くなる）",
    "・代わりに、これから探す場面なら「新着でオススメ出来るお部屋募集に出次第お送りさせていただきます！！」のように**次に何をするか**を書く",
    `・締めは「${CONTINUE_CLOSING_LINE}」`,
    "・実データ: 全力サポートの行は会話×日ごとに1回が231件（90%）・2回は24件",
  ].join("\n");
}
