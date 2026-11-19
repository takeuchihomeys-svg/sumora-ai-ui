// app/lib/our-send-uptake.ts — こちらの直前の送信（our_last_send）が、部分ごとにどう受け取られたか・どこが刺さったかを読む欄（純関数・作業員16・2026-11-12）
//
// 竹内さん 11/12「こちらから送っている事に対して、お客さんはどこの部分を理解して、どこの部分を理解できていないか」
//   ＋同日「こちらが送った部分のどこがお客さんに刺さったのか、刺さったからどのように構築されて次に誘導できるのか、細かく細分化」。
//   KB P1 d030d496（判断の順番・確認の順番の細分化）・P0 ecd7b961（一通を両側から細かく読む）。案2（読みの候補）と同じ段。
// 名前を揃えた所:
//   ・check-order.ts の確認の順番 our_last_send（こちらが前に約束・送った物）の中身をこの欄が細かく持つ
//   ・作業員21 の brain-info-kind（情報の種類）と同じく「事実の確かめ」だけ。道・次の一手は書かない
//   ・物件の点は作業員10 の compose-sentence-plan.APPEAL_POINTS（＋キャンペーン）・誘導先は next-move-types.NEXT_DEST
// 置き方: 事実の欄として道の前に置いてよい（次の一手・押す・誘導の言葉は入れない＝q406・q057・q065・q022 の教訓）。
//   刺さった部分 → 文の統括の主・誘導先は HOOK_TO_COMPOSE（道が決まった後で文の統括が読む表・作業員10 と共有）。
// スイッチ: BRAIN_OUR_SEND_UPTAKE（既定 off＝どこからも読まない）。

import type { NextDest, NextStrength } from "./next-move-types";

type Env = Record<string, string | undefined>;
export function ourSendUptakeOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.BRAIN_OUR_SEND_UPTAKE ?? "").trim().toLowerCase() === "on";
}

/** こちらの送信の部分 */
export const OUR_SEND_PART_KINDS = ["question", "fact", "promise", "proposal", "invite", "property"] as const;
export type OurSendPartKind = typeof OUR_SEND_PART_KINDS[number];
export const OUR_SEND_PART_LABEL: Record<OurSendPartKind, string> = {
  question: "聞いた事", fact: "伝えた事実", promise: "約束", proposal: "提案・推し", invite: "誘い（内覧・申込）", property: "送った物件",
};
/** 物件の点（作業員10 の APPEAL_POINTS と同じ名前＋キャンペーン） */
export const HOOK_POINTS = ["家賃", "広さ・間取り", "駅・場所", "新しさ", "設備", "初期費用", "空き・入居", "条件の合い方", "キャンペーン"] as const;
export type HookPoint = typeof HOOK_POINTS[number];
/** 部分の細かい語彙（2026-11-12 竹内さん「こちらからの部分も具体的に細かく細分化」）。
 *  名前は作業員4 の app/lib/our-part-types.ts（OUR_PARTS・feat/exchange-ledger-1112）と同じ（聞いた事の sub は作業員1 の INFO_KEYS と同じ鍵）。
 *  ⚠ どちらかが main に入ったら、ここは OUR_PARTS の kind／sub を import する形に寄せる（網を2か所に持たない）。aix の部分は AIX の送信なのでここでは扱わない。 */
