// app/lib/__tests__/condition-write-arbiter.test.ts — 2026-11-15 作業員K
//   実行: npx tsx app/lib/__tests__/condition-write-arbiter.test.ts
//   実物（property_condition_history の直近30日の取り合い・値は条件の欄だけ・お客様は伏せる）をそのまま使う
import { arbitrateField, arbitrateConditionUpdates, normalizeConditionValue, conditionWriteArbiterMode, type HistoryRowLike } from "../condition-write-arbiter";
import { normalizeRentUnits, syncScreeningPcGuardOn } from "../rent-units";
import { categoryOfCode } from "../prop-brain-score-category";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const M1 = "11111111-1111-1111-1111-111111111111", M2 = "22222222-2222-2222-2222-222222222222";
const at = (id: string) => ({ [M1]: "2026-10-28T02:07:00Z", [M2]: "2026-10-28T03:00:00Z" } as Record<string, string>)[id];

// 実物1: brain_bridge が希望エリアに足す → 4秒後に condition_brain が丸ごとで前の値に戻す
const h1: HistoryRowLike[] = [{ changed_field: "desired_area", old_value: "吉田駅・荒本駅周辺(吉田荒本あたり)", new_value: "吉田駅・荒本駅周辺(吉田荒本あたり)・吉田荒本", source_message_id: `brain_bridge:${M1}`, created_at: "2026-10-28T02:08:00Z" }];
const r1 = arbitrateField({ field: "desired_area", current: "吉田駅・荒本駅周辺(吉田荒本あたり)・吉田荒本", proposed: "吉田駅・荒本駅周辺(吉田荒本あたり)", writer: "condition_brain", now: "2026-10-28T02:08:04Z", messageAt: at(M1), history: h1, messageAtOf: at });
t("足された語が残りに含まれる戻し（重なりの片付け）→ write", r1.action === "write" && r1.reason === "重なりの片付け");
// 実物1b: 「谷町9」を足した（お客様が前の発言で言った）→ 別の発言の処理の condition_brain が丸ごとで消す
const h1b: HistoryRowLike[] = [{ changed_field: "desired_area", old_value: "桃谷・鶴橋周辺・松屋町", new_value: "桃谷・鶴橋周辺・松屋町・谷町9", source_message_id: `brain_bridge:${M1}`, created_at: "2026-11-06T08:06:00Z" }];
const r1b = arbitrateField({ field: "desired_area", current: "桃谷・鶴橋周辺・松屋町・谷町9", proposed: "桃谷・鶴橋周辺・松屋町", writer: "condition_brain", now: "2026-11-06T08:06:04Z", messageAt: at(M1), history: h1b, messageAtOf: at });
t("同じ発言から別の書き手が前の値に戻す → skip", r1b.action === "skip" && r1b.against?.writer === "brain_bridge");
// 新しい発言での言い直しは止めない
const r2 = arbitrateField({ field: "desired_area", current: "桃谷・鶴橋周辺・松屋町・谷町9", proposed: "桃谷・鶴橋周辺・松屋町", writer: "condition_brain", now: "2026-10-28T03:00:10Z", messageAt: at(M2), history: h1b.map((h) => ({ ...h, created_at: "2026-10-28T02:08:00Z" })), messageAtOf: at });
t("新しい発言の言い直し → write", r2.action === "write" && r2.reason.includes("新しい発言"));
// 実物2: 間取りの行き来（1K以上（ワンルーム除く）↔ 1K）
const h2: HistoryRowLike[] = [{ changed_field: "floor_plan", old_value: "1K", new_value: "1K以上（ワンルーム除く）", source_message_id: `condition_brain:${M1}`, created_at: "2026-10-20T01:00:00Z" }];
t("間取りを同じ発言から戻す → skip", arbitrateField({ field: "floor_plan", current: "1K以上（ワンルーム除く）", proposed: "1K", writer: "brain_bridge", now: "2026-10-20T01:00:21Z", messageAt: at(M1), history: h2, messageAtOf: at }).action === "skip");
t("発言が分からない時も戻しは skip（新しいとみなさない）", arbitrateField({ field: "floor_plan", current: "1K以上（ワンルーム除く）", proposed: "1K", writer: "brain_bridge", now: "2026-10-20T01:00:21Z", messageAt: null, history: h2 }).action === "skip");
// 実物3: 今回だけの戻し（scope）は止めない・比べる相手にもしない
const h3: HistoryRowLike[] = [{ changed_field: "floor_plan", old_value: "1K・1DK・1LDK", new_value: "1DK", source_message_id: `format:${M1}`, created_at: "2026-10-10T01:00:00Z" }];
t("scope の戻しは write", arbitrateField({ field: "floor_plan", current: "1DK", proposed: "1K・1DK・1LDK", writer: "scope", now: "2026-10-10T01:01:49Z", history: h3 }).action === "write");
const h3b: HistoryRowLike[] = [{ changed_field: "floor_plan", old_value: "1DK", new_value: "1K・1DK・1LDK", source_message_id: "scope", created_at: "2026-10-10T01:01:49Z" }];
t("直前が scope なら自動の書き手は write（相手にしない）", arbitrateField({ field: "floor_plan", current: "1K・1DK・1LDK", proposed: "1DK", writer: "brain_bridge", now: "2026-10-10T02:00:00Z", history: h3b }).action === "write");
// スタッフの直しの後
const h4: HistoryRowLike[] = [{ changed_field: "rent_max", old_value: "80000", new_value: "90000", source_message_id: "screen_edit", created_at: "2026-10-10T01:00:00Z" }];
t("直前が画面の直し → write", arbitrateField({ field: "rent_max", current: 90000, proposed: 80000, writer: "p4", now: "2026-10-10T01:05:00Z", history: h4 }).action === "write");
// 同じ書き手・直前でない・前の値でない
t("同じ書き手 → write", arbitrateField({ field: "floor_plan", current: "1K以上（ワンルーム除く）", proposed: "1K", writer: "condition_brain", now: "2026-10-20T01:00:21Z", history: h2 }).action === "write");
t("6時間を超えた → write", arbitrateField({ field: "floor_plan", current: "1K以上（ワンルーム除く）", proposed: "1K", writer: "brain_bridge", now: "2026-10-20T08:00:00Z", history: h2 }).action === "write");
t("前の値でない別の値 → write", arbitrateField({ field: "floor_plan", current: "1K以上（ワンルーム除く）", proposed: "1LDK", writer: "brain_bridge", now: "2026-10-20T01:00:21Z", history: h2 }).action === "write");
t("区切りと全角の違いは同じ値", normalizeConditionValue("1K、1DK／1LDK") === normalizeConditionValue("1K・1DK・1LDK") && normalizeConditionValue("（ワンルーム除く）") === normalizeConditionValue("(ワンルーム除く)"));
// 読み直し（同じ書き手が同じ発言から2回目）
const h5: HistoryRowLike[] = [
  { changed_field: "floor_plan", old_value: "1K以上", new_value: "1K", source_message_id: `brain_bridge:${M1}`, created_at: "2026-10-23T00:01:56Z" },
  { changed_field: "floor_plan", old_value: "1K", new_value: "1K以上", source_message_id: `format:${M2}`, created_at: "2026-10-23T01:00:00Z" },
];
t("同じ発言からの読み直し → skip", arbitrateField({ field: "floor_plan", current: "1K以上", proposed: "1K", writer: "brain_bridge", now: "2026-10-23T04:22:40Z", messageId: M1, messageAt: at(M1), history: h5, messageAtOf: at }).reason.includes("読み直し"));
t("別の発言なら読み直しにしない", arbitrateField({ field: "floor_plan", current: "1K以上", proposed: "1K", writer: "brain_bridge", now: "2026-10-23T04:22:40Z", messageId: M2, messageAt: at(M2), history: h5, messageAtOf: at }).reason !== "同じ発言からこの欄を既に書いた（読み直し）");
// スタッフの直しより古い発言
const h6: HistoryRowLike[] = [{ changed_field: "rent_max", old_value: "80000", new_value: "90000", source_message_id: "screen_edit", created_at: "2026-10-28T02:30:00Z" }];
t("画面の直しより古い発言の上書き → skip", arbitrateField({ field: "rent_max", current: 90000, proposed: 85000, writer: "condition_brain", now: "2026-10-28T02:31:00Z", messageId: M1, messageAt: at(M1), history: h6, messageAtOf: at }).action === "skip");
t("画面の直しより新しい発言 → write", arbitrateField({ field: "rent_max", current: 90000, proposed: 85000, writer: "condition_brain", now: "2026-10-28T03:01:00Z", messageId: M2, messageAt: at(M2), history: h6, messageAtOf: at }).action === "write");
// 束
const off = arbitrateConditionUpdates({ mode: "off", writer: "brain_bridge", now: "2026-10-20T01:00:21Z", current: { floor_plan: "1K以上（ワンルーム除く）" }, updates: { floor_plan: "1K", rent_max: 80000 }, history: h2 });
t("off は何もしない", off.skipped.length === 0 && off.updates.floor_plan === "1K");
const sh = arbitrateConditionUpdates({ mode: "shadow", writer: "brain_bridge", now: "2026-10-20T01:00:21Z", current: { floor_plan: "1K以上（ワンルーム除く）" }, updates: { floor_plan: "1K", rent_max: 80000 }, history: h2 });
t("shadow は書くが skip を返す", sh.skipped.length === 1 && sh.updates.floor_plan === "1K");
const on = arbitrateConditionUpdates({ mode: "on", writer: "brain_bridge", now: "2026-10-20T01:00:21Z", current: { floor_plan: "1K以上（ワンルーム除く）" }, updates: { floor_plan: "1K", rent_max: 80000 }, history: h2 });
t("on は戻しの欄だけ外す", on.skipped.length === 1 && !("floor_plan" in on.updates) && on.updates.rent_max === 80000);
t("スイッチ既定 shadow・off/on で切り替え", conditionWriteArbiterMode({}) === "shadow" && conditionWriteArbiterMode({ CONDITION_WRITE_ARBITER: "off" }) === "off" && conditionWriteArbiterMode({ CONDITION_WRITE_ARBITER: "on" }) === "on" && conditionWriteArbiterMode({ CONDITION_WRITE_ARBITER: "x" }) === "shadow");

