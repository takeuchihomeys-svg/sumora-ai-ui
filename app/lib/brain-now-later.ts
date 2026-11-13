// app/lib/brain-now-later.ts — 今の番と後の番を分ける欄（now_vs_later）を、ブレインの JSON の最初に置く（作業員16・2026-11-12・案1）
//
// 竹内さんの決定 11/12（KB P1 d030d496「判断の順番・確認の順番・優先度を細分化」・親 P0 575a7cd5）。型の表は app/lib/check-order.ts。
// なぜ: 今のブレインの JSON は action → reason → aix で始まり、お客様に何を言われたか（customer_questions）・依頼ごとの道（turn_contract）は後ろ。
//   その上、aix の但し書き「ピックアップの宣言があり未送付なら property_send」で、今の番に後で果たす AIX を選ぶ。
//   本番の物差し 7番中6番（11154・11264・11447・12189・12240・12306）と 2段の外れ 72行は「最初に答える・約束すべき番で、後で果たす AIX を先に選ぶ」形。
//   竹内さんの確認の順番は「何を言われたか → こちらの前の約束・送った物 → 今この場で届けられる物があるか → 返信か AIX か」。
// 置き方（道を引っぱらない・q406・q057・q065・q022 の教訓）: この欄は事実の確かめだけ（言われた事・開いている約束・今届けられる物・今の番に出す物の種類）。
//   次の番の狙い・押すか・気持ちの言葉は入れない。aix の意味（後で果たす AIX を書いてよい＝2段が約束の返信を作る材料）は変えない＝下流（two-stage）は今まで通り。
// スイッチ: BRAIN_NOW_LATER_FIRST（既定 off＝プロンプトも結果も1文字も変わらない）。on の時だけ JSON の最初に欄・但し書きの差し替え・meta.now_vs_later と meta.aix_now（記録だけ）。

type Env = Record<string, string | undefined>;

export function nowLaterFirstOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.BRAIN_NOW_LATER_FIRST ?? "").trim().toLowerCase() === "on";
}

export type NowThisTurn = "deliver" | "answer" | "promise" | "ack";
export type NowVsLater = {
  asked_now: string[];
  our_open: string | null;
  ready_now: string[];
  this_turn: NowThisTurn | null;
  /** 2026-11-13: 答えに使う事実の出所（company_fact／material_value／staff_only／none）。無ければ null */
  answer_source: AnswerSource | null;
};
/** 答えに使う事実の出所（KB 00d0d8f4「この物件の〇〇は資料＋管理会社、一般論は会社の事実」・67f54c24 確認の相手を分ける） */
export const ANSWER_SOURCES = ["company_fact", "material_value", "staff_only", "none"] as const;
export type AnswerSource = typeof ANSWER_SOURCES[number];

/** JSON の最初に置く欄（action より前） */
export const NOW_VS_LATER_FIELD = `"now_vs_later": {"asked_now": ["お客様の今の番の発言で言われた事・聞かれた事（最大3件・各30字以内・お客様の言葉に近く）。お礼・了承だけなら ['お礼・了承']"], "our_open": "こちらが前に約束した・送った物で、まだ果たしていない物（例: 'ピックアップしてお送りする約束' '募集状況を確認する約束'）。無ければ null", "ready_now": ["今この場で届けられる物を材料の行（送れる物件の候補・今すぐ果たせる物・確認の結果・御見積書の有無）から。'送れる物件' / '確認の結果' / '御見積書' のどれか。無ければ []"], "answer_source": "お客様の問いの答えに使う事実の出所を1つ: 'company_fact'（会社のルール・一般の期間・手続きの流れ・費用の仕組み＝どの物件でも同じ）/ 'material_value'（この物件の資料・会話にその値が書いてあり、その値を引用できる）/ 'staff_only'（この物件・この部屋の可否・交渉・空き・設備の変更など、資料に値が無く管理会社に確かめないと分からない）/ 'none'（問いが無い）", "this_turn": "今の番に出す物を1つ: 'deliver'（ready_now の物を今 AIX で届ける）/ 'answer'（会話・物件の資料・会社の事実で今答える）/ 'promise'（確かめる・探す・作ると約束する）/ 'ack'（お礼・了承に短く受ける）"}`;

/** 決まりの段（JSON の欄の説明の後に1段） */
export const NOW_VS_LATER_RULES = `【今の番と後の番を分ける（now_vs_later・JSON の一番最初に書く）】竹内さんは、①何を言われたか ②こちらが前に約束した・送った物 ③今この場で届けられる物があるか、を先に確かめてから返信か AIX かを決める。
- this_turn が deliver の時だけ、aix は今届ける AIX（ready_now の物）。
- this_turn が answer・ack の時は、今の番は返信で、aix は null（後で果たす AIX は書かない。開いているピックアップの約束はこの番では果たさない）。
- this_turn が promise の時だけ、aix に後で果たす AIX（property_send・estimate_sheet・condition_hearing 等）を書いてよい。turn_contract の該当の route は promise にし、reply_direction は今の番の約束の中身にする。
- this_turn は answer_source で決める（語で決め打ちしない）: company_fact・material_value＝answer（後で果たす AIX より先に今答える）／staff_only＝promise（聞かれた事そのものを確かめる約束。結果が ready_now にあれば deliver）。
- 一般論か「この物件の」可否かで分ける: 申込から入居までの期間・審査の期間・費用の仕組み＝company_fact（「物件により異なる」で約束にしない）／この部屋の畳を変えられるか・駐車場の空き・鍵交換の免除・ペットの可否で資料に書いていない物＝staff_only。
- 「資料にあればその値、無ければ確認」のような両にらみは書かない: 資料の値を引用できない時は staff_only に決める。
- 前の約束の結果が ready_now にある時は、その結果を届けるのが先（this_turn は deliver）。
- お礼・了承だけの番は、何への了承かを②（こちらの直前の送信）で決める。`;

