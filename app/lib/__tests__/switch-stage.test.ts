// app/lib/__tests__/switch-stage.test.ts — 段階で読む読み口（#813 の続き・2026-11-27 作業員A）
//   実行: npx tsx app/lib/__tests__/switch-stage.test.ts
import { stagedOn, runWithSwitchStage, loadOverridesSafe, loadSwitchStageCtx, enterSwitchStage, currentSwitchStage, STAGE_ALL, STAGE_OFF, STAGED_SWITCHES, type SwitchStageCtx } from "../switch-stage";
import { watchedSwitches, allSinceMs } from "../rollout-watch";
import { brainRagStateFilterOn } from "../brain-rag-state-filter";
import { brainDigestSituationOn } from "../brain-decision-ledger";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

// ① 今の読み手と同じ答え（表が空・_STAGE 無し）: env の組すべて
const VALUES: Array<string | undefined> = [undefined, "", "on", "off", "ON", "Off", " on ", " off ", "true", "1", "foo", "pct:10"];
const oldDefaultOn = (v: string | undefined) => (v ?? "").trim().toLowerCase() !== "off";
const oldDefaultOff = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "on";
// "pct:10" は _STAGE でない本体の値なので今の読み手と同じ扱い（本体の値は on/off 以外は既定）
t("既定 on の読み手（!== \"off\"）と全部同じ（defaultStage=all）", VALUES.every((v) => stagedOn("X", { X: v }, STAGE_ALL) === oldDefaultOn(v)));
t("既定 off の読み手（=== \"on\"）と全部同じ（defaultStage=off）", VALUES.every((v) => stagedOn("X", { X: v }, STAGE_OFF) === oldDefaultOff(v)));
t("入れ物があっても表が空なら同じ", runWithSwitchStage({ conversationId: "c1", overrides: [], loadedAt: 0, fellBack: false }, () => VALUES.every((v) => stagedOn("X", { X: v }, STAGE_ALL) === oldDefaultOn(v) && stagedOn("X", { X: v }, STAGE_OFF) === oldDefaultOff(v))));

// ② 戻す仕組みが効く: 表に1段下があれば env より優先
const ctxDown: SwitchStageCtx = { conversationId: "conv-xyz", overrides: [{ switch_name: "X", stage: "off" }], loadedAt: 0, fellBack: false };
t("表に off があれば env=on でも off（夜の見張りが戻した時）", runWithSwitchStage(ctxDown, () => stagedOn("X", { X: "on" }, STAGE_ALL)) === false);
t("テスト用の会話（YUMA）は yuma の段でも on", runWithSwitchStage({ conversationId: "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7", overrides: [{ switch_name: "X", stage: "yuma" }], loadedAt: 0, fellBack: false }, () => stagedOn("X", { X: "on" })) === true);
t("入れ物の外では表は読まない（env だけ）", stagedOn("X", { X: "on" }, STAGE_ALL) === true);