export const OUR_PART_SUBS = {
  question: ["area", "rent", "layout", "move_in", "size", "equipment", "schedule", "property_wish", "situation"],
  fact: ["company", "material", "check_result", "estimate_amount", "answer"],
  promise: ["check", "send_property", "search", "estimate", "contact_day"],
  proposal: ["hold", "viewing", "other_property", "screening_first"],
  invite: ["viewing_door", "apply_door"],
  property: ["one_push", "bundle", "new_arrival", "alternative"],
} as const;
export type OurPartSub = (typeof OUR_PART_SUBS)[keyof typeof OUR_PART_SUBS][number];
export function subOfPart(kind: OurSendPartKind, s: string): OurPartSub {
  switch (kind) {
    case "question": return /入居|時期/.test(s) ? "move_in" : /家賃|予算/.test(s) ? "rent" : /エリア|駅|場所/.test(s) ? "area" : /間取り|LDK|1K|1DK/.test(s) ? "layout" : /広さ|帖|㎡/.test(s) ? "size" : /設備|オートロック|バス|洗面|ペット|駐車/.test(s) ? "equipment" : /お日にち|日程|ご都合|曜|何時/.test(s) ? "schedule" : /お部屋|物件/.test(s) ? "property_wish" : "situation";
    case "fact": return /確認(?:させて|致し|いたし)?(?:頂き|いただき)?まし|確認した|募集(?:中|終了)|空いて/.test(s) ? "check_result" : /[0-9０-９,]+円|見積/.test(s) ? "estimate_amount" : /弊社|仲介手数料0|スモラ|当社|保証会社の審査/.test(s) ? "company" : /帖|㎡|築|駅|設備|オートロック|資料/.test(s) ? "material" : "answer";
    case "promise": return /見積/.test(s) ? "estimate" : /ピックアップ|新着|探/.test(s) ? "search" : /確認/.test(s) ? "check" : /明日|本日|午前|午後|日中/.test(s) ? "contact_day" : "send_property";
    case "proposal": return /抑え|押さえ|申込/.test(s) ? "hold" : /審査[^。！]{0,6}先/.test(s) ? "screening_first" : /案内|内覧|内見/.test(s) ? "viewing" : "other_property";
    case "invite": return /申込|抑え|押さえ/.test(s) ? "apply_door" : "viewing_door";
    case "property": return /新着|募集に出/.test(s) ? "new_arrival" : /代わり|こちらのお部屋如何|別のお部屋/.test(s) ? "alternative" : /🌟|特に/.test(s) ? "one_push" : "bundle";
  }
}
export type OurSendPart = { kind: OurSendPartKind; sub: OurPartSub; text: string; points: HookPoint[] };

/** 受け取られ方 */
export const UPTAKE_KINDS = ["answered", "passed", "asked_again", "misread", "accepted"] as const;
export type UptakeKind = typeof UPTAKE_KINDS[number];
export const UPTAKE_LABEL: Record<UptakeKind, string> = {
  answered: "答えた・触れた", passed: "触れずに流した", asked_again: "聞き返した（伝わっていない）", misread: "取り違えた", accepted: "了承した",
};
/** 刺さり（物件・提案の部分だけ） */
export const HOOK_KINDS = ["hooked", "neutral", "not_hooked"] as const;
export type HookKind = typeof HOOK_KINDS[number];
export const HOOK_DEGREES = ["curious", "strong", "decide"] as const; // 気になる／かなり／決めたい
export type HookDegree = typeof HOOK_DEGREES[number];
export type PartUptake = { part: OurSendPart; uptake: UptakeKind; hook?: { kind: HookKind; degree: HookDegree | null; point: HookPoint | null; reason: HookPoint | null; cue: string | null } };

