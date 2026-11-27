// app/lib/__tests__/pickup-search-spec.test.ts — 探す条件の1枚（#820 案B・2026-11-27 作業員A）
//   実行: npx tsx app/lib/__tests__/pickup-search-spec.test.ts
import { effectiveConditions, specConditionsText, lastWritersOf, buildPickupSearchSpec, readPickupSpec, specTextMismatch, pickupSpecSharedOn } from "../pickup-search-spec";
import type { SearchOverride } from "../search-override";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const row = { desired_area: "中央区・西区・浪速区", floor_plan: "1LDK", rent_max: 110000, rent_min: 70000, walk_minutes: 10, building_age: 15, move_in_time: "12月", preferences: "バストイレ別", ng_points: "1階" };
const ov: SearchOverride = { v: 1, location: { mode: "only", stations: ["桜川", "なんば"], lines: [], areas: [] }, floor_plan: null, rent_max: 120000, rent_min: null, walk_minutes: null, building_age: null, area_min: null, area_max: null, pet: null, site: null, is_wide: null };

// 上書きが無ければ今の「希望条件（DB）」と同じ形
const noOv = specConditionsText(effectiveConditions(row, null));
t("上書きなし: 今の文の条件の形（エリア・間取り・家賃上限・駅徒歩・入居・希望・NG）", noOv === "エリア: 中央区・西区・浪速区 / 間取り: 1LDK / 家賃上限: 11万円 / 駅徒歩: 10分以内 / 築年数: 15年以内 / 入居希望: 12月 / 希望: バストイレ別 / NG条件: 1階");
// 今回だけの上書き: 探す条件と文の条件が同じになる
const e = effectiveConditions(row, ov);
t("今回だけ: 場所（だけ）と家賃が今回の値・印（今回だけ）", e.desired_area === "桜川駅・なんば駅" && e.rent_max === 120000 && e.temp.join() === "desired_area,rent_max" && /エリア: 桜川駅・なんば駅（今回だけ）/.test(specConditionsText(e)) && /家賃上限: 12万円（今回だけ）/.test(specConditionsText(e)));
t("今回だけ（足す）: 登録の場所に足す", effectiveConditions(row, { ...ov, location: { mode: "add", stations: ["桜川"], lines: [], areas: [] } }).desired_area === "中央区・西区・浪速区・桜川駅");
t("上書きの書いていない欄は登録のまま", e.floor_plan === "1LDK" && e.walk_minutes === 10);

// 書き手（本番の型: フォームの読みの後にブレインの側が10分の内に同じ欄を書いた）
const hist = [
  { changed_field: "other_requests", source_message_id: "format:11111111-1111-1111-1111-111111111111", created_at: "2026-11-20T10:00:00Z" },
  { changed_field: "other_requests", source_message_id: "condition_brain", created_at: "2026-11-20T10:03:00Z" },
  { changed_field: "desired_area", source_message_id: "path_c:22222222-2222-2222-2222-222222222222", created_at: "2026-11-20T09:00:00Z" },
  { changed_field: "desired_area", source_message_id: "p4", created_at: "2026-11-18T09:00:00Z" },
];
const lw = lastWritersOf(hist);
t("最後の書き手: 欄ごと", lw.writers.other_requests.writer === "condition_brain" && lw.writers.desired_area.writer === "path_c");
t("争った欄: 同じ時（10分の内）に別の書き手が書いた欄だけ・勝ったのは最後", lw.contested.length === 1 && lw.contested[0].field === "other_requests" && lw.contested[0].writers.join() === "format,condition_brain" && lw.contested[0].winner === "condition_brain");

// 1枚
const spec = buildPickupSearchSpec({ customerId: "pc1", row, override: ov, history: hist, nowIso: "2026-11-27T03:00:00Z" });
t("1枚: 探す条件・文・上書き・書き手が入る", spec.v === 1 && spec.text === specConditionsText(e) && spec.override === ov && spec.contested.length === 1);
t("命令の payload から読む（形が違えば null）", readPickupSpec(JSON.parse(JSON.stringify(spec)))?.text === spec.text && readPickupSpec({ v: 2 }) === null && readPickupSpec(null) === null);

// 文と探した条件の照らし（書き換えはしない・印だけ）
t("照らし: 文の家賃の上限が探した条件と違う欄", specTextMismatch(spec, "家賃11万円以内でピックアップさせて頂きました").join() === "rent_max" && specTextMismatch(spec, "家賃12万円以内でお探ししました").length === 0);
t("照らし: 文に書いていない欄は見ない", specTextMismatch(spec, "オススメのお部屋をお送りさせて頂きます！！").length === 0);
t("照らし: 間取りが違う", specTextMismatch(spec, "2LDKのお部屋をピックアップしました").join() === "floor_plan");
t("既定 off", !pickupSpecSharedOn({}) && pickupSpecSharedOn({ PICKUP_SPEC_SHARED: "on" }));
// 配線: on の時だけ・命令に pickup_spec・物件の AIX の文が1枚を読む
const ai = readFileSync(join(__dirname, "..", "aix-action-items.ts"), "utf8"), tg = readFileSync(join(__dirname, "..", "..", "api", "aix-template-generate", "route.ts"), "utf8");
t("配線: 積む所は on の時だけ1枚を作り payload.pickup_spec に（新しい命令・未着手の命令の両方）", /ps.pickupSpecSharedOn()/.test(ai) && (ai.match(/pickup_spec: pickupSpec/g) ?? []).length === 2);
t("配線: 文は on の時だけ・物件の AIX だけ1枚を読む", /ps.pickupSpecSharedOn()/.test(tg) && /resolvedCustomerConditions = spec.text/.test(tg));
t("入れ物: 探す命令の所と文の所で番ごとの入れ物を作る（表が読めない時は env だけ）", ai.includes("ss.enterSwitchStage(await ss.loadSwitchStageCtx(conversationId))") && tg.includes("ss.enterSwitchStage(await ss.loadSwitchStageCtx(conversationId))"));
console.log(`pickup-search-spec: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
