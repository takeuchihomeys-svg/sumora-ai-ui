// app/lib/aix-catalog.ts — AIX の全ボタン×全ピッカーの「正の一覧」（純関数・DB/LLM なし）
//
// なぜ（2026-10-08 竹内「AIXか返信かの判断も、AIXのボタンの種類・ピッカーの種類を分かっていたら簡単に完全にすることできる」
//   ＋「返信か AIX の判断を先に完全にして、それから細かくしていくのが一番効率よくて質も上がる」・10巡目）:
//   返信か AIX かの判断は「お客様の発言に答えるのに、スタッフだけが知る情報が要るか」（P0 ca55d42b）。
//   要るならどのボタン・どのピッカーで送るか。要らないなら返信。そのためにブレインが
//   「どのボタン・ピッカーが、どのスタッフだけが知る情報を送るのか」「似たボタンとの線」を知っている必要がある。
//   旧はボタンの説明が5か所（aix-taxonomy の AIX_STAFF_NOTES・brain-core の AIX_CAPABILITY_MAP・aix-jev の JEV_AIX_OPTIONS・
//   aix-pickers の AIX_PICKERS・page.tsx のメニューの sub）に分かれ、ブレインはピッカーの層をほとんど知らず、説明の古い所があった。
//
// 作り方（手書きで二重に持たない）:
//   ・ボタンの名前・ピッカーの値と文言は AIX_PICKERS（aix-pickers.ts＝画面の実物）・AIX_BUTTON_LABELS（aix-taxonomy.ts）から作る
//   ・内覧挨拶（greeting_viewing）の専用ピッカー（page.tsx の内覧前/内覧後→申込/申込誘導/確認事項/引き続き探す）は aix-pickers.ts の AIX_PICKERS に足した（10/08）
//   ・ここで書くのは「知識」だけ: そのボタン・ピッカーが送るスタッフだけが知る情報（staffOnly）・使う場面（when＝実送信の多数派・竹内さんの番）・似たボタンとの線（lines）
//     when の数字は scripts/audit-r10-path-truth.ts（5/30〜の全部の番・押下の記録は 6/26〜）で数えた物
//
// 使う所: ①正解の表と一致率（scripts/audit-r10-path-truth.ts の catalogKeyOfPress）②ブレイン（brain-core が場面に関係するボタン・ピッカーだけを渡す＝catalogBlockForBrain）
import { AIX_PICKERS, type PickerOption } from "./aix-pickers";
import { AIX_BUTTON_LABELS } from "./aix-taxonomy";
import type { ReplyScene } from "./reply-scene";

export type CatalogEntry = {
  /** 一覧の鍵: "ボタン" か "ボタン/ピッカーの値"（例 property_check_result/unavailable） */
  key: string;
  aixType: string;
  /** 画面のボタン名（AIX_PICKERS.button／AIX_BUTTON_LABELS） */
  button: string;
  /** ピッカー（主のピッカーの1つの値）。無いボタンは null */
  picker: { field: string; value: string; label: string } | null;
  /** このボタン・ピッカーで送る「スタッフだけが知る情報」。空＝スタッフだけが知る情報は無い（定型の資料・フォームを送るだけ） */
  staffOnly: string;
  /** 使う場面（お客様の発言・前のこちらの文） */
  when: string;
  /** 似たボタン・ピッカーとの線（こういう時はこちらではない） */
  lines?: string;
  /** ブレインが選んでよいか（false＝スタッフが自分で押す物・押されない物） */
  brainSelectable: boolean;
  /** 関係する場面（reply-scene）。ブレインに渡す時に場面で絞る。空＝どの場面でも渡す */
  scenes: readonly ReplyScene[];
};

type Know = Omit<CatalogEntry, "key" | "aixType" | "button" | "picker">;

/** ボタンの主のピッカー（正解の表の粒度・ブレインに見せる粒度）。他の子のピッカー（物件数・誘導の有無 等）は一覧に出さない */
export const MAIN_PICKER_FIELD: Record<string, string> = {
  property_check_result: "check_pattern",
  property_send: "send_mode",
  property_recommendation: "pickup_type",
  estimate_sheet: "estimate_count",
  viewing_invite: "viewing_mode",
  application_push: "app_sub_mode",
  greeting_viewing: "app_sub_mode",
  acknowledge_check: "ack_preset",
  condition_hearing: "hearing_mode",
  followup_revive: "followup_sub_mode",
  cost_explain: "cost_explain_mode",
};