// ─── 部分に分ける（決まった計算は候補の網・本番ではブレインが読む＝P0 9eb6aa9c） ──────────────
const POINT_RE: Array<[HookPoint, RegExp]> = [
  ["家賃", /家賃|賃料|管理費込|[0-9０-９.,]+万円?(?:台|以内)?/], ["広さ・間取り", /帖|畳|㎡|平米|広[いさ]|間取り|1LDK|2LDK|1K|1DK|ワンルーム/],
  ["駅・場所", /駅|徒歩|エリア|周辺|線/], ["新しさ", /築|新築|リフォーム|綺麗|キレイ/], ["設備", /オートロック|宅配|独立洗面|バストイレ|室内洗濯|エアコン|キッチン|ウォークイン|WIC|収納|駐車場|ペット/],
  ["初期費用", /初期費用|敷金|礼金|仲介手数料|御?見積|割引/], ["空き・入居", /空[きい]|募集|入居可能|退去予定|即入居|完成予定/], ["キャンペーン", /キャンペーン|フリーレント/],
];
const pointsOf = (t: string) => POINT_RE.filter(([, re]) => re.test(t)).map(([p]) => p);
const Q_RE = /[?？]|でしょうか(?!😊)|ございますか|頂けますか|いかが|如何|ご都合|お聞かせ|教えて/;
const PROMISE_RE = /(?:確認|ピックアップ|お送り|ご連絡|お調べ|作成)(?:させて|致し|いたし)(?:頂き|いただき)?ます/;
const INVITE_RE = /ご案内させて|ご内覧(?:頂|いただ)|内見(?:頂|いただ|させて)|お申込(?:み)?(?:し|で)|お部屋(?:を)?(?:抑|押さ)え/;
const PROPOSAL_RE = /オススメ|おすすめ|お勧め|特に|如何でしょうか/;
const PROPERTY_RE = /号室|🌟|（オススメポイント）|室内イメージ|suumo\.jp|homes\.co\.jp/;

export function splitOurSend(text: string): OurSendPart[] {
  const sents = String(text ?? "").split(/(?<=[！!。？?])\s*|\n+/).map((s) => s.trim()).filter((s) => s.length >= 4);
  const out: OurSendPart[] = [];
  for (const s of sents) {
    if (/^(?:YUMAさん)?お世話になっております|^何卒よろしく|^お手隙の際に|^かしこまりました|^はい/.test(s) && s.length < 25) continue;
    const kind: OurSendPartKind = PROPERTY_RE.test(s) ? "property" : Q_RE.test(s) && !INVITE_RE.test(s) ? "question" : INVITE_RE.test(s) ? "invite" : PROMISE_RE.test(s) ? "promise" : PROPOSAL_RE.test(s) ? "proposal" : "fact";
    out.push({ kind, sub: subOfPart(kind, s), text: s.slice(0, 120), points: pointsOf(s) });
  }
  return out;
}

// ─── お客様の今の一通から、部分ごとの受け取られ方・刺さりを読む（網） ─────────────────────────
const ACK_RE = /^(?:はい|了解|承知|わかりました|分かりました|かしこまり|ありがとうございます|よろしくお願いします|お願いします)/;
const HOOK_DECIDE_RE = /ここにしたい|ここがいい|決めたい|申し?込み?(?:し|を)?たい|抑えて|押さえて/;
const HOOK_STRONG_RE = /すごく|めっちゃ|かなり|最高|ピッタリ|ぴったり|理想|いいですね|良いですね|素敵|綺麗ですね|やす[！!]|安い/;
const HOOK_CURIOUS_RE = /気になり|気になる|いいかも|良さそう|見てみたい|内見|内覧/;
const NOT_HOOK_RE: Array<[HookPoint, RegExp]> = [["家賃", /高い|予算|上限超|高すぎ/], ["駅・場所", /遠い|上過ぎ|場所が|エリアが/], ["広さ・間取り", /狭い|狭く|広さが/], ["初期費用", /初期費用(?:が|こんなに)|ネック/], ["新しさ", /古い|古すぎ/], ["設備", /無いの|ないのが気|エアコンない/]];

function overlap(a: string, b: string): boolean {
  const keys = (a.match(/[一-龠ァ-ヶー]{2,}/g) ?? []).filter((k) => !/させて|頂き|致し|お送り|ご確認|お部屋|部屋|物件|こちら|気に召|都合/.test(k));
  return keys.some((k) => b.includes(k));
}

