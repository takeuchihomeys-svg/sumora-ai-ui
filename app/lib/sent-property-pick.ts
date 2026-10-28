// app/lib/sent-property-pick.ts — 竹内さんの指摘 #8・#18（10/25 じゅな・10/28）の純関数とスイッチ（画面）
//
// #8 AIX【内覧へ！】の退去予定物件: 物件名・退去予定日が空欄だった（会話にはこちらが送ったロンド・エーデルワイス 105号室・見積書つきがある）。
//    竹内さん「退去予定物件の時、ここに送った物件のリストが出て押せるように。話の流れからどの物件かセットされていて、違う場合のため別の物件も押せるように」
//    → 送った物件の候補（SentPropertyPicker・見積書作成と同じ材料）を出し、話の流れで決まった物件を先に選ぶ。退去予定日は送った資料の読み取り
//      （image_details.lines の「退去予定: 〜」）から入れる（字のまま・決めつけない）。スイッチ NEXT_PUBLIC_VIEWING_VACANCY_PICK=on（既定 off）
// #18 AIX【物件オススメ】【物件ピックアップ】に「AIX ツールから選択」: 売上サポの物件一覧（PickupListImport）から選んで物件資料をセットする。
//    竹内さん「物件オススメを選んだら AIX ツールの中からも物件を選べるようにする。AIX ツールで送った物件の一覧から選べれば送りやすくなる」
//    ブレインが決めた物件（brainPropertyPick）があれば一覧で先にチェックを入れる。スイッチ NEXT_PUBLIC_AIX_TOOL_PICK=on（既定 off）

export function viewingVacancyPickOn(v: string | undefined): boolean {
  return (v ?? "").trim().toLowerCase() === "on";
}
export function aixToolPickOn(v: string | undefined): boolean {
  return (v ?? "").trim().toLowerCase() === "on";
}

/** 送った資料の読み取りの行（image_details.lines）から退去予定の字を1つ（見出し「退去予定」。無ければ ""・30字まで・字のまま） */
export function vacateDateFromLines(lines: unknown): string {
  if (!Array.isArray(lines)) return "";
  for (const raw of lines) {
    const l = String(raw ?? "").replace(/\s+/g, " ").trim();
    const m = l.match(/^退去予定(?:日)?\s*[:：]\s*(.+)$/);
    if (m && m[1].trim()) return m[1].trim().slice(0, 30);
  }
  return "";
}

const norm = (s: string) => s.normalize("NFKC").replace(/[\s　・･\-ー－()（）【】🌟★]/g, "").toLowerCase();
/** 一覧の物件名とブレインが決めた物件（表示名）が同じ建物か（号室は片方に無ければ同じとみる） */
export function sameAsPreferred(name: string, room: string | null | undefined, preferred: string | null | undefined): boolean {
  const p = norm(String(preferred ?? ""));
  const n = norm(String(name ?? ""));
  if (!p || n.length < 2) return false;
  if (!p.includes(n) && !n.includes(p.replace(/[0-9]+号?室?$/, ""))) return false;
  const r = String(room ?? "").replace(/号室?$/, "").replace(/^0+/, "");
  const pr = (p.match(/([0-9]{2,4})号?室?$/)?.[1] ?? "").replace(/^0+/, "");
  return !r || !pr || r === pr;
}
