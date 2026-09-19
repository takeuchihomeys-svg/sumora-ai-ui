// app/lib/aix-second-message.ts
// AIX の「2通目」（1分後に自動送信する締めの文）を1か所で決める（純関数・DB 依存なし）。
//
// 2026-09-19 竹内（あい事例）「2通目ボタン押した時に表示されて送られるようにする。
//   通常時にセットされた状態にせず、2通目のボタン押したらセットされるようにする」:
//   AIX【申込へ！】を開くと、2通目が**勝手にセットされていて1分後に自動送信**される作りだった。
//   実データ365日: 申込へ の AIX 送信 68件に対し、2通目の文が実際に送られたのは **3件（4.4%）**。
//   95.6% は使っていないのに、既定で付いて自動で送られる形になっていた。
//   → **既定は付けない。スタッフがボタンを押した時だけ付く**（設計知見「自動で外部に送る物は既定を
//     送らない側に倒す」。ここは人が押して送るが、1分後の自動送信という点は同じ性質）。
//
// 文面はスタッフの実送信そのまま（こちらで言い回しを作らない）。

/** 2通目を出してよい AIX（それ以外では出さない） */
export function canOfferSecondMessage(
  actionType: string | null | undefined,
  followupSubMode?: string | null,
): boolean {
  const a = (actionType ?? "").trim();
  if (a === "application_push") return true;
  if (a === "followup_revive" && (followupSubMode ?? "") === "apply_supplement") return true;
  return false;
}

/** お客様名に敬称を足す（既に さん／様 が付いていれば足さない・空なら「お客様」） */
export function withHonorific(customerName: string | null | undefined): string {
  const n = (customerName ?? "").trim();
  if (!n) return "お客様";
  return /(さん|様)$/.test(n) ? n : `${n}さん`;
}

/**
 * 2通目の本文（スタッフの実送信の型）。
 * 絵文字を外す時は呼び出し側で stripEmoji を通す（画面の「絵文字なし」と同じ扱いにするため）。
 */
export function buildSecondMessage(customerName: string | null | undefined): string {
  return `ご不明点等出てきましたら何時でもお気軽にご質問ください😊！！\n${withHonorific(customerName)}がご満足いくご入居が出来ますよう全力でサポートさせて頂きます！！`;
}
