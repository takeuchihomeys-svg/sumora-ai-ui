// app/lib/brain-turn-aims.ts — ブレインがこの番の「目的・中期の狙い・仕込み・先読みの深さ」を、道を決めた後に書く欄（純関数・DB/LLM なし）
//
// 2026-11-12 作業員7（竹内さん 11/12「何を目的か・中期的・長期的思考」「何手先まで想定するか」・統括役の決め (b)）。
//   ⚠ 前例 q406: ブレインの出力に欄を足すと道がずれた。ここは three_layer の AFTER と同じ形＝出力の最後の欄・判断を全部書いた後の振り返り・この欄で判断を変えない。
//   状態の候補は apply-route-substate.ts（APPLY_ROUTE_SUBSTATE）。文の統括・AIX の文へは conductor-handoff の decided（turnAim・plant）で渡す。
//   既定 off（BRAIN_TURN_AIMS=on）。off の時は出力の指定も決まりも1バイトも変えない。
type Env = Record<string, string | undefined>;
// ⛔ 2026-11-12 凍結（統括役の決め・既定 off のまま・消すのは後でまとめて）: ブレインの出力の欄にすると効かなかった。
//   理由: 判断の後の欄の形でも、欄があるだけで道が引かれた（q065・q425）。代わり: turn-aims-after.ts（TURN_AIMS_AFTER・道の後に決まった計算で作る）。
export const turnAimsOn =(env: Env = typeof process !== "undefined" ? process.env : {}) => (env.BRAIN_TURN_AIMS ?? "").trim().toLowerCase() === "on";

export type TurnAims = { state: string; depth: 1 | 2 | 3 | null; depthWhy: string; turnAim: string; midAim: string; plant: string };

export const BRAIN_TURN_AIMS_RULES = `【振り返り（turn_aims・判断を全部書き終えた後に書く）】aix・two_stage・turn_contract・reply_direction を決め終えた後で、竹内さんのように先を見てこの番を書き留める。この欄で判断を変えない。`
  + `state＝【この駅の細かい状態の候補】から選んだ名前（無ければ ""）／depth＝何番先まで見てこの一手を選んだか（1＝この番だけ・2＝1〜2番先の内覧・申込・見積・3＝申込までの長い道で信用と仕込み）／depth_why＝その深さを決めた合図（お客様の温度・入居時期・物件の残り・段階）／`
  + `turn_aim＝この番の目的（今の1手）／mid_aim＝次の2〜3番の狙い／plant＝この番の文に入れる先の番のための一言（1部屋のみ・申込で抑えてから内覧・入居の時期・審査のサポート・費用を抑える・全力サポート。無ければ ""）。plant は先の番のための事実・線だけで、確認・約束（管理会社に確認・確認してご連絡 等）は書かない（それは道＝turn_contract の事）。`;
export const BRAIN_TURN_AIMS_FIELD = `"turn_aims": {"state": "細かい状態の名前", "depth": 1, "depth_why": "30字以内", "turn_aim": "25字以内", "mid_aim": "30字以内", "plant": "25字以内"}`;

/** 2026-11-12 作業員7（統括役の決め ②）: 仕込みに確認・約束を入れない（q065: plant「最速入居日は管理会社に確認してすぐ連絡する」） */
export const PLANT_NOT_PROMISE_RE = /確認|確かめ|管理会社|ご?連絡(?:し|させ|いた)|約束|お調べ/;
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const blank = (v: unknown) => v == null || ["", "null", "none"].includes(String(v).trim().toLowerCase());

export function normalizeTurnAims(raw: unknown): TurnAims | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const d = Number(o.depth);
  const out: TurnAims = {
    state: blank(o.state) ? "" : clip(o.state, 30), depth: d === 1 || d === 2 || d === 3 ? d : null, depthWhy: blank(o.depth_why) ? "" : clip(o.depth_why, 40),
    turnAim: blank(o.turn_aim) ? "" : clip(o.turn_aim, 30), midAim: blank(o.mid_aim) ? "" : clip(o.mid_aim, 40), plant: blank(o.plant) || PLANT_NOT_PROMISE_RE.test(String(o.plant)) ? "" : clip(o.plant, 30),
  };
  return out.turnAim || out.midAim || out.plant || out.state ? out : null;
}

/** digest の短い1語（d1|目的 等） */
export const turnAimsDigest = (t: TurnAims | null | undefined) => (t ? `${t.depth ? `d${t.depth}` : "d?"}|${t.plant ? "仕" : ""}${t.state.slice(0, 10)}` : null);
