// app/lib/compose-order-table.ts — 文の統括の「型ごとの組み立ての表」（竹内さんの198通の文の役目の並びから・純関数・既定 off）
//
// 2026-11-12 作業員10（統括役・竹内さん 11/12「文の統括がしっかりブレインの統括のように細分化してまとめれればより強化される」）。
//   ブレインの統括の「確認の順番・判断の順番」の型（作業員16 check-order.ts の T1〜T11＝場面×状態）と同じ型で、文の側の組み立てを決める:
//     どの役目の文を・どの順で・どれを主に・なぜ（竹内さんの実例の数）・押す強さ・締め。道（返信か AIX か）は決め直さない（受け取った設計図の行を並べ替えるだけ）。
//   表の元: exam-cache/anatomy-roles/roles-r1.json（作業員5 の198通の文の役目・3回読みの多数）× anatomy-seven/seven-all198.json（押す／待つ）。
//     型は場面（resolveReplyScene）と主の役目で決める: conditions→T1／question で主が確かめる約束→T3・それ以外→T2／property_share→T4／ack→T5／considering→T6／
//     viewing→T7／cost→T8／apply→T9（T10 結果がある・T11 初回の聞き取りは198通に組が無い＝表に無い）。
//     order＝その型で2割以上の通に出た役目を、1通の中の平均の位置の順に（挨拶・受け・締めを除く）。
//   使い方（COMPOSE_ORDER_TABLE=on）: 設計図の従の行を型の順に並べ替える（主は先のまま）・誘導の行に押す強さが無ければ型の多い形・締めを付けるかの1行。
//     判断の根拠（型・並べた順・主にした文となぜ）は off の時も digest.compose_plan に残す（書き手には渡さない）。
//   1通か2通か: 198通は返信の1通だけ（AIX の番は数えていない）＝表では決めない（2通は two-message-plan・ブレインの組み合わせが決める）
// テスト: npx tsx app/lib/__tests__/compose-order-table.test.ts
import type { SentenceRole } from "./takeuchi-anatomy-roles";
import { ROLE_LABEL } from "./takeuchi-anatomy-roles";
import type { SentencePlan, TurnUnderstanding } from "./compose-sentence-plan";

type Env = Record<string, string | undefined>;
export function composeOrderTableOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.COMPOSE_ORDER_TABLE ?? "").trim().toLowerCase() === "on";
}

