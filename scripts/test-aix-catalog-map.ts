// scripts/test-aix-catalog-map.ts — AIX ボタン×情報の種類の表（app/lib/aix-catalog-map.ts・BRAIN_AIX_CATALOG_MAP 既定 off）のテスト（LLM/DB なし・費用0）
// 実行: npx tsx scripts/test-aix-catalog-map.ts
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { aixCatalogMapEnabled, BUTTON_MAP, SUB_ROWS, INFO_KINDS_16, UNCONNECTED_KINDS, UNCONNECTED_BUTTONS, buttonsOfKind, mapRowFor, catalogMapIntro } from "../app/lib/aix-catalog-map";
import { AIX_CATALOG, catalogBlockForBrain } from "../app/lib/aix-catalog";
import { INFO_KIND_ROWS } from "../app/lib/brain-info-kind";

let n = 0;
const t = (name: string, f: () => void | Promise<void>) => Promise.resolve(f()).then(() => { n++; console.log("ok", name); });
const BAD = /迷ったら|次の一手|押す |押す。|申込へ進|背中|気持ちを|温度|中期/;

(async () => {
  await t("既定 off（on だけで有効）", () => {
    assert.equal(aixCatalogMapEnabled({}), false);
    assert.equal(aixCatalogMapEnabled({ BRAIN_AIX_CATALOG_MAP: "shadow" }), false);
    assert.equal(aixCatalogMapEnabled({ BRAIN_AIX_CATALOG_MAP: " ON " }), true);
  });

  await t("off で catalogBlockForBrain が origin/main の物と1文字も変わらない（場面×不確か×ピッカー切替）", async () => {
    const base = execSync("git show origin/main:app/lib/aix-catalog.ts", { cwd: join(__dirname, ".."), encoding: "utf8", maxBuffer: 20_000_000 });
    const tmp = join(__dirname, "..", "app", "lib", "_aix_catalog_main_tmp.ts");
    writeFileSync(tmp, base);
    try {
      const modPath = "../app/lib/_aix_catalog_main_tmp"; // 実行時だけ有る一時ファイル（tsc には見せない）
      const main = (await import(modPath)) as { catalogBlockForBrain: typeof catalogBlockForBrain };
      const scenes = ["property_share", "question", "cost", "viewing", "ack", "conditions", "apply", "other", "considering", null] as const;
      const envs = [{}, { AIX_CATALOG_LEARNED: "on" }, { AIX_NEW_PICKERS_1020: "on", AIX_OCCUPANT_PICKER: "on" }, { BRAIN_AIX_CATALOG_MAP: "off" }] as Array<Record<string, string>>;
      let cnt = 0;
      for (const sc of scenes) for (const unc of [false, true]) for (const env of envs) {
        const a = main.catalogBlockForBrain(sc as never, { sceneUncertain: unc, env });
        const b = catalogBlockForBrain(sc as never, { sceneUncertain: unc, env });
        assert.equal(b, a); cnt++;
      }
      assert.equal(cnt, 80);
    } finally { unlinkSync(tmp); }
  });

  await t("on の時は各ボタンの頭の行が表から作られ、種類との対応の1段が出る・ピッカーの行は off と同じ", () => {
    const off = catalogBlockForBrain("property_share", { env: {} });
    const on = catalogBlockForBrain("property_share", { env: { BRAIN_AIX_CATALOG_MAP: "on" } });
    assert.notEqual(on, off);
    assert.match(on, /AIX のボタンと情報の種類/);
    assert.match(on, /情報の種類 K1・K4・K13/);
    const pick = (s: string) => s.split("\n").filter((l) => l.startsWith("    ・"));
    assert.deepEqual(pick(on), pick(off));
  });

  await t("表の行は一覧（AIX_CATALOG）のボタン18種を全部覆う（ボタンの漏れ0）", () => {
    const types = [...new Set(AIX_CATALOG.map((e) => e.aixType))];
    for (const ty of types) assert.ok(mapRowFor(ty, ty === "property_check_result" ? "物件確認した（募集状況）" : null), `表に行が無い: ${ty}`);
    assert.equal(types.length, 18);
  });

  await t("K 番号は K1〜K16・各ボタンの行に 手元に有るか・押さない時・近いボタン・数 が有る", () => {
    for (const r of [...Object.values(BUTTON_MAP), ...Object.values(SUB_ROWS)]) {
      for (const k of r.kinds) assert.ok(INFO_KINDS_16[k], k);
      assert.ok(r.have && r.notWhen && r.near && r.count && r.deliver);
    }
    assert.equal(Object.keys(INFO_KINDS_16).length, 16);
  });

  await t("つながらない種類（返信だけ）とつながらないボタンが表と一致する", () => {
    for (const k of UNCONNECTED_KINDS) assert.deepEqual(buttonsOfKind(k), [], `${k} にボタンがある`);
    for (const k of Object.keys(INFO_KINDS_16)) if (!UNCONNECTED_KINDS.includes(k)) assert.ok(buttonsOfKind(k).length > 0, `${k} にボタンが無い`);
    for (const b of UNCONNECTED_BUTTONS) assert.deepEqual(BUTTON_MAP[b].kinds, []);
    for (const k of UNCONNECTED_KINDS) assert.equal(INFO_KINDS_16[k].staffOnly, false);
  });

  await t("スタッフだけが知る種類（K1〜K7・K13）はすべてボタンにつながる", () => {
    for (const k of ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K13"]) assert.ok(buttonsOfKind(k).length > 0, k);
  });

  await t("表・追加の文に道を引っぱる言葉（迷ったら・次の一手・申込へ進む 等）を入れない", () => {
    assert.doesNotMatch(JSON.stringify([BUTTON_MAP, SUB_ROWS]) + catalogMapIntro(), BAD);
  });

  await t("brain-info-kind.ts の11行と矛盾しない（スタッフだけが知る7種＝K1〜K7）", () => {
    assert.equal(INFO_KIND_ROWS.filter((r) => r.staffOnly).length, 7);
    for (const k of ["K1", "K2", "K3", "K4", "K5", "K6", "K7"]) assert.equal(INFO_KINDS_16[k].staffOnly, true);
  });

  // ─ 実物の番 ─
  await t("実物: 物件確認した（募集状況）は、結果がまだ無い番は約束の返信・資料に書いてあれば返信・室内写真が手元に無ければ撮影の約束の返信（試験 q013・q145・q017）", () => {
    const r = mapRowFor("property_check_result", "物件確認した（募集状況）")!;
    assert.match(r.notWhen, /結果がまだ無い.*約束の返信/);
    assert.match(r.notWhen, /資料に入居時期・退去予定日が書いてある.*返信/);
    assert.match(r.notWhen, /室内写真が手元に無い.*約束の返信/);
  });
  await t("実物: 確認した（条件・交渉）は、代理契約（q099）の結果を届け、資料に書いてある事は返信", () => {
    const r = mapRowFor("property_check_result", "確認した（条件・交渉）")!;
    assert.match(r.deliver, /代理契約/);
    assert.match(r.notWhen, /資料に書いてある.*返信/);
  });
  await t("実物: acknowledge_check は、御見積書の後の代表確認だけ・募集状況の確認の約束は返信（旧指示文の食い違いを解く）", () => {
    const r = BUTTON_MAP.acknowledge_check;
    assert.match(r.deliver, /代表/);
    assert.match(r.notWhen, /募集状況を確認する約束は返信/);
  });
  await t("実物: 見積書送る は見積る物件が無い費用の質問は返信（見積を約束しない）・申込誘導を必須にしない（作業員19 の BRAIN_PROMPT_RULES_1112 と同じ向き）", () => {
    const r = BUTTON_MAP.estimate_sheet;
    assert.match(r.notWhen, /見積を約束しない/);
    assert.doesNotMatch(JSON.stringify(r), /申込誘導|お申込みでお部屋お抑え/);
  });
  await t("実物: 内覧日調整は、退去予定で開始日が資料に無い時の約束の返信と、資料に退去予定日が有る時の返信を言う（10/07・10/08 の決定）", () => {
    const r = BUTTON_MAP.viewing_invite;
    assert.match(r.notWhen, /内覧開始日を確認させて頂きます/);
    assert.match(r.notWhen, /以降ご内覧出来ます/);
  });
  await t("実物: 電話をかける（依頼を受ける）と 電話終了後（スタッフ操作・ブレインは選ばない）が分かれている", () => {
    assert.match(BUTTON_MAP.phone_call.near, /電話終了後/);
    assert.match(BUTTON_MAP.phone_followup.notWhen, /ブレインは選ばない/);
    assert.equal(AIX_CATALOG.find((e) => e.aixType === "phone_followup")!.brainSelectable, false);
  });

  await t("brain-core の AIX_CAPABILITY_MAP の文は触っていない（作業員19 の applyPromptRules1112 と文が重ならない）", () => {
    const src = readFileSync(join(__dirname, "..", "app", "lib", "brain-core.ts"), "utf8");
    assert.ok(!src.includes("aix-catalog-map"));
  });

  console.log(`\n${n} 件 OK`);
})().catch((e) => { console.error(e); process.exit(1); });
