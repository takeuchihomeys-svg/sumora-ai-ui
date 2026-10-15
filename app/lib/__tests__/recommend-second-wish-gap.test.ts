// AIX【物件オススメ】の2通目の型（希望とのずれ・好条件）の材料（2026-10-15 竹内悠馬・KAORI さんの実送信）
// 実行: npx tsx app/lib/__tests__/recommend-second-wish-gap.test.ts
import { resolveWishAreaGap, rentTotalOfFirst, planOfFirst, cheapVsMarket, buildSecondWishGapNote, stationsInFirstMessage, secondWishGapEnabled, ensureWishGapOpening } from "../recommend-second-wish-gap";

let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };

const KAORI_FIRST = "🌟グランノーブルⅡ 203\n\n\n（オススメポイント）\n・家賃68,000円・管理費7,700円（合計75,700円）\n・間取り：2LDK（リビング10.3帖、洋室6帖・洋室5.3帖）\n・2019年9月築で築年数浅く\n・ペット共生マンション飼育可能\n・インターネット無料（NURO光）";

// 1通目に駅が無い・資料の読みだけ四条畷（実際は瓢箪山）→ 名前は書かない・エリアから外れる形
{
  const r = resolveWishAreaGap({ desiredArea: "布施・八戸の里", firstMessage: KAORI_FIRST, savedReadStations: [{ station: "四条畷", walk: 15 }] });
  t("KAORI: 読みだけの駅 → エリアの形（駅の名前は書かない）", r.gap?.kind === "area" && r.gap.area === "布施・八戸の里", r);
}
// 1通目に駅がある（スタッフが確かめた）→ 駅の名前の形
{
  const first = KAORI_FIRST + "\n・近鉄奈良線「瓢箪山」駅徒歩6分";
  const r = resolveWishAreaGap({ desiredArea: "布施・八戸の里", firstMessage: first });
  t("1通目に希望の外の駅 → 最寄り駅の形", r.gap?.kind === "station" && r.gap.station === "瓢箪山", r);
}
// 希望の駅そのもの → ずれなし
{
  const r = resolveWishAreaGap({ desiredArea: "布施・八戸の里", firstMessage: "🌟A 101\n・近鉄奈良線「八戸ノ里」駅徒歩5分" });
  t("希望の駅 → ずれなし", r.gap === null && r.reason === "in_area", r);
}
// どれか1つでも希望の中 → ずれと言わない
{
  const r = resolveWishAreaGap({ desiredArea: "布施・八戸の里", firstMessage: "🌟A 101\n・近鉄奈良線「八戸ノ里」駅徒歩5分", savedReadStations: [{ station: "四条畷", walk: 15 }] });
  t("出どころの1つが希望の中 → ずれなし", r.gap === null, r);
}
// 希望の駅の隣（HONOKA さん: 希望 新大阪・東三国 → 江坂）→ 竹内さんは「最寄り江坂駅となりますが」
{
  const first = "🌟ファーストフィオーレ江坂垂水町Ⅱ 203号室\n\n（オススメポイント）\n・家賃80,000円・共益費10,000円（合計90,000円）\n・間取り：1DK（ダイニング5.5帖、洋室3.7帖）\n・北大阪急行電鉄「江坂」徒歩12分";
  const r = resolveWishAreaGap({ desiredArea: "新大阪、東三国", firstMessage: first, savedReadStations: [{ station: "江坂", walk: 12 }] });
  t("希望の駅の隣 → 最寄り駅の形（江坂）", r.gap?.kind === "station" && r.gap.station === "江坂", r);
  t("共益費の合計", rentTotalOfFirst(first) === 90000);
}
// 駅が読めない → 決めない
t("駅が無い → ずれなし", resolveWishAreaGap({ desiredArea: "布施・八戸の里", firstMessage: KAORI_FIRST }).gap === null);
t("希望が空 → ずれなし", resolveWishAreaGap({ desiredArea: "", firstMessage: KAORI_FIRST, savedReadStations: [{ station: "四条畷", walk: 15 }] }).gap === null);
// 売上サポの照らしが FAR・駅がある → 駅の名前
{
  const r = resolveWishAreaGap({ desiredArea: "布施・八戸の里", firstMessage: KAORI_FIRST, materialStations: [{ station: "瓢箪山", walk: 6 }], materialAreaCode: "AREA_FAR" });
  t("売上サポの行の駅 → 最寄り駅の形", r.gap?.kind === "station" && r.gap.station === "瓢箪山", r);
}