export type OrderRow = { n: number; order: SentenceRole[]; main: string; mainN: number; closeN: number; lead: string; leadN: number; push: string; pushN: number };
/** 型 → 竹内さんの組み立て（2026-11-12・198通の数え） */
export const COMPOSE_ORDER_TABLE: Readonly<Record<string, OrderRow>> = {
T1_conditions_first: { n: 22, order: ["keep","trust","barrier"] as SentenceRole[], main: "keep", mainN: 20, closeN: 13, lead: "keep", leadN: 18, push: "none", pushN: 21 }, // 役目の出た数 keep:20 trust:15 barrier:7
  T2_question_fact: { n: 18, order: ["keep","answer","viewing","trust"] as SentenceRole[], main: "answer", mainN: 5, closeN: 5, lead: "ask_send", leadN: 4, push: "none", pushN: 11 }, // 役目の出た数 keep:5 answer:10 viewing:4 trust:5
  T3_question_staff_only: { n: 4, order: ["answer","promise","worry"] as SentenceRole[], main: "promise", mainN: 4, closeN: 1, lead: "keep", leadN: 2, push: "none", pushN: 3 }, // 役目の出た数 answer:1 promise:4 worry:1
  T4_property_shared: { n: 22, order: ["trust","promise","answer","estimate","keep"] as SentenceRole[], main: "promise", mainN: 8, closeN: 4, lead: "keep", leadN: 10, push: "none", pushN: 14 }, // 役目の出た数 trust:7 promise:14 answer:6 estimate:7 keep:7
  T5_ack_hypothesis: { n: 22, order: ["viewing","keep"] as SentenceRole[], main: "viewing", mainN: 5, closeN: 12, lead: "keep", leadN: 8, push: "none", pushN: 20 }, // 役目の出た数 viewing:5 keep:6
  T6_considering: { n: 22, order: ["keep","viewing","trust"] as SentenceRole[], main: "keep", mainN: 11, closeN: 5, lead: "keep", leadN: 10, push: "none", pushN: 17 }, // 役目の出た数 keep:14 viewing:7 trust:5
  T7_viewing: { n: 22, order: ["promise","answer","viewing"] as SentenceRole[], main: "viewing", mainN: 7, closeN: 3, lead: "viewing", leadN: 12, push: "none", pushN: 14 }, // 役目の出た数 promise:5 answer:12 viewing:8
  T8_cost: { n: 22, order: ["answer","keep","barrier","trust"] as SentenceRole[], main: "answer", mainN: 8, closeN: 4, lead: "keep", leadN: 7, push: "none", pushN: 13 }, // 役目の出た数 answer:9 keep:9 barrier:6 trust:6
  T9_apply_signal: { n: 22, order: ["answer","viewing","apply","worry"] as SentenceRole[], main: "apply", mainN: 8, closeN: 3, lead: "apply", leadN: 10, push: "mid", pushN: 9 }, // 役目の出た数 answer:11 viewing:6 apply:8 worry:5
};
const SCENE_TYPE: Record<string, string> = { conditions: "T1_conditions_first", property_share: "T4_property_shared", ack: "T5_ack_hypothesis", considering: "T6_considering", viewing: "T7_viewing", cost: "T8_cost", apply: "T9_apply_signal" };
/** 型を決める（場面×主の役目・決まった計算。道は使わない） */
export function orderTypeOf(scene: string | null | undefined, mainRole: SentenceRole | null | undefined): string | null {
  if (!scene) return null;
  if (scene === "question") return mainRole === "promise" ? "T3_question_staff_only" : "T2_question_fact";
  return SCENE_TYPE[scene] ?? null;
}
const PUSH_JA: Record<string, string> = { none: "押さない", weak: "弱（お気に召されましたら）", mid: "中（如何でしょうか・時間枠）", strong: "強（推奨・抑えましょうまで）" };
/** 主にした文のなぜ（どの読みから主を決めたか） */
export function mainWhyOf(u: TurnUnderstanding): string {
  const src = u.src.main;
  return src === "turn_read" ? "一通の読み（主と従）の主" : src === "turn_contract" ? "依頼の一番（turn_contract の lead_with）" : src === "intent" ? "お客様の意図" : "主なし";
}
export type OrderBasis = { type: string | null; order: SentenceRole[]; main: SentenceRole | null; mainWhy: string; why: string; applied: boolean };
/** 判断の根拠（off でも作る）と、on の時の並べ替え・注記の行 */
export function applyOrderTable(p: SentencePlan, u: TurnUnderstanding, scene: string | null | undefined, env?: Env): { plan: SentencePlan; basis: OrderBasis; noteLine: string } {
  const main = p.rows.find((r) => r.rank === "main") ?? null;
  const type = orderTypeOf(scene, main?.role ?? null);
  const row = type ? COMPOSE_ORDER_TABLE[type] : undefined;
  const on = composeOrderTableOn(env) && !!row && !!main;
  let rows = p.rows;
  if (on && row) {
    const idx = (r: SentenceRole) => { const i = row.order.indexOf(r); return i < 0 ? row.order.length : i; };
    const subs = p.rows.filter((r) => r.rank === "sub").map((r, k) => ({ r, k })).sort((a, b) => idx(a.r.role) - idx(b.r.role) || a.k - b.k).map((x) => x.r);
    rows = [...p.rows.filter((r) => r.rank === "main"), ...subs].map((r) => {
      if (r.rank === "sub" && ["viewing", "apply", "estimate"].includes(r.role) && !(r.how ?? "").includes("押す強さ") && !(r.how ?? "").includes("押さない")) return { ...r, how: [r.how, `押す強さ（この型の竹内さんの多い形 ${row.pushN}/${row.n}）: ${PUSH_JA[row.push] ?? row.push}`].filter(Boolean).join("／") };
      return r;
    });
  }
  const basis: OrderBasis = {
    type, order: rows.map((r) => r.role), main: main?.role ?? null, mainWhy: mainWhyOf(u),
    why: row ? `竹内さんの${type} ${row.n}通: 並び ${row.order.join(">")}・主 ${row.main} ${row.mainN}/${row.n}・誘導 ${row.lead} ${row.leadN}/${row.n}・締め ${row.closeN}/${row.n}` : "型の表に無い（198通に組が無い場面）",
    applied: on,
  };
  const noteLine = on && row ? `- この番の型（${type}・竹内さんの${row.n}通）: 従は ${row.order.map((r) => ROLE_LABEL[r]).join("→")} の順。締め（何卒 等）は${row.closeN * 2 >= row.n ? `付けるのが多い（${row.closeN}/${row.n}）` : `無しが多い（付けたのは ${row.closeN}/${row.n}）`}` : "";
  return { plan: { ...p, rows }, basis, noteLine };
}
/** digest に足す判断の根拠（短い形） */
export function orderBasisDigest(b: OrderBasis): string {
  return `型=${b.type ?? "-"}${b.applied ? "(on)" : ""}｜順=${b.order.join(">") || "-"}｜主=${b.main ?? "-"}（${b.mainWhy}）`;
}

