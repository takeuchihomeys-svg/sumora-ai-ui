// app/lib/brain-info-kind.ts — 「情報の種類」の表（スタッフだけが知る情報か・材料が手元にあるか）をブレインの決まりに1段で置く（作業員21・2026-11-12）
//
// 竹内さんの決定 11/12（KB P1 03bd2c71・親 P0 ca55d42b）「AIX と返信の使い分けを細分化して質を上げる」。
// 材料（費用0・読み）: 竹内さんの解剖198通・試験302問の asks・本番の物差し・check-order.ts（T1〜T11）。
// 置き方（道を引っぱらない・q406・q057・q065・q022 の教訓）:
//   この表は「事実の確かめ」だけを書く＝その情報はスタッフだけが知るか／材料が手元にあるか／結果が手元にあるか。
//   「今の番の出力」「次の一手」「押す」「迷ったら AIX」は書かない（道は P0 9eb6aa9c のとおりブレインが読んで決める）。
//   位置は brain-now-later の NOW_VS_LATER_RULES の直後に1段（別スイッチ・単独でも on にできる）。
// スイッチ: BRAIN_INFO_KIND_TABLE（既定 off＝プロンプトは1文字も変わらない・on の時だけ決まりの1段）。

type Env = Record<string, string | undefined>;

export function infoKindTableOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.BRAIN_INFO_KIND_TABLE ?? "").trim().toLowerCase() === "on";
}

export type InfoKindRow = {
  kind: string;
  /** スタッフだけが知る情報か（true＝AI は中身を知り得ない） */
  staffOnly: boolean;
  /** 材料が手元にあるかの確かめ方（事実の確かめだけ・道は書かない） */
  check: string;
  /** 型の表（check-order.ts）の型 ID の脚注 */
  types: string[];
};

export const INFO_KIND_ROWS: readonly InfoKindRow[] = [
  { kind: "募集状況・空き", staffOnly: true, check: "確認の結果が会話・記録に届いているか（届いていなければ結果は無い）", types: ["T3", "T4", "T10"] },
  { kind: "管理会社に確認した結果（設備・入居・畳・エアコン・代理契約）", staffOnly: true, check: "資料に書いてあるか／結果が届いているか。管理会社の名前も確認が要る事", types: ["T3", "T10"] },
  { kind: "交渉の結果（値下げ・名義・保証会社の切り替え）", staffOnly: true, check: "結果が届いているか", types: ["T3", "T10"] },
  { kind: "撮影した写真・室内イメージ", staffOnly: true, check: "手元に室内イメージが有るか（こちらが送った物件か・既に送ったか・建築中でないか）", types: ["T3"] },
  { kind: "見積の金額", staffOnly: true, check: "物件が届いているか（画像・URL・見積の依頼）／御見積書が作られているか。金額は入力値だけ", types: ["T4", "T8"] },
  { kind: "内覧日程の確定", staffOnly: true, check: "日にちが決まっているか・待ち合わせ場所が未送信か・資料に退去予定日が有るか", types: ["T7"] },
  { kind: "電話で話した内容", staffOnly: true, check: "通話の中身は会話に無い", types: [] },
  { kind: "会社の事実（手数料0円・分割はカード払いのみ・審査期間と流れ・必要書類・保証会社の種類）", staffOnly: false, check: "会社の決まりとして手元に有る", types: ["T2", "T8"] },
  { kind: "資料に書いてある事（現況・入居可能日・退去予定・設備・費用）", staffOnly: false, check: "資料の該当欄に書いてあるか（無ければ資料では分からない）", types: ["T2"] },
  { kind: "物件の記録（送った物件・空室確認の結果・オススメ済み）", staffOnly: false, check: "どの物件の事かが引用・台帳で1件に決まるか", types: ["T4", "T10"] },
  { kind: "会話の事実（お客様が言った条件・事情）", staffOnly: false, check: "会話にそのまま有る", types: ["T1", "T11"] },
];

/** 決まりの1段（NOW_VS_LATER_RULES の直後・事実の確かめだけ） */
export const INFO_KIND_RULES = `【情報の種類の確かめ（info_kind・道は書かない）】スタッフだけが知る情報かと、材料が手元にあるかを、お客様の依頼ごとに確かめる。
- スタッフだけが知る情報（募集状況・管理会社に確認した結果・交渉の結果・撮影した写真・見積の金額・内覧日程の確定・電話で話した内容）は、中身を AI は知り得ない。その結果が会話・記録に届いているかを確かめる。
- AI が知り得る材料（会社の決まり・資料の該当欄に書いてある事・物件の記録・お客様が言った事）は、手元に有るかを確かめる。資料に書いてなければ、資料では分からない。
- 同じ情報の種類でも、結果が手元に有る時と無い時で扱いは変わる（有る＝届けられる物・無い＝まだ無い）。
- 物件の記録は、どの物件の事かが引用や台帳で1件に決まるかを先に確かめる。
- 1通の中に種類の違う依頼が複数あれば、依頼ごとに確かめる。
（型の表 check-order.ts の T 型: 募集状況・管理会社の確認・交渉＝T3・T4・T10／見積の金額＝T4・T8／内覧日程＝T7／会社の事実・資料＝T2・T8／会話の事実＝T1・T11）`;
