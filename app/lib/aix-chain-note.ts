// app/lib/aix-chain-note.ts
// AIX で送った1通目を読んで、その直後に送る2通目（テンプレート）の材料にする（純関数）。
//
// 2026-09-20 竹内「AIX テンプレート、AIX の内容との関係性での生成が重要なので、そこも調査・テストして改善」
//
// ■ なぜ要るか
//   画面（TemplateModal）は postAixContext.sentMessage ＝ 直前に AIX で送った本文を持っていて、
//   **推薦 API には渡しているのに生成 API には渡していなかった**。
//   材料が無いと AI は会話履歴だけを頼りに書き、1通目で既に言ったことを繰り返す
//   （設計知見「AI が『材料が無い』と言い出したら、それは出口ではなく入口の問題」＝見積書の2通目と同じ構造）。
//
// ■ 実測（scripts/audit-aix-chain-coherence.ts・直近90日・1通目→30分以内の2通目 1,419組）
//   スタッフは**1通目を見て2通目を書いている**:
//     1通目「ピックアップしました」33.3% → 2通目で未来形にする  **0.2%**
//     1通目「確認しました」      3.5% → 2通目で未来形にする  **0.1%**
//     1通目に「ご査収」         41.2% → 2通目にも書く       **3.1%**
//     1通目に挨拶              50.8% → 2通目にも書く       **2.0%**
//   2通目の中身（何を書くか）:
//     物件名・号室 39.7% ／ 条件の復唱 35.5% ／ 見積書の案内 18.2% ／ お気に召されましたら 10.1%
//     内覧の誘導 7.3% ／ 申込の誘導 4.8% ／ 全力でサポート 0.7% ／ **ごゆっくりご検討 0.0%**
//   2通目の長さ: 中央値 120字（25% 72 / 75% 162）／ 1通目からの間隔: 中央値 1分
//
//   ＝「繰り返さない」は実送信がほぼ0なので**禁止にしてよい**（設計知見「禁止にしてよいのは実送信がほぼ0の形だけ」）。

/** 1通目に何が書いてあったか */
export type FirstMessageFacts = {
  /** 挨拶行（お世話になっております／お待たせ致しました／はじめまして）がある */
  hasGreeting: boolean;
  /** 「お手隙の際にご査収ください」等の受け取りの締めがある */
  hasReceipt: boolean;
  /** 既に済んだと宣言している物（2通目で未来形にすると重複宣言になる） */
  declaredDone: Array<"pickup" | "check" | "estimate" | "viewing_guide">;
  /** 本文に出てくる物件名＋号室（2通目で別の物件を持ち出していないか・同じ物件を繰り返していないか） */
  propertyLabels: string[];
  /** 金額（初期費用の行）がある＝見積書の本体。2通目で金額を書き直さない */
  hasAmount: boolean;
  /** 1件を絞って推している（「特にオススメ」）＝2通目で同じ推しを重ねない */
  hasSinglePick: boolean;
};

const GREETING_RE = /お世話になっております|お待たせ(?:致|いた)?しました|はじめまして|夜分遅くに失礼/;
const RECEIPT_RE = /ご査収/;
const DONE_PICKUP_RE = /ピックアップ(?:させて(?:頂|いただ)き|いたし|致し)ました|お送り(?:させて(?:頂|いただ)き|いたし|致し)ました|探させて(?:頂|いただ)きました/;
// 「募集が現在ない形となります」も実送信にある形（テスト R5 の実物）。「ございません」だけに絞ると取りこぼす
const DONE_CHECK_RE = /確認(?:させて(?:頂|いただ)き|いたし|致し)ました|募集[^\n。！!]{0,8}(?:(?:御座|ござ)いません|ありません|ない形|終了)|空室(?:で)?(?:御座|ござ)いました/;
const DONE_ESTIMATE_RE = /(?:御|お)?見積(?:書|り)?[^\n。！!]{0,12}(?:お送り|送付)(?:させて(?:頂|いただ)き|いたし|致し)ました|初期費用[：:]/;
const DONE_VIEWING_RE = /ご案内(?:させて(?:頂|いただ)き|いたし|致し)ました|内覧[^\n。！!]{0,8}(?:実施|完了)/;
const AMOUNT_RE = /初期費用[：:]|[0-9０-９]{1,3}(?:,[0-9]{3})+円/;
const SINGLE_PICK_RE = /(?:の中でも)?特に[^\n。！!]{0,20}(?:オススメ|おすすめ)|1件に絞/;
/**
 * 「🌟物件名 403号室」「【物件名 403号室】」「物件名 403号室」。
 * ⚠ **行頭（または 🌟・【 の直後）に限る**。全件監査（実送信1,419通の1通目・抽出1,726件）で、
 *   文中まで拾うと費用の数字を物件名と間違えていた（20件）:
 *     「円・共益費3, 000号室」「万円〜 17号室」「イエヤスなら一般的な不動産業者より円 222号室」
 *   実送信の物件名は「🌟スプランディッド大阪EAST 204号室」「【ジュネーゼグラン難波ミラージュ 1203号室】」
 *   のように**行の先頭**に来るので、そこで線を引くと誤検知が消える。
 */