export function readUptake(parts: readonly OurSendPart[], customer: string): PartUptake[] {
  const c = String(customer ?? "");
  const cq = /[?？]|ですか|ますか|でしょうか/.test(c);
  const ackOnly = ACK_RE.test(c.trim()) && c.trim().length < 40 && !cq;
  return parts.map((p) => {
    const touched = overlap(p.text, c) || p.points.some((pt) => pointsOf(c).includes(pt));
    let uptake: UptakeKind;
    if (p.kind === "question") uptake = touched || (!cq && c.trim().length > 0 && !ackOnly) ? "answered" : "passed";
    else if (p.kind === "fact" && touched && cq) uptake = "asked_again";
    else if (p.kind === "promise" && /お願い(?:します|致します)|して(?:頂け|いただけ|もらえ)/.test(c) && !touched && !ackOnly) uptake = "misread";
    else if (touched) uptake = "answered";
    else uptake = ackOnly ? "accepted" : "passed";
    const pu: PartUptake = { part: p, uptake };
    if (p.kind === "property" || p.kind === "proposal") {
      const nh = NOT_HOOK_RE.find(([, re]) => re.test(c));
      const degree: HookDegree | null = HOOK_DECIDE_RE.test(c) ? "decide" : HOOK_STRONG_RE.test(c) ? "strong" : HOOK_CURIOUS_RE.test(c) ? "curious" : null;
      const cue = (c.match(HOOK_DECIDE_RE) ?? c.match(HOOK_STRONG_RE) ?? c.match(HOOK_CURIOUS_RE) ?? (nh ? c.match(nh[1]) : null))?.[0] ?? null;
      const hitPoint = pointsOf(c).find((pt) => p.points.includes(pt)) ?? null;
      pu.hook = nh ? { kind: "not_hooked", degree: null, point: null, reason: nh[0], cue } : degree ? { kind: "hooked", degree, point: hitPoint, reason: null, cue } : { kind: "neutral", degree: null, point: null, reason: null, cue: null };
    }
    return pu;
  });
}

// ─── 竹内さんの返し方（伝わっていない・流された部分があった番） ─────────────────────────────
export const REPAIR_KINDS = ["rephrase", "ask_again", "move_on", "drop"] as const; // 言い換えてもう一度／聞き直す／先に進む（答えて次へ）／触れない
export type RepairKind = typeof REPAIR_KINDS[number];
export function takeuchiRepairOf(gaps: readonly PartUptake[], takeuchi: readonly string[]): { kind: RepairKind; sentence: string | null } {
  const t = takeuchi.join("\n");
  for (const g of gaps) {
    if (g.part.kind === "question" && Q_RE.test(t)) return { kind: "ask_again", sentence: takeuchi.find((s) => Q_RE.test(s)) ?? null };
    if (overlap(g.part.text, t)) return { kind: "rephrase", sentence: takeuchi.find((s) => overlap(g.part.text, s)) ?? null };
  }
  return { kind: takeuchi.length ? "move_on" : "drop", sentence: null };
}

// ─── ブレインの欄（事実の欄・次の一手の言葉を入れない） ──────────────────────────────────
export const OUR_SEND_UPTAKE_FIELD = `"our_send_uptake": [{"part": "こちらの直前の送信の部分を短く（30字以内）", "kind": "question|fact|promise|proposal|invite|property", "uptake": "answered（答えた・触れた）|passed（触れずに流した）|asked_again（説明済みの事をもう一度聞いた）|misread（取り違えた・約束を依頼と取った 等）|accepted（了承した）", "hook": "property・proposal の部分だけ: hooked|neutral|not_hooked（無ければ null）", "degree": "hooked の時: curious（気になる）|strong（かなり）|decide（決めたい）", "point": "刺さった・刺さらなかった物件の点: 家賃|広さ・間取り|駅・場所|新しさ|設備|初期費用|空き・入居|条件の合い方|キャンペーン", "cue": "そう読んだお客様の言葉そのまま（20字以内）"}]`;
export const OUR_SEND_UPTAKE_RULES = `【こちらの直前の送信の受け取られ方（our_send_uptake・事実の欄）】こちらの直前の送信を部分（聞いた事・伝えた事実・約束・提案・誘い・送った物件）に分け、お客様の今の一通が部分ごとにどう受け取ったかを書く（最大5つ）。2つ聞いたのに1つだけ答えた＝残りは passed／説明済みの事をもう一度聞いた＝asked_again／約束を依頼と取った・別の物件と取り違えた＝misread。物件・提案の部分は、刺さったか（点と強さとお客様の言葉）も書く。ここには事実だけを書き、どう返すか・どこへつなぐかは書かない。`;

