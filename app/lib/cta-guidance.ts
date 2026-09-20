// app/lib/cta-guidance.ts
// 2通目（AIX テンプレート）に CTA（内覧・申込の誘い）を付けるかを決める（純関数・実測が根拠）。
//
// 2026-09-21 竹内「付けるかはブレインが判断する。お客さんの反応見て刺さっているなら、誘導する。
//   成約データや直近の会話を見て分析する」
//
// ■ purchase_signal_level は使わない（設計知見）
//   「購買シグナル peak は『申込しそう』ではなく『申込した』を言っていた」:
//   最初の peak より前に申込済みが10件中8件（中央値 -8.4日）＝**事後の追認**。
//   段階としても機能せず（strong 7%・soft 0%）、判定がある会話も49%しかない。
//   だから「刺さっている」は**お客様の直近の発言の分類**（classifyCustomerResponse）で見る。
//   返信生成・往復文脈と同じ関数なので四者同名が保たれる。
//
// ■ 実測（scripts/audit-cta-trigger.ts・直近180日・AIX の1通目→30分以内の2通目 1,424組）
//   全体の CTA 率 12.7%（内覧102 / 申込79）
//
//   お客様の反応（classifyCustomerResponse.kind）別:
//     positive           72組  **30.6%**（内覧29.2 / 申込1.4）← 刺さっている
//     question          320組    19.4%（内覧9.7 / 申込9.7）
//     answer             12組    16.7%
//     thinking           42組    14.3%
//     other             405組    11.9%
//     ack_only          438組     8.4%
//     concern            31組   **3.2%** ← 付けない
//     condition_change   94組   **1.1%** ← 付けない
//
//   前向きの中身（positive.kind）別:
//     appraisal（褒め・評価）      11組  **45.5%**（内覧36.4 / 申込9.1）
//     viewing_explicit（内覧したい）67組  **31.3%**（内覧29.9 / 申込1.5）
//     それ以外                   1346組    11.5%
//
//   **成約した会話（114組）では positive の CTA 率が 60.0%**（成約全体は14.9%）。
//
//   AIX 種類別:
//     meeting_place（待ち合わせ） 30組 **50.0%**（内覧50.0）
//     viewing_invite（内覧日調整）53組 **49.1%**（内覧47.2）
//     application_push（申込へ！）63組 **28.6%**（申込27.0）
//     estimate_sheet（見積書送る）222組 **22.1%**（申込15.8）
//     property_check_result      141組    9.2%
//     property_recommendation    537組    9.1%
//     property_send（ピックアップ）330組 **3.0%** ← ほぼ付けない
//     condition_hearing（ヒアリング）40組 **0.0%** ← 付けない

import type { CustomerResponseKind } from "./reply-context";

export type CtaMode = "push" | "soft" | "none";
export type CtaKind = "viewing" | "apply" | null;

/** AIX 種類ごとの CTA 率（実測・%）。載っていない種類は全体の12.7%とみなす */
export const CTA_RATE_BY_ACTION: Record<string, { all: number; viewing: number; apply: number }> = {
  meeting_place: { all: 50.0, viewing: 50.0, apply: 0.0 },
  viewing_invite: { all: 49.1, viewing: 47.2, apply: 1.9 },
  application_push: { all: 28.6, viewing: 1.6, apply: 27.0 },
  estimate_sheet: { all: 22.1, viewing: 6.3, apply: 15.8 },
  property_check_result: { all: 9.2, viewing: 5.0, apply: 4.3 },
  property_recommendation: { all: 9.1, viewing: 5.6, apply: 3.5 },
  property_send: { all: 3.0, viewing: 2.7, apply: 0.3 },
  condition_hearing: { all: 0.0, viewing: 0.0, apply: 0.0 },
};
export const CTA_RATE_OVERALL = 12.7;

/** お客様の反応ごとの CTA 率（実測・%） */
export const CTA_RATE_BY_KIND: Partial<Record<CustomerResponseKind, number>> = {
  positive: 30.6,
  question: 19.4,
  answer: 16.7,
  thinking: 14.3,
  other: 11.9,
  ack_only: 8.4,
  concern: 3.2,
  condition_change: 1.1,
};

/** 前向きの中身ごとの CTA 率（実測・%） */
export const CTA_RATE_BY_POSITIVE: Record<string, number> = {
  appraisal: 45.5,
  viewing_explicit: 31.3,
};

export type CtaGuidance = {
  mode: CtaMode;
  /** 付けるなら内覧か申込か（決められない時は null＝AI に選ばせる） */
  kind: CtaKind;
  /** プロンプトに入れる1行（空文字なら何も足さない） */
  note: string;
  /** 判断の根拠（ログ・監査用） */
  reason: string;
};

/**
 * 2通目に CTA を付けるか。
 * ・お客様の反応（刺さっているか）と AIX の種類の**両方**で決める。
 * ・どちらも実測の率を根拠にする。迷う時は "soft"（付けても付けなくてもよい）に倒す
 *   ＝ LLM は「付けるな」も「毎回付けろ」も極端に取るので、両端を言い切るのは
 *     **実測がはっきりしている時だけ**にする。
 */
