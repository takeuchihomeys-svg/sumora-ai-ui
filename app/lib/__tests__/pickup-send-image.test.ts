// お客様に送る物件の画像＝元の資料のページをそのまま（pickup-send-image.ts）
// 実行: npx tsx app/lib/__tests__/pickup-send-image.test.ts
// 2026-09-27 竹内「物件はいま文字とか入れなおしてるけど、そのままの画像つかったら大丈夫」
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  pickSendImageUrl, requestedFamilyFromSubstitution, requestedSystemFamilies, judgeOriginalRender, serverRenderIsOriginal, fontMissingMessage, SEND_PAGE,
} from "../pickup-send-image";
import { CUSTOMER_PAGE, AGENT_PAGE, toPickupHandoffItem } from "../property-pickups";
import { pickSaveImageUrl } from "../pickup-image-url";

let pass = 0, fail = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}

console.log("■ 送る画像は元の資料のページ（trim_image_url）だけ");
{
  t("元の資料の画像があればそれ", pickSendImageUrl({ trim_image_url: "orig.jpg" }) === "orig.jpg");
  t("無ければ null", pickSendImageUrl({ trim_image_url: null }) === null && pickSendImageUrl({}) === null && pickSendImageUrl({ trim_image_url: "" }) === null);
  // 余分な列（page_image_url＝書体を差し替えた画像・agent_image_url＝元付の面）が来ても選ばない
  const row = { trim_image_url: null, page_image_url: "noto_p1.png", agent_image_url: "agent_p2.png", pdf_has_text: true } as never;
  t("page_image_url・agent_image_url は選ばない", pickSendImageUrl(row) === null);
  t("画像保存も同じ決まり", pickSaveImageUrl(row) === null && pickSaveImageUrl({ trim_image_url: "orig.jpg" }) === "orig.jpg");
  const h = toPickupHandoffItem({ id: 1, rank: 1, property_name: "willDo難波wⅠ", room_no: "1205", conversation_id: "c", trim_image_url: null, page_image_url: "noto_p1.png" });
  t("AIX への受け渡しも page_image_url に落とさない", h.image_url === null, h);
  t("送る面は奇数ページ（1＝弊社帯）・読む面（元付）と別", SEND_PAGE === CUSTOMER_PAGE && SEND_PAGE === 1 && AGENT_PAGE === 2);
}

console.log("■ 資料が求めている書体（pdfjs の fontSubstitution）");
{
  // 実物（2026-09-27 Chrome で willDo難波wⅠ 1205 のリアプロの資料を描いた時の styles）
  const realproStyles = {
    g_d0_f1: { fontFamily: "sans-serif", fontSubstitution: "\"MS Gothic\",g_d0_sf2,serif" },
    g_d0_f2: { fontFamily: "sans-serif", fontSubstitution: "\"MS Gothic\",g_d0_sf4,serif" },
  };
  t("先頭の家族名", requestedFamilyFromSubstitution("\"MS Gothic\",g_d0_sf2,serif") === "MS Gothic");
  t("内部名・総称だけは書体ではない", requestedFamilyFromSubstitution("g_d0_sf2,serif") === null && requestedFamilyFromSubstitution("serif") === null && requestedFamilyFromSubstitution("") === null && requestedFamilyFromSubstitution(null) === null);
  t("リアプロ（MS ゴシックの埋め込みなし）＝MS Gothic を1つ", JSON.stringify(requestedSystemFamilies(realproStyles)) === JSON.stringify(["MS Gothic"]));
  // itandi（書体を埋め込み）は fontSubstitution が付かない
  t("itandi（埋め込み）＝求める書体なし", requestedSystemFamilies({ g_d0_f1: { fontFamily: "sans-serif" }, g_d0_f2: {} }).length === 0);
  t("styles が無くても投げない", requestedSystemFamilies(null).length === 0 && requestedSystemFamilies(undefined).length === 0);
}

console.log("■ 画面で描いた画像が元の資料と同じか");
{
  const has = (set: string[]) => (f: string) => set.includes(f);
  t("Windows（MS ゴシックあり）→ そのまま使う", judgeOriginalRender({ requested: ["MS Gothic"], available: has(["MS Gothic", "Yu Gothic"]), textChars: 900, textDraws: 839 }).ok);
  const iphone = judgeOriginalRender({ requested: ["MS Gothic"], available: has(["Hiragino Sans"]), textChars: 900, textDraws: 839 });
  t("iPhone（MS ゴシックなし）→ 作らない（別の書体に差し替えた画像になる）", !iphone.ok && iphone.reason === "font_missing" && JSON.stringify(iphone.missing) === JSON.stringify(["MS Gothic"]), iphone);
  t("理由の文に書体の名前", !iphone.ok && iphone.message === fontMissingMessage(["MS Gothic"]) && iphone.message.includes("MS Gothic") && iphone.message.includes("パソコン"));
  t("itandi（埋め込み）はどの端末でもそのまま（字形の線で描くので描いた文字 0 でもよい）", judgeOriginalRender({ requested: [], available: has([]), textChars: 600, textDraws: 0 }).ok);
  const blank = judgeOriginalRender({ requested: ["MS Gothic"], available: has(["MS Gothic"]), textChars: 900, textDraws: 0 });
  t("端末の書体で描く資料なのに1文字も描けていない（白い表）→ 作らない", !blank.ok && blank.reason === "no_text_drawn", blank);
  t("文字の少ない資料は白い表の検査をしない", judgeOriginalRender({ requested: ["MS Gothic"], available: has(["MS Gothic"]), textChars: 10, textDraws: 0 }).ok);
}

console.log("■ サーバーで描いた画像（予備）");
{
  t("描いた文字 0（全部埋め込みの字形）＝元の資料のまま", serverRenderIsOriginal(0));
  t("1回でも fillText（Noto Sans JP に差し替え）＝作らない", !serverRenderIsOriginal(839) && !serverRenderIsOriginal(1));
  t("分からない時は作らない", !serverRenderIsOriginal(null) && !serverRenderIsOriginal(undefined));
}

console.log("■ 経路（ソースの静的検査）");
{
  const root = join(__dirname, "..", "..", "..");
  const browser = readFileSync(join(root, "app/lib/pdf-trim-browser.ts"), "utf8");
  t("画面の描画は切り取らない（矩形の計算を使わない）", !/cropRectForSheet|pdf-trim-rect|keepRatio/.test(browser.replace(/^\s*\/\/.*$/gm, "")));
  t("画面の描画はサーバー用の pdf-trim を import しない", !/from\s+["']\.\/pdf-trim["']/.test(browser));
  t("画面の描画は端末の書体で描き、どの書体かを出す", /useSystemFonts:\s*true/.test(browser) && /fontExtraProperties:\s*true/.test(browser) && /judgeOriginalRender/.test(browser));
  const route = readFileSync(join(root, "app/api/property-pickups/trim/route.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  t("サーバーの予備は page_image_url から作らない", !/fetch\(r\.page_image_url/.test(route));
  t("サーバーの予備は書体のまま描けた時だけ", /serverRenderIsOriginal\(png\.textDraws\)/.test(route) && /keepRatio:\s*1/.test(route));
  const review = readFileSync(join(root, "app/components/PickupReview.tsx"), "utf8");
  t("売上サポは元の資料のまま描く関数を使う", /renderOriginalPageInBrowser/.test(review) && !/trimPdfPageInBrowser/.test(review));
  t("売上サポは予備の結果を読む（作れなかった物件を黙って落とさない）", /const fallbackJson = /.test(review));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
