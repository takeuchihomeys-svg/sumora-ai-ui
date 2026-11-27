// app/lib/__tests__/search-condition-view.test.ts — 検索の見立て（#820 案A・記録だけ・2026-11-27 作業員A）
//   実行: npx tsx app/lib/__tests__/search-condition-view.test.ts
//   文は本番の会話の言い方（お客様の名前・物件名は入れない）
import { rentBasisOf, fieldStrengthsOf, buildSearchConditionView, inclusiveRentRisk, searchConditionViewOn } from "../search-condition-view";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

t("駐車場と併せて13万＝駐車場込み 13万", (() => { const r = rentBasisOf(["②ご希望家賃（管理費込み）\n駐車場と併せて13万円（駐車場は近隣でも可）"]); return r?.basis === "with_parking" && r.amountMan === 13; })());
t("共益費込みで家賃15万＝管理費込み 15万", (() => { const r = rentBasisOf(["条件を変えて、共益費込みで家賃15万の物件もご紹介いただけますか？"]); return r?.basis === "with_fee" && r.amountMan === 15; })());
t("フォームの欄「ご希望家賃（管理費込み）」の答え 9〜12万＝管理費込み 12万（上の端）", (() => { const r = rentBasisOf(["②ご希望家賃（管理費込み）\n9〜12万円\n③ご希望間取り"]); return r?.basis === "with_fee" && r.amountMan === 12 && r.from === "form_label"; })());
t("込みの言い方が無ければ null", rentBasisOf(["②5〜7\n③1LDK", "家賃は8万までで"]) === null);
t("新しい通が優先", rentBasisOf(["共益費込みで12万", "駐車場と併せて14万で"])?.basis === "with_parking");

const st = fieldStrengthsOf(["できれば新築がいいです", "家賃は絶対10万以内でお願いします", "駅から10分以上でも大丈夫です"]);
t("強さ: 築はできれば・家賃は絶対・徒歩はでも大丈夫", st.find((x) => x.field === "age")?.strength === "soft" && st.find((x) => x.field === "rent")?.strength === "must" && st.find((x) => x.field === "walk")?.strength === "soft");
t("強さの言葉が無い文は数えない", fieldStrengthsOf(["1LDKで探しています"]).length === 0);

const v = buildSearchConditionView({ customerTexts: ["駐車場と併せて13万円（駐車場は近隣でも可）"], rentMaxYen: 130000, nowIso: "2026-11-27T00:00:00Z" });
t("込みの金額をそのまま家賃の上限に（差 0）＝疑いあり", v.rentGapMan === 0 && inclusiveRentRisk(v));
t("上限が込みの分だけ下がっていれば疑いなし", !inclusiveRentRisk(buildSearchConditionView({ customerTexts: ["駐車場と併せて13万円"], rentMaxYen: 110000, nowIso: "x" })));
t("既定 off", !searchConditionViewOn({}) && searchConditionViewOn({ SEARCH_CONDITION_VIEW: "on" }));
const ai = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "aix-action-items.ts"), "utf8");
t("配線: on の時だけ・命令の payload.search_view に（新しい命令・未着手の命令の両方）・検索の欄は変えない", ai.includes("sv.searchConditionViewOn()") && (ai.match(/search_view: searchView/g) ?? []).length === 2);
console.log(`search-condition-view: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
