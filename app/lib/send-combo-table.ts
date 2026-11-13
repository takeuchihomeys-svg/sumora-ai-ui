// app/lib/send-combo-table.ts — 返信と AIX の組と順番の型の表（統括が番ごとに選ぶ・純関数・DB/LLM なし・作業員7・2026-11-12）
//
// 竹内さん 11/12「返信と AIX の組み合わせと順番も、なぜこのようにしているのか細分化して理解できるようにして強化していく」
//   「ここもちゃんとブレインの統括が判断できるように細分化していく」。親 P0 575a7cd5（統括の芯）・ca55d42b（AIX と返信の分け方）。
// 形: check-order の型（T1〜T12・作業員16／22 の check_order_type）×手がかり → 組の型・順番・間隔・なぜ・竹内さんの数。
//   数は scripts/audit-takeuchi-reply-aix-order.ts（竹内さん本人の番・申込以降と従業員の混ざる番を外す）で埋める。
// 置き方の決まり（q406・q057・q065・q022）: 道（返信か AIX か・どの AIX か）は決め直さない。道が決まった後の meta を読み、
//   その道に合う組の型を選んで記録するだけ（digest）。スイッチ SEND_COMBO_TABLE（既定 off＝何もしない／shadow＝記録だけ／on＝今は shadow と同じ）。

export type SendCombo =
  | "reply_only"            // 返信1通
  | "reply_reply"           // 返信→返信（話題が別・答えの後に次の一歩）
  | "reply_then_aix_quick"  // 返信→数秒〜数分後に AIX（初回の挨拶＋条件ヒアリング・答えの後にフォーム／見積書）
  | "promise_then_aix_later"// 約束の返信→後で結果の AIX（2段・確かめる前に答えると作り話）
  | "aix_then_reply"        // AIX→返信（結果・資料を先に事実で・次の手や誘いを後に）
  | "aix_then_aix"          // AIX→別の AIX（見積書→内覧調整 等）
  | "aix_only";             // AIX だけ（文を書く AIX の中で答えを済ませる）

export type ComboCues = {
  firstContact?: boolean;
  /** 前の約束の結果が手元にある（確認した・見積ができた） */
  resultReady?: boolean;
  /** 悪い知らせ（募集終了・申込が入っていた・審査に通らない） */
  badNews?: boolean;
  /** 約束が開いている */
  openPromise?: boolean;
  /** お客様の問いが2つ以上・話題が別 */
  multiTopics?: boolean;
  /** 2026-11-13 作業員7b: 約束が2つ開いている（募集状況の確認＋ピックアップ 等・11408 の形） */
  twoOpenPromises?: boolean;
  /** 2026-11-13 作業員7b: お客様が今の連投で物件を送ってきて、まだ募集状況を確かめていない（持ち込み・未確認） */
  broughtUnchecked?: boolean;
  /** 2026-11-13 作業員7b: ブレインが選んだ AIX が条件ヒアリング（初回でなくても・久しぶりの探し直しも） */
  hearing?: boolean;
  /** 2026-11-13 作業員C: 決まった道の AIX の種類（property_send・estimate_sheet 等）。AIX の後に返信を足す竹内さんの形を選ぶ */
  aixKind?: string | null;
};

export type ComboRow = {
  type: string;            // check-order の型の id（"*"＝どの型でも）
  when: string;            // 手がかり（説明）
  match: (c: ComboCues) => boolean;
  /** 道（決まった後の meta）がこの形の時だけ使う */
  route: "reply" | "two_stage" | "aix";
  combo: SendCombo;
  order: string;
  gap: "秒" | "分" | "時間" | "翌日以降" | "-";
  why: string;
  /** 2026-11-12 竹内さん「なぜ・何の情報が足りないから・どこの要点を押さえにいくか」（名前は check-order と揃える） */
  purpose: string;
  missing: string;
  keyPoint: string;
  /** 竹内さんの数（監査の結果で埋める・まだの行は "未数え"） */
  count: string;
};

