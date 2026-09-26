// app/lib/__tests__/search-override.test.ts
// 2026-09-27 竹内「メモ欄に条件を送ったら、それに連動して検索。『大正駅で検索する』なら駅は大正駅だけ、『1LDKで検索する』なら1LDK。
//   拡張ツールの一時調整の部分で合わせる形。DeepSeek の物件検索 AI が要約して拡張ツールに渡す」
// 文は本番のメモ・お客様の条件の書き方（2026-09-27 の点検で DeepSeek に当てた物）と竹内さんの例。
// 実行: npx tsx app/lib/__tests__/search-override.test.ts（全 PASS で exit 0）
import { looksLikeSearchInstruction, overrideLine, isEmptyOverride, maskMemoPii, parseModelJson, buildUserContent, SEARCH_OVERRIDE_SYSTEM_PROMPT, type RegisteredConditions } from "../search-override";
import { parseDeterministic, validateOverride, sanitizeSearchOverride, layoutsInText, moneyInText } from "../search-override-read";
import { buildWebBrainCommands } from "../web-brain-search";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) => t(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const REG: RegisteredConditions = { desired_area: "大正区・西区", area_mode: "ward", rent_max: 75000, floor_plan: "1K〜1DK" };
const det = (s: string, reg: RegisteredConditions | null = REG) => validateOverride(parseDeterministic(s, reg), s, reg);

console.log("── きっかけ語（DeepSeek を呼ぶかの入口）");
for (const s of ["大正駅で検索する", "1LDKで検索する", "家賃8万までで広げて", "itandi で", "レインズで条件入れて", "西区で1Kか1DK、6万から7万で", "ピンポイントでもう一回検索して", "大正駅で検索したい"]) t(`指示: ${s}`, looksLikeSearchInstruction(s));
for (const s of ["オススメ理由は？", "明日10時に内覧予定", "送った物件の反応待ち", "大正駅で検索した", "大正駅で検索済み", "", "物件確認した"]) t(`メモ: ${s || "(空)"}`, !looksLikeSearchInstruction(s));

console.log("── 竹内さんの例（決定論の読み）");
{
  const r = det("大正駅で検索する");
  eq("大正駅だけ（駅・only）", r.override?.location, { mode: "only", stations: ["大正"], lines: [], areas: [] });
  eq("書かれていない間取り・家賃は null（登録のまま）", [r.override?.floor_plan, r.override?.rent_max], [null, null]);
  eq("1行", overrideLine(r.override, REG), "🔍 大正駅だけ・間取りは登録のまま（1K〜1DK）・家賃は登録のまま（〜7.5万）・リアプロ・ピンポイント で検索します");
}
{
  const r = det("1LDKで検索する");
  eq("1LDK だけ・場所は null", [r.override?.floor_plan, r.override?.location], ["1LDK", null]);
  t("1行に「場所は登録のまま」", overrideLine(r.override, REG).includes("場所は登録のまま（大正区・西区）"));
}
{
  const r = det("家賃8万までで広げて");
  eq("家賃の上限 8万（円）・広げては家賃にかかる＝範囲は null", [r.override?.rent_max, r.override?.is_wide], [80000, null]);
}
eq("itandi で → サイトだけ", det("itandi で").override?.site, "itandi");
eq("レインズで条件入れて → reins", det("レインズで条件入れて").override?.site, "reins");
eq("家賃を1万上げて → 登録 7.5万 + 1万", det("家賃を1万上げて検索").override?.rent_max, 85000);
eq("家賃5千円下げて → 7万", det("家賃5千円下げて検索").override?.rent_max, 70000);
eq("7万5千まで2DK", [det("7万5千まで2DKで検索").override?.rent_max, det("7万5千まで2DKで検索").override?.floor_plan], [75000, "2DK"]);
eq("難波駅も追加 → add", det("難波駅も追加して検索").override?.location?.mode, "add");
eq("御堂筋線沿い・1LDK以上・広げて", (() => { const o = det("御堂筋線沿いで1LDK以上 広げて検索").override; return [o?.location?.lines, o?.floor_plan, o?.is_wide]; })(), [["御堂筋線"], "1LDK以上", true]);
eq("徒歩10分・築20年", (() => { const o = det("徒歩10分以内、築20年以内で検索お願い").override; return [o?.walk_minutes, o?.building_age]; })(), [10, 20]);
t("「大正区以外」は場所を入れない（unclear）", det("大正区以外で検索").override?.location == null && det("大正区以外で検索").unclear.length > 0);
t("「梅田まで一本」は検索の駅にしない", det("梅田まで一本で検索").override?.location == null);
eq("吹田市で広げて", (() => { const o = det("吹田市で広げて検索").override; return [o?.location?.areas, o?.is_wide]; })(), [["吹田市"], true]);
eq("阪急京都線の「京都」を駅にしない", det("阪急京都線で検索").override?.location?.stations, []);

console.log("── DeepSeek の答えを文の根拠で絞る（validateOverride）");
{
  const memo = "大正駅で検索する";
  const raw = { is_search: true, location: { mode: "only", stations: ["大正", "芦原橋"], lines: [], areas: ["大正区"] }, floor_plan: "1LDK", rent_max_man: 8, rent_min_man: null, walk_minutes: 10, building_age: null, area_min: null, area_max: null, pet: true, site: "itandi", scope: "wide", unclear: [] };
  const r = validateOverride(raw, memo, REG);
  eq("文に無い駅・区は落とす", r.override?.location, { mode: "only", stations: ["大正"], lines: [], areas: [] });
  eq("文に無い間取り・家賃・徒歩・ペット・サイト・範囲は落とす", [r.override?.floor_plan, r.override?.rent_max, r.override?.walk_minutes, r.override?.pet, r.override?.site, r.override?.is_wide], [null, null, null, null, null, null]);
  t("落とした物を残す（画面に出す）", r.dropped.length >= 6, r.dropped.join("/"));
}
{
  // 本番の条件の文で DeepSeek が「茨木」「豊中」を地域に入れた → 文の中では駅なので駅にする
  const memo = "茨木、豊中、2K、2万までで検索して";
  const raw = { is_search: true, location: { mode: "only", stations: [], lines: [], areas: ["茨木", "豊中"] }, floor_plan: "2K", rent_max_man: 2, unclear: [] };
  eq("区・市でない名前は文の中の駅に直す", validateOverride(raw, memo, null).override?.location?.stations, ["茨木", "豊中"]);
}
{
  const memo = "大阪市内、2LDK〜、12万までで検索して";
  const raw = { is_search: true, location: { mode: "only", stations: [], lines: [], areas: ["大阪市"] }, floor_plan: "2LDK", rent_max_man: 12, unclear: [] };
  const r = validateOverride(raw, memo, null);
  eq("「2LDK〜」は以上", r.override?.floor_plan, "2LDK以上");
  t("「大阪市」は表に無い → 場所は入れない・落とした物に出す", r.override?.location == null && r.dropped.some((d) => d.includes("大阪市")));
}
{
  const memo = "市内に電車で30分以内で行ける距離、1K、6万までで検索して";
  const raw = { is_search: true, location: null, floor_plan: "1K", rent_max_man: 6, walk_minutes: 30, unclear: [] };
  eq("電車の30分を徒歩にしない", validateOverride(raw, memo, null).override?.walk_minutes, null);
}
{
  const memo = "家賃を1万上げて検索";
  const raw = { is_search: true, location: null, rent_max_man: 8.5, unclear: [] };
  eq("差分は登録の上限±文の数字なら通す", validateOverride(raw, memo, REG).override?.rent_max, 85000);
  eq("登録が無ければ差分は通さない", validateOverride(raw, memo, null).override?.rent_max, null);
}
eq("「追加」の語が無い add は only に", validateOverride({ is_search: true, location: { mode: "add", stations: ["大正"], lines: [], areas: [] } }, "大正駅で検索", REG).override?.location?.mode, "only");
eq("is_search=false はメモ", validateOverride({ is_search: false }, "大正駅で検索した", REG).is_search, false);
eq("答えが無い（null）はメモ扱い", validateOverride(null, "x", REG).is_search, false);

console.log("── DeepSeek の答えの読み取り");
t("前後に ``` があっても読む", parseModelJson("```json\n{\"is_search\":true}\n```")?.is_search === true);
t("is_search が無い形は読まない（読み直しの合図）", parseModelJson("{\"x\":1}") === null);
t("崩れた JSON は null", parseModelJson("{is_search:") === null);

console.log("── 個人情報・キャッシュの形");
eq("電話とメールを伏せる", maskMemoPii("090-1234-5678 a@b.jp 大正駅で検索"), "＊＊＊ ＊＊＊ 大正駅で検索");
{
  const u = buildUserContent("大正駅で検索する", { ...REG, ...({ customer_name: "山田", phone: "09012345678" } as object) } as RegisteredConditions);
  t("材料に名前・電話が入らない", !u.includes("山田") && !u.includes("0901234"));
  t("材料は後ろ・前置きは固定（毎回同じ文字）", !SEARCH_OVERRIDE_SYSTEM_PROMPT.includes("大正駅で検索する") && u.includes("【メモ】"));
}

console.log("── 間取り・金額の読み");
eq("1L → 1LDK・ワンルーム → 1R", layoutsInText("1Lかワンルーム"), ["1LDK", "1R"]);
eq("8万5千・85000円・5千", moneyInText("8万5千 85000円 5千円").sort(), [0.5, 8.5]);

console.log("── 積む前の関所（sanitizeSearchOverride）");
{
  const ok = sanitizeSearchOverride({ v: 1, location: { mode: "only", stations: ["大正", "存在しない駅"], lines: ["御堂筋線"], areas: ["大正区", "<script>"] }, floor_plan: "1LDK", rent_max: 80000, rent_min: 90000, walk_minutes: 99, pet: true, site: "itandi", is_wide: true, extra: "x" });
  eq("知らない駅・区・範囲外は捨てる", ok, { v: 1, location: { mode: "only", stations: ["大正"], lines: ["御堂筋線"], areas: ["大阪市大正区"] }, floor_plan: "1LDK", rent_max: 80000, rent_min: null, walk_minutes: null, building_age: null, area_min: null, area_max: null, pet: true, site: "itandi", is_wide: true });
  eq("形の違う間取りは捨てる", sanitizeSearchOverride({ floor_plan: "1LDK; drop table" }), null);
  eq("何も無ければ null", sanitizeSearchOverride({ site: "itandi" }), null);
  eq("配列でも null", sanitizeSearchOverride([1]), null);
  t("isEmptyOverride(null)", isEmptyOverride(null));
}

console.log("── 積む行（payload.search_override）");
{
  const ov = sanitizeSearchOverride({ location: { mode: "only", stations: ["大正"], lines: [], areas: [] } })!;
  const { rows } = buildWebBrainCommands([{ id: "c1", rp_update_days: 3 }], "realnetpro", false, { searchOverride: ov });
  eq("web_brain の payload に上書きが入る", rows[0].payload, { source: "web_brain", is_wide: false, rp_update_days: 3, search_override: ov });
  const { rows: r2 } = buildWebBrainCommands([{ id: "c1", rp_update_days: 3 }], "realnetpro", false, {});
  t("上書きが無ければ payload は今まで通り", !("search_override" in r2[0].payload));
  const { rows: r3, skipped } = buildWebBrainCommands([{ id: "c1" }], "realnetpro", false, { searchOverride: ov, queued: new Set(["c1::realnetpro"]) });
  t("同じ回が走っていれば積まない（上書きがあっても）", r3.length === 0 && skipped.length === 1);
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