const ALL: readonly ReplyScene[] = [];
const S = (...s: ReplyScene[]) => s;

/** ボタンごとの知識（ピッカーの値ごとに上書きする時は PICKER_KNOW） */
const BUTTON_KNOW: Record<string, Know> = {
  property_check_result: {
    staffOnly: "管理会社・代表・オーナーに確認して分かった結果（募集中か・募集終了・別の部屋・入居可能日・設備・費用の交渉の結果 等）",
    when: "確認の約束をした後、確認の結果が出た時（お客様の持ち込みの物件・聞かれた条件）",
    lines: "結果がまだ無い時は確認の約束の返信（2段）。資料・会話・会社の事実で答えられる質問（礼金・保証会社・駐車場・管理会社が資料にある）は返信",
    brainSelectable: true,
    scenes: S("property_share", "question", "cost", "viewing", "ack", "other"),
  },
  property_send: {
    staffOnly: "スタッフが検索して選んだ物件（資料）",
    when: "条件がそろっていて、スタッフが選んだ物件がある時（売上サポに今送れる物件がある）",
    lines: "送れる物件がまだ無い時は「ピックアップしてお送りさせて頂きます」の約束の返信（2段）。1件に絞って推す時は物件オススメ",
    brainSelectable: true,
    scenes: S("conditions", "considering", "ack", "other", "question"),
  },
  property_recommendation: {
    staffOnly: "スタッフが選んだ1件（資料の画像）とその推しどころ",
    when: "物件ピックアップした の直後に1件を推す／新着が1件出た（追客）",
    lines: "複数件をまとめて送るのは物件ピックアップした。お客様の発言への答えとして選ぶ事は少ない（こちらから出す）",
    brainSelectable: true,
    scenes: S("conditions", "considering", "ack", "other"),
  },
  estimate_sheet: {
    staffOnly: "管理会社の資料から作った御見積書の金額（最大限割引）",
    when: "御見積書が作れた時（見積の依頼に約束した後・物件確認の後の費用の質問）",
    lines: "見積る物件がまだ無い・作る前は「御見積書を作成しお送りさせて頂きます」の約束の返信（2段）。初期費用の中身の質問は初期費用について、安さを不審に思われたら初期費用を説明",
    brainSelectable: true,
    scenes: S("cost", "property_share", "question", "ack", "considering"),
  },
  viewing_invite: {
    staffOnly: "スタッフの空いている日時（内覧の候補日）・退去予定の部屋の内覧開始日",
    when: "内覧の希望（今見られる部屋）・初めての日時の指定・別の日程の問い",
    lines: "退去予定（入居中）の部屋は先に内覧開始日の確認の約束（2段）。日時が決まった後は待ち合わせ",
    brainSelectable: true,
    scenes: S("viewing", "considering", "ack", "question"),
  },
  meeting_place: {
    staffOnly: "内覧の確定（日時）と待ち合わせの場所・住所（番地まで）",
    when: "内覧の候補日を出した後、お客様が日時を選んだ・了承した",
    lines: "候補日を出す前の日時の指定は内覧日調整（内覧日指定あり）",
    brainSelectable: true,
    scenes: S("viewing", "ack"),
  },
  application_push: {
    staffOnly: "申込の手続き（申込書の様式・必要書類の案内）",
    when: "お客様が申込の意思を示した（「申込します」「ここで大丈夫です」）",
    lines: "見積書の後の前向きな反応だけでは内覧のご案内が先",
    brainSelectable: true,
    scenes: S("apply", "considering", "ack"),
  },
  greeting_viewing: {
    staffOnly: "内覧の日時（内覧前）／内覧に行ったスタッフが分かった事（内覧後）",
    when: "確定した内覧の当日（内覧の前）＝お客様が内覧を忘れない・確実に来てもらうための確認（10/08 竹内さん「忘れないため」）／内覧の後のお礼（内覧後）",
    lines: "内覧当日のお客様の連絡（遅れる・向かう）は返信「かしこまりました！！お気をつけてお越しください😌！！」。今日もう当日の挨拶を送っていれば出さない",
    brainSelectable: true,
    scenes: S("viewing", "ack"),
  },
  condition_hearing: {
    staffOnly: "",
    when: "初回でまだ物件を送っておらず、エリアと家賃の両方がそろっていない",
    lines: "エリアと家賃が分かっていれば物件ピックアップ（2段）",
    brainSelectable: true,
    scenes: S("other", "conditions"),
  },
  acknowledge_check: {
    staffOnly: "",
    when: "御見積書を送った後にお客様が「更に安くならないか」と聞いた（初期費用を更に割引できるか）→ 代表確認（初期費用）の約束を AIX で送る（10/08 竹内さん）。結果は 確認した→代表に確認した",
    lines: "御見積書の前の「安くなりますか」は見積書送る。物件の募集状況の確認の約束は返信（2段）",
    brainSelectable: true,
    scenes: S("cost", "question", "considering", "other", "apply"),
  },
  followup_revive: {
    staffOnly: "",
    when: "お客様の返信が止まった（3日以上）・申込の書類が届かない",
    brainSelectable: true,
    scenes: ALL,
  },
  cost_explain: {
    staffOnly: "貸主からの報酬（AD）と還元額",
    when: "費用の安さを不審に思われた・安い理由を聞かれた",
    brainSelectable: true,
    scenes: S("cost", "question"),
  },
  cost_breakdown: {
    staffOnly: "送った御見積書の内訳（項目と金額）",
    when: "御見積書の後に初期費用の中身（何が含まれるか・家賃だけで入居できるか）を聞かれた",
    brainSelectable: true,
    scenes: S("cost", "question"),
  },
  guarantor_info: {
    staffOnly: "物件ごとの保証会社名・種類（管理会社に確認した物）",
    when: "保証会社そのもの（どこか・種類・通りやすさ）を聞かれた・複数の物件の保証会社を伝える",
    lines: "資料に保証会社が書いてある物件1件の質問は返信（8巡目 竹内さんの決定）",
    brainSelectable: true,
    scenes: S("question", "apply"),
  },
  phone_call: {
    staffOnly: "",
    when: "お客様が電話で話したい（電話の依頼）",
    brainSelectable: true,
    scenes: ALL,
  },
  phone_followup: {
    staffOnly: "電話で話した内容",
    when: "電話の後のまとめ（スタッフが押す）",
    brainSelectable: false,
    scenes: ALL,
  },
  zenryoku_support: {
    staffOnly: "スタッフが探した結果（条件に合うお部屋が今は無い）",
    when: "条件で探したが送れる物件が無かった時（新着が出次第送る約束）（10/08 竹内さん「進めて良い」）",
    lines: "送れる物件がある時は物件ピックアップした",
    brainSelectable: true,
    scenes: S("conditions", "ack", "considering"),
  },
  property_search: {
    staffOnly: "",
    when: "（文は送らない）拡張ツールで探す操作。お客様への最初の一手は約束の返信（2段）",
    brainSelectable: false,
    scenes: ALL,
  },
};