const always = () => true;
export const SEND_COMBO_ROWS: readonly ComboRow[] = [
  { type: "T11_first_contact_hearing", when: "初回", match: (c) => !!c.firstContact || !!c.hearing, route: "aix", combo: "reply_then_aix_quick", order: "挨拶＋問いや不安への答えの返信 → 数秒〜1分半後に AIX【条件ヒアリング】 → フォームの案内の返信（決まった文・FIRST_HEARING_SEQUENCE）", gap: "秒",
    why: "挨拶と問いへの答えで信頼を作ってからフォーム＝いきなりフォームだと機械的に見える（作業員4 の見極め 6会話中5・本番 12306 は返信を落とした外れ）", purpose: "信頼を作ってから聞く", missing: "エリア・家賃・間取り・入居時期・初期費用の予算", keyPoint: "機械的に見せずに条件をそろえる（問いには先に答える）", count: "11/13 作業員7b 本番の見張り60日の AIX【条件ヒアリング】24番: フォームの前に返信 22・返信→フォーム→返信 19・案内の型 13（久しぶりの探し直し 12306 も同じ形）／6会話中5（作業員4）・11/12 監査 120日（グループを外した 704番）: 初回83番で RA 3・RAR 9（返信＋2分以内の AIX は 6組・間隔の中央 30秒・AIX はほぼ条件ヒアリング）" },
  { type: "T10_result_ready", when: "結果が手元・悪い知らせ", match: (c) => !!c.resultReady && !!c.badNews, route: "aix", combo: "aix_then_reply", order: "AIX【物件確認した】（募集終了・申込が入っていた）→ 返信で代わりの物件・次の手", gap: "分",
    why: "悪い知らせは事実で先に（AIX の決まった形）・次の手は後の返信で（関係が縮まないように）", purpose: "事実を正確に伝えてから次の手で関係をつなぐ", missing: "代わりに合う物件・お客様の気持ち（がっかり）", keyPoint: "悪い知らせを事実で先に・代わりの物件を後に（関係を縮めない）", count: "悪い知らせだけは未数え（AR 全体は 11/12 監査 120日で 56番）" },
  { type: "T10_result_ready", when: "結果が手元（空いていた・見積ができた）", match: (c) => !!c.resultReady, route: "aix", combo: "aix_then_reply", order: "AIX（結果・見積書）→ 返信で内覧・申込への誘い", gap: "分",
    why: "結果（事実・金額）は AIX で正確に・誘いは返信で人の言葉で（竹内さん AR 79番＝返信2通以上の番の中で一番多い組）", purpose: "結果を渡して次の段へ進める", missing: "お客様がその結果で決めるか（内覧・申込の意思）", keyPoint: "数字・事実は AIX で正確に、誘いは返信で人の言葉で", count: "200日 AR 79・11/12 監査 120日 AR 56（決める合図 6/24・費用 11/70・物件が届いた 8/80・AIX は見積書が多い）" },
  // 2026-11-13 作業員7b: 条件ヒアリングの番は型の id に関わらず（久しぶりの探し直し 12306 も）同じ組（上の T11 の行と同じ中身・型の id が無い時の受け）
  { type: "*", when: "条件ヒアリング（初回・探し直し）", match: (c) => !!c.hearing, route: "aix", combo: "reply_then_aix_quick", order: "挨拶＋問いや不安への答えの返信 → 数秒後に AIX【条件ヒアリング】 → フォームの案内の返信（決まった文）", gap: "秒",
    why: "挨拶と問いへの答えで信頼を作ってからフォーム＝いきなりフォームだと機械的に見える", purpose: "信頼を作ってから聞く", missing: "エリア・家賃・間取り・入居時期・初期費用の予算", keyPoint: "機械的に見せずに条件をそろえる（問いには先に答える）", count: "本番の見張り60日の AIX【条件ヒアリング】24番: 返信→フォーム→返信 19・フォームの前に返信 22" },
  // 2026-11-13 作業員7b（弱い所 aix:skip-result-and-two-msg-order の 11408）: 約束が2つ開いていて（募集状況の確認＋ピックアップ）、了承だけの番は、竹内さんは約束した順に AIX で果たす
  { type: "*", when: "約束が2つ開いている（確認＋ピックアップ）・結果が手元", match: (c) => !!c.twoOpenPromises && !!c.resultReady, route: "aix", combo: "aix_then_aix", order: "AIX【物件確認した】（確認の結果・募集終了など）→ 数分後に AIX【物件を送る】（約束したピックアップ）", gap: "分",
    why: "お客様が先に頼んだ確認の答えを先に（後回しにすると聞いた事への答えが抜ける）・代わりの物件はその後（feedback_promise_order_split の順: 物件の募集確認→結果 AIX→…）", purpose: "約束を1つも落とさずに順に果たす", missing: "確認の結果（スタッフだけが知る）", keyPoint: "1通に詰めない・先の約束から", count: "11408（1番）・竹内さんの同じ形の番は未数え（(a) で数える）" },
  // 2026-11-13 作業員C（組の違いの14日の監査 scripts/audit-combo-mismatch.ts・竹内さん本人の番）: 物件を送る AIX（何件も）の後、竹内さんは返信で一押し1件を言う
  //   実送信の形「お送りさせて頂きましたお部屋の中でも特に〇〇が特にオススメのお部屋となります！！」＋理由（敷金礼金なし・駐車場代込で月〇 等）。複数送った時だけ（1件のオススメには言わない）
  { type: "*", when: "物件を送る AIX（何件も）", match: (c) => c.aixKind === "property_send", route: "aix", combo: "aix_then_reply", order: "AIX【物件を送る】（何件も）→ 返信で一押し1件（お送りさせて頂きましたお部屋の中でも特に〇〇がオススメ＋理由）", gap: "分",
    why: "物件の事実は AIX で正確に・どれを選ぶかの決め手は返信で人の言葉で（並べただけだと選べない）", purpose: "送った中から1件に絞って次の段（内覧）へ", missing: "お客様がどれを気に入るか", keyPoint: "送った中の1件の一押しと理由（作らない・資料の事実で）", count: "11/13 作業員C 14日の竹内さんの番: 物件を送る AIX の後に一押しの返信 5（ブレインは AIX だけ）" },
  // 同じ監査: 見積書の AIX の後、竹内さんは返信で「最大限割引しました初期費用の御見積書となります」＋保証会社など見積の中身の説明
  { type: "*", when: "見積書の AIX", match: (c) => c.aixKind === "estimate_sheet", route: "aix", combo: "aix_then_reply", order: "AIX【見積書】→ 返信で「〇〇最大限割引しました初期費用の御見積書となります！！」＋保証会社など中身の説明", gap: "分",
    why: "金額は AIX で正確に・割引した事と保証会社など読み方の説明は返信で（金額だけだと不安が残る）", purpose: "見積の中身を分かってもらい内覧・申込へ", missing: "お客様がその金額で進めるか", keyPoint: "最大限割引した事と、保証会社など見積の中身", count: "11/13 作業員C 14日の竹内さんの番: 見積書の AIX の後に説明の返信 2（ブレインは AIX だけ）" },
  // 2026-11-13 作業員7b（竹内さんの決定 0f475703・11/11）: 持ち込みの未確認の番は、同じ日の2通目でも約束の返信→後で AIX（2択にしない）
  { type: "*", when: "持ち込みの物件・まだ募集状況を確かめていない", match: (c) => !!c.broughtUnchecked, route: "two_stage", combo: "promise_then_aix_later", order: "募集状況の確認（＋最大限割引の御見積書）の約束の返信 → 確かめた後で AIX【物件確認した】", gap: "時間",
    why: "確かめる前に空きを言うと作り話になる＝今の番は約束まで（竹内さんの決定 0f475703「同じ日の2通目でも募集状況の確認は約束に寄せる」・KB 56b662a4 の2択より上）", purpose: "待ってもらう間の安心と、確かめた事実だけを渡す", missing: "管理会社にしか無い募集状況", keyPoint: "約束→結果の AIX の順を崩さない", count: "竹内さん本人の約100日（同じ日の2通目のこちらの最初の手）: 約束 18／直接の AIX 5（KB 0f475703）" },
  { type: "*", when: "確かめる前の依頼（空き・設備・見積）", match: always, route: "two_stage", combo: "promise_then_aix_later", order: "確認・作成の約束の返信 → 確かめた後で結果の AIX", gap: "時間",
    why: "確かめる前に答えると作り話になる＝今の番は約束まで・結果は AIX（P0 ca55d42b）", purpose: "待ってもらう間の安心", missing: "管理会社・資料にしか無い答え（空き・設備・金額）", keyPoint: "確かめる前に答えない（作り話にしない）・確かめて連絡すると言い切る", count: "11/12 監査 120日: 2段(R→A) 224＋(RR→A) 10＝704番の33%（初回 60%・物件が届いた 55%・費用 39%）" },
  { type: "*", when: "答える要件が2つ・話題が別", match: (c) => !!c.multiTopics, route: "reply", combo: "reply_reply", order: "1通目に1つ目の答え → 2通目に別の要件（または次の一歩）", gap: "分",
    why: "1通に詰めると読みにくく返しにくい＝1通に1つ（竹内さん 200日 RR 87・2通目は別の要件か次の一歩）", purpose: "分かりやすく・返しやすくする", missing: "2つ目の要件へのお客様の答え（2通目の問い・誘いに答えてもらう）", keyPoint: "1通に1つの要件・2通目は答えやすい1つの問いか誘い", count: "200日 RR 87・11/12 監査 120日 RR 28（4%・内覧 10%・質問 9%・検討 7%）" },
  { type: "*", when: "ふだん", match: always, route: "reply", combo: "reply_only", order: "返信1通", gap: "-",
    why: "竹内さんの番の 74%（200日 R 716）。答えが1つで次の一歩が要らない番", purpose: "答えて閉じる", missing: "なし（答えで足りる）", keyPoint: "問いの答えを先に・短く", count: "200日 R 716・11/12 監査 120日 R 310（44%・検討 71%・お礼 56%）" },
  { type: "*", when: "AIX の文の中で答えを済ませる", match: always, route: "aix", combo: "aix_only", order: "AIX 1通（受け止め・答えを AIX の文の中で）", gap: "-",
    why: "文を書く AIX（内覧調整・待ち合わせ・物件確認した 等）は 6〜7割が AIX 1通", purpose: "1通で答えと次の段を済ませる", missing: "AIX が運ぶ事実（日時・場所・結果）", keyPoint: "受け止め・答えを AIX の文の中で済ませ、返信を足さない", count: "11/05 数え 61〜71%" },
];

