// app/lib/__tests__/pii-alt-names.test.ts
// 2026-10-20 決定 209b9a92: 表示名しか伏せていなかった DeepSeek の経路（要約・戦略・調べる係・好みの学習・条件の要約・メモ・画面の見張り）に
//   当事者の呼び名・登録名・他のお客様の呼び名の伏せを足す（buildAltNameMask・maskPIIForAlt・maskWatchText の aliases）。
//   名前は作った例（実在のお客様ではない）。駅名・物件名を壊さない事を一緒に確かめる。
// 実行: npx tsx app/lib/__tests__/pii-alt-names.test.ts（全 PASS で exit 0）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAltNameMask, maskPIIForAlt, maskPII } from "../pii-mask";
import { maskWatchText } from "../screen-watch";
import { memoLlmMessages } from "../customer-memo";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

console.log("── buildAltNameMask の線");
{
  const m = buildAltNameMask(["🎀"], ["さやか", "日野", "R"], ["たかはし", "あ", "🍀🍀"]);
  t("当事者の3字以上は裸で伏せる名前に入る", m.names.includes("さやか"));
  t("当事者の短い名前は裸の名前に入らない（駅名を壊さない）", !m.names.includes("日野") && !m.names.includes("R"));
  t("当事者の短い名前は敬称つきの束に入る", m.shortNames.includes("日野") && m.shortNames.includes("R"));
  t("他のお客様の呼び名は3字以上で名前の字がある物だけ", m.names.includes("たかはし") && !m.names.includes("あ") && !m.names.includes("🍀🍀"));
  t("他のお客様の短い呼び名は敬称の束にも入らない", !m.shortNames.includes("あ"));
  t("base（今まで渡していた表示名）はそのまま", m.names.includes("🎀"));
}

console.log("── maskPIIForAlt");
{
  const m = buildAltNameMask(["🎀"], ["さやか", "日野"], ["たかはし"]);
  const out = maskPIIForAlt("さやかさん、日野駅の物件です。日野さんにもお伝えします。たかはしさんの件", m);
  t("当事者の呼び名が残らない", !out.includes("さやか"), out);
  t("短い当事者名は敬称つきだけ伏せる（日野駅は残る）", out.includes("日野駅") && !out.includes("日野さん"), out);
  t("他のお客様の呼び名が残らない", !out.includes("たかはし"), out);
  const plain = "石川町駅 徒歩5分 家賃8.5万円 2LDK";
  t("物件・駅・家賃は変わらない", maskPIIForAlt(plain, m) === maskPII(plain, ["🎀"]), maskPIIForAlt(plain, m));
  t("空の文は空のまま", maskPIIForAlt("", m) === "");
}

console.log("── 足した名前は境目つき（物件名の中に当てない・確かめる人 2026-10-20）");
{
  const m = buildAltNameMask(["🎀"], ["Lisa", "みどり", "日野 太郎"], ["Bay", "ひかり"]);
  const props = "Lisaです。パークヒルズ天保山Bay・La CLisa駒川中野・プレジオみどり夙川・ひかり荘・日野駅 徒歩5分";
  const out = maskPIIForAlt(props, m);
  t("文の頭の英字の呼び名は伏せる", out.startsWith("お客様です"), out);
  t("英字の名前が物件名の英字・漢字に続く所は伏せない", out.includes("天保山Bay") && out.includes("CLisa駒川"), out);
  t("かなの名前がカタカナ・漢字に挟まる所は伏せない", out.includes("プレジオみどり夙川") && out.includes("ひかり荘"), out);
  t("登録名の姓（2字）を駅名に当てない", out.includes("日野駅"), out);
  const named = maskPIIForAlt("日野です。太郎より。Bayさん・ひかりさんにも", m);
  t("登録名の姓・名は境目があれば伏せる", !named.includes("日野") && !named.includes("太郎"), named);
  const joined = maskPIIForAlt("氏名\n日野太郎\nヒノタロウ", m);
  t("登録名を続けて書いた形も伏せる", !joined.includes("日野") && !joined.includes("太郎"), joined);
  t("他のお客様の呼び名は敬称つきなら伏せる", !named.includes("Bay") && !named.includes("ひかり"), named);
  t("base（表示名）は今まで通り maskPII", maskPIIForAlt("田中花子さん", buildAltNameMask(["田中花子"], [], [])) === maskPII("田中花子さん", ["田中花子"]));
}

