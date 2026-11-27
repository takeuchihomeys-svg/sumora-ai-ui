// app/lib/aix-brain-read-card.ts — AIX ボタンの文作りに、その会話の最新のブレインの読みを「札」1枚で渡す（台帳 #827・竹内さん 11/27・作業員A）
//   竹内さん 11/27「AIX ボタン（物件確認した 等）の文作りをブレインとつなぐ」。11/26 の地図の外れで、AIX の物件の文に書き手の仕込みが届かないと分かった。
//   棚卸し（11/28 未明）: AIX は turn_contract（AIX_BRAIN_CONTRACT・既定 on）とお客様の状態の欄は読んでいたが、
//     番の目的・仕込みの一言（meta.turn_aims）・main_point・地図の駅と細かい状態（meta.apply_route）は meta にあるのに読んでいない。
//     答え漏れ・逆算の日・やわらかい誘いはブレインの材料の文にだけあって meta に残っていなかった。
//   統括役の条件（11/28）:
//     ① 答え漏れ・誘い等の要約はブレインの出力の欄にしない。判断の後に決まった計算で meta.aix_read_src に残す（AFTER_DECISION_RECORDS と同じ形）。ブレインのプロンプトは変えない
//     ② 札は事実と向きだけ。AIX の文の言い回しは今の手本とトーンのまま。札があるだけで AIX の種類・ピッカーは変えない（試験で見る）
//     ③ 提案タブには今の文と札ありの文を実物で並べる
//   人だけが知る事（確認の結果・金額・日程の確定）は札に入れない＝AIX の入力のまま。古い判断（最後のお客様の発言より前）は渡さない（呼ぶ側の isStaleMeta）。
//   スイッチ AIX_BRAIN_READ_CARD（既定 off・段階で読む）。印: aix-template-generate のログ tag "aix-template-generate:brain-read-card"（字数）＝aix_brain_link
import { stagedOn, STAGE_OFF } from "./switch-stage";

type Env = Record<string, string | undefined>;
export const aixBrainReadCardOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => stagedOn("AIX_BRAIN_READ_CARD", env, STAGE_OFF);

/** 判断の後に meta に残す材料の要約（決まった計算・ブレインの出力ではない） */
export type AixReadSrc = { unanswered?: string; soft_next?: string; backplan?: string; station_state?: string };
const MAX = 140;
const cut = (s: string | null | undefined) => {
  const t = String(s ?? "").replace(/\s+/g, " ").replace(/^【|】$/g, "").trim();
  return t ? (t.length > MAX ? `${t.slice(0, MAX)}…` : t) : "";
};
/** ブレインの材料の塊（materialBlocks）と保留の柔らかい次の一手の文から、AIX に渡す分だけを短く取る */
export function aixReadSrcOf(i: { blocks: ReadonlyArray<{ key: string; text: string }>; holdSoftNext?: string | null }): AixReadSrc | null {
  const pick = (k: string) => cut(i.blocks.find((b) => b.key === k)?.text);
  const out: AixReadSrc = {};
  const ua = pick("unanswered"); if (ua) out.unanswered = ua;
  const bp = pick("route_backplan"); if (bp) out.backplan = bp;
  const ss = pick("station_state"); if (ss) out.station_state = ss;
  const sn = cut(i.holdSoftNext); if (sn) out.soft_next = sn;
  return Object.keys(out).length ? out : null;
}

type MetaIn = {
  turn_aims?: { turnAim?: string; midAim?: string; plant?: string; state?: string } | null;
  main_point?: unknown;
  apply_route?: { node?: string | null; branch?: string | null; substate?: unknown } | null;
  aix_read_src?: AixReadSrc | null;
} | null | undefined;

/** 仕込みに確認・約束が入っていたら渡さない（brain-turn-aims の PLANT_NOT_PROMISE_RE と同じ線・q065 の教訓） */
const PLANT_NG = /確認|確かめ|管理会社|ご?連絡(?:し|させ|いた)|約束|お調べ/;

/** AIX の文作りに足す札（無ければ ""）。事実と向きだけ・言い回しの指示はしない・AIX の種類とピッカーには触れない */
export function aixBrainReadCard(meta: MetaIn): string {
  if (!meta) return "";
  const rows: string[] = [];
  const ta = meta.turn_aims;
  if (ta?.turnAim) rows.push(`この番の目的: ${cut(ta.turnAim)}`);
  if (ta?.midAim) rows.push(`次の2〜3番の狙い: ${cut(ta.midAim)}`);
  if (ta?.plant && !PLANT_NG.test(ta.plant)) rows.push(`先の番のための一言（入れるかは文の流れで・言い回しは手本のまま）: ${cut(ta.plant)}`);
  const mp = typeof meta.main_point === "string" ? meta.main_point : (meta.main_point as { text?: string } | null)?.text;
  if (mp) rows.push(`要点: ${cut(mp)}`);
  const ar = meta.apply_route;
  const st = ar ? (ar.branch ? `分:${ar.branch}` : ar.node) : null;
  const sub = ar && ar.substate && typeof ar.substate === "object" ? (ar.substate as { id?: string }).id : null;
  if (st) rows.push(`申込までの地図の今の駅: ${st}${sub ? `（細かい状態 ${sub}）` : ""}`);
  const src = meta.aix_read_src;
  if (src?.station_state) rows.push(`駅の状態: ${src.station_state}`);
  if (src?.backplan) rows.push(`入居からの逆算: ${src.backplan}`);
  if (src?.unanswered) rows.push(`まだ答えていない事（この AIX で受ける物だけ触れる）: ${src.unanswered}`);
  if (src?.soft_next) rows.push(`やわらかい次の一手の候補: ${src.soft_next}`);
  if (!rows.length) return "";
  return `\n\n【ブレインの読み（材料・事実と向きだけ）】\n${rows.map((r) => `・${r}`).join("\n")}\n`
    + `※ 言い回しは今の手本とトーンのまま。この札で AIX の種類・ピッカー・確認の結果・金額・日程は変えない（それは入力と資料のまま）。\n`;
}
