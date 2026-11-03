// app/lib/aix-commander.ts — AIX の統括（ボタン×ピッカーを選ぶ・純関数・DB も LLM も持たない）
//
// 2026-10-29 竹内さん（KB P1 03d2bdd2「AIX を選ぶ判断は AIX の中の統括に任せ、ボタンとピッカーごとに担当」・ad20192b「AIX の中身を理解」・7bbb1760 2つの統括をつなぐ）・作業員1:
//   呼ぶのは LINE の統括（brain-core）が AIX と決めた番だけ。候補＝ブレインの AIX＋2つ目の AIX＋取り違えやすい組の相手（②の実データ）。
//   候補の担当の札（aix_desk_cards・竹内さんの送信と決定から作る）を並べ、見分けの軸に沿って1回で比べて1つ選ぶ（担当を別々に聞くと皆 0.9 を付けて見分けにならなかった）。
//   答え: 選んだ鍵（ブレインと違えば AIX の統括の判断）／also（同じ連投に別の要件もある＝1通に詰めず順に出す・feedback_promise_order_split）／
//         差し戻し（promise＝結果が無く約束で受ける番・reply＝AIX の番ではない）は書き換えず LINE の統括の読み直しへ渡すだけ（作業員2）。
//   試し（scripts/aix-desk-eval.ts --compare・30日の外れ134＋当たり60）: ブレインが AIX の番で 外れ +11（②種類違い 29→10直る）・当たり −5（43中）。
//   切替: AIX_DESK_COMMAND（既定 off・shadow＝比べて記録だけ・on＝記録＋ブレインと違う時は読み直しの口へ）。2026-11-03 竹内さん「統括を束ねる6つの型」: 答えは提案・黙って書き換えない
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
  property_check_result: ["estimate_sheet", "acknowledge_check"], estimate_sheet: ["property_check_result", "cost_explain", "cost_breakdown"], cost_explain: ["estimate_sheet", "cost_breakdown"], cost_breakdown: ["estimate_sheet", "cost_explain"], acknowledge_check: ["property_check_result"],
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
  "・内覧は段階どおり（竹内さんの決定）: 内覧調整（候補日を出す）→ 日にち決定 → 待ち合わせ＝確定。別の質問への答えでは段階を進めない。退去予定（入居中）の部屋は先に内覧開始日の確認。",
  "・見積書送る ↔ 初期費用を説明 ↔ 初期費用について（竹内さんの決定）: 物件の初期費用の金額は見積書送る。安さを不審に思われた・安い理由を聞かれたら初期費用を説明（仕組み）。初期費用の中身（家賃だけで入れるか・何が含まれるか）の質問は初期費用について（御見積書を貼って会話を合わせる）。",
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

/**
 * 今の番でお客様が持ち込んだ物件の名前（状況のまとめの needCheck に足す・situation-summary.withTurnBrought）。
 *   「〇〇 2階 https://suumo…」→ URL の前の名前／URL だけ → 「お客様が今送った物件（URL）」／物件の画面・資料の画像 → 「お客様が今送った物件（画像）」
 */
export function broughtThisTurnNames(turnText: string): string[] {
  const out: string[] = [];
  for (const line of String(turnText ?? "").split(/\n/)) {
    const m = /^(.{2,40}?)\s*(?:[0-9０-９]{1,2}階)?\s*https?:\/\/\S+/.exec(line.trim());
    if (m && m[1].trim() && !/お願い|ありがと|こちら|ここ/.test(m[1])) out.push(m[1].trim());
    else if (/https?:\/\/\S+/.test(line)) out.push("お客様が今送った物件（URL）");
    if (/【物件の(?:画面|資料)/.test(line)) out.push("お客様が今送った物件（画像）");
  }
  return [...new Set(out)].slice(0, 5);
}