console.log("── maskWatchText の aliases（画面の見張り）");
{
  const out = maskWatchText("待ち: さやかさん・リアプロ 日野駅 検索結果 12件", { names: ["山田花子"], aliases: ["さやか", "日野"], otherNames: ["たかはし"] });
  t("当事者の呼び名を伏せる", !out.includes("さやか"), out);
  t("短い別名を裸で置換しない（日野駅が残る）", out.includes("日野駅"), out);
  const none = maskWatchText("日野駅 検索結果 12件", { names: [] });
  t("名前が無い時は今まで通り", none === "日野駅 検索結果 12件", none);
  const onlyAlias = maskWatchText("さやかさんの検索", { names: [], aliases: ["さやか"] });
  t("登録名が無くても別名だけで伏せる", !onlyAlias.includes("さやか"), onlyAlias);
}

console.log("── memoLlmMessages の mask（メモの DeepSeek）");
{
  const msgs = [{ sender: "customer", text: "さやかです、日野駅が良いです", createdAt: "2026-10-20T00:00:00Z" }];
  const m = buildAltNameMask(["🎀"], ["さやか"], []);
  const a = memoLlmMessages(msgs as never, ["🎀"], (s) => maskPIIForAlt(s, m));
  const at = String(a[0]?.text ?? "");
  t("mask を渡すと呼び名も伏せる", !at.includes("さやか") && at.includes("日野駅"), at);
  const b = memoLlmMessages(msgs as never, ["🎀"]);
  const bt = String(b[0]?.text ?? "");
  t("mask が無ければ今まで通り（表示名だけ）", bt === maskPII("さやかです、日野駅が良いです", ["🎀"]), bt);
}

console.log("── 配線（DeepSeek の経路だけ・Claude の経路は今のまま）");
{
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const bc = src("app/lib/brain-core.ts");
  t("要約（checkpoint）: DeepSeek に回る時だけ足す・Claude は maskPII(userContent, [customerName]) のまま",
    /cpRoutesAlt\s*\n?\s*\?\s*maskPIIForAlt\(userContent, await loadAltNameMask\(conversationId, \[customerName\]\)\)\s*\n?\s*:\s*maskPII\(userContent, \[customerName\]\)/.test(bc));
  t("戦略（strategy）: DeepSeek に回る時だけ足す・Claude は maskPII(userText, [customerName]) のまま",
    /strategyRoutesAlt\s*\n?\s*\?\s*maskPIIForAlt\(userText, await loadAltNameMask\(conversationId, \[customerName\]\)\)\s*\n?\s*:\s*maskPII\(userText, \[customerName\]\)/.test(bc));
  t("要約の振り分けは willRouteAlt と線の印（blocked は Claude）", /willRouteAlt\("brain_checkpoint"\) && cpCutoffHeader\[LLM_CUTOFF_HEADER\] !== "blocked"/.test(bc));
  t("戦略の振り分けは willRouteAlt（申込以降は回さない）", /willRouteAlt\("brain_strategy", \{ postApply: isPostApplyStatus\(conv\.status as string \| null\) \}\)/.test(bc));
  t("調べる係", /maskPIIForAlt\(o\.customerText, await loadAltNameMask\(o\.conversationId/.test(src("app/lib/brain-researcher-server.ts")));
  const pl = src("app/lib/customer-pref-learning-server.ts");
  t("好みの学習: 3か所とも altMaskFor（maskPII の素の名前だけは残らない）", (pl.match(/altMaskFor\(/g) ?? []).length >= 3 && !/maskPII\(s, \[c\??\.customerName\]\)/.test(pl));
  t("条件の要約", /maskClause\(maskPIIForAlt\(x, altMask\)\)/.test(src("app/lib/condition-summary-server.ts")));
  t("メモ", /memoLlmMessages\(msgs, \[c\.customer_name\], \(s\) => maskPIIForAlt\(s, altMask\)\)/.test(src("app/lib/customer-memo-server.ts")));
  const sw = src("app/lib/screen-watch-server.ts");
  t("画面の見張り: 画面の文・お客様の言葉の両方", /aliases, otherNames \}\);/.test(sw) && /customerWords\(sb, pcid, names, \{ aliases, otherNames \}\)/.test(sw));
  t("分類の影（Jev）: 呼び名と別名を仮名化へ", /knownNames: \[\.\.\.names, \.\.\.callNames\], partyAliases/.test(src("app/lib/condition-classify-shadow-server.ts")));
  t("穴の見張りの報告", (src("app/lib/brain-gap-finder-server.ts").match(/maskOf\(/g) ?? []).length >= 2);
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
