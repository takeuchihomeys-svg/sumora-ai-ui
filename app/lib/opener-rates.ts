// app/lib/opener-rates.ts
// 開口語を「一択」で決めつけず、実送信の分布とブレインの判断で見る（純関数・DB 依存なし）。
//
// 2026-09-21 竹内「一択と指摘するんじゃなくて実際の成約データや直近の会話から学習して、
//   場面でいれるかどうかはブレインに判断させる。そのためにもブレインはあるのだから（文の構成等）」
//
// ■ それまでの形（決めつけ）— final-check.ts に直書きされていた
//     感謝返し・短い了承・強推し直後・一時保留・検討中フォロー → 「はい😊！！」一択
//     条件提示・内覧キャンセル・顧客自身の断り              → 「かしこまりました！！」一択
//
// ■ 実測で検算したら、**どの場面でも一択にできなかった**
//   （scripts/audit-opener-by-scene.ts・直近180日・場面は直前のお客様の発言で決めた）
//     短い了承・お礼(343)  : 開口語なし49.3% / はい32.9% / かしこまりました8.7%
//     検討中・一時保留(94) : かしこまりました35.1% / はい27.7% / 開口語なし23.4%
//     条件提示(129)        : かしこまりました43.4% / 開口語なし27.1%
//     条件フォーム受領(176): はじめまして55.1% / 〇〇頂きありがとう14.8% / 開口語なし13.1% / かしこまりました10.8%
//     断り・キャンセル(21) : 開口語なし47.6% / かしこまりました47.6%
//     質問(1542)           : 開口語なし52.5% / かしこまりました22.8% / お世話になっております12.7% / はい9.3%
//   成約（closed_won 等）だけで見ても向きは同じ（短い了承の「はい」は 27.5%）。
//   直近30日でも同じ（短い了承の「はい」47.3%・条件提示の かしこまりました 52.6%）。
//   ＝ 設計知見「必須にしてよいのは過半数が守っている形だけ」に照らすと、
//     **一番多い開口語ですら半分に届かない場面がほとんど**。一択の指摘は雑音になる。
//
// ■ 直した形
//   ① ブレインが開口語を決めていれば**それに従う**（判断はブレインの仕事）
//   ② ブレインが決めていない時は、**実送信でほぼ使われていない開口語**の時だけ言う
//      （設計知見「禁止にしてよいのは実送信がほぼ0の形だけ」）
//   ③ 言う時も「一択です」ではなく**実測の率を添えて**言う（根拠を隠さない）

export type OpenerScene =
  | "短い了承・お礼" | "検討中・一時保留" | "条件提示" | "条件フォーム受領"
  | "断り・キャンセル" | "質問" | "その他";

export type OpenerLabel =
  | "はい" | "かしこまりました" | "開口語なし" | "お世話になっております"
  | "〇〇頂きありがとうございます" | "承知／了解" | "ありがとうございます（目的語なし）" | "はじめまして";

/** 実送信の分布（%）。scripts/audit-opener-by-scene.ts の「全体」欄をそのまま置く */
export const OPENER_RATE: Record<OpenerScene, Partial<Record<OpenerLabel, number>>> = {
  "短い了承・お礼": { "開口語なし": 49.3, "はい": 32.9, "かしこまりました": 8.7, "お世話になっております": 7.0, "ありがとうございます（目的語なし）": 1.7, "〇〇頂きありがとうございます": 0.3 },
  "検討中・一時保留": { "かしこまりました": 35.1, "はい": 27.7, "開口語なし": 23.4, "お世話になっております": 11.7, "承知／了解": 1.1, "はじめまして": 1.1 },
  "条件提示": { "かしこまりました": 43.4, "開口語なし": 27.1, "はじめまして": 9.3, "お世話になっております": 7.8, "〇〇頂きありがとうございます": 7.8, "はい": 3.9, "ありがとうございます（目的語なし）": 0.8 },
  "条件フォーム受領": { "はじめまして": 55.1, "〇〇頂きありがとうございます": 14.8, "開口語なし": 13.1, "かしこまりました": 10.8, "お世話になっております": 5.1, "はい": 0.6, "ありがとうございます（目的語なし）": 0.6 },
  "断り・キャンセル": { "開口語なし": 47.6, "かしこまりました": 47.6, "お世話になっております": 4.8 },
  "質問": { "開口語なし": 52.5, "かしこまりました": 22.8, "お世話になっております": 12.7, "はい": 9.3, "〇〇頂きありがとうございます": 1.3, "はじめまして": 1.0, "承知／了解": 0.2, "ありがとうございます（目的語なし）": 0.2 },
  "その他": { "開口語なし": 35.9, "かしこまりました": 35.1, "はい": 10.8, "お世話になっております": 8.3, "〇〇頂きありがとうございます": 6.2, "はじめまして": 2.5, "ありがとうございます（目的語なし）": 1.1, "承知／了解": 0.2 },
};
/** 母数（何通から出した率か。少ない場面で強く言わないため） */
export const OPENER_SAMPLE: Record<OpenerScene, number> = {
  "短い了承・お礼": 343, "検討中・一時保留": 94, "条件提示": 129, "条件フォーム受領": 176,
  "断り・キャンセル": 21, "質問": 1542, "その他": 1311,
};
/** 「実送信でほぼ使われていない」線。これ未満の時だけ言う（設計知見「禁止は実送信ほぼ0の形だけ」） */
export const OPENER_RARE_PCT = 3.0;
/** 母数がこれ未満の場面では何も言わない（率が当てにならない） */
export const OPENER_MIN_SAMPLE = 30;

