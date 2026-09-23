// app/lib/company-fact-guard.ts
// 「会社として答えが決まっている事実」（company-facts.ts）に**反する断定**を、出口（最終チェックの決定論の段）で見つける純関数。
//
// 2026-09-23 竹内「会社の事実に反する断定を出口で止める規則の部分、ファイナルチェックがあるからそこで予防できている。
//   ファイナルチェックが問題なく機能しているか確認する。機能していない場合もあるので」
//
// ── 実物（DeepSeek 経路・YUMA・scripts/yuma-company-facts-direct.ts）──
//   場面③「これ室内写真欲しいです」
//     → 「室内写真は現在ご用意出来ていない為、私の方で撮影しお送りさせて頂きます😊！！」（そのまま画面に出た）
//   場面②（写真の依頼・別の回）
//     → 「弊社での室内撮影は行えておらず現状写真はご用意できておりません」
//   場面①「当日はそちらの店舗へ伺い…」
//     → 「店舗にご来店頂いてのご相談も承っております」（会社の事実と逆）
//   S7（クレカ払い）当時の実データ
//     → 「クレジットカード払いは対応しておらず」（スタッフが直した）
//
// ── 出所（追った結果）──
//   最終チェックは動いていた（3パス完走・issues 空）が、**会社の事実を判定の根拠として持っていなかった**:
//     ・final-check.ts は company-facts を import していない（会社の事実は生成プロンプトとブレインにしか渡っていない）
//     ・anomaly_scan の「会社の制度」は仲介手数料・日割家賃・AD還元だけ（FABRICATED_POLICY の定義も同じ）
//     ・決定論の段（BANNED_WORDS／ASSERTION_BAN_RULES／BANNED_PATTERNS／V7〜V9）に「写真が無い」「店舗で相談可」
//       「クレカ不可」の断定を見る物は無い。V7 PHOTO_NO_PREMISE はお客様が写真を望んでいる時は免除＝場面③では発火しない
//   ＝ 壊れて素通りしたのではなく、判定の根拠を持っていなかった。
//
// ── 実送信で引いた線（365日・scripts/audit-final-check-company-facts.ts で候補を全部目で読む）──
//   ここに入れる形は「実送信 0通」の物だけ（設計知見「出口は誤削除0でなければ入れない」）。
//   守る物（当てない）:
//     ・理由付きの「写真はご用意出来ておりません」（建築中・完成前・退去前・入居中 ＝ 物件固有の正しい説明。
//       line-reply-prompts.ts:1354 が ○ と教える形・実送信1通）
//     ・条件形「写真がない場合は」（実送信1通）
//     ・「ご来店お待ちしております」（内覧の待ち合わせ・実送信4通）／「ご来店頂けますと内覧から審査まで」（申込テンプレ）
//       → 店舗の断定は **店舗・事務所＋来店・来社＋相談** の形だけに絞る（裸の「来店」は止めない）
//     ・クレカの話でも保証会社の審査（「クレカ系は控えたい」「滞納歴」）は支払い方法ではない
//
// ── 入口と出口 ──
//   入口（生成プロンプト・ブレイン）… buildCompanyFactsNote（既存）。DeepSeek には 6〜7割しか届かない（実測）
//   出口（この関数 → final-check V16 COMPANY_FACT_CONTRADICTION）… **block**（修正ループで書き直させる。本文は決定論で削らない）
//   さらに anomaly_scan（Haiku）にも [COMPANY_FACTS] を渡す（final-check.ts buildAnomalyScanPrompt）。
//
// ⚠ 判定はお客様が**その事実を聞いている時**（matchCompanyFacts が当たる時）だけ。会社の事実は「聞かれた時だけ渡す」設計で、
//   検査も同じ関数（四者同名）で場面を決める。聞かれていない時の断定は anomaly_scan の [COMPANY_FACTS] にも載らないので、
//   ここでは見ない（監査で「聞かれていない時の断定」が実送信に無いことも確かめてある＝ゲート無しでも 0通）。

import { matchCompanyFacts, COMPANY_FACTS } from "./company-facts";

/** 文の中（区切りをまたがない） */
const SEG = "[^。！!？?\\n]";

export type CompanyFactContradiction = {
  /** company-facts.ts の id（お客様がこれを聞いている時だけ当てる） */
  factId: string;
  /** 反する断定の形（実送信 0通の物だけ） */
  re: RegExp;
  /** 同じ文にこれがあれば正しい文（物件固有の理由・条件形・別の意味）なので当てない */
  exclude?: RegExp;
  /** 指摘の1文 */
  label: string;
  /** 修正ループに渡す直し方（実送信の正解の形） */
  suggestion: string;
};

