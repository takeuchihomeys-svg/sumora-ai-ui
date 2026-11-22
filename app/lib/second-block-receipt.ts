// app/lib/second-block-receipt.ts — ✨2通目の書き手へ「同じ送付の塊の前の通で、もうご査収を言った」を渡す（純関数・DB/LLM なし）
//
// 2026-11-21 作業員K2（竹内さん「2通で同じ事を言うのも、ちゃんと改善されるか」・統括役の頼み）。
//   数え（scripts/audit-two-message-overlap.ts・14日 82組）: AIX＋返信の組で2通の中身が重なった割合は スタッフ 26/27（96%）・竹内さん 4/10（40%）。
//   重なりの中身はほとんどが「お手隙の際にご査収ください」が2通の両方にある事（スタッフ 23/27）。
//   60日のピックアップの塊（AIX「〜ピックアップさせて頂きました…ご査収ください」→ 🌟の資料 → 2通目）で2通目にもご査収があった割合:
//     スタッフ（ほぼ AI の2通目をそのまま送った文）85/94（90%）・竹内さん 26/49（53%）。竹内さんが繰り返さなかった 23番のうち 18番は内覧のご案内で締めた。
//   原因（材料が届いていない）: 2通目の書き手に渡す「1通目」（sentMessage）は直前の🌟の資料の通で、ご査収を言ったピックアップのお知らせの通は渡していない
//     （aixChainNote は 1通目との重なりだけを見る）＝書き手は前の通でご査収を言った事を知らない。
//   直し（入口・材料だけ）: 同じ塊の前の AIX の通（30分以内・お客様の発言を挟まない）にご査収があれば1行で伝える。繰り返すかは書き手が締めの向きで決める
//     （竹内さんも半分は繰り返す＝出口で消さない。過半数が守る形ではないので決め打ちにしない）。
//   スイッチ SECOND_BLOCK_RECEIPT_SEEN=on（既定 off）。
export function secondBlockReceiptSeenOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SECOND_BLOCK_RECEIPT_SEEN ?? "").trim().toLowerCase() === "on";
}

type Recent = { sender?: string | null; text?: string | null; isAix?: boolean | null; rawCreatedAt?: string | null; createdAt?: string | null };
const RECEIPT_RE = /お手隙の際に(?:ごゆっくり)?(?:ご査収|ご確認)/;

/**
 * 直近の会話（古い順）の最後の塊（最後のお客様の発言より後のこちらの通）で、1通目（sentMessage）より前の AIX の通にご査収があれば、書き手への1行を返す。
 * 無ければ ""（今まで通り）。
 */
export function secondBlockReceiptNote(recent: ReadonlyArray<Recent>, sentMessage: string | null | undefined): string {
  const list = [...(recent ?? [])];
  let lastCust = -1;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].sender === "customer") { lastCust = i; break; }
  const block = list.slice(lastCust + 1);
  const sent = String(sentMessage ?? "").trim();
  const timeOf = (m: Recent) => Date.parse(String(m.rawCreatedAt ?? m.createdAt ?? ""));
  // 時刻の基準は塊の最後の通（試験の写しは昔の時刻のまま＝今の時刻で測ると外れる）
  const lastT = Math.max(...block.map(timeOf).filter((x) => Number.isFinite(x)), -Infinity);
  const earlier = block.filter((m) => m.sender !== "customer" && m.isAix && String(m.text ?? "").trim() !== sent && RECEIPT_RE.test(String(m.text ?? ""))
    && (!Number.isFinite(timeOf(m)) || !Number.isFinite(lastT) || lastT - timeOf(m) <= 30 * 60_000));
  if (!earlier.length || RECEIPT_RE.test(sent)) return ""; // 1通目そのものにご査収があれば aixChainNote が扱う
  return "\n\n【同じ送付の前の通】この塊の前の通（ピックアップのお知らせ等）で、もう「お手隙の際にご査収ください」を伝えている。2通目で同じご査収の一言を重ねるかは締めの向きで決める（竹内さんは重ねない時の多くを内覧のご案内で締めている・推すお部屋の訴求が主）。";
}