// ── 文の要素ごとの型（2026-11-12 作業員10・竹内さん「細分化してあたるように強化していく・ブレインとも連動していく」） ─────────────
//   要素: 押す線（押さえ方）・信頼の作り方・潜在の不安への一文・次へのつなぎ（next-move-types の行き先×強さ×時機）。
//   数は竹内さんの198通（anatomy-roles/roles-r1 の文 × anatomy-seven/seven-all198 の押す・潜在）で、型の言葉が文に出た通の数（2026-11-12）。
//   選ぶのはブレインの欄だけ（fields に書いた欄・BRAIN_FIELD_ROUTE で plan の欄）。決まった計算はブレインの欄を読むだけ＝判断はブレイン基準。
//   スイッチ COMPOSE_ELEMENT_TYPES=on（既定 off）で、選んだ型を設計図の行の「どうやって」に添える（文は写さない＝言葉の型と役目だけ）。
export type ElementKind = "push_line" | "trust" | "latent_line";
export type ElementType = {
  id: string; element: ElementKind; name: string;
  /** どのブレインの欄で選ぶか（brain-core の欄の名前） */
  fields: string[];
  cue: string; why: string;
  /** 竹内さんの198通で型の言葉が出た通の数と、その文の役目（多い順） */
  count: number; roles: string;
  /** その型の言葉（物差しで竹内さんの文から型を読む時にも使う） */
  re: RegExp;
  /** 文の意味＝相手のどの不安・気持ち・考えに効くか（役目は「文が何をするか」・ここは「相手に何の意味があるか」） */
  meaning?: { mind: string; effect: string };
};
export const ELEMENT_TYPES: readonly ElementType[] = [
  { id: "P_hold_first", element: "push_line", name: "先に申込で抑える（抑えた状態で内覧）", fields: ["latent_read", "customer_concern", "appeal_timing", "seven_read"], cue: "潜在＝先に取られる・待つ間に埋まる／訴求のタイミング＝申込", why: "決める前に取られる不安を、先に抑える道で消す（押す強さは物件の残り×決める合図）", count: 19, roles: "apply 11・answer 4・barrier 3", re: /抑え(?:た状態|てから|る事が)|先にお申込|お?申込(?:み)?(?:し|で)お?部屋(?:を)?抑え/, meaning: { mind: "取られる不安（決める前に埋まる）", effect: "先に確保できる＝急ぐ理由と安心" } },
  { id: "P_one_room", element: "push_line", name: "1部屋のみの募集", fields: ["turn_contract", "seven_read", "latent_read"], cue: "物件の事実に1部屋のみ（資料・答え・先回りの事実）", why: "物件の残りの事実で決める理由を作る（事実がある時だけ）", count: 5, roles: "apply 3・worry 1", re: /1部屋のみ|1部屋しか|残り1部屋|この1部屋/, meaning: { mind: "取られる不安", effect: "急ぐ理由（残りが少ない事実）" } },
  { id: "P_fill_soon", element: "push_line", name: "すぐ埋まる可能性", fields: ["customer_concern", "latent_read", "turn_contract"], cue: "お客様が埋まるかを聞いた・潜在＝先に取られる", why: "埋まる可能性を正直に言い、待つ間の不安に答える", count: 4, roles: "worry 4", re: /埋ま(?:る|って)|お問い合わせが多|お申込が入る/, meaning: { mind: "待つ間に埋まらないか", effect: "正直な見通し＝信頼" } },
  { id: "P_no_cancel_fee", element: "push_line", name: "審査通過までキャンセル料がかからない線", fields: ["appeal_timing", "seven_read"], cue: "申込へ押す番（訴求のタイミング＝申込・押す強さ 強）", why: "申込の壁（費用の不安）を下げる", count: 3, roles: "barrier 3", re: /キャンセル料(?:が)?(?:かか|発生)(?:り|し)?ません|キャンセル料かかりません|キャンセルも可能/, meaning: { mind: "申込んで後悔しないか・お金を失わないか", effect: "壁が下がる＝試しに申込める" } },
  { id: "P_vacate_soon", element: "push_line", name: "退去予定・内覧できる時期", fields: ["property_state", "turn_contract"], cue: "物件が退去予定・まだ内覧できない", why: "内覧できない間の進め方（時期と抑える道）を先に言う", count: 4, roles: "promise 1", re: /退去予定|ご内覧可能(?:日|に)|内覧できない/, meaning: { mind: "見られないまま決めて大丈夫か", effect: "先が見える（時期と道）" } },
  { id: "R_company_fact", element: "trust", name: "会社の事実（最大限割引・手数料・還元）", fields: ["customer_concern", "latent_read", "turn_contract", "latent_intent", "three_layer"], cue: "潜在＝費用・総額／費用の問い", why: "安さの理由を会社の事実で示して信用を作る", count: 27, roles: "estimate 12・barrier 9・answer 3", re: /最大限割引|仲介手数料|手数料|弊社では|還元|前家賃/, meaning: { mind: "安すぎて裏が無いか・本当に安くなるか", effect: "理由が分かる＝信頼" } },
  { id: "R_numbers", element: "trust", name: "数字・日付・件数で示す", fields: ["turn_contract", "seven_read"], cue: "答えの中身に数字（日数・金額・件数）", why: "曖昧にせず数字で言い切る", count: 48, roles: "keep 16・answer 11・barrier 6・promise 6", re: /\d+[%％]|\d+日|\d+万|\d+円|\d+件/, meaning: { mind: "曖昧にされていないか", effect: "具体が分かる＝信頼" } },
  { id: "R_quick", element: "trust", name: "すぐ動く約束（確認出来次第・明日一番）", fields: ["turn_contract", "now_vs_later", "latent_read", "latent_intent"], cue: "主が確かめる約束・こちらの開いている事", why: "手間と早さを見せて待ってもらう", count: 30, roles: "keep 14・promise 11・estimate 4", re: /明日一番|本日中|すぐに|至急|確認出来次第|出来次第/, meaning: { mind: "待たされないか・後回しにされないか", effect: "動いてくれる＝安心" } },
  { id: "R_support", element: "trust", name: "サポートの姿勢（全力でサポート）", fields: ["turn_contract", "seven_read", "latent_read"], cue: "条件の番（探す約束）・初回", why: "条件の番の信頼の芯（了承・検討の番には足さない）", count: 24, roles: "trust 17・keep 6", re: /全力でサポート|最善のサポート|ご満足頂/, meaning: { mind: "見つかるまで付き合ってくれるか", effect: "見捨てられない＝関係が続く" } },
  { id: "R_honest", element: "trust", name: "正直にずれ・弱点を先に言う", fields: ["seven_read", "latent_read", "latent_intent", "three_layer"], cue: "7つの欄の信頼の作り方＝honest_weak", why: "合わない所を先に言って信用を守る（198通では少ない）", count: 1, roles: "barrier 1", re: /正直|ではない(?:のですが|ですが)|ないのですが/, meaning: { mind: "隠されていないか", effect: "弱点も言う＝信頼" } },
  { id: "L_guarantor", element: "latent_line", name: "審査→独立系・別の保証会社", fields: ["latent_read", "customer_concern", "customer_mindset"], cue: "潜在＝審査で落ちる・保証会社", why: "審査の不安に保証会社の事実で先回り", count: 9, roles: "answer 5・barrier 3・worry 2", re: /独立系|保証会社/, meaning: { mind: "審査で落ちて第一候補を逃さないか", effect: "通る道がある＝安心" } },
  { id: "L_estimate", element: "latent_line", name: "総額→最大限割引の御見積書", fields: ["latent_read", "customer_concern"], cue: "潜在＝費用・総額が見えない", why: "総額の不安を見積書で見せる", count: 17, roles: "estimate 13・answer 4", re: /御見積|見積書|お見積/, meaning: { mind: "総額が見えない・予算を超えないか", effect: "総額が見える＝決められる" } },
  { id: "L_freerent", element: "latent_line", name: "費用→敷金礼金なし・フリーレント", fields: ["latent_read", "customer_concern", "turn_contract"], cue: "潜在＝費用・物件の事実にフリーレント等", why: "費用の不安を物件の事実で下げる（事実がある時だけ）", count: 6, roles: "answer 3・barrier 3", re: /フリーレント|敷金礼金(?:0|なし|無し)/, meaning: { mind: "初期費用が高くないか", effect: "下げる事実がある＝前に進める" } },
  { id: "L_card", element: "latent_line", name: "一度に払えない→カードの分割（3.24%）", fields: ["latent_read", "customer_concern", "turn_contract"], cue: "潜在＝初期費用を一度に払えない・分割の問い", why: "払い方の不安に会社の事実で答える", count: 4, roles: "answer 4", re: /クレジットカード|カード/, meaning: { mind: "一度に払えない", effect: "払い方がある＝前に進める" } },
  { id: "L_new_arrival", element: "latent_line", name: "見つからない→ピックアップ・新着で送る", fields: ["latent_read", "turn_contract", "seven_read"], cue: "潜在＝条件に合う部屋が見つかるか・探す条件の番", why: "見つからない不安に送り続ける約束で答える", count: 56, roles: "keep 50", re: /新着|ピックアップ/, meaning: { mind: "合う部屋が見つかるか", effect: "送り続けてくれる＝待てる" } },
];
export function composeElementTypesOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.COMPOSE_ELEMENT_TYPES ?? "").trim().toLowerCase() === "on";
}
const objOf = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
/** ブレインの欄から読む手がかり（決まった計算はここだけ・ブレインの欄の言葉を読む） */
export function elementCuesOf(meta: unknown): { latent: string; facts: string; applyPush: boolean; promiseMain: boolean; conditions: boolean; notViewable: boolean; honest: boolean; asksNumbers: boolean } {
  const m = objOf(meta) ?? {};
  const lr = objOf(m.latent_read), sr = objOf(m.seven_read), cc = objOf(m.customer_concern), at = objOf(m.appeal_timing), tc = objOf(m.turn_contract), ps = objOf(m.property_state);
  const asks = Array.isArray(tc?.asks) ? (tc!.asks as unknown[]).map((a) => objOf(a)).filter((a): a is Record<string, unknown> => !!a) : [];
  const tl = objOf(m.three_layer);
  const latent = [JSON.stringify(lr ?? ""), JSON.stringify(objOf(sr?.latent) ?? ""), cc ? `${cc.topic ?? ""} ${cc.object ?? ""}` : "", typeof m.latent_intent === "string" ? m.latent_intent : "", JSON.stringify(objOf(m.customer_mindset)?.anxiety ?? ""), tl ? `${tl.worry ?? ""} ${tl.relief ?? ""}` : ""].join(" ");
  const facts = [...asks.map((a) => `${a.answer ?? ""}`), JSON.stringify(objOf(sr?.latent)?.fact ?? ""), JSON.stringify(objOf(sr?.appeal) ?? ""), typeof lr?.fact === "string" ? lr.fact : ""].join(" ");
  const push = objOf(sr?.push);
  return {
    latent, facts,
    applyPush: (at?.kind === "apply" && (at.level === "must" || at.level === "suggest")) || (push?.push === true && (push.strength === "strong" || push.strength === "mid")),
    promiseMain: asks[typeof tc?.lead_with === "number" ? (tc.lead_with as number) : 0]?.route === "promise",
    conditions: asks.some((a) => a.about === "search_condition"),
    notViewable: ps?.notViewable === true || !!ps?.vacancyDate,
    honest: Array.isArray(sr?.trust_how) && (sr!.trust_how as unknown[]).includes("honest_weak"),
    asksNumbers: asks.some((a) => /\d/.test(String(a.answer ?? ""))),
  };
}
/** 型を選ぶ（要素ごとに当たる物を件数の多い順に最大2つ）。手がかりはブレインの欄だけ */
export function pickElementTypes(meta: unknown): Record<ElementKind, string[]> {
  const c = elementCuesOf(meta);
  const taken = /埋ま|取られ|逃|先に取られる/.test(c.latent), cost = /費用|初期|総額|払|家賃/.test(c.latent), screen = /審査|保証|落ち/.test(c.latent), find = /見つから|合う部屋|他の物件|新着/.test(c.latent);
  const hit: Record<string, boolean> = {
    P_hold_first: taken || c.applyPush, P_one_room: /1部屋/.test(c.facts), P_fill_soon: taken && /埋ま/.test(c.latent), P_no_cancel_fee: c.applyPush && /キャンセル/.test(c.facts), P_vacate_soon: c.notViewable,
    // 2026-11-12 信頼の作り方はブレインに欄が無い（7つの欄の trust_how は案A の振り返りだけ）＝潜在の4欄・3段・気持ちの言葉からも選ぶ
    R_company_fact: cost || /安すぎ|裏|本当に安|なぜ安/.test(c.latent), R_numbers: c.asksNumbers, R_quick: c.promiseMain || /早く|すぐ|待たされ|後回し/.test(c.latent),
    R_support: c.conditions || find || /見捨て|付き合って|最後まで/.test(c.latent), R_honest: c.honest || /隠|本当は|信用|おとり|オトリ|騙/.test(c.latent),
    L_guarantor: screen, L_estimate: cost && !/分割|カード/.test(c.latent), L_freerent: cost && /フリーレント|敷金礼金/.test(c.facts), L_card: /分割|カード|一度に/.test(c.latent), L_new_arrival: find || c.conditions,
  };
  const out: Record<ElementKind, string[]> = { push_line: [], trust: [], latent_line: [] };
  for (const t of [...ELEMENT_TYPES].sort((a, b) => b.count - a.count)) if (hit[t.id] && out[t.element].length < 2) out[t.element].push(t.id);
  return out;
}
/** 竹内さんの1文ずつに「相手のどの不安・気持ちに効く文か」を付ける（型の言葉が出た文だけ・無い文は null＝付けない） */
export function sentenceMeaningOf(sentence: string): Array<{ id: string; mind: string; effect: string }> {
  return ELEMENT_TYPES.filter((t) => t.meaning && t.re.test(sentence)).map((t) => ({ id: t.id, mind: t.meaning!.mind, effect: t.meaning!.effect }));
}
/** 竹内さんの文から型を読む（物差しの正解の型の欄） */
export function elementTypesOfText(text: string): Record<ElementKind, string[]> {
  const out: Record<ElementKind, string[]> = { push_line: [], trust: [], latent_line: [] };
  for (const t of ELEMENT_TYPES) if (t.re.test(text)) out[t.element].push(t.id);
  return out;
}
/** 設計図に添える1行（on の時だけ・言葉の型と竹内さんの数だけ・文は写さない） */
export function elementTypesNote(picked: Record<ElementKind, string[]>, env?: Env): string {
  if (!composeElementTypesOn(env)) return "";
  const byId = new Map(ELEMENT_TYPES.map((t) => [t.id, t]));
  const part = (k: ElementKind, ja: string) => (picked[k].length ? `${ja}: ${picked[k].map((id) => `${byId.get(id)!.name}（${byId.get(id)!.meaning ? `${byId.get(id)!.meaning!.mind}→${byId.get(id)!.meaning!.effect}・` : ""}竹内さん ${byId.get(id)!.count}通）`).join("／")}` : null);
  const L = [part("push_line", "押す線"), part("trust", "信頼の作り方"), part("latent_line", "潜在の不安への一文")].filter(Boolean);
  return L.length ? `- この番に合う言葉の型（ブレインの欄から・材料に無い事実は書かない）: ${L.join("｜")}` : "";
}