export const COMPANY_FACT_CONTRADICTIONS: CompanyFactContradiction[] = [
  {
    factId: "room_photo",
    // 「写真…ご用意出来ていない／ございません／無い」「撮影は行えておらず／しておりません／出来ません」
    //   「無い」は条件形（写真がない場合は・無い時は）を否定先読みで外す
    re: new RegExp(
      `(?:写真|画像|動画)${SEG}{0,20}?(?:ご用意|用意)(?:が|は)?(?:出来|でき)て(?:い|お)(?:ない|りません|いません|らず)` +
      `|(?:写真|画像|動画)${SEG}{0,20}?(?:は|が|も)(?:現在|今|まだ)?(?:ございません|御座いません|ありません|無い|ない)(?!場合|時|際|なら|よう|と|か|の)` +
      `|(?:弊社|当社|こちら|私ども)(?:では|で|の|での|側では)?(?:室内|お部屋)?(?:の)?撮影(?:は|を|が)?(?:行(?:え|っ|い)?て|して|し|出来て|できて)(?:おりません|いません|おらず|いない|ません)` +
      `|撮影(?:は|を|が)?(?:行(?:え|っ|い)?て|して|出来て|できて)(?:おりません|いません|おらず|いない)` +
      `|撮影(?:は|が)?(?:出来|でき)(?:ません|かね)`,
    ),
    // 物件固有の理由（建築中・完成前・退去前・入居中・募集前・エリア外）がある文は正しい説明
    exclude: /建築中|建設中|工事中|完成|新築|竣工|退去(?:前|まで|後)|入居中|募集前|エリア外|対応エリア|管理会社|オーナー|貸主|お住まい中|居住中/,
    label: "室内の写真・動画はスタッフが手元の物を AIX から送る／撮影して送れる（会社の事実）のに「写真が無い／ご用意出来ていない／撮影していない」と断定しています",
    // 2026-09-23 竹内「室内の写真が欲しいといわれたら AIX の物件確認したの室内写真確認したのピッカーから送る形」: 直し方を流れに合わせる。
    //   re／exclude は変えない（出口は誤削除0の物だけ。「撮影して送る」宣言は実送信にある形なので出口で止めない）
    suggestion: "断定の文を削除し「室内のお写真お送りさせて頂きます！！」の受付にとどめる（写真・URL は AIX【物件確認した→室内写真を確認した】からスタッフが送る。本文で「撮影してお送りします」と約束しない・建築中など物件固有の理由が無い限り「ご用意出来ていない」と書かない）",
  },
  {
    factId: "store",
    // 店舗・事務所＋来店・来社＋相談 の形だけ（裸の「ご来店」は内覧の待ち合わせ・申込テンプレで実送信にある）
    re: new RegExp(
      `(?:店舗|事務所|オフィス)(?:に|へ|で|での|まで)?(?:の)?(?:ご)?(?:来店|来社|お越し)(?:を)?(?:頂|いただ)(?:い|け)て(?:の)?(?:ご)?(?:相談|面談|お話|ご案内|説明)` +
      `|(?:店舗|事務所|オフィス)(?:での|で|に|へ)(?:の)?(?:ご)?(?:相談|面談|対面|打ち合わせ|お打合せ|お話)(?:も|は|を)?${SEG}{0,8}?(?:承|可能|大丈夫|歓迎|お待ち|出来ます|できます|頂けます|いただけます)` +
      `|(?:店舗|事務所|オフィス)(?:に|へ)(?:の)?(?:ご)?(?:来店|来社|お越し)(?:も|は)?${SEG}{0,6}?(?:承|可能|大丈夫|歓迎|お待ち)` +
      `|対面で(?:の)?(?:ご)?(?:相談|面談)(?:も|は)?${SEG}{0,6}?(?:承|可能|大丈夫|歓迎|出来ます|できます)`,
    ),
    label: "弊社はオンライン専門で、事務所への来社でのご相談は受けていない（会社の事実）のに、店舗・事務所でのご相談を受け入れています",
    suggestion: "店舗・事務所での相談を受け入れる文を削除し「弊社はオンライン専門の不動産サービスで、お部屋の紹介・内覧の日程調整は LINE とお電話で行っております」の形にする",
  },
  {
    factId: "credit_card",
    // 「クレジットカード（払い・決済）は対応していない／利用できない／不可」
    re: new RegExp(
      `(?:(?:クレジット|クレカ)(?:カード)?|カード)(?:払い|決済|でのお?支払い?|支払い|で)?(?:は|には|に|も|の)?${SEG}{0,10}?` +
      `(?:対応(?:して|いたして|致して|しており|できて|出来て|は)?(?:おりません|いません|おらず|いない|ません)` +
      `|(?:ご利用|利用|お使い)(?:いただけ|頂け|でき|出来)ません` +
      `|(?:出来|でき)(?:ません|かね)|不可|承って(?:おりません|いません)|お受け(?:して|できて|出来て)?(?:おりません|いません))`,
    ),
    // 保証会社の審査の話（クレカ系・ブラック・滞納）は支払い方法ではない。「分割サービスは導入していない」は正しい
    exclude: /ブラック|滞納|審査|保証会社|クレカ系|分割サービス|後払い/,
    label: "初期費用はクレジットカード払いに対応している（会社の事実・決済手数料3.24%）のに「対応していない／利用できない」と断定しています",
    suggestion: "断定の文を削除し「初期費用はクレジットカード払いにも対応しております（決済手数料3.24%が別途かかります）」の形にする",
  },
  {
    factId: "emergency_contact",
    // 「緊急連絡先は不要／必要ありません／必須ではない／無くても大丈夫／任意」
    re: new RegExp(
      `緊急連絡先(?:の設定|の登録|のご登録)?(?:は|も|が)?${SEG}{0,8}?(?:不要|必要(?:ありません|ございません|御座いません|ない|なく)|必須では(?:ありません|ございません|ない)|(?:無|な)くても|任意)`,
    ),
    label: "緊急連絡先は必須（会社の事実・3親等以内）なのに「不要／必須ではない」と断定しています",
    suggestion: "断定の文を削除し「緊急連絡先は3親等以内のご家族（お母様・お父様・ご兄弟など）で必須となります」の形にする",
  },
  {
    factId: "viewing_method",
    // 「オンライン内覧は行っていない／できない／不可」（エリア外・物件固有の理由が無い形だけ）
    re: new RegExp(
      `オンライン(?:での|で|の|にて)?(?:内覧|内見)(?:は|も|には|に)?${SEG}{0,10}?` +
      `(?:(?:行って|して|対応して|承って|実施して|やって)(?:おりません|いません|おらず|いない)|(?:出来|でき)(?:ません|かね)|不可|対応外)`,
    ),
    exclude: /エリア外|対応エリア|エリア|遠方|管理会社|オーナー|貸主|退去|入居中|建築中|完成|募集前|お部屋によって|物件によって|ご案内出来ない/,
    label: "内覧はオンライン内見（スタッフが現地からビデオ通話）も選べる（会社の事実）のに「オンライン内覧は出来ない」と断定しています",
    suggestion: "断定の文を削除し「オンライン内見（スタッフが現地に行きビデオ通話でご案内）・室内の動画撮影・現地でのご案内からお選び頂けます」の形にする（内覧可能エリア外の物件だけは理由を添えて不可と伝える）",
  },
];

