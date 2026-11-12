// app/lib/compose-elements.ts — 文の要素の土台が無い・粗い4つ（つなぎ・押さえ方・信頼の作り方・潜在の不安）を、竹内さんの実送信から型にする（純関数・DB/LLM なし・既定 off）
//
// 2026-11-12 作業員23（竹内さん 11/12「ここの部分を具体的に強化していく」・KB 2301dbf1／親 P0 d16cfe1b「土台→細分化→状況ごとの重要」）。
//   材料は竹内さん本人の実送信（exemplar-bank 181通＝1文ずつの役目 takeuchi-anatomy-roles ＋ seven-all198 の7つの欄の読み＋seven-latent4 の潜在の4つ）。
//   ここは数えるだけ（LLM なし）。どれも「竹内さんの文の過半数（>50%）が守っている形」だけを型にし、届かない物は型にしない（fixed=false・理由と幅だけ残す）。
//   ① つなぎ: 前の文の役目 → 次の文の役目の組（答え→次の一手・答え→安心・事実→次の一手・安心→次の一手・誘い→安心・悪い知らせ→代わり・受け→本題）ごとに、
//      次の文の頭の言い方（その為・また・お気に召されましたら・言い切り 等）の幅
//   ② 押さえ方: 押さえる要点（取られる前に抑える・総額を見せる・内覧の日を決める・審査が通る道）ごとに、添える事実（next-move-detail の PlantFact）・置き場所・強さ（seven の push）
//   ③ 信頼の作り方: 信頼の手がかり（takeuchi-seven-read の TRUST_METHODS）ごとの件数と、信頼の文の骨の幅（同じ言い回しを続けない決まりの案）
//   ④ 潜在の不安: 言う5種（文型カタログの latentSay）の 手がかり（latent4 の trigger.kind）・添える事実・置き場所／言わない4種は数で理由
//   語彙は単一の出所: 役目＝takeuchi-anatomy-roles・誘導先＝LEAD_TO・要点の押さえ方／信頼＝takeuchi-seven-read・事実＝next-move-detail.PlantFact・
//   潜在＝takeuchi-exemplar の LATENT_KEYS（9種＝sentence-pattern-catalog.LATENT_NINE）・骨＝sentence-pattern-catalog.skeletonize
//   check-order の型（T1〜T12・作業員16／22）は main に入っていない＝今は 場面×誘導先 で分ける（checkType を渡せば、その型でも分ける口は用意した）
//   書き手への口は COMPOSE_ELEMENTS=on の時だけ（既定 off）。道（返信か AIX か・誘導先）が決まった後に、その道の型を添えるだけ（決め直さない）
// テスト: app/lib/__tests__/compose-elements.test.ts
import type { SentenceRole, LeadTo } from "./takeuchi-anatomy-roles";
import { TRUST_METHODS, type TrustMethod } from "./takeuchi-seven-read";
import { PLANT_FACT_JA, type PlantFact } from "./next-move-detail";
import { skeletonize, skeletonKey, LATENT_NINE } from "./sentence-pattern-catalog";
import type { LatentKey } from "./takeuchi-exemplar";

const r2 = (x: number) => Math.round(x * 100) / 100;
/** 型にする線: 竹内さんの文の過半数 */
export const MAJORITY = 0.5;
/** 型にする最少の通（これ未満は数が少なく型にしない） */
export const MIN_N = 5;

// ── 材料の形 ──
export type ElemSentence = { text: string; role: SentenceRole | null; why?: string | null };
export type ElemTurn = {
  id: string; scene: string; lead: LeadTo; latent: LatentKey; checkType?: string | null;
  sentences: ElemSentence[];
  trustHow: TrustMethod[];
  push: { push: boolean; strength: "strong" | "mid" | "weak" | null } | null;
  customer?: string | null; // お客様の発言（伏せ済み・お客様の文の種類を分けるだけに使う）
  trigger: string | null; // latent4 の trigger.kind（customer_words/scene/prev_send/property_fact）
  latentFact: string | null; // seven の latent.fact
};
/** 型の1行（fixed＝過半数が守る形か）。example＝実物1通の骨（名前・物件名・号室は差し込み欄） */
export type ElemForm = { form: string; n: number; share: number };
export type ElemType = { element: "bridge" | "press" | "trust" | "latent" | "push"; key: string; n: number; fixed: boolean; forms: ElemForm[]; detail: Record<string, ElemForm[]>; why: string | null; example: string | null; note: string };