t("合計の家賃（合計）", rentTotalOfFirst(KAORI_FIRST) === 75700);
t("合計の家賃（家賃＋管理費）", rentTotalOfFirst("・家賃68,000円・管理費7,700円") === 75700);
t("合計の家賃（家賃管理費込）", rentTotalOfFirst("家賃管理費込81,000円の1LDK") === 81000);
t("家賃だけ・管理費不明 → 決めない", rentTotalOfFirst("・家賃68,000円") === null);
t("間取り", planOfFirst(KAORI_FIRST) === "2LDK");
t("1通目の駅", JSON.stringify(stationsInFirstMessage("・近鉄大阪線「河内山本」駅徒歩15分\n・江坂駅徒歩5分")) === JSON.stringify([{ station: "河内山本", walk: 15 }, { station: "江坂", walk: 5 }]), stationsInFirstMessage("・近鉄大阪線「河内山本」駅徒歩15分\n・江坂駅徒歩5分"));

const band = { plan: "2LDK" as const, n: 33, p25: 82000, p50: 94000, p75: 104000, lo: 8, hi: 10.5, nWithinBudget: null, sayable: true };
t("相場の下25%以下 → 好条件", cheapVsMarket(75700, band));
t("相場の中央 → 言わない", !cheapVsMarket(90000, band));
t("件数が足りない → 言わない", !cheapVsMarket(60000, { ...band, sayable: false }));