// 家賃の単位
const ru = normalizeRentUnits({ rent_max: 1000000, rent_min: 8, initial_cost_limit: 600000 });
t("家賃 10倍 → /10・万円 → 円・初期費用の 60万はそのまま", ru.rent_max === 100000 && ru.rent_min === 80000 && ru.initial_cost_limit === 600000);
t("同期の守りは既定 on・off で戻す", syncScreeningPcGuardOn({}) && !syncScreeningPcGuardOn({ SYNC_SCREENING_PC_GUARD: "off" }) && syncScreeningPcGuardOn({ SYNC_SCREENING_PC_GUARD: "on" }));
t("正しい家賃はそのまま", normalizeRentUnits({ rent_max: 130000 }).rent_max === 130000);

// 採点の項目
t("札の項目", categoryOfCode("AD_UNDER_1M") === "AD" && categoryOfCode("RENT_CHEAP_W80") === "家賃帯" && categoryOfCode("FLOOR_PLAN_MATCH") === "合い方（間取り・広さ）"
  && categoryOfCode("ZERO_ZERO_MATCH") === "初期費用" && categoryOfCode("WALK_OK") === "駅・エリア" && categoryOfCode("EQUIP_AUTOLOCK_OK") === "設備"
  && categoryOfCode("AGE_W5") === "築年・構造" && categoryOfCode("ALREADY_SENT_OTHER_ROOM") === "新着・送付済み" && categoryOfCode("XYZ") === "その他");

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