// ── 共通 ──
const MAIN_NEXT = new Set<SentenceRole>(["viewing", "apply", "estimate", "ask_send", "keep", "promise"]);
const EASE = new Set<SentenceRole>(["worry", "trust", "barrier"]);
const BAD_NEWS = /募集(が)?終了|お申込(み)?が入|申込が入っ|埋ま(って|り)|ございませんでした|難しい|出来かね|できかね|ご紹介出来ない|空きが無/;
function dist(xs: ReadonlyArray<string>): ElemForm[] {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].map(([form, n]) => ({ form, n, share: xs.length ? r2(n / xs.length) : 0 })).sort((a, b) => b.n - a.n || a.form.localeCompare(b.form));
}
const isFixed = (n: number, forms: ElemForm[]) => n >= MIN_N && (forms[0]?.share ?? 0) > MAJORITY;
const body = (t: ElemTurn) => t.sentences.filter((s) => s.role !== "greet");

// ── ① つなぎ ──
export type BridgeKind = "answer_to_next" | "answer_to_ease" | "fact_to_next" | "ease_to_next" | "next_to_ease" | "bad_to_alt" | "uke_to_main";
export const BRIDGE_JA: Record<BridgeKind, string> = {
  answer_to_next: "答え→次の一手", answer_to_ease: "答え→安心・先回り", fact_to_next: "先回りの事実→次の一手", ease_to_next: "安心（サポートの姿勢）→次の一手",
  next_to_ease: "約束・誘い→安心", bad_to_alt: "悪い知らせ→代わり", uke_to_main: "受け→本題",
};
export function bridgeKindOf(prev: ElemSentence, next: ElemSentence): BridgeKind | null {
  const a = prev.role, b = next.role;
  if (!a || !b || a === b || b === "close" || b === "greet" || a === "greet") return null;
  if (a === "answer" && BAD_NEWS.test(prev.text) && (MAIN_NEXT.has(b) || b === "answer")) return "bad_to_alt";
  if (a === "uke") return b === "uke" ? null : "uke_to_main";
  if (a === "answer" && MAIN_NEXT.has(b)) return "answer_to_next";
  if (a === "answer" && EASE.has(b)) return "answer_to_ease";
  if ((a === "barrier" || a === "worry") && MAIN_NEXT.has(b)) return "fact_to_next";
  if (a === "trust" && MAIN_NEXT.has(b)) return "ease_to_next";
  if (MAIN_NEXT.has(a) && EASE.has(b)) return "next_to_ease";
  return null;
}
/** 次の文の頭の言い方（つなぎの言葉）。無ければ「言い切りで続ける」 */
export function connectiveOf(next: string, prev: string): string {
  const t = String(next ?? "").normalize("NFKC").replace(/^[\p{Extended_Pictographic}\u{FE0F}\s]+/u, "");
  const p = String(prev ?? "").normalize("NFKC");
  const heads: Array<[RegExp, string]> = [
    [/^(その為|そのため|ですので|なので|ので)/, "その為・ですので"], [/^(また|尚|なお|あと)/, "また・なお"], [/^(お気に召され|もし|もしも)/, "お気に召されましたら・もし"],
    [/^(引き続き)/, "引き続き"], [/^(その間|それまで)/, "その間も"], [/^(是非|ぜひ)/, "是非"], [/^(ご都合)/, "ご都合よろしい〜"],
    [/^[^。!！]{0,12}(さん|様)/, "名前で呼びかけ"], [/^(こちら|この)/, "こちらの〜"], [/^(現在|今)/, "現在〜"],
  ];
  for (const [re, f] of heads) if (re.test(t)) return f;
  if (/(ので|為|ため)[^。!！]{0,3}[!！。]*$/.test(p)) return "前の文を「〜ので」で受ける";
  return "言い切りで続ける";
}

