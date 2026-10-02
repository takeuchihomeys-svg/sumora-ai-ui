// app/lib/schedule-line-dedupe.ts
// 2026-10-02 ⑫（YUMA の再生 flow4 t03・AIX【内覧調整】・DeepSeek）: 候補の日時の行が2回並んだ
//   「直近ですと10/15(木) 14:00〜16:00にてご案内可能です😊！！ / 10/15(木) 14:00〜16:00にてご案内可能です！！」。
//   同じ日時（月/日＋時刻の並び）を持ち、言い回しも同じ（「直近ですと」・絵文字・記号を除いて一致）行が2回目に出たら落とす。
//   日時が同じでも違う文（受けの「8/6 14:00ご案内させて頂きます」と待ち合わせの「8/6 14:00にスプランディッド難波VII」）は残す
//   （監査: 日時だけで落とすと人の送信 13,605通中12通を変えた＝全部この形・誤り → 言い回しの一致まで見る）
// 線（scripts/audit-schedule-line-dup.ts・本番のスタッフの送信）: 人の手打ち・AIX の文で同じ日時の行が2回ある通を数えて目で読む
export function scheduleKeyOf(line: string): string | null {
  const t = line.normalize("NFKC");
  const d = t.match(/([0-9]{1,2})\s*[\/月]\s*([0-9]{1,2})/);
  const h = [...t.matchAll(/([0-9]{1,2}):([0-9]{2})/g)].map((m) => `${Number(m[1])}:${m[2]}`);
  if (!d || h.length === 0) return null;
  const body = t.replace(/^\s*直近(?:ですと|でしたら|です)?[、,]?\s*/, "").replace(/\p{Extended_Pictographic}|️/gu, "").replace(/[！!。、\s]/g, "");
  return `${Number(d[1])}/${Number(d[2])} ${h.join("-")}|${body}`;
}

export function dedupeScheduleLines(text: string): { text: string; removed: string[] } {
  const seen = new Set<string>();
  const removed: string[] = [];
  const lines = String(text ?? "").split("\n");
  const out = lines.filter((l) => {
    const k = scheduleKeyOf(l);
    if (!k) return true;
    if (seen.has(k)) { removed.push(l); return false; }
    seen.add(k);
    return true;
  });
  return { text: removed.length ? out.join("\n").replace(/\n{3,}/g, "\n\n") : text, removed };
}
