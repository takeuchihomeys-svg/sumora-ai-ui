// app/lib/work-log-fields.ts — 作業の台帳（work_log）の欄をそろえる（純関数）
//   2026-11-07 作業員1（竹内さん「設計知見の統括」・統括役の頼み⑤）: 報告と work_log に「引いた KB の id8」の欄。actor の名前は「作業員N」にそろえる
//   （直近7日の 47行で、実在する KB の id8 が入っていたのは 13行＝28%・actor は「作業員7」と「worker:作業員7」に割れていた）

/** actor の名前をそろえる: worker:作業員7 → 作業員7（作業員以外の worker:<名前> は名前だけ・session と統括役はそのまま） */
export function normalizeActor(a: string | null | undefined): string {
  const s = String(a ?? "").trim() || "session";
  const m = s.match(/^worker:\s*(.+)$/);
  return m ? m[1].trim() : s;
}

/** --kb= の値（id8 をカンマ区切り・引かなかった時は none）。id8 は 16進8字。読めない物は bad に */
export function parseKbIds(v: string | null | undefined): { ids: string[]; none: boolean; bad: string[] } {
  const raw = String(v ?? "").trim();
  if (/^(none|なし)$/i.test(raw)) return { ids: [], none: true, bad: [] };
  const parts = raw.split(/[,\s、]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const ids = [...new Set(parts.filter((x) => /^[0-9a-f]{8}$/.test(x)))];
  return { ids, none: false, bad: parts.filter((x) => !/^[0-9a-f]{8}$/.test(x)) };
}