export function resolveCtaGuidance(input: {
  customerKind: CustomerResponseKind | null | undefined;
  positiveKind?: string | null;
  action?: string | null;
}): CtaGuidance {
  const kindRate = input.customerKind ? (CTA_RATE_BY_KIND[input.customerKind] ?? CTA_RATE_OVERALL) : CTA_RATE_OVERALL;
  const posRate = input.positiveKind ? CTA_RATE_BY_POSITIVE[input.positiveKind] : undefined;
  const act = (input.action ?? "").trim();
  const actRate = CTA_RATE_BY_ACTION[act]?.all ?? CTA_RATE_OVERALL;
  const actRow = CTA_RATE_BY_ACTION[act];

  // ① お客様が「付けない」側にはっきり寄っている（懸念・条件変更）→ 付けない
  if (input.customerKind === "concern" || input.customerKind === "condition_change") {
    return {
      mode: "none", kind: null,
      note: `【CTA（内覧・申込の誘い）は書かない】お客様は${input.customerKind === "concern" ? "懸念" : "条件の変更"}を伝えている。`
        + `実送信の2通目でこの場面の CTA は **${kindRate}%**（全体${CTA_RATE_OVERALL}%）＝ ほぼ誘わない。`
        + `懸念・条件を受け止めて、次にこちらが何をするかだけ書く。`,
      reason: `customerKind=${input.customerKind} (${kindRate}%)`,
    };
  }
  // ② お客様が刺さっている（前向き）→ 付ける
  //   ⚠ **AIX の種類より先に見る**。竹内さん「お客さんの反応見て刺さっているなら、誘導する」。
  //     物件ピックアップ（全体3.0%）の直後でも、お客様が「内覧したい」と言っているなら誘ってよい
  //     （AIX 別の率は「相槌・無反応が大半」の平均なので、前向きな反応の時まで抑える根拠にはならない）。
  if (input.customerKind === "positive") {
    const viewingLed = (posRate ?? 0) >= 30 || input.positiveKind === "viewing_explicit";
    const kind: CtaKind = actRow && actRow.apply > actRow.viewing ? "apply" : viewingLed ? "viewing" : null;
    return {
      mode: "push", kind,
      note: `【CTA（誘い）を1文入れる】お客様は前向きな反応（${input.positiveKind ?? "前向き"}）を見せている。`
        + `実送信でこの場面の CTA は **${posRate ?? kindRate}%**（全体${CTA_RATE_OVERALL}%）、`
        + `**成約した会話では60%**が誘っている。`
        + (kind === "viewing" ? `誘うのは**内覧**（この反応では内覧29.9% / 申込1.5%）。` : "")
        + (kind === "apply" ? `誘うのは**申込**（この AIX では申込${actRow?.apply}% / 内覧${actRow?.viewing}%）。` : "")
        + `押し付けず「お気に召されましたら」の条件付きで1文だけ。`,
      reason: `positive/${input.positiveKind ?? "-"} (${posRate ?? kindRate}%) × action=${act} (${actRate}%)`,
    };
  }
  // ③ AIX 自体が誘わない種類（ヒアリング・物件ピックアップ）→ 付けない
  //   （②で前向きな反応は先に拾ってあるので、ここに来るのは相槌・無反応・その他の時だけ）
  if (actRate <= 5) {
    return {
      mode: "none", kind: null,
      note: `【CTA（内覧・申込の誘い）は書かない】この AIX の2通目で CTA を付けるのは実送信の **${actRate}%** だけ。`
        + `（物件を送った直後は、お客様が見てから動く場面。ここで誘わない）`,
      reason: `action=${act} (${actRate}%) / kind=${input.customerKind ?? "-"}`,
    };
  }
  // ④ AIX が誘う種類（内覧日調整・待ち合わせ・申込へ・見積書）→ 付けてよい
  if (actRate >= 20) {
    const kind: CtaKind = actRow ? (actRow.apply > actRow.viewing ? "apply" : "viewing") : null;
    return {
      mode: "push", kind,
      note: `【CTA（誘い）を1文入れてよい】この AIX の2通目は実送信の **${actRate}%** が誘っている`
        + (kind ? `（${kind === "apply" ? "申込" : "内覧"}が中心: 申込${actRow?.apply}% / 内覧${actRow?.viewing}%）` : "")
        + `。お客様の反応に合っていれば1文だけ添える。`,
      reason: `action=${act} (${actRate}%)`,
    };
  }
  // ⑤ それ以外 → どちらでもよい（言い切らない）
  return {
    mode: "soft", kind: null,
    note: `【CTA（内覧・申込の誘い）は任意】この場面の実送信は **${Math.round(Math.min(kindRate, actRate))}%前後**。`
      + `お客様が前向きなら1文添えてよいが、無理に誘わない。見立てを伝えて終わってよい。`,
    reason: `kind=${input.customerKind ?? "-"} (${kindRate}%) × action=${act} (${actRate}%)`,
  };
}
