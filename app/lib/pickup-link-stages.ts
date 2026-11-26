// app/lib/pickup-link-stages.ts — 物件を選んだ理由と LINE のブレインの連携を段に分けた表（竹内さん 11/26「ここも細分化して強化していく」・純関数・DB/LLM なし）
// 2026-11-26 作業員A（統括役の頼み・#479・#545 の続き）: 地図の土台の表と同じ形（段ごとに 決まり・材料・物差し・統括に届くか・試験の問題）
//   60日の物件出しの AIX（物件ピックアップした・物件オススメ・申込以降を外す 547番）の数（11/26 昼・1本の集計の読み）:
//     ② AIX ツールで選んだ 350（64%）・ツールの外 197（画像の読みあり 176・何も無い 21）
//     ③ 選んだ理由の札 350/350（ツールで選んだ番は全部付く）
//     ③' 送った印（status=sent・送った時刻の前後1時間）252/350＝選んだのに送った印が付かず pending のまま 98（28%）← ④の読み手は sent しか読まない
//     ④ LINE のブレイン: PICKUP_WHY_TO_BRAIN・SIP_JUDGE とも既定 off＝本番では届いていない（届いた印 material_marks.pickup_why）
//     ④' AIX の2通目: 1件の物件オススメの2通目は札（reason_codes）を読む（aix-template-generate の propertyRow）＝届いている
//     ⑤ 文に入る: AIX の文に条件の言葉（ご希望・条件・お探し）98/547（粗い網）
//     ⑥ お客様の反応: 札あり 208/350（59%）・札なし 131/197（66%）＝札の有無で反応の差は見えない（札がブレインに届いていないので当然）
export type LinkStage = { id: string; name: string; rule: string; material: string; metric: string; conductor: string; exam: string; gap: string | null };
export const PICKUP_LINK_STAGES: readonly LinkStage[] = [
  { id: "s1_material", name: "① 選ぶ材料（条件と優先・前に送った物・気に入った物）", rule: "条件がそろってから探す（#546）", material: "property_pickups.terms・search_conditions", metric: "growth:pickup_ready:最初", conductor: "統括の訴求（n.appeal）の持つ", exam: "—", gap: "気に入った物（お客様の声）が選ぶ材料に入る印が無い" },
  { id: "s2_select", name: "② AIX ツール側の物件のブレインが選ぶ", rule: "1件ならオススメ・複数ならピックアップ（#535）", material: "property_pickups（売上サポ）", metric: "pickup:link:tool_share（350/547）", conductor: "—", exam: "—", gap: "ツールの外で送った 197（画像だけ 176）は SIP_JUDGE（既定 off）だけが拾う" },
  { id: "s3_record", name: "③ 選んだ理由・合う点・合わない点を記録", rule: "判定の札（reason_codes）", material: "property_pickups.reason_codes", metric: "pickup:link:reasons（350/350）", conductor: "—", exam: "—", gap: "選んだのに送った印（sent）が付かない 98（28%）＝④の読み手から落ちる" },
  { id: "s4_receive", name: "④ LINE のブレイン（判断・書き手・2通目）が受け取る", rule: "PICKUP_WHY_TO_BRAIN（判断の材料の1行）", material: "material_marks.pickup_why・pickup_why_sip", metric: "受け持ち表 own:pickup_why:hold", conductor: "MATERIAL_PRIORITY の控えの行 pickup_why（約束の番の4番目）", exam: "ess-1122r-pickupwhy（印が無く効いたか不明）", gap: "本番は off＝判断に届いていない・書き手（返信）への渡しは無い・2通目（1件のオススメ）だけ届く" },
  { id: "s5_text", name: "⑤ 文に入る", rule: "物件オススメ の文と締め（#543）", material: "AIX の文", metric: "pickup:link:text_cond（98/547・粗い網）", conductor: "—", exam: "—", gap: "理由が文に入ったかの決まった網が無い（条件の言葉の粗い網だけ）" },
  { id: "s6_react", name: "⑥ お客様の反応（気に入った・内覧へ）", rule: "次の石: 提案中 → 気に入った物件の確かめ（route-next-stone）", material: "aix_usage_logs.customer_reacted・sent_properties.customer_hook_points", metric: "pickup:link:react（札あり 59%・札なし 66%）", conductor: "次の石の表（提案中）", exam: "—", gap: "刺さった点（customer_hook_points）が7日で0＝SENT_HOOK_POINTS の届きが無い" },
];
/** つなぎ（既定 off）: 選んだのに送った印が付かない pending の行を、送った AIX の物件名で読み手に入れる */
export function pickupWhyPendingMatchOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.PICKUP_WHY_PENDING_MATCH ?? "").trim().toLowerCase() === "on";
}
const norm = (s: unknown) => String(s ?? "").normalize("NFKC").replace(/[\s　]/g, "");
/** pending の行のうち、72時間以内に送った物件の AIX の物件名に入っている物だけ（純関数） */
export function pendingMatchedOf<T extends { property_name?: string | null }>(pending: readonly T[], sentNames: readonly string[]): T[] {
  const set = new Set(sentNames.map(norm).filter(Boolean));
  return pending.filter((p) => set.has(norm(p.property_name)));
}