// ── 送った部分のどこが刺さったか → 文の組み立て（2026-11-12 竹内さん「こちらが送った部分のどこが刺さったのか、刺さったからどう構築して次に誘導できるのか」） ─────
//   作業員16 の BRAIN_OUR_SEND_UPTAKE（送った部分ごとの刺さり＝物件の点ごと・強さ・手がかり）を受ける口。欄の名前は作業員16 の出力に揃える（今は仮: meta.our_send_uptake）。
//   受ける形（寛く読む）: 配列 か {parts: 配列}・各要素 {property|ref, point|part|aspect, strength|level（strong|mid|weak）, clue|evidence}
//   組み立て（竹内さんの2通目の型 aix-second-brain-plan と同じ考え方）: 刺さった点を主の文の推す軸に（広さ・帖・㎡は先に・階は推しの理由にしない）→
//   刺さりの強さで押さえ方と誘導先: 強＝内覧／物件の残り・退去予定があれば先に抑える線／中＝内覧の誘い／弱＝扉だけ（お手隙の際にご査収）
export type UptakePart = { property: string | null; point: string; strength: "strong" | "mid" | "weak"; clue: string | null };
export function readOurSendUptake(meta: unknown): UptakePart[] {
  const m = objOf(meta) ?? {};
  const raw = m.our_send_uptake;
  const arr = Array.isArray(raw) ? raw : Array.isArray(objOf(raw)?.parts) ? (objOf(raw)!.parts as unknown[]) : [];
  const s = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
  return arr.map((x) => objOf(x)).filter((x): x is Record<string, unknown> => !!x).map((x) => {
    const st = String(x.strength ?? x.level ?? "").trim();
    return { property: s(x.property ?? x.ref, 40), point: s(x.point ?? x.part ?? x.aspect, 40) ?? "", strength: (st === "strong" || st === "weak" ? st : "mid") as UptakePart["strength"], clue: s(x.clue ?? x.evidence, 40) };
  }).filter((x) => x.point).slice(0, 4);
}
export type UptakePlan = { axis: string[]; strongest: UptakePart["strength"] | null; lead: "viewing" | "apply" | "door" | null; pushLine: string | null; why: string };
/** 刺さった部分 → 推す軸・押さえ方・誘導先（ブレインの欄だけで決める・道は変えない） */
export function uptakePlan(meta: unknown): UptakePlan | null {
  const parts = readOurSendUptake(meta);
  if (!parts.length) return null;
  const rank = { strong: 3, mid: 2, weak: 1 } as const;
  const sorted = [...parts].sort((a, b) => rank[b.strength] - rank[a.strength]);
  const size = (p: string) => /広|帖|㎡|間取|LDK|1K|1DK|2DK/.test(p);
  const axis = [...sorted.filter((p) => size(p.point)), ...sorted.filter((p) => !size(p.point) && !/階/.test(p.point))].map((p) => (p.property ? `${p.property}の${p.point}` : p.point)).slice(0, 2);
  const c = elementCuesOf(meta);
  const strongest = sorted[0].strength;
  const remain = /1部屋/.test(c.facts) || c.notViewable;
  const lead = strongest === "strong" ? (remain ? "apply" : "viewing") : strongest === "mid" ? "viewing" : "door";
  const pushLine = strongest === "strong" && remain ? "P_hold_first" : null;
  return { axis, strongest, lead, pushLine, why: `刺さり ${sorted.map((p) => `${p.point}:${p.strength}`).join("・")}${remain ? "・物件の残り/退去予定あり" : ""}` };
}
/** 設計図に添える1行（COMPOSE_ELEMENT_TYPES=on の時だけ） */
export function uptakeNote(p: UptakePlan | null, env?: Env): string {
  if (!p || !composeElementTypesOn(env)) return "";
  const leadJa = { viewing: "内覧の誘い", apply: "先に抑える道（申込）", door: "扉だけ（お手隙の際にご査収）" } as const;
  return `- 送った部分の刺さり（ブレイン）: 主の文の推す軸＝${p.axis.join("・") || "－"}（広さを先に・階は推しの理由にしない）→ 次へ: ${p.lead ? leadJa[p.lead] : "－"}（${p.why}）`;
}
