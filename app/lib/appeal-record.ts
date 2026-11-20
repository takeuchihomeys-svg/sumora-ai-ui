// app/lib/appeal-record.ts — 1回の訴求を1つの記録にする（純関数・DB/LLM なし）
//
// 2026-11-15 作業員K（竹内さん 11/15「訴求の部分はまだ弱いのか。何でこの状況にこの訴求をしているのか、なんでここでする必要があるのか。
//   ここは統括的に全体を把握して行う部分。関連性や強度、気持ちの割合、条件にどれだけ合っているのか、の具体的な部分を強化してより細かく、
//   必要な土台を追加し、統括のように今ある物を取りまとめれば質が上がる」・統括役の OK 済みの欄の案）。
//
// ■ 何をするか（土台）
//   今は「何を推すか」を決める部品が3つ（オススメポイント recommend-appeal-points・2通目の網 second-appeal-points・🌟の理由 recommend-star-rank）、
//   「強さ」を決める所が2つ（appeal-timing・recommend-cta）に分かれ、「なぜこのお客様にこの点か」は LLM の判断の中にしか無い。
//   ここで1回の訴求を同じ欄に並べる。竹内さんの文と AI の文を同じ関数で読み、欄ごとに比べられるようにする（物差し: scripts/audit-appeal-record.ts）。
//
// ■ 欄（名前は全体の統括とそろえる）
//   strength … next-move-types.NextStrength（strong／invite／together／door／none）＝作業員16・22 の「次の一手の強さ」と同じ語彙
//   aim      … next-move-types.NextDest（viewing／apply／estimate／…）＝次の一手の行き先と同じ語彙（狙う返事）
//   points   … recommendation-gaps.TOPICS の話題（敷礼0・駅近・広さ・設備…）＝🌟の appeal_topics と同じ語彙
//   why      … 推した点のうち、お客様の希望（customer_wants・出所つき）に応える点
//   fit      … 希望の数のうち推した点で応えた数・「〜となりますが」の外れを先に言ったか
//   relevance… 前のやり取りへの言及（前回・お送り頂いた・ご希望の）・複数送った中から1件を推す形（お部屋の中でも）
//   why_now  … 今推す理由の言い方（すぐ埋まる・問い合わせが多い・空室・退去予定・先着）
//   feeling  … 文からは読まない（ブレインの meta から入れる口だけ・今は null）
//
// スイッチ: APPEAL_RECORD=shadow（2026-11-18 から既定・記録を作ってログ・判断と文は変えない）|off。本番の道への接続はまだ（物差しの後）
import { TOPICS, type TopicKey } from "./recommendation-gaps";
import { readClosingKind } from "./recommend-cta";
import type { NextDest, NextStrength } from "./next-move-types";

export type AppealSurface = "reply" | "aix_first" | "aix_second" | "estimate_second";
export type AppealWriter = "ai" | "takeuchi" | "employee" | "unknown";
export type WantLite = { key: string; from?: string | null };

export type AppealRecord = {
  v: 1;
  surface: AppealSurface;
  writer: AppealWriter;
  propertyKey: string | null;
  points: TopicKey[];
  why: Array<{ topic: TopicKey; wantFrom: string | null }>;
  fit: { wantTotal: number; wantHit: number; gapFirst: boolean };
  relevance: { prevRef: boolean; oneOfMany: boolean };
  whyNow: string[];
  strength: NextStrength;
  aim: NextDest;
  feeling: { main: string; sub: string | null; strength: number } | null;
  /** なぜこのお客様に: 潜在の下の種類（brain meta の latent_five_sub か latent_subkind_record・LATENT_SUBKINDS の記録）。無ければ null */
  latent: { id: string; top: string } | null;
};

export type AppealRecordMode = "off" | "shadow";
export function appealRecordMode(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): AppealRecordMode {
  // 2026-11-18 既定 shadow（記録だけ・aix-template-generate の after() の中だけ・文と判断は変えない。文と判断に触れないことをコードで確かめた・統括役の決め A）。=off で止める
  return String(env.APPEAL_RECORD ?? "").trim().toLowerCase() === "off" ? "off" : "shadow";
}

const nf = (s: unknown) => String(s ?? "").normalize("NFKC");

/** 推した話題（本文の言い方で読む・同じ話題は1回） */
export function appealPointsOf(text: string): TopicKey[] {
  const t = nf(text);
  return TOPICS.filter((x) => x.appeal && x.appeal.test(t)).map((x) => x.key);
}

const WHY_NOW: Array<[string, RegExp]> = [
  ["すぐ埋まる", /(?:すぐ|早く|直ぐ)(?:に)?(?:埋ま|決ま|無くな|なくな)|埋まりやす/],
  ["問い合わせが多い", /(?:お)?問い?合わせ(?:が|も)?(?:多|殺到|増え)|人気(?:の|が高|物件)/],
  ["先着", /先着|早い者勝ち|一番手|1番手/],
  ["空室", /空室(?:のため|です|となって)|即入居|すぐ(?:に)?(?:ご)?入居/],
  ["退去予定", /退去予定/],
  ["新着", /新着|出たばかり|出てきた|募集(?:が)?(?:開始|始ま|出)/],
];

