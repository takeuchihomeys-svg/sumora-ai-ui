// app/lib/aix-desk-types.ts — LINE の統括と AIX の統括の間で渡す物の型（型だけ・動きは無い）
//
// 2026-10-29 竹内さん（KB P1 03d2bdd2「AIX を選ぶ判断は AIX の中の統括に任せ、ボタンとピッカーごとに担当」・7bbb1760 2つの統括をつなぐ）・作業員1＋作業員2で合わせた形:
//   LINE の統括（brain-core）→ AIX の統括: AixHandoff（状況のまとめは作業員2の situation-summary.ts の SituationSummary をそのまま入れる）
//   AIX の統括 → LINE の統括: AixVerdict（選んだボタン×ピッカー・理由・足りない材料・差し戻し）
//   差し戻し（sendBack）が来たら LINE の統括がブレインを1回だけ読み直す（作業員2の担当・決まった書き換えはしない）。どちらも黙って上書きしない。
//   記録: brain_decision_logs.digest.ad（cand・pick・sb）。毎晩2つの統括の食い違いを数え、外れは試験の問題にする。

/** 担当の札（scripts/build-aix-desk-cards.ts の出力 cards.json の1枚） */
export type AixDeskCard = { key: string; button: string; picker: string | null; text: string; owner: number; thin: string[] };

/** スタッフだけが知る事のうち、この番で要る物（物件名つき＝状況のまとめの「今すぐ果たせる物」と突き合わせる） */
export type StaffOnlyNeed = { kind: string; property?: string | null };

/** LINE の統括 → AIX の統括 */
export type AixHandoff<Situation = unknown, Bind = unknown> = {
  /** 状況のまとめ（作業員2の SituationSummary） */
  situation: Situation | null;
  /** AIX の番と見た理由（短い文） */
  whyAix: string;
  /** 要るスタッフだけが知る事 */
  staffOnlyNeeds: StaffOnlyNeed[];
  /** 今のお客様の発言（伏せた物） */
  turnText: string;
  /** 今の発言が指す送った事（sent-ledger-bind の結果）か null */
  bind: Bind | null;
  /** LINE の統括の最初の AIX（比べるため） */
  llmAix: string | null;
};

/** 担当（ボタン×ピッカー）の答え */
export type AixDeskAnswer = {
  /** 担当の鍵（"ボタン" か "ボタン/ピッカーの値"） */
  key: string;
  /** この番は自分の番か */
  mine: boolean;
  /** 自分の番の時、どのピッカーか（鍵と違うピッカーを勧める時） */
  picker?: string | null;
  /** 足りない材料 */
  missing: string[];
  /** 理由（短い文） */
  why: string;
};

/** 差し戻し: not_aix＝AIX の番ではない（返信）／promise＝今は結果が無いので約束の返信にすべき */
export type AixSendBack = { kind: "not_aix" | "promise"; why: string };

/** AIX の統括 → LINE の統括 */
export type AixVerdict = {
  pick: { key: string; reason: string } | null;
  missing: string[];
  sendBack: AixSendBack | null;
  desks: AixDeskAnswer[];
};
