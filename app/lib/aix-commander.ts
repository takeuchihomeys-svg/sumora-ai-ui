// app/lib/aix-commander.ts — AIX の統括（ボタン×ピッカーを選ぶ・純関数・DB も LLM も持たない）
//
// 2026-10-29 竹内さん（KB P1 03d2bdd2「AIX を選ぶ判断は AIX の中の統括に任せ、ボタンとピッカーごとに担当」・ad20192b「AIX の中身を理解」・7bbb1760 2つの統括をつなぐ）・作業員1:
//   呼ぶのは LINE の統括（brain-core）が AIX と決めた番だけ。候補＝ブレインの AIX＋2つ目の AIX＋取り違えやすい組の相手（②の実データ）。
//   候補の担当の札（aix_desk_cards・竹内さんの送信と決定から作る）を並べ、見分けの軸に沿って1回で比べて1つ選ぶ（担当を別々に聞くと皆 0.9 を付けて見分けにならなかった）。
//   答え: 選んだ鍵（ブレインと違えば AIX の統括の判断）／also（同じ連投に別の要件もある＝1通に詰めず順に出す・feedback_promise_order_split）／
//         差し戻し（promise＝結果が無く約束で受ける番・reply＝AIX の番ではない）は書き換えず LINE の統括の読み直しへ渡すだけ（作業員2）。
//   試し（scripts/aix-desk-eval.ts --compare・30日の外れ134＋当たり60）: ブレインが AIX の番で 外れ +11（②種類違い 29→10直る）・当たり −5（43中）。
//   切替: AIX_DESK_COMMAND（既定 off・shadow＝比べて記録だけ・on＝選んだ鍵に替える）
import { buttonOfKey } from "./aix-catalog";
import type { AixVerdict } from "./aix-desk-types";

