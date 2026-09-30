// app/lib/__tests__/condition-scope-floor.test.ts
// 2026-09-30 竹内「一時的に1階も含む場合は、検索して1階の物件も含めて送ったら大丈夫、その際だけ。階数以外の家賃でも、拡張ツールの一時調整の部分を
//   上手く活用すればできる。一時調整でその一回限定して行うか、そもそもの条件自体を変えるのかの判断の部分も強化する」
//   ① 一時調整（search_override）に階（floor_min）を足す ② 今回だけ／切り替えの決め方を強化 ③ 判断の当たり外れを付ける物差し
// 文は YUMA のテストと本番の実物（scripts/audit-condition-scope.ts で読んだ物）。
// 実行: npx tsx app/lib/__tests__/condition-scope-floor.test.ts（全 PASS で exit 0）
import {
  resolveConditionChangeScope, preBrainMayWriteRegistered, weakTemporaryScopeCue, futurePermanentScopeCue, permanentScopeCue,
  hasRegisteredConditions, planScopeRevert, labelScopeOutcome, scoreScopeDecisions,
} from "../condition-change-scope";
import { buildTemporaryOverride } from "../condition-scope-override";
import {
  floorMinInText, stripFloorWants, normFloorMin, floorMinLabel, overrideShortLabel, overrideLine, overrideRulerKey, isEmptyOverride, type SearchOverride,
} from "../search-override";
import { sanitizeSearchOverride, validateOverride, parseDeterministic } from "../search-override-read";
import { overlayCustomerForOverride, buildProfileWithOverride } from "../search-override-judge";
import { parseEquipmentWants } from "../listing-equipment";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) => t(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const REG = { desired_area: "福島・野田・中津", floor_plan: "1K", rent_max: 80000 };
const sc = (text: string, registered: Record<string, unknown> | null | undefined = REG, brain: unknown = null) => {
  const d = resolveConditionChangeScope({ text, brainScope: brain, registered: registered ?? undefined });
  return `${d.scope}/${d.by}`;
};
const OV0: SearchOverride = { v: 1, location: null, floor_plan: null, rent_max: null, rent_min: null, walk_minutes: null, building_age: null, area_min: null, area_max: null, pet: null, site: null, is_wide: null };

console.log("■ 今回だけ／切り替え（竹内 9/30 の言い回し）");
eq("今回だけ1階も（YUMA）", sc("今回だけ1階も見たいです", REG, "permanent"), "temporary/text_temporary");
eq("今回は1階も見てみたい", sc("今回は1階も見てみたいです"), "temporary/text_temporary");
eq("一旦家賃12万で", sc("一旦家賃12万で探してもらえますか？"), "temporary/text_temporary_weak");
eq("とりあえず福島区も", sc("とりあえず福島区も見てみたいです"), "temporary/text_temporary_weak");
eq("やっぱり1Kに変えて", sc("やっぱり1Kに変えてください"), "permanent/text_permanent");
eq("これからは駅10分以内で", sc("これからは駅10分以内で探してください", REG, "temporary"), "permanent/text_permanent_future");
eq("一旦1Kに変えて＝入口は広め（今回だけ）", sc("一旦1Kに変えて探してもらえますか"), "temporary/text_temporary_weak");
eq("今回だけじゃなくこれからも1階OK＝切り替え", sc("今回だけじゃなくてこれからも1階OKです"), "permanent/text_permanent_future");
eq("今後とも（挨拶）は期間の語にしない", sc("今後ともよろしくお願いします。とりあえず福島区も見たいです"), "temporary/text_temporary_weak");
eq("10月以降の入居（入居時期）は期間の語にしない", sc("10月以降の入居で、一旦1LDKで見たいです"), "temporary/text_temporary_weak");
eq("d3a56a97 一旦他の条件は無視で（本番）", sc("ペット可、子供可でしたら一旦他の条件は無視で大丈夫です🙏🏻"), "temporary/text_temporary_weak");
eq("7e2d3403 やっぱり1LDKで探してくれないですか（本番）", sc("やっぱり1LDKで探してくれないですか?"), "permanent/text_permanent");
eq("7df53628 1DKに変更しようと思います（本番）", sc("広めの1DKに変更しようと思います💦(あればですが)"), "permanent/text_permanent");
eq("b771af1f 8畳以上の広いワンルームでもいい（本番・スタッフは『も含めて』＝足す）", sc("8畳以上の広いワンルームでもいいかなとおもってます、、"), "permanent/default");
eq("3722d12d 1Kでも大丈夫なので（本番）", sc("なるほど、、!1Kでも大丈夫なので探してみてください"), "permanent/default");
eq("本番「一度、一階のお部屋もお願いしたいです」→ 今回だけ（弱い語）", sc("一度、一階のお部屋もお願いしたいです！"), "temporary/text_temporary_weak");
eq("「一度内覧したい」は今回だけの語でない", sc("一度内覧したいです", REG, "permanent"), "permanent/brain");
eq("語が無ければブレイン", sc("天王寺付近で同じような条件で部屋ありますか？", REG, "temporary"), "temporary/brain");

console.log("■ 弱い語は登録の条件がある人だけ（初めての条件を消さない）");
eq("初めての条件の文（登録が空）→ 弱い語は使わない", sc("とりあえず梅田で1Kで探してます", {}), "permanent/text_permanent");
eq("登録が空・語なし → 既定", sc("とりあえず梅田周辺で1K", {}), "permanent/default");
eq("registered を渡さない（ブレインの後）→ 弱い語を使う", sc("とりあえず梅田周辺で1K", null), "temporary/text_temporary_weak");
t("hasRegisteredConditions", hasRegisteredConditions(REG) && !hasRegisteredConditions({}) && !hasRegisteredConditions({ desired_area: " ", rent_max: 0 }) && hasRegisteredConditions({ rent_max: 70000 }));
eq("P4: 弱い語＋登録あり → 書かない", preBrainMayWriteRegistered("一旦家賃12万で", REG), { ok: false, evidence: "一旦" });
eq("P4: 弱い語・登録を渡さない → 書く（ブレインの後で戻す）", preBrainMayWriteRegistered("一旦家賃12万で").ok, true);
eq("P4: 弱い語・登録が空 → 書く", preBrainMayWriteRegistered("とりあえず梅田で1Kで探してます", {}).ok, true);
eq("P4: 弱い語＋これからは → 書く", preBrainMayWriteRegistered("とりあえずこれからは1Kで", REG).ok, true);
eq("P4: 強い語は登録が無くても止める", preBrainMayWriteRegistered("今回だけ1階も見たいです").ok, false);
t("語の関数", weakTemporaryScopeCue("ひとまず西区で") === "ひとまず" && futurePermanentScopeCue("次から1Kで") !== null && permanentScopeCue("これからは徒歩10分") !== null && futurePermanentScopeCue("これから仕事なので") === null);

console.log("■ 戻す（弱い語は初めて入った列を残す）");
{
  const rows = [
    { changed_field: "rent_max", old_value: "80000", new_value: "120000", created_at: "2026-09-30T01:00:05Z" },
    { changed_field: "walk_minutes", old_value: null, new_value: "10", created_at: "2026-09-30T01:00:05Z" },
  ];
  const cur = { rent_max: 120000, walk_minutes: 10 };
  eq("強い語: 両方戻す", planScopeRevert(rows, cur, "2026-09-30T01:00:00Z").updates, { rent_max: 80000, walk_minutes: null });
  eq("弱い語: 元が空の列は残す", planScopeRevert(rows, cur, "2026-09-30T01:00:00Z", { keepNewFields: true }).updates, { rent_max: 80000 });
}

console.log("■ 階の読み（floorMinInText）");
eq("今回だけ1階も見たいです → 1", floorMinInText("今回だけ1階も見たいです"), 1);
eq("一度、一階のお部屋もお願いしたいです（本番）→ 1", floorMinInText("一度、一階のお部屋もお願いしたいです！"), 1);
eq("be73fa13 11階の部屋でもいい（本番）→ 1 にしない", floorMinInText("アーバネックス京町堀の11階の部屋でもいいなと考えてます！"), null);
eq("1階でも大丈夫 → 1", floorMinInText("1階でも大丈夫です"), 1);
eq("階数は問わない → 1", floorMinInText("階数は問わないです"), 1);
eq("1階以外（本番）→ 2", floorMinInText("家賃 120,000まで / 鉄筋or鉄骨 / 1階以外 / ガス火"), 2);
eq("3階以上が理想（本番）→ 3", floorMinInText("できればアパートではなく、マンション希望で、3階以上が理想です"), 3);
eq("二階以上 → 2", floorMinInText("二階以上エレベーター付"), 2);
eq("2階以上はエレベーター必須（その階の時だけの設備）→ null", floorMinInText("2階以上はエレベーター必須"), null);
eq("1階もOK と 2階以上が両方 → null（勝手に決めない）", floorMinInText("1階もOKだけど2階以上がいい"), null);
eq("階の話なし → null", floorMinInText("家賃8万で1K"), null);
eq("normFloorMin", [normFloorMin(1), normFloorMin("3"), normFloorMin(0), normFloorMin(31), normFloorMin(1.5), normFloorMin(null)], [1, 3, null, null, null, null]);
eq("floorMinLabel", [floorMinLabel(1), floorMinLabel(3), floorMinLabel(null)], ["1階も含める", "3階以上", null]);

console.log("■ 自由文の欄から階の希望を外す（判定の写しだけ）");
eq("バス・トイレ別、2階以上、独立洗面台", stripFloorWants("バス・トイレ別、2階以上、独立洗面台"), { text: "バス・トイレ別、独立洗面台", removed: ["2階以上"] });
eq("11階以上[必須]・眺め（本番の形）", stripFloorWants("バストイレ別、独立洗面台、2階以上・11階以上[必須]"), { text: "バストイレ別、独立洗面台", removed: ["2階以上", "11階以上[必須]"] });
eq("2階以上はエレベーター必須は残す", stripFloorWants("2階以上はエレベーター必須"), { text: "2階以上はエレベーター必須", removed: [] });
eq("NG の欄の「1階」", stripFloorWants("1階", "ng_points"), { text: null, removed: ["1階"] });
eq("階の話なし", stripFloorWants("南向き・角部屋"), { text: "南向き・角部屋", removed: [] });
eq("13階建（建物の説明）は外さない", stripFloorWants("13階建のマンション希望"), { text: "13階建のマンション希望", removed: [] });

console.log("■ 一時調整の形（search-override）");
{
  const ov1: SearchOverride = { ...OV0, floor_min: 1 };
  t("階だけの上書きは空でない", !isEmptyOverride(ov1) && isEmptyOverride({ ...OV0 }));
  eq("短い説明", overrideShortLabel(ov1), "1階も含める");
  t("画面の1行に1階も含める", overrideLine(ov1, { rent_max: 80000 }).includes("1階も含める"));
  const k0 = overrideRulerKey({ command_id: "c", override: { ...OV0, rent_max: 90000 } });
  const k1 = overrideRulerKey({ command_id: "c", override: { ...OV0, rent_max: 90000, floor_min: 1 } });
  t("物差しの鍵: 階があると別の物差し・無い行の鍵は旧のまま", k0 !== k1 && k0 === JSON.stringify(["", "", 90000, "", "", "", "", "", ""]));
  eq("関所: floor_min を残す", sanitizeSearchOverride({ floor_min: 1 })?.floor_min, 1);
  eq("関所: 範囲外は捨てる（空なら null）", [sanitizeSearchOverride({ floor_min: 0 }), sanitizeSearchOverride({ floor_min: 31 }), sanitizeSearchOverride({ floor_min: "x" })], [null, null, null]);
  eq("メモ「1階も含めて大正駅で検索」", (() => { const v = validateOverride(parseDeterministic("1階も含めて大正駅で検索"), "1階も含めて大正駅で検索"); return [v.override?.floor_min, v.override?.location?.stations]; })(), [1, ["大正"]]);
  eq("DeepSeek が文に無い階を言った → 落とす", (() => { const v = validateOverride({ is_search: true, floor_min: 3 }, "大正駅で検索"); return [v.override?.floor_min ?? null, v.dropped]; })(), [null, ["階 3（文に無い）"]]);
}

console.log("■ お客様の「今回だけ」→ その回だけの上書き（buildTemporaryOverride）");
{
  const r = buildTemporaryOverride("今回だけ1階も見たいです", { desired_area: "福島", floor_plan: "1K", rent_max: 80000 });
  eq("今回だけ1階も → floor_min=1 だけ", r.override, { ...OV0, floor_min: 1 });
  const r2 = buildTemporaryOverride("一旦家賃12万で探してもらえますか？", { desired_area: "福島", floor_plan: "1K", rent_max: 80000 });
  eq("一旦家賃12万で → 家賃の上限だけ", [r2.override?.rent_max, r2.override?.floor_min ?? null, r2.override?.location ?? null], [120000, null, null]);
  const r3 = buildTemporaryOverride("とりあえず福島区も見てみたいです", { desired_area: "野田", floor_plan: "1K", rent_max: 80000 });
  eq("とりあえず福島区も → 場所を足す", r3.override?.location, { mode: "add", stations: [], lines: [], areas: ["大阪市福島区"] });
}

console.log("■ 判定（その回だけ）: 登録の「2階以上」を外す／足す");
{
  const cust = { desired_area: "福島", floor_plan: "1K", rent_max: 80000, preferences: "バストイレ別、2階以上、独立洗面台", ng_points: "1階", other_requests: null };
  const c1 = overlayCustomerForOverride(cust, { ...OV0, floor_min: 1 });
  eq("写しのこだわり・NG から階を外す", [c1.preferences, c1.ng_points], ["バストイレ別、独立洗面台", null]);
  eq("元の条件は変えない", [cust.preferences, cust.ng_points], ["バストイレ別、2階以上、独立洗面台", "1階"]);
  const keys = (c: Record<string, unknown>) => parseEquipmentWants(c).wants.map((w) => w.key);
  t("登録のままなら設備の希望に floor2", keys(cust).includes("floor2"));
  t("1階も含める回は設備の希望に階が無い", !keys(c1).some((k) => k === "floor2" || k === "floor"), JSON.stringify(keys(c1)));
  const b = buildProfileWithOverride(cust, [], [], null, { ...OV0, floor_min: 1 });
  t("画像で確かめる希望から 2階以上 が消える", !b.profile.imageWants.includes("floor_2_plus") && b.overridden, JSON.stringify(b.profile.imageWants));
  const reg = buildProfileWithOverride(cust, [], [], null, null);
  t("上書きなしは 2階以上 を確かめる", reg.profile.imageWants.includes("floor_2_plus"));
  const c3 = overlayCustomerForOverride({ ...cust, preferences: "南向き", ng_points: null }, { ...OV0, floor_min: 3 });
  eq("3階以上（その回だけ）を足す", c3.preferences, "南向き、3階以上");
}

console.log("■ 当たり外れの物差し（labelScopeOutcome）");
{
  const at = "2026-09-30T01:00:00Z";
  eq("人が直して戻した → temporary", labelScopeOutcome(at, { history: [
    { changed_field: "rent_max", old_value: "80000", new_value: "120000", created_at: "2026-09-30T02:00:00Z", source_message_id: "screen_edit" },
    { changed_field: "rent_max", old_value: "120000", new_value: "80000", created_at: "2026-09-30T20:00:00Z", source_message_id: "screen_edit" },
  ], overrideAt: [], staffTexts: [] }).truth, "temporary");
  eq("人が直したまま → permanent", labelScopeOutcome(at, { history: [{ changed_field: "floor_plan", old_value: "1K", new_value: "1LDK", created_at: "2026-09-30T02:00:00Z", source_message_id: "screen_edit:abc" }], overrideAt: [], staffTexts: [] }).truth, "permanent");
  eq("P4 の自動の書き込みは物差しにしない", labelScopeOutcome(at, { history: [{ changed_field: "floor_plan", old_value: "1K", new_value: "1LDK", created_at: "2026-09-30T01:00:10Z", source_message_id: "p4:abc" }], overrideAt: [], staffTexts: [] }).truth, "unknown");
  eq("メモの一時調整で検索 → temporary", labelScopeOutcome(at, { history: [], overrideAt: ["2026-09-30T03:00:00Z"], staffTexts: [] }).truth, "temporary");
  eq("返事「ひとまず」（本番 d99ab7e6）→ temporary", labelScopeOutcome(at, { history: [], overrideAt: [], staffTexts: [{ text: "かしこまりました！！ / ひとまず大阪市内から家賃5万円台のお部屋ピックアップさせていただきます！！", created_at: "2026-09-30T01:05:00Z" }] }).truth, "temporary");
  eq("返事「条件に加え」（本番 1de819c9）→ permanent", labelScopeOutcome(at, { history: [], overrideAt: [], staffTexts: [{ text: "浪速区から広めのワンルームもご条件に加え初期費用抑えられるお部屋ピックアップさせていただきます！！", created_at: "2026-09-30T01:05:00Z" }] }).truth, "permanent");
  eq("返事「引き続き全力でサポート」だけ → unknown（決め手にしない）", labelScopeOutcome(at, { history: [], overrideAt: [], staffTexts: [{ text: "引き続き全力でサポートさせて頂きます😊", created_at: "2026-09-30T01:05:00Z" }] }).truth, "unknown");
  eq("24時間より後の返事は見ない", labelScopeOutcome(at, { history: [], overrideAt: [], staffTexts: [{ text: "ひとまず西区から", created_at: "2026-10-02T01:05:00Z" }] }).truth, "unknown");
  const s = scoreScopeDecisions([
    { scope: "temporary", by: "text_temporary", truth: "temporary" },
    { scope: "permanent", by: "default", truth: "temporary" },
    { scope: "temporary", by: "text_temporary_weak", truth: "permanent" },
    { scope: "permanent", by: "default", truth: "unknown" },
    { scope: "none", by: "brain", truth: "permanent" },
  ]);
  eq("数える（unknown・none は数えない）", [s.n, s.hit, s.wrongPermanent, s.wrongTemporary, s.byRule.default], [3, 1, 1, 1, { n: 1, hit: 0 }]);
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
