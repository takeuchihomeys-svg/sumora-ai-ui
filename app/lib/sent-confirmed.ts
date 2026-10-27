// app/lib/sent-confirmed.ts — 「こちらが送った物件＝送った時点で募集中を確認済み」をブレインと書く役の材料にする（純関数・DB も LLM も持たない）
//
// 2026-10-28 竹内さんの指摘（10/20 の画面・KB P1「こちらが送った物件は送った時点で募集状況を確認済み」・9de893ed・c90aaf62）:
//   ・和樹: こちらが送った🌟Tio Verde への「初期費用はどうなりますか？」に、下書きが「3件の募集状況と…御見積書を確認しお送り」（送った物件の確認を約束した）
//   ・あかり: 送った物件の「初期費用全部おしえて」「15万くらいないですかね」に「15万円前後に近づけられるよう最大限割引」（予算に近づける約束）
//   ・てん: 持ち込み物件（アーバネックス）は「明日一番で確認」・ピックアップは今＝1通の中で約束の「いつ」がぶつかった
//   竹内さん「物件を送っているので募集状況も確認しているということをちゃんと把握する。ここを理解できれば文の質が全然違う」。
//   決まり（P1）はあるのに、送った物件の行に「確認済み」の事実が無く、主語の無い費用の質問では台帳の ▶ も付かない＝材料が届いていない。
// 形: 送った物件ごとに「何日前に送った・送った時点で募集中を確認済み（7日を超えたら念のための確認）」の事実と、持ち込み物件との違いの1行。
//   どう返すか（見積書の AIX・約束の返信・答え）はブレインと書く役が決める（P0）。決定論で文を書き換えない。
// 切替: SENT_CONFIRMED_NOTE=on の時だけ（既定 off）。テスト: app/lib/__tests__/sent-confirmed.test.ts
export function sentConfirmedNoteEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SENT_CONFIRMED_NOTE ?? "").trim().toLowerCase() === "on";
}

const DAY = 86_400_000;
/** 送ってからこれを超えた物件は念のため確認（KB 90237498「7日以上前の資料だけ念のため確認」） */
export const SENT_CONFIRMED_FRESH_DAYS = 7;
/** 材料に載せる送付の古さの上限 */
export const SENT_CONFIRMED_WINDOW_DAYS = 21;

export type SentConfirmedEntry = { kind: string; status: string; at: string | null; detail?: { propertyNames?: string[] } | null };

/** 送った物件（名前ごとに一番新しい送付）。古い順でなく新しい順 */
export function sentPropertiesOf(entries: ReadonlyArray<SentConfirmedEntry>, nowMs: number): Array<{ name: string; at: string; days: number }> {
  const by = new Map<string, { name: string; at: string; days: number }>();
  for (const e of entries) {
    if (e.kind !== "properties_sent" || e.status !== "done" || !e.at) continue;
    const t = Date.parse(e.at);
    // 未来の時刻（試験の場面は今より少し先に置く）は今日の送付とみる
    if (!Number.isFinite(t) || nowMs - t > SENT_CONFIRMED_WINDOW_DAYS * DAY) continue;
    for (const raw of e.detail?.propertyNames ?? []) {
      const name = String(raw ?? "").trim();
      if (!name) continue;
      const prev = by.get(name);
      if (!prev || Date.parse(prev.at) < t) by.set(name, { name, at: e.at, days: Math.max(0, Math.floor((nowMs - t) / DAY)) });
    }
  }
  return [...by.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

const ageJa = (days: number) => (days <= 0 ? "今日" : `${days}日前`);

/** 材料の文（送った物件が無ければ ""） */
export function buildSentConfirmedNote(entries: ReadonlyArray<SentConfirmedEntry>, nowMs: number, o: { max?: number } = {}): string {
  const props = sentPropertiesOf(entries, nowMs);
  if (!props.length) return "";
  const max = o.max ?? 8;
  const lines = props.slice(0, max).map((p) => `・${p.name}（${ageJa(p.days)}に送付）${p.days <= SENT_CONFIRMED_FRESH_DAYS ? "＝送った時点で募集中を確認済み" : "＝送ってから7日を超えた（聞かれたら念のため募集状況を確認）"}`);
  if (props.length > max) lines.push(`・ほか ${props.length - max}件`);
  return `\n【こちらが送った物件（こちらが探して送った＝送った時点で募集中を確認済み・事実）】\n${lines.join("\n")}\n` +
    "※送ってから7日以内の物件への費用・空き・内覧の質問は、募集状況の確認を約束する場面ではない（費用は最大限割引の御見積書をお送りする・内覧は日程）。" +
    "見積書を作って送る場面で、予算の額に「近づけられるよう」と約束しない（金額は御見積書で伝える）。" +
    "お客様が持ち込んだ物件（SUUMO 等の画面・URL）はこれと別で確認が要る。ピックアップの約束と同じ通で持ち込み物件の確認を約束する時は、同じ流れ（今から）にそろえる（片方だけ『明日』にしない）。";
}