/** ピッカーの値ごとの知識（ボタンの知識を上書き） */
const PICKER_KNOW: Record<string, Partial<Know>> = {
  "property_check_result/available": { staffOnly: "管理会社に確認した募集中の結果（＋最大限割引の御見積書を同封）", when: "確認の約束の後・募集中だった" },
  "property_check_result/unavailable": { staffOnly: "管理会社に確認した募集終了の結果", when: "確認の約束の後・募集が終わっていた（見積書を作ろうとして終わっていた時も）" },
  "property_check_result/alternative": { staffOnly: "聞かれた部屋は満室・同じ建物の別の部屋が募集中という結果" },
  "property_check_result/exclusive": { staffOnly: "専任物件で弊社から紹介できないという結果" },
  "property_check_result/move_in_date": { staffOnly: "退去日から計算した入居可能日（資料の画像）", lines: "資料に入居時期・退去予定日が書いてある時は返信（8巡目）。管理会社に入居日を聞いた結果は 確認した→入居日について（mgmt_move_in）＝入居日のピッカーは2つ" },
  "property_check_result/interior_photo": { staffOnly: "手元の室内写真・室内イメージ URL", when: "室内の写真を頼まれ、頼まれた物件の室内イメージが手元にある", lines: "手元に無い（持ち込み・建築中）は「室内のお写真撮影出来次第お送り」の約束の返信（2段）" },
  "property_check_result/other_room_check": { staffOnly: "同じ建物の別の部屋・別の間取りの有無" },
  "property_check_result/mgmt_availability": { staffOnly: "管理会社に聞いた募集状況（募集している／終了）", lines: "物件確認した（募集状況）の 物件あった／なかった と同じ中身。確認した（条件・交渉）側から送る時" },
  "property_check_result/vacate_date": { staffOnly: "管理会社に聞いた退去予定日", lines: "資料に退去予定日がある時は返信（8巡目）" },
  "property_check_result/mgmt_move_in": { staffOnly: "管理会社に聞いた入居可能日・希望日で入れるか", lines: "入居日のピッカーは2つ: 物件確認した→入居日確認した（退去日から計算・資料）／確認した→入居日について（管理会社の回答）" },
  "property_check_result/mgmt_initial_cost": { staffOnly: "管理会社・代表・オーナーとの初期費用の交渉の結果（礼金・消臭代を外せるか 等）", lines: "費用を知りたいだけの依頼は見積書送る" },
  "property_check_result/mgmt_proxy": { staffOnly: "代理契約の可否（管理会社の回答）" },
  "property_check_result/mgmt_guarantor": { staffOnly: "管理会社に聞いた保証会社・保証人・審査の条件", lines: "資料に保証会社が書いてある時は返信（8巡目）" },
  "property_check_result/mgmt_company": { staffOnly: "資料・管理会社で確かめた管理会社の名前・連絡先", lines: "資料の弊社帯の次の元付が分かる時は返信（8巡目）" },
  "property_check_result/mgmt_parking": { staffOnly: "管理会社に聞いた駐車場の有無・料金・空き", lines: "資料に駐車場の空き・料金がある時は返信（8巡目）" },
  "property_check_result/mgmt_pet": { staffOnly: "管理会社に聞いたペットの可否・条件" },
  "property_check_result/mgmt_equipment": { staffOnly: "管理会社に聞いた設備の有無", lines: "資料に書いてある設備は返信" },
  "property_check_result/nearby_parking": { staffOnly: "近隣の月極駐車場（名前・距離・料金・空き）" },
  "property_check_result/owner_other": { staffOnly: "オーナーに確認した内容と結果" },
  "property_send/normal": { when: "まだ物件を送っていないお客様に初めて送る（初回まとめ）" },
  "property_send/new_arrival": { when: "前に送った後の新着（追客・他の物件も見たい）" },
  "property_send/widen": { when: "希望どおりが無く条件を広げて探した・お客様が条件を広げた" },
  "property_send/alternative": { when: "気に入った物件が募集終了・紹介不可の代わり（物件確認した→物件なかった の後）" },
  "estimate_sheet/single": { when: "お部屋1件の御見積書" },
  "estimate_sheet/multi": { when: "2〜3件の御見積書を一度に" },
  "viewing_invite/通常": { when: "内覧の希望（日時なし・今見られる部屋）に候補日を出す" },
  "viewing_invite/退去予定物件": { staffOnly: "管理会社に確認した退去予定の部屋の内覧開始日", when: "退去予定の部屋の内覧（確認の約束の後）" },
  "viewing_invite/内覧日指定あり": { when: "お客様が初めて日時を指定した（候補日を出す前）" },
  "viewing_invite/日程変更": { when: "決まった内覧の日時を変える" },
  "application_push/push": { when: "まだ決めていないお客様の申込の後押し（退去予定の先押さえ・部屋を抑えて内覧）" },
  "application_push/confirm": { when: "お客様が申込を決めた（確定のご連絡と次の手順）" },
  "application_push/format": { when: "申込を決めた後に申込書（記入フォーマット）を送る" },
  "application_push/docs_request": { when: "不足している書類の依頼" },
  "greeting_viewing/before": { staffOnly: "内覧の日時", when: "内覧の前（当日の朝・前日）の挨拶" },
  "acknowledge_check/daihyo_initial_cost": { when: "御見積書の後に「更に安くならないか」と聞かれた → 代表に初期費用の更なる割引を確認・交渉する約束（お客様あて）" },
  "acknowledge_check/kanri_boshu": { when: "（押下なし）管理会社に募集状況を確認する" },
  "followup_revive/apply_supplement": { when: "申込の書類・情報が届かないまま止まった" },
  "followup_revive/search_continue": { when: "物件を送った後に返信が3日以上止まった（お部屋探しを続けているか）" },
};