/** 強さ（next-move-types の段の言い方の形） */
export function appealStrengthOf(text: string): NextStrength {
  const t = nf(text);
  // 2026-11-21 作業員K2（#142・本物の2通目を読んだ直し・記録の物差しだけ）: 「押さえ」も抑えと同じ／「こちらのお部屋如何でしょうか」（物件への反応を聞く頭の一文）は内覧の誘いではない
  if (/(?:抑え|押さえ)(?:ましょう|させて|る形|て頂|ておく)|お早めに|キャンセル料|お申込み?(?:頂|いただ)ければ/.test(t)) return "strong";
  if (/併せて|あわせて[^。！!]*ご案内|一緒にご案内/.test(t)) return "together";
  const t2 = t.replace(/(?:こちらの)?お部屋(?:は)?(?:如何|いかが)でしょうか/g, "");
  if (/ご都合よろしいお日にち|ご内覧(?:如何|いかが)|ご案内させて頂きます|如何でしょうか|いかがでしょうか/.test(t2)) return "invite";
  if (/お気に召されましたら|お気軽に|いつでも|ご査収/.test(t)) return "door";
  return "none";
}

/** 狙う返事（締めの種類＋見積の言い方） */
export function appealAimOf(text: string): NextDest {
  const t = nf(text);
  if (/(?:御|お)?見積(?:書|もり)?(?:を)?(?:お作り|作成|お送り|送らせ)/.test(t)) return "estimate";
  const k = readClosingKind(text);
  if (k === "viewing") return "viewing";
  if (k === "apply") return "apply";
  if (k === "receipt") return "door";
  if (/ご内覧|内見|ご案内/.test(t)) return "viewing";
  if (/お申込|抑え/.test(t)) return "apply";
  return "none";
}

export function appealRecordFromText(text: string, o: { surface: AppealSurface; writer: AppealWriter; wants?: ReadonlyArray<WantLite> | null; propertyKey?: string | null; latent?: { id?: string | null; top?: string | null } | null; feeling?: { main?: string | null; sub?: string | null; strength?: number | null } | null }): AppealRecord {
  const t = nf(text);
  const points = appealPointsOf(t);
  const wants = (o.wants ?? []).filter((w) => w && w.key);
  const wantKeys = new Map<string, string | null>(wants.map((w) => [w.key, w.from ?? null]));
  const why = points.filter((p) => wantKeys.has(p)).map((p) => ({ topic: p, wantFrom: wantKeys.get(p) ?? null }));
  const firstPara = t.split(/\n\s*\n/).slice(0, 2).join("\n");
  return {
    v: 1,
    surface: o.surface,
    writer: o.writer,
    propertyKey: o.propertyKey ?? null,
    points,
    why,
    fit: { wantTotal: wantKeys.size, wantHit: why.length, gapFirst: /となりますが|ではございませんが|ではありませんが|少し(?:外れ|離れ)ますが/.test(firstPara) },
    relevance: { prevRef: /前回|先日|お送り頂いた|お送りいただいた|ご希望の|仰って(?:頂|いただ)いた/.test(t), oneOfMany: /お部屋の中でも/.test(t) },
    whyNow: WHY_NOW.filter(([, re]) => re.test(t)).map(([k]) => k),
    strength: appealStrengthOf(t),
    aim: appealAimOf(t),
    // 2026-11-21 作業員K2（#142・#100）: 気持ちはブレインの meta（feeling_conductor.read＝FEELING_CONDUCTOR_TABLE の既定 shadow の記録）から入れる。無ければ null（文からは読まない）
    feeling: o.feeling?.main ? { main: String(o.feeling.main), sub: o.feeling.sub ? String(o.feeling.sub) : null, strength: Number(o.feeling.strength ?? 0) } : null,
    latent: o.latent?.id ? { id: String(o.latent.id), top: String(o.latent.top ?? "") } : null,
  };
}

export type AppealCompare = {
  pointsOverlap: number; // Jaccard（両方空なら 1）
  missingPoints: TopicKey[]; // 基準（竹内さん）にあって比べる側（AI）に無い
  extraPoints: TopicKey[];
  whySame: boolean; // 希望に応える点の集まりが同じ
  gapFirstSame: boolean;
  prevRefSame: boolean;
  whyNowSame: boolean;
  strengthSame: boolean;
  aimSame: boolean;
};
export function compareAppealRecords(base: AppealRecord, other: AppealRecord): AppealCompare {
  const a = new Set(base.points), b = new Set(other.points);
  const inter = [...a].filter((x) => b.has(x)).length, uni = new Set([...a, ...b]).size;
  const wa = new Set(base.why.map((w) => w.topic)), wb = new Set(other.why.map((w) => w.topic));
  const sameSet = (x: Set<string>, y: Set<string>) => x.size === y.size && [...x].every((k) => y.has(k));
  return {
    pointsOverlap: uni ? inter / uni : 1,
    missingPoints: [...a].filter((x) => !b.has(x)),
    extraPoints: [...b].filter((x) => !a.has(x)),
    whySame: sameSet(wa, wb),
    gapFirstSame: base.fit.gapFirst === other.fit.gapFirst,
    prevRefSame: base.relevance.prevRef === other.relevance.prevRef,
    whyNowSame: sameSet(new Set(base.whyNow), new Set(other.whyNow)),
    strengthSame: base.strength === other.strength,
    aimSame: base.aim === other.aim,
  };
}
