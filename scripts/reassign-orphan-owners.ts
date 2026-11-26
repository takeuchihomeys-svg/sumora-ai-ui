// scripts/reassign-orphan-owners.ts — 持ち主の居ない台帳の行（今の2人 A・L と統括役でない持ち主）を、分野で A か L に決め直す（統括役の決め 11/26）
// 2026-11-26 作業員L。決め: ブレイン・AIX・地図・物件の文 → 作業員A／約束・書き手・成約データ・費用・試験の道具・学び → 作業員L。
//   分野（work_items.area）で決め、分野が無い・表に無い行は題の語で決める。決まらない行は統括役に残す（書き換えない）。
//   既定は見るだけ（--dry）。--write で書き換える（前の持ち主は next_step の頭に「（前の持ち主 X）」で残す）。閉じた行（done・dropped）は触らない
// 実行: npx tsx --env-file=.env.local scripts/reassign-orphan-owners.ts [--write]
import { createClient } from "@supabase/supabase-js";

export const AREA_OWNER: Readonly<Record<string, "作業員A" | "作業員L">> = {
  "ブレイン": "作業員A", "AIX": "作業員A", "2通": "作業員A", "2通目": "作業員A", "物件出し": "作業員A", "画像": "作業員A", "image": "作業員A", "道": "作業員A",
  "申込までの地図": "作業員A", "要件": "作業員A", "訴求": "作業員A", "search": "作業員A", "統括": "作業員A", "RAG": "作業員A",
  "状況": "作業員L", "土台": "作業員L", "つなぎ": "作業員L", "DB": "作業員L", "試験": "作業員L", "文": "作業員L", "指摘の点検": "作業員L", "費用": "作業員L",
  "信頼": "作業員L", "学び": "作業員L", "自己改善": "作業員L", "deal_outcomes": "作業員L", "foundation": "作業員L", "brain": "作業員A",
};
const TITLE_RULES: Array<[RegExp, "作業員A" | "作業員L"]> = [
  [/ブレイン|AIX|地図|駅|物件|ピックアップ|画像|内覧|見積/, "作業員A"],
  [/約束|書き手|下書き|文の|成約|申込の時刻|費用|試験|学び|時系列|台帳|記録|土台/, "作業員L"],
];
export function ownerFor(area: string | null, title: string): "作業員A" | "作業員L" | null {
  const a = String(area ?? "").trim();
  if (a && AREA_OWNER[a]) return AREA_OWNER[a];
  for (const [re, o] of TITLE_RULES) if (re.test(title)) return o;
  return null;
}
export const isLiveOwner = (o: string | null) => !o || /^統括役$/.test(o) || /^作業員(?:A|L)(?:・作業員(?:A|L))?$/.test(o);

if (require.main === module) (async () => {
  const write = process.argv.includes("--write");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const { data, error } = await sb.from("work_items").select("id, title, area, owner, next_step, stage").not("stage", "in", "(done,dropped)").limit(3000);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Array<{ id: number; title: string; area: string | null; owner: string | null; next_step: string | null; stage: string }>).filter((r) => !isLiveOwner(r.owner));
  const plan = rows.map((r) => ({ ...r, to: ownerFor(r.area, r.title) }));
  const toA = plan.filter((p) => p.to === "作業員A"), toL = plan.filter((p) => p.to === "作業員L"), left = plan.filter((p) => !p.to);
  console.log(`持ち主の居ない行 ${plan.length}: → 作業員A ${toA.length}・→ 作業員L ${toL.length}・決まらない（統括役に残す） ${left.length}`);
  console.log(`A: ${toA.map((p) => p.id).join(",")}`);
  console.log(`L: ${toL.map((p) => p.id).join(",")}`);
  console.log(`残す: ${left.map((p) => `#${p.id}（${p.owner}）`).join("・")}`);
  if (!write) return;
  let n = 0;
  for (const p of [...toA, ...toL]) {
    const { error: e } = await sb.from("work_items").update({ owner: p.to, next_step: `（前の持ち主 ${p.owner}・11/26 分野で決め直し）${p.next_step ?? ""}`.slice(0, 4000), updated_at: new Date().toISOString() }).eq("id", p.id);
    if (!e) n++;
  }
  console.log(`書き換えた ${n}行`);
})().catch((e) => { console.error(e); process.exit(1); });