function optionsOf(aixType: string): PickerOption[] {
  const field = MAIN_PICKER_FIELD[aixType];
  const spec = AIX_PICKERS[aixType];
  return spec?.pickers.find((p) => p.key === field)?.options ?? [];
}

function buttonLabel(aixType: string): string {
  if (aixType === "property_check_result") return "物件確認した（募集状況）／確認した（条件・交渉）";
  return AIX_PICKERS[aixType]?.button ?? AIX_BUTTON_LABELS[aixType] ?? aixType;
}

/** 物件確認した の値が「確認した（条件・交渉）」側か（画面は別のボタン） */
export function isConditionCheckPattern(v: string | null | undefined): boolean {
  return !!v && (/^mgmt_|^owner_|^daihyo_/.test(v) || v === "vacate_date" || v === "nearby_parking");
}

/** 全ボタン×主のピッカーの一覧（コードから作る） */
export function buildAixCatalog(): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  const types = [...new Set([...Object.keys(AIX_PICKERS), ...Object.keys(AIX_BUTTON_LABELS), "greeting_viewing", "zenryoku_support"])];
  for (const t of types) {
    const know = BUTTON_KNOW[t];
    if (!know) continue;
    const opts = optionsOf(t).filter((o, i, a) => a.findIndex((x) => x.label === o.label) === i); // 誘導の 申込/apply のような別名は1つに
    const field = MAIN_PICKER_FIELD[t];
    const base = { aixType: t, button: buttonLabel(t) };
    if (!opts.length) { out.push({ key: t, ...base, picker: null, ...know }); continue; }
    for (const o of opts) {
      const k = `${t}/${o.value}`;
      const over = PICKER_KNOW[k] ?? {};
      const btn = t === "property_check_result" ? (isConditionCheckPattern(o.value) ? "確認した（条件・交渉）" : "物件確認した（募集状況）") : base.button;
      out.push({ key: k, aixType: t, button: btn, picker: { field: field ?? "", value: o.value, label: o.label }, ...know, when: over.when ?? (o.when || know.when), ...over });
    }
  }
  return out;
}
export const AIX_CATALOG: readonly CatalogEntry[] = buildAixCatalog();