// ⚠ u フラグ必須: 🌟 はサロゲートペアなので、u が無いと文字クラスが片方のサロゲートだけを見て
//   物件名の先頭に壊れた文字が混ざる（行頭に固定した時に表面化した）
const PROPERTY_LABEL_RE = /(?:^|\n)[\s　]*[🌟【]?[\s　]*([^\n【】🌟、。！!]{2,28}?)[\s　]+([0-9０-９]{2,4})[\s　]*号?室?[\s　]*[】]?/gu;
/** 物件名ではない（費用・条件の断片） */
const NOT_A_PROPERTY_RE = /家賃|管理費|共益費|合計|初期費用|敷金|礼金|徒歩|築|割引|節約|不動産業者|円|万|％|%|〜|~|以内|以上/;

/** 1通目を読む。空なら全部 false（材料が無い時に何も主張しない） */
export function readFirstMessage(text: string | null | undefined): FirstMessageFacts {
  const t = (text ?? "").trim();
  const empty: FirstMessageFacts = {
    hasGreeting: false, hasReceipt: false, declaredDone: [], propertyLabels: [], hasAmount: false, hasSinglePick: false,
  };
  if (!t) return empty;
  const done: FirstMessageFacts["declaredDone"] = [];
  if (DONE_PICKUP_RE.test(t)) done.push("pickup");
  if (DONE_CHECK_RE.test(t)) done.push("check");
  if (DONE_ESTIMATE_RE.test(t)) done.push("estimate");
  if (DONE_VIEWING_RE.test(t)) done.push("viewing_guide");
  const labels: string[] = [];
  PROPERTY_LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROPERTY_LABEL_RE.exec(t)) !== null) {
    const name = m[1].trim();
    // 「家賃106,000円」のような費用・条件の断片を物件名にしない（全件監査で20件の誤検知が出た線）
    if (!name || /^[0-9０-９,，.．\s　・]+$/.test(name) || NOT_A_PROPERTY_RE.test(name)) continue;
    const label = `${name} ${m[2].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))}号室`;
    if (!labels.includes(label)) labels.push(label);
    if (labels.length >= 6) break;
  }
  return {
    hasGreeting: GREETING_RE.test(t),
    hasReceipt: RECEIPT_RE.test(t),
    declaredDone: done,
    propertyLabels: labels,
    hasAmount: AMOUNT_RE.test(t),
    hasSinglePick: SINGLE_PICK_RE.test(t),
  };
}

const DONE_JA: Record<FirstMessageFacts["declaredDone"][number], string> = {
  pickup: "お部屋をピックアップして**送り終えた**",
  check: "募集状況・条件を**確認し終えた**",
  estimate: "御見積書を**送り終えた**",
  viewing_guide: "内覧のご案内を**し終えた**",
};
const FUTURE_NG: Record<FirstMessageFacts["declaredDone"][number], string> = {
  pickup: "「ピックアップさせて頂きます」「お送りさせて頂きます」「お探しさせて頂きます」",
  check: "「確認させて頂きます」「お調べさせて頂きます」",
  estimate: "「御見積書を作成しお送りさせて頂きます」",
  viewing_guide: "「ご案内させて頂きます」（既に案内済みのため）",
};

/**
 * 1通目を踏まえた指示ブロック。1通目が無い・何も読み取れない時は空文字（何も主張しない）。
 * ⚠ ここは**入口**（材料を渡す）。本文を書き換える出口は作らない。
 */
export function buildAixChainNote(firstMessage: string | null | undefined): string {
  const f = readFirstMessage(firstMessage);
  const t = (firstMessage ?? "").trim();
  if (!t) return "";
  const L: string[] = [];
  L.push("【直前にこのお客様へ送った1通目（AIX）— この続きとして書く】");
  L.push(t.length > 600 ? `${t.slice(0, 600)}…` : t);
  L.push("");
  L.push("↑ これは**もう送信済み**。今から書くのはその**直後に続けて送る2通目**。");
  const rules: string[] = [];
  if (f.declaredDone.length > 0) {
    rules.push(`1通目で${f.declaredDone.map((d) => DONE_JA[d]).join("・")}と伝えている。同じことを${f.declaredDone.map((d) => FUTURE_NG[d]).join("／")}のように**これからやる形で書かない**（実送信1,419組でこの重複は0.2%）`);
  }
  if (f.hasGreeting) rules.push("1通目に挨拶（お世話になっております等）が入っている。2通目に挨拶行を重ねない（実送信で重ねるのは2.0%）");
  if (f.hasReceipt) rules.push("1通目が「ご査収ください」で締めている。2通目で「ご査収ください」を繰り返さない（実送信で重ねるのは3.1%）");
  if (f.hasAmount) rules.push("1通目に金額（初期費用）が入っている。2通目で金額・割引額・節約額を書き直さない（数字は1通目が正）");
  if (f.hasSinglePick) rules.push("1通目で既に1件に絞って推している。2通目で別の1件を推し直さない");
  if (f.propertyLabels.length > 0) {
    rules.push(`1通目で触れている物件: ${f.propertyLabels.join("・")}。2通目でこれ以外の物件名・号室を出さない（会話履歴の別物件を持ち出さない）`);
  }
  if (rules.length === 0) return "";
  L.push("");
  L.push("【2通目の書き方（1通目との関係）】");
  for (const r of rules) L.push(`・${r}`);
  L.push("・2通目は1通目の中身を前提にして、**次の一歩**だけを書く。長さは120字前後（実送信の中央値）");
  return L.join("\n");
}