/** final-check の TPO ラベルから場面に寄せる（対応が付かなければ null＝何も言わない） */
export function sceneFromTpo(tpo: string | null | undefined): OpenerScene | null {
  const t = tpo ?? "";
  if (!t) return null;
  if (/条件フォーム/.test(t)) return "条件フォーム受領";
  if (/感謝返し|短い了承|強推し直後/.test(t)) return "短い了承・お礼";
  if (/一時保留|検討中フォロー|検討中/.test(t)) return "検討中・一時保留";
  if (/内覧キャンセル|顧客自身の断り|断り/.test(t)) return "断り・キャンセル";
  if (/条件提示|条件変更|条件追加/.test(t)) return "条件提示";
  if (/質問/.test(t)) return "質問";
  return null;
}

/** 本文の書き出しから開口語の種類を決める（監査 audit-opener-by-scene.ts の openerOf と同名・同順） */
export function openerLabelOf(text: string | null | undefined): OpenerLabel {
  const first = ((text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "");
  if (/^かしこまりました/.test(first)) return "かしこまりました";
  if (/^[はハ]い/.test(first)) return "はい";
  if (/^(?:承知|了解)/.test(first)) return "承知／了解";
  if (/はじめまして/.test(first)) return "はじめまして";
  if (/お世話になっております/.test(first)) return "お世話になっております";
  if (/^[^\n。！!]{0,20}(?:お送り|ご連絡|ご記入|ご入力)(?:頂|いただ)き[^\n。！!]{0,4}ありがとう/.test(first)) return "〇〇頂きありがとうございます";
  if (/^ありがとうございます/.test(first)) return "ありがとうございます（目的語なし）";
  return "開口語なし";
}

export type OpenerJudgement = { ok: true } | { ok: false; message: string; suggestion: string; rate: number };

/**
 * 開口語を見る。**一択とは言わない**。
 *
 * @param brainOpener ブレインが決めた開口語（無ければ null）。決まっていればそれに従う。
 */
export function judgeOpener(
  scene: OpenerScene | null,
  text: string | null | undefined,
  brainOpener?: OpenerLabel | null,
): OpenerJudgement {
  const used = openerLabelOf(text);
  // ① ブレインが決めているなら、その判断が上。合っていれば何も言わない
  if (brainOpener) {
    if (used === brainOpener) return { ok: true };
    const r = scene ? (OPENER_RATE[scene][used] ?? 0) : 0;
    return {
      ok: false, rate: r,
      message: `ブレインはこの場面の開口語を「${brainOpener}」と判断しましたが、書き出しは「${used}」です`
        + `${scene ? `（この場面の実送信では ${used} ${r}%・${brainOpener} ${OPENER_RATE[scene][brainOpener] ?? 0}%）` : ""}`,
      suggestion: `書き出しを「${brainOpener}」に合わせる（ブレインの判断を変えるなら、そちらを直す）`,
    };
  }
  // ② ブレインが決めていない時は、実送信でほぼ使われていない形だけ言う
  if (!scene) return { ok: true };
  if (OPENER_SAMPLE[scene] < OPENER_MIN_SAMPLE) return { ok: true };
  const rate = OPENER_RATE[scene][used] ?? 0;
  if (rate >= OPENER_RARE_PCT) return { ok: true };
  const top = (Object.entries(OPENER_RATE[scene]) as Array<[OpenerLabel, number]>)
    .sort((a, b) => b[1] - a[1]).slice(0, 3);
  return {
    ok: false, rate,
    message: `この場面（${scene}・実送信${OPENER_SAMPLE[scene]}通）で「${used}」で書き出すのは ${rate}% しかありません`
      + `（多いのは ${top.map(([k, v]) => `${k} ${v}%`).join(" / ")}）`,
    suggestion: `書き出しを ${top.map(([k]) => k).join(" か ")} のどれかにする（どれが良いかは会話の中身で決める）`,
  };
}

/** ブレインに渡す材料（実測の分布をそのまま見せて、ブレインに決めさせる） */
export function buildOpenerRateNote(scene: OpenerScene | null): string {
  if (!scene || OPENER_SAMPLE[scene] < OPENER_MIN_SAMPLE) return "";
  const list = (Object.entries(OPENER_RATE[scene]) as Array<[OpenerLabel, number]>)
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}%`).join(" / ");
  return `この場面（${scene}）でスタッフが実際に使っている書き出し（実送信${OPENER_SAMPLE[scene]}通）: ${list}。`
    + `一択にはできない（一番多い物でも過半数に届かない場面が多い）ので、会話の中身で決めること。`;
}