export type OurSendUptakeRow = { part: string; kind: OurSendPartKind; uptake: UptakeKind; hook: HookKind | null; degree: HookDegree | null; point: HookPoint | null; cue: string | null };
export function normalizeOurSendUptake(raw: unknown): OurSendUptakeRow[] | null {
  if (!Array.isArray(raw)) return null;
  const pick = <T extends string>(v: unknown, xs: readonly T[]): T | null => (typeof v === "string" && (xs as readonly string[]).includes(v.trim()) ? (v.trim() as T) : null);
  const out: OurSendUptakeRow[] = [];
  for (const r of raw.slice(0, 5)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const kind = pick(o.kind, OUR_SEND_PART_KINDS), uptake = pick(o.uptake, UPTAKE_KINDS);
    if (!kind || !uptake) continue;
    const hook = kind === "property" || kind === "proposal" ? pick(o.hook, HOOK_KINDS) : null;
    out.push({ part: String(o.part ?? "").trim().slice(0, 40), kind, uptake, hook, degree: hook === "hooked" ? pick(o.degree, HOOK_DEGREES) : null, point: hook ? pick(o.point, HOOK_POINTS) : null, cue: typeof o.cue === "string" && o.cue.trim() ? o.cue.trim().slice(0, 24) : null });
  }
  return out.length ? out : null;
}
export function ourSendUptakeDigest(rows: readonly OurSendUptakeRow[] | null | undefined): string | null {
  if (!rows?.length) return null;
  return rows.map((r) => `${r.kind[0]}${r.uptake === "answered" ? "○" : r.uptake === "passed" ? "－" : r.uptake === "asked_again" ? "？" : r.uptake === "misread" ? "✕" : "了"}${r.hook === "hooked" ? `刺${r.degree?.[0] ?? ""}` : r.hook === "not_hooked" ? "外" : ""}`).join(",");
}

/** 刺さった部分 → 文の統括の主・誘導先（道が決まった後で文の統括が読む表・作業員10 の compose-sentence-plan と共有）。
 *  数は竹内さんの198通（scripts/audit-our-send-uptake.ts）で確かめる。強さの上限は next-move-types.strengthCeiling が先。 */
export const HOOK_TO_COMPOSE: ReadonlyArray<{ when: string; mainRole: string; lead: NextDest; strength: NextStrength; why: string }> = [
  { when: "広さ・間取り・設備に刺さった（かなり）", mainRole: "trust", lead: "viewing", strength: "invite", why: "実物を見れば決められる段。竹内さんは刺さった点を言い直して内覧の日時へ" },
  { when: "初期費用・家賃に刺さった（安い・やす！）", mainRole: "trust", lead: "estimate", strength: "invite", why: "総額を見せると決めやすい。見積書→内覧の順（費用に刺さった番の竹内さんの次の一手は見積・内覧）" },
  { when: "決めたい（ここにしたい・抑えて）", mainRole: "apply", lead: "apply", strength: "strong", why: "合図に即答して抑える（取られる不安が潜在）" },
  { when: "気になる（気になります・良さそう）", mainRole: "uke", lead: "viewing", strength: "door", why: "まだ迷い。扉だけ開けて急かさない" },
  { when: "刺さらない（予算・場所・広さが合わない）", mainRole: "keep", lead: "keep_send", strength: "none", why: "合わなかった点を外して探す約束。合わない物件で押さない" },
  { when: "どこにも触れずに流した（反応が薄い）", mainRole: "uke", lead: "door", strength: "door", why: "刺さっていない時は内覧に誘わない（竹内さんの決まり）" },
];