{
  const note = buildSecondWishGapNote({ gap: { kind: "area", area: "布施・八戸の里" }, rentTotal: 75700, cheap: true, name: "YUMA" });
  t("注記: エリアの形・合計・好条件", /布施・八戸の里から少し外れますがこちらのお部屋如何でしょうか/.test(note) && /家賃管理費込75,700円/.test(note) && /好条件で/.test(note), note);
  const n2 = buildSecondWishGapNote({ gap: null, rentTotal: 75700, cheap: false });
  t("注記: ずれも相場も無い → 空", n2 === "");
  const n3 = buildSecondWishGapNote({ gap: { kind: "station", station: "瓢箪山", area: "布施・八戸の里" }, rentTotal: null, cheap: false });
  t("注記: 駅の形・相場は書かない", /最寄り駅瓢箪山駅となりますが/.test(n3) && /相場の事.*書かない/.test(n3), n3);
}
{
  const g = { kind: "station" as const, station: "江坂", area: "新大阪、東三国" };
  const a = ensureWishGapOpening("こちらのお部屋如何でしょうか😊！！\n最寄り駅江坂駅となりますが、2025年8月築で築年数浅く、YUMAさんにかなりオススメ出来るお部屋となります！！\nお手隙の際にご査収ください😌！！", g);
  t("出口: 途中のずれを外し書き出しをずれの1行に（絵文字はそのまま）", a.text === "最寄り駅江坂駅となりますがこちらのお部屋如何でしょうか😊！！\n2025年8月築で築年数浅く、YUMAさんにかなりオススメ出来るお部屋となります！！\nお手隙の際にご査収ください😌！！" && a.applied === "moved", a);
  const b = ensureWishGapOpening("こちらのお部屋如何でしょうか😊！！\n2025年8月築・角部屋で、YUMAさんにかなりオススメ出来るお部屋となります！！", g);
  t("出口: 書かなかった → 書き出しを替える", /^最寄り駅江坂駅となりますがこちらのお部屋如何でしょうか😊！！\n2025/.test(b.text) && b.applied === "replaced", b);
  const c = ensureWishGapOpening("最寄り駅江坂駅となりますがこちらのお部屋如何でしょうか！！\n2025年8月築", g);
  t("出口: 書き出しにある → そのまま", c.applied === null);
  const d = ensureWishGapOpening("お世話になっております！！\n2025年8月築で、かなりオススメ出来るお部屋となります！！", g);
  t("出口: 書き出しの形が無い → 挨拶の次に足す", d.text.split("\n")[1] === "最寄り駅江坂駅となりますがこちらのお部屋如何でしょうか！！" && d.applied === "inserted", d);
  const e = ensureWishGapOpening("YUMAさんこちらのお部屋如何でしょうか！！\n\n布施・八戸の里から少し外れますが、家賃管理費込75,700円", { kind: "area", area: "布施・八戸の里" });
  t("出口: 名前つきの書き出し・エリアの形", e.text === "布施・八戸の里から少し外れますがこちらのお部屋如何でしょうか！！\n\n家賃管理費込75,700円", e);
  t("出口: ずれ無し → 触らない", ensureWishGapOpening("abc", null).applied === null);
}
// レビュー 10/16: 誤爆・書き出しの直し
{
  const st = (s: string) => `🌟A\n・「${s}」駅徒歩6分`;
  t("レビュー: 東大阪市×瓢箪山（市の中・駅の市が表に無い）→ 外れと言わない", resolveWishAreaGap({ desiredArea: "東大阪市", firstMessage: st("瓢箪山") }).gap === null);
  t("レビュー: 堺市×中百舌鳥 → 外れと言わない", resolveWishAreaGap({ desiredArea: "堺市", firstMessage: st("中百舌鳥") }).gap === null);
  t("レビュー: 豊中市×服部天神 → 外れと言わない", resolveWishAreaGap({ desiredArea: "豊中市", firstMessage: st("服部天神") }).gap === null);
  t("レビュー: 売上サポの照らし AREA_CLOSE だけでは外れと言わない", resolveWishAreaGap({ desiredArea: "東大阪市", firstMessage: KAORI_FIRST, materialAreaCode: "AREA_CLOSE" }).gap === null);
  t("レビュー: 大阪市内×江坂（吹田市）→ 外れ", resolveWishAreaGap({ desiredArea: "大阪市内", firstMessage: st("江坂") }).gap?.kind === "station");
  const A = { kind: "area" as const, area: "布施・八戸の里" };
  const S = { kind: "station" as const, station: "瓢箪山", area: "布施・八戸の里" };
  const a = ensureWishGapOpening("最寄り駅四条畷駅となりますがこちらのお部屋如何でしょうか😊！！\n2019年9月築", A);
  t("レビュー: エリアの形なのに駅の名前（読みの四条畷）→ エリアの形に替える", a.text === "布施・八戸の里から少し外れますがこちらのお部屋如何でしょうか😊！！\n2019年9月築" && a.applied === "corrected", a);
  const b = ensureWishGapOpening("最寄り駅河内山本駅となりますがこちらのお部屋如何でしょうか！！\n2019年9月築", S);
  t("レビュー: 違う駅 → 決めた駅に替える", b.text.startsWith("最寄り駅瓢箪山駅となりますが") && !/河内山本/.test(b.text), b);
  const c = ensureWishGapOpening("KAORIさん お世話になっております！！\nこちらのお部屋如何でしょうか😊！！\n2019年", S);
  t("レビュー: 名前つきの挨拶の次に置く", c.text === "KAORIさん お世話になっております！！\n最寄り駅瓢箪山駅となりますがこちらのお部屋如何でしょうか😊！！\n2019年", c);
  const d = ensureWishGapOpening("お世話になっております！！\nこちらのお部屋如何でしょうか😊！！\n最寄り駅瓢箪山駅となりますが、こちらのお部屋如何でしょうか😊！！\n築浅", S);
  t("レビュー: 如何でしょうかの行を重ねない", d.text === "お世話になっております！！\n最寄り駅瓢箪山駅となりますがこちらのお部屋如何でしょうか😊！！\n築浅", d);
  const e = ensureWishGapOpening("こちらのお部屋如何でしょうか😊！！ 家賃管理費込75,700円", S);
  t("レビュー: 同じ行の続きは残す・重ねない", e.text === "最寄り駅瓢箪山駅となりますがこちらのお部屋如何でしょうか😊！！ 家賃管理費込75,700円", e);
}
t("既定 on・off で止まる", secondWishGapEnabled({}) && !secondWishGapEnabled({ RECOMMEND_SECOND_WISH_GAP: "off" }));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
