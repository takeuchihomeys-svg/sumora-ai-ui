// app/lib/brain-material-miss.ts — ブレインの材料が DB から読めなかった時（時間切れ等）に、黙って空にせず「読めなかった」とブレインに渡す（純関数）
//
// 2026-10-28 作業員4（指揮役の依頼・q125 で見つけた件）: 試験で「[customer-state] failed: … messages: TimeoutError」の後、ブレインには
//   今の状況（段階・内覧・送ったお部屋）が空のまま渡っていた。brain-core の材料の読み（条件・送った物件・AIX の履歴・タスク・内覧…）も
//   supabase の error を見ずに `data ?? []` で読むので、読めなかった材料は「無い」と同じ形でブレインに届く（静かに壊れる型）。
//   空の材料は「送っていない・約束していない・内覧の予定が無い」と読まれる → 誤った判断の元。
//   BRAIN_MATERIAL_MISS_NOTE=on で: ①今の状況だけ1回読み直す（7本・失敗した時だけ）②それでも読めない材料の名前をブレインの材料に1行で渡す。既定 off。
//   読めなかった事のログ（brain:material-miss）は off でも出す（本番で何回起きているかを数えるため・動きは変えない）

export function brainMaterialMissEnabled(): boolean {
  return (process.env.BRAIN_MATERIAL_MISS_NOTE ?? "").trim().toLowerCase() === "on";
}

/** 材料の鍵 → ブレインに見せる名前 */
export const BRAIN_MATERIAL_LABELS: Readonly<Record<string, string>> = {
  customer_state: "今の状況（段階・内覧・送ったお部屋の一覧）",
  pc: "お客様の条件・これまでの要約",
  sent_props: "送った物件",
  aix_logs: "送った AIX の履歴",
  open_tasks: "確認事項・タスク",
  viewings: "内覧の予定",
  viewing_history: "内覧の履歴",
  scheduled_msgs: "予約した送信",
  checkpoints: "これまでの判断の控え",
};

type MaybeErr = object | null | undefined; // supabase の { data, error }（error の無い形 { data: null } も来る）

/** 読みの結果（supabase の { data, error }）から、error のある材料の鍵を返す（並びは渡した順） */
export function collectMaterialMisses(results: Readonly<Record<string, MaybeErr>>): string[] {
  return Object.entries(results).filter(([, r]) => !!r && !!(r as { error?: unknown }).error).map(([k]) => k);
}

/** ブレインに渡す1行（読めなかった材料が無ければ ""） */
export function materialMissNote(misses: readonly string[]): string {
  const names = [...new Set(misses)].map((k) => BRAIN_MATERIAL_LABELS[k] ?? k);
  if (!names.length) return "";
  return `【読めなかった材料（DB の読みの時間切れ等・今回だけ）】${names.join("・")}\n` +
    "→ これらは今回読めていないだけで「無い」とは限らない。読めなかった材料が空に見えても『送っていない・約束していない・内覧の予定が無い』と決めない。" +
    "その材料が決め手になる判断（もう送ったか・約束の中身・内覧の日時）は会話の文から確かめられる範囲だけで行い、言い切らない。";
}
