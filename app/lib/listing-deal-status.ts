// app/lib/listing-deal-status.ts — 資料の「現況/入居時期」の欄に書かれた申込の状況（審査中・商談中）を資料の文字のまま読む（純関数・画面とサーバーで共用）
//
// 2026-09-27 竹内「申込以降のステータス審査中は審査中としておく」（memory feedback_aix_learning_mismatch）:
//   リアプロの資料は「現況/入居時期 空室 / 相談 / 審査中 / 内装中」のように、現況・入居時期の後ろに申込の状況が並ぶ。
//   今まで listing-terms は現況（空室・居住中・退去予定）と入居時期だけを読み、3つ目の「審査中」「商談中」は捨てていた
//   → ピックアップの判定は pass のまま・カードの「状態/入居」は「空室／相談」・ブレインにも届かず、YUMA の手元の回で
//     審査中の Rainbow Court 立売堀 307（#679）が送られ、後の物件確認したの設定も「募集中」になった。
//   実物（property_pickups 113行・9/27）: 審査中 4件（#664・#668・#679・#682）・商談中 9件、すべてリアプロ・判定 pass 12／hold 1・送付済み 11。
//   保存済みの terms.evidence.moveIn（「空室/相談/審査中/内装中」）に文字が残っているので、DB を変えずに読める。
// 決まり:
//   - 資料の文字のまま返す（「審査中」「商談中」）。言い換えない・推測しない（memory feedback_pickup_material_verbatim）
//   - 除外はしない（審査中＝募集終了ではない。番手での申込になる）。札・ブレインの材料として「審査中」と分かるようにするだけ
//   - 「商談中」を審査中と同じに扱うかは竹内さんに確認中 → ブレインへは「審査中」だけを渡す（カードは資料の文字をそのまま出す）

export type ListingDealStatus = "審査中" | "商談中";

const DEAL_RE = /審査中|商談中/u;

/** 「空室/相談/審査中/内装中」「現況/入居時期 空室 / 相談 / 審査中」から申込の状況の語（資料の文字）を取る */
function pickFromMoveInField(text: string): ListingDealStatus | null {
  const m = text.match(DEAL_RE);
  return m ? (m[0] as ListingDealStatus) : null;
}

/**
 * 資料の申込の状況（無ければ null）。読む順: 資料の表の照合の根拠（terms.evidence.moveIn）→ PDF の文字の「現況/入居時期」の行。
 * 画像の読み取り（image_lines）の「現況: 空室」は現況しか書かない形なので読まない。
 */
export function listingDealStatus(src: {
  evidenceMoveIn?: string | null;
  pdfText?: string | null;
}): ListingDealStatus | null {
  const ev = String(src.evidenceMoveIn ?? "");
  if (ev) {
    const s = pickFromMoveInField(ev);
    if (s) return s;
  }
  const pdf = String(src.pdfText ?? "");
  if (pdf) {
    // 「現況/入居時期」の見出しの後ろ 40 文字だけ（本文の別の所の「審査中」を拾わない）
    const m = pdf.match(/現況\s*[/／]\s*入居時期([\s\S]{0,40})/u);
    if (m) {
      const s = pickFromMoveInField(m[1].split(/\n\s*\n/)[0]);
      if (s) return s;
    }
  }
  return null;
}

/** property_pickups の行（terms・pdf_text）から */
export function pickupDealStatus(row: { terms?: { evidence?: { moveIn?: string | null } | null } | null; pdf_text?: string | null }): ListingDealStatus | null {
  return listingDealStatus({ evidenceMoveIn: row.terms?.evidence?.moveIn ?? null, pdfText: row.pdf_text ?? null });
}

/**
 * ブレインに渡す一段（お客様にお送りしたピックアップのうち、資料の現況が「審査中」のお部屋）。無ければ空文字。
 * 名前・号室は資料の文字のまま。同じお部屋は1回だけ
 */
export function buildScreeningRoomsBrainText(rows: ReadonlyArray<{ property_name: string | null; room_no: string | null; terms?: { evidence?: { moveIn?: string | null } | null } | null; pdf_text?: string | null }>): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const r of rows) {
    if (pickupDealStatus(r) !== "審査中") continue;
    const label = [String(r.property_name ?? "").trim(), r.room_no ? `${String(r.room_no).trim()}号室` : ""].filter(Boolean).join(" ");
    if (!label || seen.has(label)) continue;
    seen.add(label);
    names.push(label);
  }
  if (!names.length) return "";
  return `\n\n【資料の現況が「審査中」のお部屋（お送りしたピックアップ）】\n${names.map((n) => `- ${n}`).join("\n")}\n※資料を作った時点で他のお客様の申込が審査中＝募集終了ではない（申込は番手になる）。このお部屋を「募集中」「即入居可能」と言わない。今の状況はお客様に聞かれたら管理会社に確かめる（物件確認した）`;
}
