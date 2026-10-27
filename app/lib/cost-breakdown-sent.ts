// app/lib/cost-breakdown-sent.ts — AIX【初期費用について】で、スタッフが御見積書を貼らなかった時に「この会話で送った見積書」を材料にする（純関数＋スイッチ）
//
// 2026-10-27 竹内さんの指摘（brain_weaknesses owner-fb:1016-cost-explain-aix）:
//   初期費用を説明する場面で、実際に送った物件（の御見積書）を入れて AIX【初期費用について】から送る形にする。
//   旧は御見積書の画像を貼らないと「御見積書の画像を貼り付けてください」で止まり、送った見積書があってもスタッフが貼り直していた。
//   材料は送った見積書の読み取り（image_details.kind=estimate）だけ。金額は今まで通り読み取りにある物だけ（無い金額は伏せ字＝送信前チェック）。
//   直近の1回の送信（最新の見積書から10分以内に送った物）だけを使い、前の別の見積書を混ぜない。
// スイッチ: COST_BREAKDOWN_SENT_ESTIMATE=on（既定 off＝今と同じ・貼られた画像があれば常にそちらが先）

export function costBreakdownSentEstimateOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.COST_BREAKDOWN_SENT_ESTIMATE ?? "").trim().toLowerCase() === "on";
}

/** 新しい順の読み取りの行から、直近の1回の送信（最新から windowMs 以内）の見積書の URL を最大 max 件（重複なし） */
export function pickSentEstimateUrls(rows: ReadonlyArray<{ image_url: string | null; read_at: string | null }>, o: { max?: number; windowMs?: number } = {}): string[] {
  const max = o.max ?? 3, windowMs = o.windowMs ?? 10 * 60_000;
  const ok = rows.filter((r) => typeof r.image_url === "string" && r.image_url.trim() && r.read_at && Number.isFinite(Date.parse(r.read_at)))
    .sort((a, b) => Date.parse(b.read_at as string) - Date.parse(a.read_at as string));
  if (!ok.length) return [];
  const newest = Date.parse(ok[0].read_at as string);
  const out: string[] = [];
  for (const r of ok) {
    if (newest - Date.parse(r.read_at as string) > windowMs) break;
    const u = (r.image_url as string).trim();
    if (!out.includes(u)) out.push(u);
    if (out.length >= max) break;
  }
  return out;
}