// ③ 表が読めない時は env だけ（遅らせない）
(async () => {
  const slow = await loadOverridesSafe(() => new Promise((res) => setTimeout(() => res([{ switch_name: "X", stage: "off" }]), 2000)), 50);
  t("時間切れは空＝env だけ（fellBack）", slow.rows.length === 0 && slow.fellBack);
  const bad = await loadOverridesSafe(() => Promise.reject(new Error("db down")), 50);
  t("DB の失敗は空＝env だけ（fellBack）", bad.rows.length === 0 && bad.fellBack);
  const ok = await loadOverridesSafe(async () => [{ switch_name: "X", stage: "pct:10" }], 50);
  t("読めた時は表の行", ok.rows.length === 1 && !ok.fellBack);
  // 1番につき1回: 同じ会話の2回目は読まない
  let calls = 0;
  const load = async () => { calls++; return []; };
  await runWithSwitchStage({ conversationId: null, overrides: [], loadedAt: 0, fellBack: false }, async () => {
    enterSwitchStage(await loadSwitchStageCtx("conv-1", load)); enterSwitchStage(await loadSwitchStageCtx("conv-1", load));
    t("入れ物に入れた後の await の先でも stagedOn が表を読む", await (async () => { enterSwitchStage({ conversationId: "c9", overrides: [{ switch_name: "Y", stage: "off" }], loadedAt: 0, fellBack: false }); await new Promise((r) => setTimeout(r, 5)); return stagedOn("Y", { Y: "on" }) === false; })());
    calls = calls; enterSwitchStage({ conversationId: "conv-1", overrides: [], loadedAt: 0, fellBack: false });
    t("1番につき1回だけ読む", calls === 1 && currentSwitchStage()?.conversationId === "conv-1");
  });

  // ④ rollout-watch の名簿と all に上がった日
  t("名簿が空なら見張る名前は前と同じ", watchedSwitches({ A_STAGE: "pct:10", B_STAGE: "yuma", C_STAGE: "all", D: "on", E_STAGE: "off" }).join(",") === "A,C" && watchedSwitches({ A_STAGE: "pct:10", D: "on" }, []).join(",") === "A");
  t("名簿の物は =on（all）・コードの既定 all も見る・off は見ない", watchedSwitches({ D: "on", F: "off" }, [{ name: "D", defaultStage: STAGE_OFF }, { name: "F", defaultStage: STAGE_ALL }, { name: "G", defaultStage: STAGE_ALL }]).join(",") === "D,G");
  const vers = [{ switches: "A=off", first_seen_at: "2026-11-03T05:40:00Z" }, { switches: "A=on", first_seen_at: "2026-11-15T03:35:00Z" }];
  t("all に上がった時: 版の記録の変わり目（前の cron の計算と同じ）", allSinceMs("A", vers) === Date.parse("2026-11-15T03:35:00Z"));
  t("ずっと on の版だけ＝null（前と同じ）", allSinceMs("A", [{ switches: "A=on", first_seen_at: "2026-11-03T00:00:00Z" }], "2026-11-20") === null);
  t("版に1度も出ない物はコードの既定が入った日（JST の0時）", allSinceMs("Z", vers, "2026-11-20") === Date.parse("2026-11-20T00:00:00+09:00"));
  // 移した1・2本目: 今の読み手（!== "off"）と env の組すべてで同じ（入れ物の外・空の入れ物の中）
  for (const [name, fn] of [["BRAIN_RAG_STATE_FILTER", brainRagStateFilterOn], ["BRAIN_DIGEST_SITUATION", brainDigestSituationOn]] as const) {
    t(`移した ${name}: 入れ物の外で今の読み手と同じ（12通り）`, VALUES.every((v) => fn({ [name]: v }) === oldDefaultOn(v)));
    t(`移した ${name}: 空の入れ物の中でも同じ`, runWithSwitchStage({ conversationId: "c2", overrides: [], loadedAt: 0, fellBack: false }, () => VALUES.every((v) => fn({ [name]: v }) === oldDefaultOn(v))));
    t(`移した ${name}: 夜の見張りが off を書けば戻る`, runWithSwitchStage({ conversationId: "c3", overrides: [{ switch_name: name, stage: "off" }], loadedAt: 0, fellBack: false }, () => fn({ [name]: "on" })) === false);
  }
  t("名簿: 移した2本（既定 all）＋今日の既定 off の3本（既定 off）", STAGED_SWITCHES.map((r) => r.name).join() === "BRAIN_RAG_STATE_FILTER,BRAIN_DIGEST_SITUATION,AFTER_DECISION_RECORDS,PICKUP_SPEC_SHARED,SEARCH_CONDITION_VIEW,SHADOW_REACH" && STAGED_SWITCHES.slice(0, 2).every((r) => r.defaultStage.kind === "all") && STAGED_SWITCHES.slice(2).every((r) => r.defaultStage.kind === "off"));
  t("見張りの名簿に入る（本番の env=on）", watchedSwitches({ BRAIN_RAG_STATE_FILTER: "on", BRAIN_DIGEST_SITUATION: "on" }, STAGED_SWITCHES).join() === "BRAIN_DIGEST_SITUATION,BRAIN_RAG_STATE_FILTER");
  console.log(`switch-stage: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