export type SendComboMode = "off" | "shadow" | "on";
export function sendComboMode(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): SendComboMode {
  const v = (env.SEND_COMBO_TABLE ?? "").trim().toLowerCase();
  return v === "shadow" || v === "on" ? v : "off";
}

/** 決まった道（meta）を読む: AIX の番か・2段か・返信か。道は変えない */
export function routeOfMeta(meta: Record<string, unknown> | null | undefined): "reply" | "two_stage" | "aix" {
  const m = meta ?? {};
  if (String(m.reply_mode ?? "") === "aix" && String(m.action ?? "").trim()) return "aix";
  if (String(m.two_stage ?? "").trim()) return "two_stage";
  return "reply";
}

export type SendComboPick = { combo: SendCombo; order: string; gap: string; why: string; purpose: string; missing: string; keyPoint: string; count: string; row: number };
/** 型の id・手がかり・決まった道から組を選ぶ（型が合う行が先・無ければ "*" の行・上から最初に当たった1つ） */
export function pickSendCombo(i: { type: string | null | undefined; route: "reply" | "two_stage" | "aix"; cues: ComboCues }): SendComboPick | null {
  const rows = SEND_COMBO_ROWS.map((r, idx) => ({ r, idx })).filter(({ r }) => r.route === i.route);
  const hit = rows.find(({ r }) => r.type === i.type && r.match(i.cues)) ?? rows.find(({ r }) => r.type === "*" && r.match(i.cues));
  return hit ? { combo: hit.r.combo, order: hit.r.order, gap: hit.r.gap, why: hit.r.why, purpose: hit.r.purpose, missing: hit.r.missing, keyPoint: hit.r.keyPoint, count: hit.r.count, row: hit.idx } : null;
}