/** aix の但し書き（ピックアップの宣言の後）の差し替え。off の時の文は brain-core に残す */
// 2026-11-13 作業員16（w16-nl-on2 の q065: 本質の道が 返信 3/4 → AIX:property_send 0/4）: 「aix は property_send のままでよい」が、
//   お客様が会社の事実で答えられる事を聞いた番（最速の入居時期）でも aix に property_send を書かせ、問いを「物件により異なる」で約束に倒していた。
//   → 今の番が問い（answer）なら aix は null。property_send を残すのは、今の番が約束（promise＝条件の言い直し・催促）の時だけ。
export const NOW_LATER_AIX_PROVISO = "この時も先に now_vs_later を確かめる。ready_now に送れる物件がある時は property_send（今届ける＝deliver）。まだ送れる物件が無い時: お客様の今の発言が問いで answer_source が company_fact・material_value なら this_turn は answer で aix は null（staff_only なら確かめる約束）（ピックアップの約束はこの番では果たさない）。条件の言い直し・催促など約束の番の時だけ aix は property_send（物件が揃ってから果たす AIX）のまま、this_turn と turn_contract の route は promise";

/** 決まり⑧の解除の一文の後半の差し替え（reply_direction を今の番の中身に） */
export const NOW_LATER_RULE8_TAIL = "この時の aix は property_send。reply_direction は now_vs_later.this_turn に合わせる（deliver＝宣言したピックアップを届ける／promise・answer・ack＝今の番の返信の中身）。";

const TURN_KINDS: readonly NowThisTurn[] = ["deliver", "answer", "promise", "ack"];
const READY_RE = /送れる物件|物件|確認の結果|結果|御見積書|見積/;

function strList(v: unknown, max: number, len: number): string[] {
  if (!Array.isArray(v)) return typeof v === "string" && v.trim() ? [v.trim().slice(0, len)] : [];
  return v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean).slice(0, max).map((x) => x.slice(0, len));
}

export function normalizeNowVsLater(raw: unknown): NowVsLater | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const t = String(r.this_turn ?? "").trim().toLowerCase() as NowThisTurn;
  const open = typeof r.our_open === "string" && r.our_open.trim() && !/^(null|なし|無し)$/i.test(r.our_open.trim()) ? r.our_open.trim().slice(0, 60) : null;
  const ready = strList(r.ready_now, 3, 20).filter((x) => READY_RE.test(x) && !/^(なし|無し|null)$/.test(x));
  const src = String(r.answer_source ?? "").trim().toLowerCase();
  const out: NowVsLater = { asked_now: strList(r.asked_now, 3, 40), our_open: open, ready_now: ready, this_turn: TURN_KINDS.includes(t) ? t : null, answer_source: (ANSWER_SOURCES as readonly string[]).includes(src) ? (src as AnswerSource) : null };
  if (!out.asked_now.length && !out.our_open && !out.ready_now.length && !out.this_turn) return null;
  return out;
}

/** 今の番に押す AIX（記録だけ・本番の物差しの数え方を今と後で分けるため）。deliver の時だけ aix、それ以外は null。欄が無ければ undefined（数えない） */
export function aixNowOf(n: NowVsLater | null | undefined, finalAix: string | null | undefined): string | null | undefined {
  if (!n || !n.this_turn) return undefined;
  return n.this_turn === "deliver" ? (finalAix ?? null) : null;
}

/** 欄と他の欄の食い違い（ログだけ・決め直さない＝P0 9eb6aa9c・0dbfbc97 ②） */
export function nowLaterConflicts(n: NowVsLater | null | undefined, o: { finalAix: string | null | undefined; contractRoutes?: ReadonlyArray<string | null | undefined> }): string[] {
  if (!n || !n.this_turn) return [];
  const out: string[] = [];
  const routes = (o.contractRoutes ?? []).map((x) => String(x ?? ""));
  if (n.this_turn === "deliver" && !o.finalAix) out.push("deliver_without_aix");
  if (n.this_turn === "deliver" && !n.ready_now.length) out.push("deliver_without_ready");
  if (n.this_turn !== "deliver" && routes.length && routes.every((r) => r === "aix")) out.push("reply_turn_but_contract_all_aix");
  if (n.this_turn === "promise" && routes.length && !routes.includes("promise")) out.push("promise_turn_without_promise_route");
  // 出所と今の番の食い違い（ログだけ・決め直さない）
  if (n.answer_source === "staff_only" && n.this_turn === "answer") out.push("staff_only_answered_now");
  if ((n.answer_source === "company_fact" || n.answer_source === "material_value") && n.this_turn === "promise") out.push("fact_source_promised");
  return out;
}

/** 記録の短い印（digest・ログ用）: 例 "t=promise r=- o=1" */
export function nowLaterDigest(n: NowVsLater | null | undefined): string | null {
  if (!n) return null;
  return `t=${n.this_turn ?? "?"} s=${n.answer_source ?? "?"} r=${n.ready_now.length ? n.ready_now.join("+") : "-"} o=${n.our_open ? 1 : 0}`;
}
