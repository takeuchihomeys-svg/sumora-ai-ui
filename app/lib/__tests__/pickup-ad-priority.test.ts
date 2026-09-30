// ピックアップの選び方（2026-09-28 竹内）: 審査中・商談中を入れない／新規のお客様は AD の高い物件を優先
// 実行: npx tsx app/lib/__tests__/pickup-ad-priority.test.ts
// 形は実物: 田邉 歩夢さんの 9/28 10:59 の回（property_pickups #799〜#826・まだ物件をお送りしていない新規のお客様・
//   旧の既定のチェックで AD1 の5件＝#821・#822・#824・#825・#826 がそのまま送られた）と、未桜さんの #787（資料の現況「退去予定/2026年10月下旬/商談中」・通す 162点）。
//   札は AD の段と判定に効く物だけ残した（点・判定・id・順位は実物のまま）
import { pickupAdTier, selectByAdPriority, isFirstProposalRound, isProposalSend, firstProposalSentAt, AD2_ENOUGH } from "../pickup-ad-priority";
import { pickQualityTop, defaultAixChecks, pickTopForAix, qualityPickMessage, dealStatusOf, dealConfirmMessage, underReviewBlockMessage, type AixPickRow } from "../pickup-review-order";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ""}`); }
}

type R = AixPickRow & { created_at?: string };
const A2 = ["AD_HIGH"], A25 = ["AD_HIGH", "AD_2_5M", "AD_VERY_HIGH"], A15 = ["AD_1M", "AD_1_5M"], A1 = ["AD_1M"];
const mk = (id: number, rank: number, recommended: number, score: number, codes: string[], moveIn = "空室/即入", verdict = "pass"): R =>
  ({ id, rank, recommended, score, verdict, status: "pending", reason_codes: [...codes, "SEARCH_PINPOINT"], terms: { evidence: { moveIn } } });

// 田邉さんの回（通す・保留。保留の #801・#804・#806・#811 は AD_HIGH_HELD）
const TANABE: R[] = [
  mk(799, 1, 0, 153, A25), mk(800, 4, 2, 157, A2), mk(801, 5, 0, 88, ["AD_HIGH_HELD", "INITIAL_COST_NOT_ZERO"], "退去予定/相談", "hold"),
  mk(802, 6, 0, 153, ["AD_HIGH", "AD_2_5M"]), mk(803, 7, 0, 167, A2), mk(804, 8, 0, 93, ["AD_HIGH_HELD", "INITIAL_COST_NOT_ZERO"], "退去予定/2026年10月16日", "hold"),
  mk(805, 10, 0, 181, A2, "退去予定/相談"), mk(806, 11, 0, 113, ["AD_HIGH_HELD", "MOVE_IN_LATE"], "退去予定/2026年12月07日", "hold"),
  mk(807, 16, 0, 170, A2, "空室/相談"), mk(808, 17, 0, 145, A2, "退去予定(10/31)/相談"), mk(809, 11, 0, 154, A15),
  mk(810, 1, 2, 167, A2), mk(811, 2, 0, 93, ["AD_HIGH_HELD", "INITIAL_COST_NOT_ZERO"], "空室/即入", "hold"), mk(812, 3, 1, 150, A2),
  mk(813, 4, 0, 158, A2, "空室/相談"), mk(814, 5, 1, 160, A2), mk(815, 6, 0, 153, A2), mk(816, 8, 0, 153, A2), mk(817, 9, 0, 150, A2),
  mk(818, 10, 0, 130, A15, "空室/即入/商談中"),
  mk(819, 11, 0, 158, A1, "退去予定/2026年10月28日"), mk(820, 1, 0, 143, A1, "退去予定(9/下)/相談"), mk(821, 2, 1, 170, A1),
  mk(822, 3, 0, 158, A1, "退去予定/2026年11月12日"), mk(823, 4, 0, 145, A1, "退去予定/2026年11月04日"), mk(824, 5, 0, 166, A1),
  mk(825, 6, 1, 166, A1, "空室/2026年10月01日"), mk(826, 7, 2, 166, A1, "退去予定/2026年10月27日"),
];
const tierOf = (id: number) => pickupAdTier(TANABE.find((r) => r.id === id)!.reason_codes);

console.log("■ AD の段（判定の札から）");
{
  t("AD_HIGH → AD2以上", pickupAdTier(["AD_HIGH"]) === "ad2");
  t("AD_HIGH＋2.5＋3ヶ月 → AD2以上", pickupAdTier(A25) === "ad2");
  t("保留の AD_HIGH_HELD も AD2以上（段は同じ）", pickupAdTier(["AD_HIGH_HELD"]) === "ad2");
  t("アズ・スタットのみなし（AD_ASSUMED_AGENT＋AD_HIGH）→ AD2以上", pickupAdTier(["AD_ASSUMED_AGENT", "AD_HIGH"]) === "ad2");
  t("AD_1M＋AD_1_5M → AD1.5", pickupAdTier(A15) === "ad15");
  t("AD_1M だけ → AD1", pickupAdTier(A1) === "ad1");
  t("AD_UNDER_1M・AD_NONE → AD1未満", pickupAdTier(["AD_UNDER_1M"]) === "low" && pickupAdTier(["AD_NONE"]) === "low");
  t("札なし・AD_UNKNOWN → 不明", pickupAdTier([]) === "unknown" && pickupAdTier(["AD_UNKNOWN"]) === "unknown" && pickupAdTier(null) === "unknown");
}

console.log("■ 審査中・商談中（資料の現況）");
{
  const miou: R = mk(787, 3, 0, 162, A2, "退去予定/2026年10月下旬/商談中");
  t("未桜さん #787 は商談中", dealStatusOf(miou) === "商談中");
  t("API の deal_status も読む（terms が無くても）", dealStatusOf({ deal_status: "審査中", terms: null }) === "審査中");
  t("空室/即入 は null", dealStatusOf(mk(1, 1, 0, 100, A2)) === null);
  const others = [mk(2, 1, 0, 150, A2), mk(3, 2, 0, 140, A2)];
  const q = pickQualityTop([miou, ...others]);
  t("質の高い10件に入らない（162点で一番上でも）", !q.ids.includes(787) && q.ids.length === 2 && q.dealExcluded === 1, q);
  const dc = defaultAixChecks([{ items: [miou, ...others] }]);
  t("既定のチェックも付かない", dc[787] === false && dc[2] === true && dc[3] === true, dc);
  t("手で11件以上チェックして絞る時は一番後ろ（先に外れる）", pickTopForAix([miou, ...others], null, 2).join(",") === "2,3", pickTopForAix([miou, ...others], null, 2));
  t("手で選んだ分は絞っても枠があれば残る", pickTopForAix([miou, ...others], null, 10).includes(787));
  t("田邉さんの回の #818 商談中（AD1.5）も入らない", !pickQualityTop(TANABE).ids.includes(818) && pickQualityTop(TANABE).dealExcluded === 1);
}

console.log("■ 新規のお客様: AD2以上 → AD1.5 → （AD2以上が8件未満の時だけ）AD1");
{
  const oldQ = pickQualityTop(TANABE);   // お送りした後の回＝今まで通り点の順
  t("今まで通り（新規でない）は AD1 の #821 170点が入る", oldQ.ids.includes(821) && oldQ.adExcluded === 0 && !oldQ.firstProposal, oldQ.ids);
  t("今まで通りは AD1 が5件入っていた（実際に送られた5件）", [821, 822, 824, 825, 826].every((id) => oldQ.ids.includes(id)), oldQ.ids);
  const q = pickQualityTop(TANABE, null, 10, { firstProposal: true });
  t("新規: 10件すべて AD2以上", q.ids.length === 10 && q.ids.every((id) => tierOf(id) === "ad2"), q.ids.map((id) => [id, tierOf(id)]));
  t("新規: AD1 の5件は外れ、数も出る", [821, 822, 824, 825, 826].every((id) => !q.ids.includes(id)) && q.adExcluded === 5, q);
  t("新規: 保留（#801・#804・#806・#811）は AD2以上でも入らない", [801, 804, 806, 811].every((id) => !q.ids.includes(id)));
  t("新規: 段の中は点の順（181 の #805 が先頭・170 の #807 が次）", q.ids[0] === 805 && q.ids[1] === 807, q.ids);
  t("新規: AD1.5 の #809（154点）は AD2以上が10件あるので入らない", !q.ids.includes(809));

  const rows = (spec: Array<[string[], number]>) => spec.flatMap(([codes, n], gi) => Array.from({ length: n }, (_, i) => mk(1000 + gi * 100 + i, i + 1, 0, 150 - gi - i, codes)));
  const s1 = selectByAdPriority(rows([[A2, 5], [A15, 2], [A1, 6]]), 10);
  t("AD2以上5・AD1.5 2・AD1 6 → 5＋2＋AD1 3＝10件", s1.picked.length === 10 && s1.lowAllowed && s1.picked.filter((r) => pickupAdTier(r.reason_codes) === "ad1").length === 3, s1.tiers);
  const s2 = selectByAdPriority(rows([[A2, 8], [A1, 5]]), 10);
  t(`AD2以上が${AD2_ENOUGH}件そろえば AD1 では埋めない（8件で止める）`, s2.picked.length === 8 && !s2.lowAllowed, s2.tiers);
  const s3 = selectByAdPriority(rows([[A2, 7], [A15, 4], [A1, 3]]), 10);
  t("AD2以上7・AD1.5 4 → 7＋3＝10件・AD1 は入らない（10件に届く）", s3.picked.length === 10 && s3.picked.every((r) => pickupAdTier(r.reason_codes) !== "ad1"), s3.tiers);
  const s4 = selectByAdPriority(rows([[A2, 2], [A1, 3], [[], 2]]), 10);
  t("AD2以上が少なければ AD1・AD 不明も足す（7件）", s4.picked.length === 7 && s4.lowAllowed, s4.tiers);
  const s5 = selectByAdPriority(rows([[A1, 12]]), 10);
  t("AD1 しかない新規のお客様は AD1 で10件（条件に合う物件が少ない時は入れる）", s5.picked.length === 10);
}

console.log("■ 新規のお客様か（まだ物件をお送りしていない回）");
{
  t("まだ1件も送っていない → 新規", isFirstProposalRound("2026-09-28T01:59:55Z", null));
  t("分からない（undefined）→ 今まで通り", !isFirstProposalRound("2026-09-28T01:59:55Z", undefined));
  t("回が一番最初のお送りより前 → 新規", isFirstProposalRound("2026-09-28T01:59:55.07354+00:00", "2026-09-28T03:10:00+00:00"));
  t("回がお送りの後（新着）→ 対象外", !isFirstProposalRound("2026-09-28T08:00:00+00:00", "2026-09-28T03:10:00+00:00"));
  t("グループ共有だけは数えない", !isProposalSend({ sent_at: "x", channel: "extension_group", delivery: "shared", source: "line_group" }) && !isProposalSend({ sent_at: "x", channel: null, delivery: null, source: "line_group" }));
  t("物件確認・見積書は数えない", !isProposalSend({ sent_at: "x", channel: "check", delivery: "customer", source: "aix:property_check_result" }) && !isProposalSend({ sent_at: "x", channel: "estimate", delivery: "customer", source: "aix:estimate_sheet" }));
  t("ピックアップ・オススメ・画像で読んだ古い行（channel なし）は数える", isProposalSend({ sent_at: "x", channel: "pickup", delivery: "customer", source: "aix:property_send" }) && isProposalSend({ sent_at: "x", channel: null, delivery: "customer", source: "vision" }));
  const first = firstProposalSentAt([
    { sent_at: "2026-09-20T00:00:00Z", channel: "extension_group", delivery: "shared", source: "line_group" },
    { sent_at: "2026-09-22T00:00:00Z", channel: "check", delivery: "customer", source: "aix:property_check_result" },
    { sent_at: "2026-09-28T03:10:00Z", channel: "pickup", delivery: "customer", source: "aix:property_send" },
    { sent_at: "2026-09-28T05:00:00Z", channel: null, delivery: "customer", source: "vision" },
  ]);
  t("一番最初のご提案（共有・物件確認は飛ばす）", first === "2026-09-28T03:10:00Z", first);
  const dcNew = defaultAixChecks([{ items: TANABE, created_at: "2026-09-28T01:59:55.07354+00:00" }], null, 10, { firstProposalSentAt: null });
  t("既定のチェック（新規）: AD1 の #821 に付かない・#805 に付く", dcNew[821] === false && dcNew[805] === true && Object.values(dcNew).filter(Boolean).length === 10);
  const dcLater = defaultAixChecks([{ items: TANABE, created_at: "2026-09-28T08:00:00Z" }], null, 10, { firstProposalSentAt: "2026-09-28T03:10:00Z" });
  t("既定のチェック（お送りした後の新着）: 今まで通り #821 に付く", dcLater[821] === true);
  const dcUnknown = defaultAixChecks([{ items: TANABE }], null, 10);
  t("既定のチェック（分からない）: 今まで通り", dcUnknown[821] === true && dcUnknown[818] === false);
}

console.log("■ 知らせの文");
{
  t("前の文は変えない", qualityPickMessage(7, 6) === "✨ 質の高い7件を選びました（10件に足りません・NG 条件・保留の物件は選びません・6件）");
  const m = qualityPickMessage(10, 4, 10, { dealExcluded: 1, adExcluded: 5 });
  t("審査中・商談中・AD の段を書く", m === "✨ 質の高い10件を選びました（NG 条件・保留の物件は選びません・4件・審査中・商談中は選びません・1件・新規のお客様は AD の高い物件を優先・AD1 など5件を外しました）", m);
}

console.log("■ AIX に渡す前の確かめ（2026-09-29 反証: 画像保存ではなく AIX のボタンで聞く）");
{
  const miou = { ...mk(787, 3, 0, 162, A2, "退去予定/2026年10月下旬/商談中"), property_name: "未桜さんの候補", room_no: "302" };
  const open = { ...mk(2, 1, 0, 150, A2), property_name: "空室の物件", room_no: null };
  t("審査中・商談中が無ければ聞かない（null）", dealConfirmMessage([open]) === null);
  const m = dealConfirmMessage([open, miou]);
  t("商談中は確認でなく送れない（確認の文は出さない）", m === null, String(m));
  // 2026-09-30 竹内「審査中の物件送らない」: 審査中は確認でなく送れない（旧: 審査中も確認の件数に数えていた）
  t("審査中・商談中は確認の件数に数えない（null）", dealConfirmMessage([{ deal_status: "審査中", terms: null, property_name: "A" }, miou]) === null);
  const blk = underReviewBlockMessage([{ deal_status: "審査中", terms: null, property_name: "FEEL UMEDA (フィールウメダ)", room_no: "202" }, open]);
  t("★ 審査中が入っていれば送れない文（名前・号室）", blk === "資料の現況が審査中・商談中の物件は送れません（FEEL UMEDA (フィールウメダ) 202：審査中）。チェックを外してから送ってください", blk);
  t("資料の現況（退去予定/相談/審査中）からも読む", underReviewBlockMessage([{ ...mk(2665, 1, 0, 158, A2, "退去予定/相談/審査中"), property_name: "FEEL UMEDA", room_no: "202" }]) !== null);
  t("★ 商談中も送れない（竹内 9/30「提案通り」）", (underReviewBlockMessage([miou, open]) ?? "").includes("未桜さんの候補 302：商談中"));
  t("空室だけなら止めない（null）", underReviewBlockMessage([open]) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
