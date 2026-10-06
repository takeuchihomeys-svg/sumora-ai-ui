// app/lib/secondary-profile.ts — 1人のお客様の2つ目の探し物（物置・店舗・事務所…）を別の行（子）に分ける決まり（純関数）
//
// 2026-10-06 ⑫ 竹内さん（ゆいと）「物置は別での物件の事となる。その為、別物件は分けておこなう ゆいとさん物件 ゆいとさん物置 と2つに分ければ
//   拡張ツールで検索するさいも検索しやすい。このように1人のお客さんで2種類や2パターンの場合もある」
//   形: property_customers の子の行（profile_label・parent_customer_id）。名前は「ゆいと（物置）」で、拡張・一覧には別のお客様として出る。
//   会話の紐付け（conversations.property_customer_id）と line_user_id は親だけ（line_user_id で引く所が多い＝子に入れると取り違える）。
//   住まいの条件（親）には2つ目の探し物の家賃・地名を書かない（ゆいと: 家賃の上限 9万が 2万に上書きされた）

export type ChildRow = { id: string; profile_label: string | null; updated_at: string | null; created_at?: string | null };
export type SecondaryPlan = { action: "create"; label: string } | { action: "update"; id: string; label: string; relabel: boolean };

/** 種類の名前があいまいな物（「仕事用」）。後から具体的な種類（物置）を言われたら同じ子の名前を直す */
const VAGUE_LABELS = new Set(["仕事用"]);
const REUSE_WINDOW_MS = 14 * 86400_000;

/**
 * 子を作るか、今ある子を直すか。
 *   同じ種類の子 → その子。あいまいな種類（仕事用）とどちらかが同じ探し物の続き（14日以内）→ その子（具体的な方の名前に直す）。それ以外は作る
 */
export function planSecondaryProfile(children: ReadonlyArray<ChildRow>, label: string, nowMs = Date.now()): SecondaryPlan {
  const same = children.find((c) => c.profile_label === label);
  if (same) return { action: "update", id: same.id, label, relabel: false };
  const recent = [...children]
    .filter((c) => { const t = Date.parse(c.updated_at ?? c.created_at ?? ""); return Number.isFinite(t) && nowMs - t <= REUSE_WINDOW_MS; })
    .sort((a, z) => String(z.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))[0];
  if (recent && (VAGUE_LABELS.has(recent.profile_label ?? "") || VAGUE_LABELS.has(label))) {
    const keep = VAGUE_LABELS.has(label) ? (recent.profile_label ?? label) : label;
    return { action: "update", id: recent.id, label: keep, relabel: keep !== recent.profile_label };
  }
  return { action: "create", label };
}

/** 子の名前（「ゆいと（物置）」）。親の名前に既に括弧の種類があれば付け直す */
export function secondaryProfileName(parentName: string | null | undefined, label: string): string {
  const base = String(parentName ?? "").replace(/（[^）]*）$/, "").trim() || "お客様";
  return `${base}（${label}）`;
}

/** 子の条件の欄に書く値（足すだけ・家賃は言った上限・地名は今ある物に足す） */
export function mergeSecondaryConditions(
  current: { rent_max?: number | null; desired_area?: string | null; floor_plan?: string | null; other_requests?: string | null } | null,
  read: { rent_max: number | null; desired_area: string | null; floor_plan: string | null; note: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (read.rent_max != null && read.rent_max !== current?.rent_max) out.rent_max = read.rent_max;
  if (read.desired_area) {
    const cur = String(current?.desired_area ?? "").split(/[・、,]+/).map((x) => x.trim()).filter(Boolean);
    const add = read.desired_area.split("・").filter((x) => x && !cur.includes(x));
    if (add.length) out.desired_area = [...cur, ...add].join("・");
  }
  if (read.floor_plan && read.floor_plan !== current?.floor_plan) out.floor_plan = read.floor_plan;
  const notes = String(current?.other_requests ?? "").split("・").map((x) => x.trim()).filter(Boolean);
  if (read.note && !notes.includes(read.note)) out.other_requests = [...notes, read.note].join("・");
  return out;
}