// ── ② 押さえ方 ──
export type PressKey = "hold_before_taken" | "show_total" | "fix_viewing_date" | "screening_path";
export const PRESS_JA: Record<PressKey, string> = { hold_before_taken: "取られる前に抑える", show_total: "総額を見せる", fix_viewing_date: "内覧の日を決める", screening_path: "審査が通る道" };
const PRESS_ROLE: Record<PressKey, SentenceRole[]> = { hold_before_taken: ["apply"], show_total: ["estimate"], fix_viewing_date: ["viewing"], screening_path: ["barrier", "worry", "answer"] };
export function pressKeysOf(t: ElemTurn): PressKey[] {
  const all = t.sentences.map((s) => s.text).join("\n");
  const out: PressKey[] = [];
  if (t.lead === "apply" || t.sentences.some((s) => s.role === "apply")) out.push("hold_before_taken");
  if (t.lead === "estimate" || t.sentences.some((s) => s.role === "estimate")) out.push("show_total");
  if (t.lead === "viewing" || t.sentences.some((s) => s.role === "viewing")) out.push("fix_viewing_date");
  if (t.latent === "screening" || /審査|保証会社/.test(all)) out.push("screening_path");
  return out;
}
const PLANT_RE: Array<[PlantFact, RegExp]> = [
  ["one_room_only", /1部屋のみ|一部屋のみ|残り1部屋/], ["hold_by_apply", /お申込(み)?(し|して|頂|いただ)[^。!！]{0,12}(抑|押さ)え|先にお申込/], ["cancel_fee_free", /キャンセル料/],
  ["screening_stage", /審査(の)?(段階|期間|結果|通過|通り)/], ["max_discount", /最大限(の)?割引/], ["key_money_zero", /敷金礼金(なし|無し|0)|礼金0/], ["free_rent", /フリーレント/],
  ["move_in_date", /入居(可能)?日|30日前|ご入居時期/], ["independent_guarantor", /独立系|通りやすい保証|審査の通りやすい/], ["full_support", /全力で(お部屋探し)?サポート/],
];
export function plantFactsOf(text: string): PlantFact[] { const t = String(text ?? "").normalize("NFKC"); return PLANT_RE.filter(([, re]) => re.test(t)).map(([k]) => k); }
/** 文の置き場所（挨拶を除いた文の中で 頭／中／終わり。締めは数えない） */
export function positionOf(idx: number, len: number): "頭" | "中" | "終わり" {
  if (len <= 1 || idx === 0) return "頭";
  return idx >= len - 1 ? "終わり" : idx / (len - 1) < 0.5 ? "頭" : "中";
}

// ── お客様の文の種類（作業員10 の compose-head.ts の customerKindOf と同じ分け方。compose-head.ts が main に入ったら import に替えて重ねを消す） ──
export const CUSTOMER_KINDS = ["sent", "thanks", "considering", "request", "question", "report"] as const;
export type CustomerKind = typeof CUSTOMER_KINDS[number];
export const CUSTOMER_KIND_JA: Record<CustomerKind, string> = { sent: "送ってきた", thanks: "お礼", considering: "検討", request: "依頼", question: "問い", report: "報告・事情" };
export function customerKindOf(text: string): CustomerKind {
  const c = String(text ?? "");
  if (/\[画像\]|\[ファイル\]|https?:\/\/|ご希望のお部屋探しご条件|①【/.test(c)) return "sent";
  if (/ありがとう/.test(c) && !/[?？]|ですか|ますか/.test(c)) return "thanks";
  if (/検討/.test(c)) return "considering";
  if (/お願い|ください|下さい|したい|欲しい|ほしい|頂けますか|いただけますか|もらえ/.test(c)) return "request";
  if (/[?？]|ですか|ますか|でしょうか|かな/.test(c)) return "question";
  return "report";
}
/** q057 型の問い（内見できない・退去予定・いつから見られる）と、先に取られる不安の文 */
export const VACATING_ASK = /内見(でき|出来)(ない|ません)|内覧(でき|出来)(ない|ません)|退去予定|空き予定|いつから(内覧|内見|見)|見れ(ない|ません)|見られ(ない|ません)/;
export const TAKEN_WORRY = /埋ま|取られ|他の方(から|が|に)|お申込(み)?が(はい|入)|先にお申込|抑え|押さえ/;

// ── ④ 潜在 ──
export const TRIGGER_JA: Record<string, string> = { customer_words: "お客様の言葉", scene: "場面", prev_send: "前の送信", property_fact: "物件の事実", none: "手がかり無し" };