// ─── 押した AIX → 一覧の鍵（正解の表） ─────────────────────────────────────────────

export type PressRecord = {
  aix_type: string | null;
  check_pattern?: string | null;
  send_mode?: string | null;
  app_sub_mode?: string | null;
  picker_choices?: unknown;
  /** 送った文（aix_usage_logs.generated_text か AIX の通の本文）。ピッカーの記録が無い古い押下の推定に使う */
  text?: string | null;
};
export type PressKey = { key: string; source: "recorded" | "inferred" | "button_only" };

const REC_LEGACY: Record<string, string> = { new_arrival: "新着1件", widen: "条件広げピックアップ", normal: "新規ピックアップ", alternative: "代替ピックアップ" };

/**
 * 押した AIX をボタン×主のピッカーの鍵にする。記録（check_pattern・send_mode・app_sub_mode・picker_choices）を先に、
 * 無ければ送った文から推定する（推定は source=inferred で分ける）。
 */
export function catalogKeyOfPress(p: PressRecord): PressKey {
  const t = String(p.aix_type ?? "");
  const pc = (p.picker_choices && typeof p.picker_choices === "object" ? p.picker_choices : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const txt = String(p.text ?? "").normalize("NFKC");
  const rec = (v: string | null): PressKey | null => (v ? { key: `${t}/${v}`, source: "recorded" } : null);
  const inf = (v: string): PressKey => ({ key: `${t}/${v}`, source: "inferred" });
  switch (t) {
    case "property_check_result": {
      const r = rec(s(p.check_pattern) ?? s(pc.check_pattern));
      if (r) return r;
      if (!txt) return { key: t, source: "button_only" };
      if (/室内(?:の)?(?:写真|画像|イメージ)|室内写真/.test(txt)) return inf("interior_photo");
      if (/募集(?:が)?終了|満室|申込(?:が|み)?入|埋まって|ご紹介(?:が)?(?:出来|でき)(?:ない|ません)|専任/.test(txt)) return inf(/専任/.test(txt) ? "exclusive" : "unavailable");
      if (/別の(?:お)?部屋|他の(?:お)?部屋[^\n]{0,10}募集/.test(txt)) return inf("alternative");
      if (/入居(?:可能)?日|ご入居可能|退去予定/.test(txt) && !/募集中/.test(txt)) return inf("move_in_date");
      if (/募集中|募集して|ご紹介可能|空いて/.test(txt)) return inf("available");
      return { key: t, source: "button_only" };
    }
    case "property_send":
      return rec(s(p.send_mode) ?? s(pc.send_mode)) ?? (/新た(?:に|な)|新着/.test(txt) ? inf("new_arrival") : txt ? inf("normal") : { key: t, source: "button_only" });
    case "property_recommendation": {
      const v = s(pc.pickup_type) ?? s(p.send_mode);
      if (v) return { key: `${t}/${REC_LEGACY[v] ?? v}`, source: "recorded" };
      if (!txt) return { key: t, source: "button_only" };
      if (/新た(?:に|な)|新着|募集に出/.test(txt)) return inf("新着1件");
      if (/中でも|お送りさせて(?:頂|いただ)きました(?:お部屋|物件)の中/.test(txt)) return inf("継続ピックアップ");
      return inf("新規ピックアップ");
    }
    case "estimate_sheet":
      return rec(s(pc.estimate_count)) ?? (txt ? inf((txt.match(/【[^】]+】/g) ?? []).length >= 2 ? "multi" : "single") : { key: t, source: "button_only" });
    case "viewing_invite": {
      const r = rec(s(pc.viewing_mode));
      if (r) return r;
      if (!txt) return { key: t, source: "button_only" };
      if (/退去予定/.test(txt)) return inf("退去予定物件");
      if (/変更/.test(txt)) return inf("日程変更");
      return inf("通常");
    }
    case "application_push":
      return rec(s(p.app_sub_mode) ?? s(pc.app_sub_mode)) ?? (/記入欄】|・\s*氏名/.test(txt) ? inf("format") : txt ? inf("push") : { key: t, source: "button_only" });
    case "greeting_viewing":
      return rec(s(p.app_sub_mode)) ?? { key: t, source: "button_only" };
    case "acknowledge_check":
      return rec(s(pc.ack_preset)) ?? (/代表/.test(txt) ? inf("daihyo_initial_cost") : { key: t, source: "button_only" });
    case "condition_hearing":
      return rec(s(pc.hearing_mode)) ?? { key: t, source: "button_only" };
    case "followup_revive":
      return rec(s(pc.followup_sub_mode)) ?? { key: t, source: "button_only" };
    default:
      return { key: t, source: "button_only" };
  }
}

/** 鍵のボタンの部分 */
export const buttonOfKey = (k: string) => k.split("/")[0];
/** 物件確認した の鍵の「話題」（結果のあった／なかったはスタッフが確認してから選ぶので、ブレインと比べる時は寄せる） */
export function topicKey(k: string): string {
  const [b, v] = k.split("/");
  if (b !== "property_check_result") return b === "acknowledge_check" ? "acknowledge_check" : k;
  if (!v || /^(?:available|unavailable|alternative|exclusive|mgmt_availability)$/.test(v)) return "property_check_result/募集状況";
  if (v === "interior_photo" || v === "other_room_check") return `property_check_result/${v}`;
  if (v === "move_in_date" || v === "mgmt_move_in" || v === "vacate_date") return "property_check_result/入居日";
  return `property_check_result/条件:${v}`;
}

// ─── ブレインに渡す一覧（場面に関係するボタン・ピッカーだけ） ──────────────────────────

/** 判断の順番（竹内さん 10/08・P0 ca55d42b） */
export const AIX_DECISION_ORDER = [
  "【返信か AIX かの決め方（この順番で決める）】",
  "① お客様の今の発言に答えるのに「スタッフだけが知る情報」（管理会社・代表・オーナーに確認した結果・スタッフが選んだ物件・御見積書の金額・スタッフの空いている日時・内覧の確定と住所・交渉の結果・撮影した写真）が要るか。",
  "② 要らない（会話・物件の資料・会社の事実・送った記録で答えられる／お礼・了承だけ）→ 返信。",
  "③ 要るが、その情報がまだ手元に無い（これから確認・探す・作る）→ 約束の返信（2段: 確認させて頂きます／ピックアップしお送りさせて頂きます／御見積書を作成しお送りさせて頂きます）。AIX は結果が出てから。",
  "④ 要り、その情報を送る時 → 下の一覧のどのボタン・どのピッカーで送るかを決める（ピッカーまで決まらないボタンは選ばない）。",
  "⑤ スタッフだけが知る情報が無くても AIX で送る物（10/08 竹内さん）: 条件ヒアリングのフォーム・申込フォーマット・内覧挨拶（当日の確認・内覧後のお礼）。",
].join("\n");

/** 物件確認した の「結果」のピッカー（スタッフが確認してから選ぶ＝ブレインは選ばない・まとめて1行で見せる） */
const RESULT_PICKERS = new Set(["available", "unavailable", "alternative", "exclusive"]);

export function catalogBlockForBrain(scene: ReplyScene | null | undefined, o: { includeAll?: boolean } = {}): string {
  const rows = AIX_CATALOG.filter((e) => e.brainSelectable && (o.includeAll || !scene || !e.scenes.length || e.scenes.includes(scene)));
  const byBtn = new Map<string, CatalogEntry[]>();
  for (const e of rows) { const k = `${e.aixType}|${e.button}`; if (!byBtn.has(k)) byBtn.set(k, []); byBtn.get(k)!.push(e); }
  const lines: string[] = [AIX_DECISION_ORDER, `【AIX のボタン×ピッカー（${scene ? `場面「${scene}」に関係する物` : "全部"}）＝aix の値はボタンのキー・check_pattern はピッカーの値】`];
  for (const [k, es] of byBtn) {
    const [t, btn] = k.split("|");
    const bk = BUTTON_KNOW[t];
    lines.push(`- ${t}【${btn}】 送る情報: ${bk?.staffOnly || "（定型の文・フォーム。スタッフだけが知る情報なし）"}${bk?.lines && !es[0].picker ? `｜線: ${bk.lines}` : ""}${!es[0].picker ? `｜使う時: ${es[0].when}` : ""}`);
    if (!es[0].picker) continue;
    if (t === "property_check_result" && btn.startsWith("物件確認した")) {
      const res = es.filter((e) => RESULT_PICKERS.has(e.picker!.value)).map((e) => e.picker!.label);
      if (res.length) lines.push(`    ・結果のピッカー（${res.join("／")}）: 確認の約束の後、スタッフが確認してから選ぶ（ブレインは check_pattern を空にする）。${bk?.lines ?? ""}`);
    }
    if (t === "property_check_result" && btn.startsWith("確認した")) {
      // 誰に確認したか（画面の check_who の実物から作る・ブレインが代表／オーナーを知らなかった穴）
      const who = AIX_PICKERS.property_check_result.pickers.find((p) => p.key === "check_who")?.options ?? [];
      if (who.length) lines.push(`    ・誰に確認したか: ${who.map((o) => `${o.label}（${o.when}）`).join("／")}`);
    }
    for (const e of es) {
      if (t === "property_check_result" && RESULT_PICKERS.has(e.picker!.value)) continue;
      const own = PICKER_KNOW[e.key]?.lines;
      lines.push(`    ・${e.picker!.label}（${e.picker!.value}）: ${e.when}${own ? `｜${own}` : ""}`);
    }
  }
  return lines.join("\n");
}