/** digest の1語（例 "rq|T11"）。記録だけ */
const SHORT: Record<SendCombo, string> = { reply_only: "r", reply_reply: "rr", reply_then_aix_quick: "rq", promise_then_aix_later: "p2", aix_then_reply: "ar", aix_then_aix: "aa", aix_only: "a" };
export function sendComboDigest(p: SendComboPick | null, type: string | null | undefined): string | null {
  return p ? `${SHORT[p.combo]}|${String(type ?? "-").split("_")[0]}` : null;
}

/**
 * 2026-11-13 作業員C: meta（判断の後）から手がかりを読む（純関数・道は読むだけ）。今まで手がかりを渡す配線が無かった（sendComboRecord を呼ぶ所が無い）。
 *   resultReady: 今すぐ果たせる（now_vs_later.ready_now）か型が T10 ／ twoOpenPromises: 行動台帳でまだ果たしていない約束が2つ以上（ピックアップ・見積・確認）／
 *   multiTopics: turn_contract の問いが2つ以上 ／ hearing: 道の AIX が条件ヒアリング ／ aixKind: 道の AIX の種類
 */
export function comboCuesFromMeta(meta: Record<string, unknown> | null | undefined): ComboCues {
  const m = meta ?? {};
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const route = routeOfMeta(m);
  const aixKind = route === "aix" ? String(m.action ?? "").trim() || null : null;
  const facts = obj(obj(m.action_ledger)?.facts) ?? {};
  const open = [facts.pickupPromisedUnfulfilled, facts.estimatePromisedUnfulfilled, facts.confirmationPromisedUnfulfilled].filter((x) => x === true).length;
  const ready = obj(m.now_vs_later)?.ready_now;
  const asks = (obj(m.turn_contract)?.asks ?? []) as Array<{ kind?: unknown }>;
  return {
    firstContact: m.check_order_type === "T11_first_contact_hearing",
    hearing: aixKind === "condition_hearing",
    resultReady: m.check_order_type === "T10_result_ready" || (Array.isArray(ready) && ready.length > 0),
    twoOpenPromises: open >= 2,
    openPromise: open >= 1,
    multiTopics: Array.isArray(asks) && asks.filter((a) => a?.kind === "question").length >= 2,
    aixKind,
  };
}

/** meta（判断の後）から記録を作る。off の時は null＝何も足さない */
export function sendComboRecord(meta: Record<string, unknown> | null | undefined, cues: ComboCues, env?: Record<string, string | undefined>): { pick: SendComboPick; digest: string } | null {
  if (sendComboMode(env) === "off") return null;
  const type = typeof meta?.check_order_type === "string" ? (meta.check_order_type as string) : null;
  const pick = pickSendCombo({ type, route: routeOfMeta(meta), cues });
  const digest = sendComboDigest(pick, type);
  return pick && digest ? { pick, digest } : null;
}