type Env = Record<string, string | undefined>;
export type AixDeskMode = "off" | "shadow" | "on";
export function aixDeskCommandMode(env: Env = typeof process !== "undefined" ? process.env : {}): AixDeskMode {
  const v = (env.AIX_DESK_COMMAND ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "shadow" ? "shadow" : "off";
}

/** 取り違えやすい組（②の実データ）: 片方が候補にあれば相手も比べる */
export const AIX_PAIRS: Readonly<Record<string, readonly string[]>> = {
  property_check_result: ["estimate_sheet", "acknowledge_check"], estimate_sheet: ["property_check_result"], acknowledge_check: ["property_check_result"],
  property_recommendation: ["property_send"], property_send: ["property_recommendation"],
  viewing_invite: ["meeting_place"], meeting_place: ["viewing_invite"],
  guarantor_info: ["phone_call"], zenryoku_support: ["property_send", "property_recommendation"],
};

/** 組の見分けの軸（竹内さんの決定・カタログの線・②の外れの読み） */
export const AIX_PAIR_AXES: readonly string[] = [
  "・物件確認した ↔ 見積書送る: その物件の募集中がもう分かっている（今すぐ果たせる物の「募集中と確認済み」「見積を作れる」にある）なら見積書送る。まだ確認が要る物件（持ち込み・募集の確認がまだ）は物件確認した（募集中なら見積書を同封する）。",
  "・物件オススメ ↔ 物件ピックアップした: 1件に絞って推す（強い1件・新着1件・送った中から1件）は物件オススメ。何件かをまとめて送る（新規・新着の束・条件を広げた束）は物件ピックアップした。",
  "・内覧調整 ↔ 待ち合わせ: お客様が候補から日と時刻を決めた・了承した（「〇日〇時でお願いします」）は待ち合わせ。日時なしの内覧の希望・空きを聞く・日だけで時刻なしは内覧調整。",
  "・確認した（条件・交渉）↔ 物件確認した: 物件を特定する物（URL・画像・物件名＋募集の問い）は物件確認した。礼金・家賃・設備など条件の交渉・確認は確認した。",
  "・保証会社・審査の相談（夜職・無職・ブラック・滞納など本人の事情）は電話も候補（文で言い切らない）。",
  "・全力サポートはお客様の返信の後・送った物件が刺さらず送れる物件が無い時だけ。持ち込みの物件や新着がある時は物件の AIX。",
];

/** 統括の system（固定＝キャッシュに乗る） */
export const AIX_COMMANDER_SYSTEM = [
  "あなたは大阪の賃貸仲介（スモラ）の「AIX の統括」です。LINE の統括（ブレイン）がこの番を AIX の番と決めました。",
  "候補のボタン×ピッカーの担当の札を読み比べ、この番の後にスタッフ（竹内さん＝社長の基準）が送る物を1つ選びます。",
  "選べる答え: 候補の鍵のどれか／reply（AIX ではなく返信で答える番・会話や資料や会社の事実で答えられる）／promise（スタッフだけが知る事が要るが、結果がまだ無く、同じ連投に約束で受けるべき依頼もある＝まず約束の返信・結果が出てから AIX）。",
  "確認の結果（募集中か終了か等）はスタッフが確かめてから選ぶので、結果がまだ会話に無い事だけでは promise にしない。promise は探す・見積の作成などの依頼が一緒にあって、まとめて約束で受けるのが自然な時。",
  "同じ連投に別の AIX の要件（例: 内覧の日時と初期費用）が両方ある時は、片方を捨てない。優先して先に送る物を pick、もう片方を also に入れる（1通に詰めず要件ごとに順に送る）。",
  "【取り違えやすい組の見分けの軸】",
  ...AIX_PAIR_AXES,
  '出力は JSON だけ: {"pick":"鍵 か reply か promise","also":["同じ連投の別の要件の鍵（無ければ空）"],"why":"見分けの軸に沿って短く"}',
].join("\n");

/** ブレインの AIX（ボタン）と check_pattern から札の鍵へ（札が無ければボタンの最初の札） */
export function deskKeyOf(action: string | null | undefined, checkPattern: string | null | undefined, cardKeys: readonly string[]): string | null {
  const a = String(action ?? "").trim();
  if (!a) return null;
  const withPicker = checkPattern ? `${a}/${checkPattern}` : null;
  if (withPicker && cardKeys.includes(withPicker)) return withPicker;
  if (cardKeys.includes(a)) return a;
  return cardKeys.find((k) => buttonOfKey(k) === a) ?? null;
}

/** 候補: ブレインの AIX＋2つ目の AIX＋組の相手（最大6） */
export function commanderCandidates(brainKey: string | null, altActions: readonly string[], cardKeys: readonly string[]): string[] {
  const out: string[] = [];
  const add = (k: string | null) => { if (k && cardKeys.includes(k) && !out.includes(k) && out.length < 6) out.push(k); };
  add(brainKey);
  for (const a of altActions) add(deskKeyOf(a, null, cardKeys));
  for (const k of [...out]) for (const pb of AIX_PAIRS[buttonOfKey(k)] ?? []) {
    if (out.some((x) => buttonOfKey(x) === pb)) continue;
    add(deskKeyOf(pb, null, cardKeys));
  }
  return out;
}

/** 統括に渡す user（毎回変わる物だけ・伏せた文） */
export function commanderUserText(o: { situationLine: string; conversation: string; cards: ReadonlyArray<{ key: string; text: string }> }): string {
  return [
    o.situationLine ? `【状況のまとめ】${o.situationLine}` : "",
    `【会話（★が今の番のお客様の発言）】\n${o.conversation}`,
    `【候補の担当の札】\n${o.cards.map((c) => c.text).join("\n\n")}`,
    `【候補の鍵】${o.cards.map((c) => c.key).join(" / ")} / reply / promise`,
  ].filter(Boolean).join("\n\n");
}

/** 統括の答えを整える（候補に無い鍵は捨てる） */
export function parseCommanderAnswer(raw: unknown, cands: readonly string[]): { pick: string | null; also: string[]; sendBack: "promise" | "not_aix" | null; why: string } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const p = String(o.pick ?? "").trim();
  const also = (Array.isArray(o.also) ? o.also : []).map(String).filter((k) => cands.includes(k) && k !== p).slice(0, 2);
  const why = String(o.why ?? "").slice(0, 200);
  if (p === "promise") return { pick: null, also, sendBack: "promise", why };
  if (p === "reply") return { pick: null, also, sendBack: "not_aix", why };
  return { pick: cands.includes(p) ? p : null, also, sendBack: null, why };
}

/** 統括の答え → AixVerdict（記録・作業員2の読み直しの入口へ） */
export function toAixVerdict(a: ReturnType<typeof parseCommanderAnswer>): AixVerdict {
  return {
    pick: a.pick ? { key: a.pick, reason: a.why } : null,
    missing: [],
    sendBack: a.sendBack ? { kind: a.sendBack, why: a.why } : null,
    desks: [],
  };
}

/** 選んだ鍵 → ボタンと check_pattern（物件確認した の結果のピッカーはスタッフが選ぶので外す） */
export function actionOfKey(key: string): { action: string; checkPattern: string | null } {
  const [b, v] = key.split("/");
  if (b !== "property_check_result" || !v) return { action: b, checkPattern: null };
  if (/^(?:available|unavailable|alternative|exclusive)$/.test(v)) return { action: b, checkPattern: null };
  return { action: b, checkPattern: v };
}