// ── 組み立て ──
export type ComposeElements = { builtAt: string; n: number; types: ElemType[]; latentNo: Array<{ latent: string; n: number; wrote: number; rate: number; why: string }>; trustRepeat: { rule: string; measured: string } };

export function buildComposeElements(turns: ReadonlyArray<ElemTurn>, o: { propertyNames?: ReadonlyArray<string>; latentSay?: ReadonlyArray<string>; now?: string } = {}): ComposeElements {
  const pn = o.propertyNames ?? [];
  const sk = (t: string) => skeletonize(t, pn).skeleton;
  const types: ElemType[] = [];

  // ① つなぎ（1通の中の組は種類ごとに1つ数える）
  const bridge = new Map<BridgeKind, Array<{ id: string; form: string; why: string | null; ex: string; lead: string }>>();
  for (const t of turns) {
    const b = body(t); const seen = new Set<BridgeKind>();
    for (let i = 0; i + 1 < b.length; i++) {
      const k = bridgeKindOf(b[i], b[i + 1]);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      (bridge.get(k) ?? bridge.set(k, []).get(k)!).push({ id: t.id, form: connectiveOf(b[i + 1].text, b[i].text), why: b[i + 1].why ?? null, ex: `${sk(b[i].text)} → ${sk(b[i + 1].text)}`, lead: t.lead });
    }
  }
  for (const [k, list] of bridge) {
    const forms = dist(list.map((x) => x.form));
    const rep = list.find((x) => x.form === forms[0]?.form) ?? list[0];
    const fixed = isFixed(list.length, forms);
    types.push({ element: "bridge", key: k, n: list.length, fixed, forms, detail: { 誘導先: dist(list.map((x) => x.lead)) }, why: rep?.why ?? null, example: rep?.ex ?? null,
      note: fixed ? `${BRIDGE_JA[k]}: 次の文の頭は「${forms[0].form}」が ${Math.round(forms[0].share * 100)}%` : `${BRIDGE_JA[k]}: 頭の言い方は割れている（一番多い「${forms[0]?.form}」で ${Math.round((forms[0]?.share ?? 0) * 100)}%）＝型にしない` });
  }

  // ② 押さえ方（全体と、お客様の文の種類ごと＝統括役 11/12: 場面×誘導先だけだと「検討」「お礼」の番で外れる・作業員10 の4分け 押さえ B 61）
  const kinds = CUSTOMER_KINDS;
  const pressOf = (key: PressKey, hit: ElemTurn[], tag: string) => {
    if (!hit.length) return;
    const factsAll: string[] = [], pos: string[] = [], strength: string[] = [], firstFact: string[] = [];
    let rep: { why: string | null; ex: string } | null = null;
    for (const t of hit) {
      const b = body(t).filter((s) => s.role !== "close");
      const i = b.findIndex((s) => s.role && PRESS_ROLE[key].includes(s.role) && (key !== "screening_path" || /審査|保証/.test(s.text)));
      const f = plantFactsOf(t.sentences.map((s) => s.text).join("\n"));
      firstFact.push(f[0] ? PLANT_FACT_JA[f[0]] : "事実を添えない");
      for (const x of f) factsAll.push(PLANT_FACT_JA[x]);
      pos.push(i >= 0 ? positionOf(i, b.length) : "その文が無い");
      strength.push(t.push?.push ? (t.push.strength ?? "不明") : "押さない");
      if (!rep && i >= 0) rep = { why: b[i].why ?? null, ex: sk(b[i].text) };
    }
    const facts = dist(firstFact), place = dist(pos), str = dist(strength);
    const fixedDims = [["添える事実", facts], ["置き場所", place], ["強さ", str]].filter(([, d]) => isFixed(hit.length, d as ElemForm[])).map(([n]) => n as string);
    types.push({ element: "press", key: tag ? `${key}@${tag}` : key, n: hit.length, fixed: fixedDims.length > 0, forms: facts, detail: { 置き場所: place, 強さ: str, 事実の全部: dist(factsAll) }, why: rep?.why ?? null, example: rep?.ex ?? null,
      note: `${PRESS_JA[key]}${tag ? `（お客様の文: ${CUSTOMER_KIND_JA[tag as CustomerKind]}）` : ""}: ${fixedDims.length ? `過半数が守る形＝${fixedDims.map((d) => `${d} ${d === "添える事実" ? facts[0].form : d === "置き場所" ? place[0].form : str[0].form}`).join("・")}` : `${hit.length < MIN_N ? "通が少ない" : "どの欄も割れている"}＝型にしない`}` });
  };
  for (const key of Object.keys(PRESS_JA) as PressKey[]) {
    const hit = turns.filter((t) => pressKeysOf(t).includes(key));
    pressOf(key, hit, "");
    for (const ck of kinds) pressOf(key, hit.filter((t) => customerKindOf(t.customer ?? "") === ck), ck);
  }

  // ③ 信頼の作り方（手がかりごと・信頼の文の骨の幅。お客様の文の種類ごとにも）
  const trustOf = (m: TrustMethod, hit: ElemTurn[], tag: string) => {
    if (!hit.length) return;
    // 言い回しは「信頼の文（trust・barrier）がある番」の中で数える。信頼の文が無い番＝他の文の中で信頼を作っている（その割合も残す）
    const phr: string[] = []; let rep: { why: string | null; ex: string } | null = null; let inside = 0;
    for (const t of hit) {
      const s = t.sentences.find((x) => x.role === "trust" || x.role === "barrier");
      if (!s) { inside++; continue; }
      const k = sk(s.text);
      phr.push(skeletonKey(k));
      if (!rep) rep = { why: s.why ?? null, ex: k };
    }
    const forms = dist(phr);
    // 初回の名乗り（「お部屋探し担当させて頂きます〇〇と申します」）は挨拶の段＝信頼の言い回しの型にしない（送ってきた番の多数がこれだった）
    const fixed = isFixed(phr.length, forms) && !/と申します/.test(forms[0]?.form ?? "");
    types.push({ element: "trust", key: tag ? `${m}@${tag}` : m, n: hit.length, fixed, forms: forms.slice(0, 4), detail: {
      信頼の文がある番: [{ form: `${phr.length}通`, n: phr.length, share: r2(phr.length / hit.length) }], 他の文の中で: [{ form: `${inside}通`, n: inside, share: r2(inside / hit.length) }],
      言い回しの数: [{ form: `${forms.length}通り`, n: forms.length, share: phr.length ? r2(forms.length / phr.length) : 0 }] }, why: rep?.why ?? null, example: rep?.ex ?? null,
      note: fixed ? `信頼（${m}）: 「${forms[0].form}」が ${Math.round(forms[0].share * 100)}%` : `信頼（${m}）: 信頼の文がある ${phr.length}通の言い回しは ${forms.length}通りに散る（一番多くて ${Math.round((forms[0]?.share ?? 0) * 100)}%）・${Math.round((inside / hit.length) * 100)}%は他の文の中で作る＝言い回しは型にしない・手がかりだけ渡す` });
  };
  for (const m of TRUST_METHODS) {
    const hit = turns.filter((t) => t.trustHow.includes(m));
    trustOf(m, hit, "");
    for (const ck of kinds) trustOf(m, hit.filter((t) => customerKindOf(t.customer ?? "") === ck), ck);
  }

  // ③’ 押す強さの上限（場面×お客様の文の種類ごと・統括役 11/12: つなぎの誘いの足し引き 33 は上限の分け方が粗い）
  //   強さの順 押さない < weak < mid < strong。代表＝過半数の線（中央の強さ）・上限＝竹内さんの8割がこの強さ以下
  const LV = ["押さない", "weak", "mid", "strong"];
  const lvOf = (t: ElemTurn) => (t.push?.push ? Math.max(1, LV.indexOf(t.push.strength ?? "weak")) : 0);
  const groups = new Map<string, ElemTurn[]>();
  for (const t of turns) for (const g of [`*|${customerKindOf(t.customer ?? "")}`, `${t.scene}|${customerKindOf(t.customer ?? "")}`]) (groups.get(g) ?? groups.set(g, []).get(g)!).push(t);
  for (const [g, list] of groups) {
    const lv = list.map(lvOf).sort((a, b) => a - b);
    const q = (p: number) => LV[lv[Math.min(lv.length - 1, Math.ceil(p * lv.length) - 1)]];
    const forms = dist(lv.map((x) => LV[x]));
    const [scene, ck] = g.split("|");
    types.push({ element: "push", key: g, n: list.length, fixed: list.length >= MIN_N, forms, detail: { 代表: [{ form: q(0.5), n: list.length, share: 0.5 }], 上限: [{ form: q(0.8), n: list.length, share: 0.8 }] }, why: null, example: null,
      note: `押す強さ（場面 ${scene}・お客様の文 ${CUSTOMER_KIND_JA[ck as CustomerKind] ?? ck}・${list.length}通）: 代表 ${q(0.5)}・上限 ${q(0.8)}（竹内さんの8割がこれ以下）${list.length < MIN_N ? "＝通が少なく型にしない" : ""}` });
  }

  // ④ 潜在の不安（言う型: 手がかり・事実・置き場所）
  const say = new Set(o.latentSay ?? []);
  const latentNo: ComposeElements["latentNo"] = [];
  for (const k of LATENT_NINE) {
    const all = turns.filter((t) => t.latent === k);
    const wrote = all.filter((t) => t.sentences.some((s) => s.role === "worry" || s.role === "barrier"));
    if (!say.has(k)) {
      const rate = all.length ? r2(wrote.length / all.length) : 0;
      latentNo.push({ latent: k, n: all.length, wrote: wrote.length, rate, why: all.length < MIN_N ? `通が少ない（${all.length}通）` : `竹内さんが潜在の一文を書いたのは ${wrote.length}/${all.length}（${Math.round(rate * 100)}%）＝2割未満` });
      continue;
    }
    if (!wrote.length) continue;
    const cue: string[] = [], fact: string[] = [], place: string[] = []; let rep: { why: string | null; ex: string } | null = null;
    for (const t of wrote) {
      const b = body(t).filter((s) => s.role !== "close");
      const i = b.findIndex((s) => s.role === "worry" || s.role === "barrier");
      const ans = b.findIndex((s) => s.role === "answer");
      cue.push(TRIGGER_JA[t.trigger ?? "none"] ?? String(t.trigger));
      const f = plantFactsOf(b[i]?.text ?? "");
      fact.push(f[0] ? PLANT_FACT_JA[f[0]] : t.latentFact ? "物件・会社の事実（型の外）" : "事実を添えない");
      place.push(ans < 0 ? `答えの文が無い・${positionOf(i, b.length)}` : i > ans ? "答えの後" : "答えの前");
      if (!rep && i >= 0) rep = { why: b[i].why ?? null, ex: sk(b[i].text) };
    }
    const dc = dist(cue), df = dist(fact), dp = dist(place);
    const fixedDims = [["手がかり", dc], ["添える事実", df], ["置き場所", dp]].filter(([, d]) => isFixed(wrote.length, d as ElemForm[])).map(([n]) => n as string);
    types.push({ element: "latent", key: k, n: wrote.length, fixed: fixedDims.length > 0, forms: dc, detail: { 添える事実: df, 置き場所: dp }, why: rep?.why ?? null, example: rep?.ex ?? null,
      note: `潜在（${k}・書いた ${wrote.length}/${all.length}通）: ${fixedDims.length ? `過半数が守る形＝${fixedDims.join("・")}` : `${wrote.length < MIN_N ? "通が少ない" : "どの欄も割れている"}＝型にしない`}` });
  }
  // ④’ q057 型（統括役 11/12）: 内見できない・退去予定・いつから見られるの問い → 先に取られる不安を竹内さんが書くか
  {
    const ask = turns.filter((t) => VACATING_ASK.test(t.customer ?? ""));
    const wrote = ask.filter((t) => t.sentences.some((s) => (s.role === "worry" || s.role === "barrier" || s.role === "apply") && TAKEN_WORRY.test(s.text)));
    const rate = ask.length ? r2(wrote.length / ask.length) : 0;
    const fixed = ask.length >= MIN_N && rate > MAJORITY;
    const rep = wrote[0]?.sentences.find((s) => TAKEN_WORRY.test(s.text));
    types.push({ element: "latent", key: "taken_by_vacating", n: ask.length, fixed, forms: [{ form: "先に取られる不安を書いた", n: wrote.length, share: rate }, { form: "書かない", n: ask.length - wrote.length, share: ask.length ? r2(1 - rate) : 0 }], detail: {}, why: rep?.why ?? null, example: rep ? sk(rep.text) : null,
      note: `潜在（内見できない・退去予定の問い→先に取られる）: 問いの番 ${ask.length}通のうち ${wrote.length}通（${Math.round(rate * 100)}%）が書いた${fixed ? "" : `＝${ask.length < MIN_N ? "通が少なく" : "過半数に届かず"}型にしない`}` });
  }
  return {
    builtAt: o.now ?? new Date().toISOString(), n: turns.length, types, latentNo,
    trustRepeat: { rule: "同じ会話で直近3通のこちらの文に使った信頼の文の骨（skeletonKey）は、同じ手がかりの別の言い回しに替える（無ければその文を省く）", measured: "同じ会話の中で同じ骨が続く割合は束（会話の id が無い）では数えられない＝未測定。夜（JST 22時以降）に束の番の messages.conversation_id を引き、同じ会話の竹内さんの前後3通の信頼の文の骨を比べる（読むだけ・軽く）案。数える前は決まりを型にしない（口にも出すが『案』の扱い）" },
  };
}