// ─── 逆向きの相談（2026-11-03 竹内さん「AIX かもってなったら AIX のブレインに相談して AIX のブレインが判断する」・KB P1）─────────────────
//   ブレインが返信と決めた番でも、①自信が低い（本質の依頼に AIX・約束があるのに最後は返信／場面が曖昧）②根拠の無い事実（作業員6の no_ground）
//   ③スタッフしか分からない気配（募集・空き・初期費用・内覧の日時・持ち込みの物件）の時だけ、返信と決めきる前に AIX の統括に相談する。
//   答え: aix（鍵）／promise（確認の約束）／keep（返信のままで良い）。読み直しは作業員2の口（opts.recheck）で1回だけ。切替: AIX_DESK_CONSULT（既定 off・shadow／on）
export function aixDeskConsultMode(env: Env = typeof process !== "undefined" ? process.env : {}): AixDeskMode {
  const v = (env.AIX_DESK_CONSULT ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "shadow" ? "shadow" : "off";
}

/** スタッフしか分からない気配（お客様の言葉）。会話・資料で答えられる質問も混ざる＝相談のきっかけだけ（決めるのは AIX の統括） */
export const STAFF_ONLY_CUE_RE = /空(?:い|き)|募集|まだ(?:あり|あります|ある)|初期費用|見積|いくら|内覧|内見|見学|何時|何日|駐車場|ペット|入居(?:日|可能)|退去|審査|交渉|安く(?:なり|でき)|https?:\/\/|【物件の(?:画面|資料)/;

export type ConsultTrigger = "contract_aix" | "scene_uncertain" | "no_ground" | "staff_only_cue";
/** 相談するきっかけ（無ければ []） */
export function consultTriggers(o: { contractAsksAixOrPromise: boolean; sceneUncertain: boolean; noGround: boolean; turnText: string }): ConsultTrigger[] {
  const out: ConsultTrigger[] = [];
  if (o.contractAsksAixOrPromise) out.push("contract_aix");
  if (o.noGround) out.push("no_ground");
  if (STAFF_ONLY_CUE_RE.test(o.turnText ?? "")) out.push("staff_only_cue");
  if (o.sceneUncertain && out.length) out.push("scene_uncertain"); // 場面が曖昧なだけでは相談しない（お礼・雑談の番を増やさない）
  return out;
}

export const AIX_CONSULT_SYSTEM = [
  "あなたは大阪の賃貸仲介（スモラ）の「AIX の統括」です。LINE の統括（ブレイン）はこの番を返信で答えると決めかけていますが、AIX の番かもしれないので相談に来ました。",
  "候補のボタン×ピッカーの担当の札を読み、この番の後にスタッフ（竹内さん＝社長の基準）がする事を1つ選びます。",
  "選べる答え: 候補の鍵のどれか（スタッフだけが知る事＝管理会社に確認した結果・見積の金額・内覧の空き・撮った写真などを送る番）／promise（スタッフだけが知る事が要るが、まず確認の約束の返信で受ける番）／keep（会話・資料・会社の事実だけで答えられる＝返信のままで良い）。",
  "迷う時は keep にする（返信の当たりを落とさない）。資料・会話に書いてある事の質問は keep。",
  "【取り違えやすい組の見分けの軸】",
  ...AIX_PAIR_AXES,
  '出力は JSON だけ: {"answer":"鍵 か promise か keep","why":"短く"}',
].join("\n");

/** 相談の候補: 場面のボタン（catalogSceneButtons）＋組の相手（最大6） */
export function consultCandidates(sceneButtons: readonly string[], cardKeys: readonly string[]): string[] {
  const out: string[] = [];
  const add = (k: string | null) => { if (k && cardKeys.includes(k) && !out.includes(k) && out.length < 6) out.push(k); };
  for (const b of sceneButtons) add(deskKeyOf(b, null, cardKeys));
  for (const k of [...out]) for (const pb of AIX_PAIRS[buttonOfKey(k)] ?? []) add(deskKeyOf(pb, null, cardKeys));
  return out;
}

export function parseConsultAnswer(raw: unknown, cands: readonly string[]): { answer: "aix" | "promise" | "keep"; key: string | null; why: string } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const a = String(o.answer ?? "").trim();
  const why = String(o.why ?? "").slice(0, 200);
  if (a === "promise") return { answer: "promise", key: null, why };
  if (cands.includes(a)) return { answer: "aix", key: a, why };
  return { answer: "keep", key: null, why };
}