export type CompanyFactContradictionHit = {
  factId: string;
  /** 当たった文（区切りで切った1文） */
  sentence: string;
  label: string;
  suggestion: string;
};

/** 文に分ける（final-check V15 と同じ区切り） */
export function splitSentencesForFactGuard(text: string): string[] {
  return (text ?? "").split(/[\n。！!？?]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * ゲート無しの判定（監査用）。本文のどの文が、どの事実に反する断定か。
 * ⚠ 本番の検査はこれを直接使わず、findCompanyFactContradiction（お客様が聞いている時だけ）を使う。
 */
export function findCompanyFactContradictionsUngated(body: string | null | undefined): CompanyFactContradictionHit[] {
  const out: CompanyFactContradictionHit[] = [];
  for (const s of splitSentencesForFactGuard(body ?? "")) {
    for (const c of COMPANY_FACT_CONTRADICTIONS) {
      if (!c.re.test(s)) continue;
      if (c.exclude && c.exclude.test(s)) continue;
      out.push({ factId: c.factId, sentence: s, label: c.label, suggestion: c.suggestion });
    }
  }
  return out;
}

/**
 * お客様がその事実を聞いている時（matchCompanyFacts が当たる時）だけ、反する断定を返す（最初の1件）。
 * customerTexts は直近のお客様の発言（最新＋数通）。画像の書き起こしは matchCompanyFacts 側で外れる。
 */
export function findCompanyFactContradiction(
  body: string | null | undefined,
  customerTexts: ReadonlyArray<string | null | undefined>,
): CompanyFactContradictionHit | null {
  const asked = new Set(matchCompanyFacts(customerTexts.map((t) => t ?? "")).map((f) => f.id));
  if (asked.size === 0) return null;
  for (const h of findCompanyFactContradictionsUngated(body)) if (asked.has(h.factId)) return h;
  return null;
}

/**
 * 最終チェック（anomaly_scan）に渡す会社の事実の一覧。お客様が聞いている物だけ（無ければ空文字）。
 * 生成プロンプト（buildCompanyFactsNote）と同じ matchCompanyFacts を使う（四者同名）。送る文ではなく事実として渡す。
 */
export function buildCompanyFactsForCheck(customerTexts: ReadonlyArray<string | null | undefined>): string {
  const hit = matchCompanyFacts(customerTexts.map((t) => t ?? ""));
  if (hit.length === 0) return "";
  return hit.map((f) => `- ${f.fact.replace(/\*\*/g, "")}`).join("\n");
}

/** 監査・テスト用: 事実の id 一覧（company-facts と同じ物を指しているか） */
export const COMPANY_FACT_IDS_WITH_GUARD = COMPANY_FACT_CONTRADICTIONS.map((c) => c.factId);
const knownIds = new Set(COMPANY_FACTS.map((f) => f.id));
for (const id of COMPANY_FACT_IDS_WITH_GUARD) {
  if (!knownIds.has(id)) throw new Error(`company-fact-guard: company-facts.ts に無い id「${id}」`);
}