// ── 書き手への口（既定 off・道の後だけ・決め直さない） ──
type Env = Record<string, string | undefined>;
export const composeElementsOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.COMPOSE_ELEMENTS ?? "").trim().toLowerCase() === "on";
/** その番の注記（型になった物だけ・型にしない物は渡さない）。lead＝決まった誘導先・latent＝潜在の型・trust＝ブレインの信頼の手がかり（分かる時） */
export function composeElementsNote(ce: ComposeElements | null, key: { lead: LeadTo; latent: LatentKey; trust?: ReadonlyArray<string> | null; scene?: string | null; customerText?: string | null }, env?: Env): string | null {
  if (!ce || !composeElementsOn(env)) return null;
  const L: string[] = [];
  const ck = key.customerText != null ? customerKindOf(key.customerText) : null;
  const press = (Object.keys(PRESS_ROLE) as PressKey[]).filter((k) => (k === "hold_before_taken" && key.lead === "apply") || (k === "show_total" && key.lead === "estimate") || (k === "fix_viewing_date" && key.lead === "viewing") || (k === "screening_path" && key.latent === "screening"));
  const fixedOf = (el: ElemType["element"], k: string) => ce.types.find((t) => t.element === el && t.key === k && t.fixed) ?? null;
  for (const t of ce.types) {
    if (!t.fixed) continue;
    if (t.element === "bridge" && (t.key === "answer_to_next" || t.key === "uke_to_main" || t.key === "bad_to_alt")) L.push(`つなぎ ${t.note}`);
    if (t.element === "latent" && t.key === key.latent) L.push(t.note);
  }
  // 押さえ方・信頼: お客様の文の種類の型があればそれを先に（無ければ全体の型）
  for (const p of press) { const t = (ck && fixedOf("press", `${p}@${ck}`)) || fixedOf("press", p); if (t) L.push(`押さえ方 ${t.note}`); }
  for (const m of key.trust ?? []) { const t = (ck && fixedOf("trust", `${m}@${ck}`)) || fixedOf("trust", m); if (t) L.push(t.note); }
  // 押す強さの上限（場面×お客様の文の種類 → 無ければ全場面×種類）
  if (ck) { const t = fixedOf("push", `${key.scene ?? "*"}|${ck}`) || fixedOf("push", `*|${ck}`); if (t) L.push(t.note); }
  // q057 型（内見できない・退去予定の問い）
  if (key.customerText && VACATING_ASK.test(key.customerText)) { const t = fixedOf("latent", "taken_by_vacating"); if (t) L.push(t.note); }
  const no = ce.latentNo.find((x) => x.latent === key.latent);
  if (no) L.push(`潜在（${key.latent}）は書かない: ${no.why}`);
  if (!L.length) return null;
  // 同じ言い回しを続けない決まり（trustRepeat）は未測定の案＝口には出さない
  return [`【竹内さんの文の要素の型（過半数が守る形だけ・道は決め直さない・文は写さない）】`, ...L].join("\n");
}
