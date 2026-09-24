// 2026-09-24 竹内「必要な所（間取り図・室内写真）だけを切り出して読ませる。表の文字は PDF の文字層から取る」
//   実物の PDF（fixtures/realpro-sheet-2p.pdf＝property_pickups id 36 と同じ資料）で、描画命令の位置・文字層・切り出しを見る
// 実行: npx tsx app/lib/__tests__/pdf-sheet-crop.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSheetPdf, cropCanvas, imageBoxesFromOps } from "../pdf-sheet-crop";
import { detectSheetType, planSheetCrop, REALPRO_SLOTS } from "../sheet-layout";
import { parseSheetText, unitKeyOf, checkSheetConsistency } from "../sheet-facts";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
const near = (a: number, b: number, tol = 0.002) => Math.abs(a - b) <= tol;

(async () => {
  const bytes = new Uint8Array(readFileSync(join(__dirname, "fixtures", "realpro-sheet-2p.pdf")));
  const r = await readSheetPdf(bytes);
  t("★ PDF を読める（2ページ・文字層2ページ分・描いた1ページ目）", !!r && r.pages === 2 && r.texts.length === 2 && !!r.canvas, r && { pages: r.pages, texts: r.texts.map((x) => x.length) });
  if (!r) { console.log(`\n${passed} passed, ${failed + 1} failed`); process.exit(1); }
  const floor = r.boxes.find((b) => near(b.x, REALPRO_SLOTS.floor.x) && near(b.y, REALPRO_SLOTS.floor.y));
  const map = r.boxes.find((b) => near(b.x, REALPRO_SLOTS.map.x) && near(b.y, REALPRO_SLOTS.map.y));
  t("★ 描画命令: 間取り図 x.343 y.296 w.255 h.362・地図 x.604 y.296 を取れる", !!floor && near(floor.w, 0.255) && near(floor.h, 0.362) && !!map, r.boxes);
  t("★ A4 横（高さ÷幅 ≒ 0.706）", near(r.aspect, 0.706, 0.005), r.aspect);
  const type = detectSheetType({ site: null, pdfUrl: null, pageText: r.texts[0] });
  t("★ 型: 文字層の目印でリアプロ", type.type === "realpro" && type.by === "text", type);
  const plan = planSheetCrop(type.type, r.boxes, r.aspect);
  t("★ 切り出し: 間取り図（描画命令で確かめた）", plan.mode === "floor" && plan.basis === "drawn", plan);
  const c1 = await cropCanvas(r.canvas!, plan.rect);
  const c2 = await cropCanvas(r.canvas!, plan.rect);
  t("★ 切り出し: JPEG・長い辺 1000px 以内・ほぼ正方形", !!c1 && c1.jpeg[0] === 0xff && c1.jpeg[1] === 0xd8 && Math.max(c1.width, c1.height) <= 1000 && Math.abs(c1.width / c1.height - 1) < 0.1, c1 && { w: c1.width, h: c1.height });
  t("★ 同じ図は同じハッシュ（保存した読み取りを引く鍵）", !!c1 && !!c2 && c1.hash === c2.hash && c1.hash.length === 32);
  const r2 = await readSheetPdf(bytes);
  const c3 = r2?.canvas ? await cropCanvas(r2.canvas, planSheetCrop("realpro", r2.boxes, r2.aspect).rect) : null;
  t("★ 読み直しても同じハッシュ（描き直しで変わらない）", !!c3 && c3.hash === c1?.hash, { a: c1?.hash, b: c3?.hash });
  const exterior = await cropCanvas(r.canvas!, { x: 0.343, y: 0.023, w: 0.184, h: 0.261 });
  t("★ 別の枠（外観）は別のハッシュ", !!exterior && exterior.hash !== c1?.hash);
  const text = parseSheetText(r.texts.join("\n"));
  t("★ 文字層: 物件名・号室・間取り・面積・賃料（画像で読ませない）", text.name === "スプランディッド難波WEST" && text.roomNo === "303" && text.madori === "1K" && text.areaSqm === 22.4 && text.rentYen === 77000, { ...text, features: text.features.slice(0, 60) });
  t("★ 文字層: 1ページ目と2ページ目の物件名・号室が同じ（まとめ PDF のずれなし）", text.names.length === 1 && text.roomNos.length === 1);
  t("★ 物件の鍵が作れる", !!unitKeyOf(text));
  t("★ 説明文と一致（実物の説明文）", checkSheetConsistency({ summary: "【2🌟】スプランディッド難波WEST\n77,000円 7,000円\n1K 22.4㎡\nAD 2ヶ月", text }).status === "ok");
  const noRender = await readSheetPdf(bytes, { render: false });
  t("★ render:false は描かない（文字層と位置だけ・保存した読み取りを引く時）", !!noRender && noRender.canvas === null && noRender.boxes.length === r.boxes.length);
  t("★ 壊れた PDF は null（投げない）", (await readSheetPdf(new Uint8Array([1, 2, 3]))) === null);
  // 変換行列の計算（save/restore・transform）
  const OPS = { save: 1, restore: 2, transform: 3, paintImageXObject: 4, paintFormXObjectBegin: 5, paintFormXObjectEnd: 6 };
  const boxes = imageBoxesFromOps({ fnArray: [1, 3, 4, 2, 4], argsArray: [null, [50, 0, 0, 25, 10, 20], ["img1"], null, ["img2"]] }, OPS, (x, y) => [x, 100 - y], { width: 100, height: 100 });
  t("★ 描画命令: 変換行列で位置を出し、restore で戻す", JSON.stringify(boxes[0]) === JSON.stringify({ x: 0.1, y: 0.55, w: 0.5, h: 0.25 }) && boxes[1].w === 0.01, boxes);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
