// app/lib/open-search-ack.ts（純関数・DB/LLM なし）— まだ果たしていない「引き続き探す・新着をお送り」の約束がある時の了承だけの番の材料
//
// 2026-10-16 竹内悠馬（10/16 の画面の事例 f）: 見積は送り済み・他のご条件（独立洗面台・トイレ別）で引き続き探している途中のお客様の「分かりました！」に、
//   正しくは「気になる点等出てきましたらいつでもお気軽にご連絡ください」＋「新着でご条件に合った物件があればお送りします」と約束して締め、AIX（新着が出たら送る）をセット。
//   ブレインのカードには「新着が出たら物件送付」があったのに、了承の番は close_only（前の約束を言い直さない）で下書きの約束に届かなかった。
//   竹内さんの実送信の形（同じ会話 10/04）:「気になる点出てきましたらいつでもお気軽にご連絡ください！！引き続き〇〇さんにオススメ出来る新着物件募集に出次第お送りさせて頂きます😌！！」
// 決め: 了承・お礼だけの番で、14日以内のこちらの「引き続き探す／新着をお送り」の約束の後にまだ物件を送っていない（物件ピックアップした・物件オススメが無い）時、
//   材料の1行を渡す（言い直すかはブレイン・turn_contract.ack_form）。決定 C（直前のこちらの約束がピックアップ）の番は別の行があるので出さない。戻す ACK_OPEN_SEARCH_CLOSE=off

export function ackOpenSearchCloseEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ACK_OPEN_SEARCH_CLOSE ?? "").trim().toLowerCase() !== "off";
}

const OPEN_SEARCH_RE = /(?:引き続き|新着)[^。！!\n]{0,40}(?:お探し|お送り|ピックアップ|ご紹介)/;

export function openSearchPromise(i: {
  staffMsgs: ReadonlyArray<{ text: string | null; created_at: string; is_aix_generated?: boolean | null }>;
  propertyAixAts: ReadonlyArray<string>;
  nowMs: number;
}): { at: string; quote: string } | null {
  const from = i.nowMs - 14 * 86_400_000;
  const hit = [...i.staffMsgs].filter((m) => !m.is_aix_generated && Date.parse(m.created_at) >= from && OPEN_SEARCH_RE.test(String(m.text ?? "")))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!hit) return null;
  if (i.propertyAixAts.some((t) => Date.parse(t) > Date.parse(hit.created_at))) return null;
  const line = String(hit.text ?? "").split(/[\n。！!]+/).map((x) => x.trim()).find((x) => OPEN_SEARCH_RE.test(x)) ?? "";
  return { at: hit.created_at, quote: Array.from(line).slice(0, 50).join("") };
}

export function openSearchAckLine(p: { at: string; quote: string }, jst: (iso: string) => string): string {
  // 2026-10-16 下書きの関所（q158 3回中3回 receive_only）: 見出しが ack_form の決まり（【前の約束への了承】の材料がある番だけ）と違う名前で、
  //   ブレインは直前のこちらの答え（入居可能日・空き部屋）への了承と読んで受けだけを選んでいた → 同じ見出しにし、どの約束への了承として読むかを書く
  return `【前の約束への了承（材料・まだ果たしていない探す約束）】${jst(p.at)} こちら「${p.quote}」の後、まだ物件を送っていない。お客様の今の発言は了承・お礼だけ（直前のこちらの答えへの了承でも、探す約束はまだ続いている）。`
    + "竹内さんはこの番を「気になる点等出てきましたらいつでもお気軽にご連絡ください」＋「引き続き新着でご条件に合ったお部屋が出次第お送りさせて頂きます」の形で締め、物件は後で AIX で送る＝turn_contract.ack_form は wait_line（受けだけの receive_only にしない・close_only でもこの待ちの形の1文は可）。新しい約束・別の提案（申込・内覧）は足さない";
}
