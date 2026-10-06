// ITANDI の募集図面の帯替えの判断（zumen-obi.ts）
// 実行: npx tsx app/lib/__tests__/zumen-obi.test.ts
// 2026-10-06 竹内「帯替えとはこのように弊社の情報に帯を変更するということ　帯の部分だけ判断して変えれば良い」
// 実物（Downloads の ZIP）での監査は scripts/audit-zumen-obi.ts。ここは形を写した合成の材料で、止める側の線を確かめる
import { parseZumenName, groupZumenFiles, planObiReplace, linesFromItems, obiPlacement, type ObiTextItem, type ObiRowProfile, type ObiBox } from "../zumen-obi";

let pass = 0, fail = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}

console.log("■ ファイル名");
{
  const a = parseZumenName("ITANDI_BB_募集図面20261006180046/0_ラフォルテ日本橋 408.pdf");
  t("連番・物件名・号室", a.seq === 0 && a.name === "ラフォルテ日本橋" && a.room === "408" && a.ext === ".pdf", a);
  const b = parseZumenName("10_JESUS SQUARE nippombashi 301.jpeg");
  t("英字の物件名（空白を含む）", b.seq === 10 && b.name === "JESUS SQUARE nippombashi" && b.room === "301", b);
  const c = parseZumenName("7_コスモトム日本橋Ⅱ 5B.pdf");
  t("号室に英字", c.room === "5B" && c.name === "コスモトム日本橋Ⅱ", c);
  const g = groupZumenFiles([
    { path: "F/3_ラフォルテ日本橋 305.pdf" }, { path: "F/2_ラフォルテ日本橋 305.pdf" }, { path: "F/1_ラフォルテ日本橋 501.pdf" },
    { path: "F/" }, { path: "__MACOSX/F/._1_x.pdf" }, { path: "F/memo.txt" },
  ]);
  t("同じ号室は1つにまとめ・連番の順・フォルダ等は外す", g.length === 2 && g[0].room === "501" && g[1].files.length === 2 && g[1].seq === 2, g.map((x) => [x.room, x.seq, x.files.length]));
}

console.log("■ 1字ずつの片をつなぐ（ホームメイトの免許番号）");
{
  const chars = "国土交通大臣免許(11)第3058号".split("");
  const items: ObiTextItem[] = chars.map((s, i) => ({ s, x0: 0.1 + i * 0.01, x1: 0.1 + i * 0.01 + 0.0098, y0: 0.887, y1: 0.902 }));
  const l = linesFromItems(items);
  t("隙間の無い片は詰める", l.length === 1 && l[0].text === "国土交通大臣免許(11)第3058号", l);
}

// 合成のページ: 白い行ばかり・文字のある所だけ汚れた行にする
function rowsFor(lines: ObiTextItem[], H = 1000, extraDirty: Array<[number, number]> = []): ObiRowProfile {
  const ink = new Float32Array(H), rule = new Uint8Array(H);
  for (const l of lines) for (let y = Math.floor(l.y0 * H); y <= Math.ceil(l.y1 * H); y++) ink[y] = 0.2;
  for (const [a, b] of extraDirty) for (let y = Math.floor(a * H); y <= Math.ceil(b * H); y++) ink[y] = 0.3;
  return { height: H, ink, rule };
}
const L = (s: string, y0: number, y1 = y0 + 0.015, x0 = 0.05, x1 = 0.6): ObiTextItem => ({ s, x0, x1, y0, y1 });
const BODY: ObiTextItem[] = [
  L("ラフォルテ日本橋 305号室", 0.18), L("賃料 9.9万円 共益費 9,000円", 0.3), L("間取り 1DK 専有面積 40.04㎡", 0.4),
  L("敷金 1ヶ月 礼金 1ヶ月", 0.45), L("築年月 H26.8 交通 日本橋駅 徒歩5分", 0.5), L("設備 オートロック", 0.55),
];

console.log("■ 帯替えする形");
{
  const band = [L("株式会社サンプル管理 大阪梅田店 TEL 06-0000-0000", 0.87), L("大阪府知事(4)第52532号", 0.9), L("貸主:0% 借主:100% 元付:0% 客付:100%", 0.93)];
  const items = [...BODY, ...band];
  const p = planObiReplace({ items, images: [], rows: rowsFor(items) });
  t("帯の目印の上の空の行で切る", p.kind === "replace" && p.cutY > 0.56 && p.cutY < 0.87, p);
  const pl = obiPlacement(1000, 700, 0.86, { width: 2016, height: 139 });
  t("弊社の帯は帯の範囲の中に縦横比のまま", pl.draw.y >= pl.fill.y && pl.draw.y + pl.draw.h <= 700 && Math.abs(pl.draw.w / pl.draw.h - 2016 / 139) < 0.2, pl);
}

console.log("■ 止める形");
{
  const band = [L("大阪府知事(4)第52532号 株式会社サンプル TEL 06-0000-0000", 0.9)];
  const items = [...BODY, ...band];
  // 境目が無い（文字の上から下まで汚れた行が続く＝縦に長い画素の塊）
  const p1 = planObiReplace({ items, images: [], rows: rowsFor(items, 1000, [[0.7, 0.99]]) });
  t("境目が無ければ止める", p1.kind === "stop" && p1.code === "no_cut", p1);
  // 帯の範囲に間取りの字（間取り図の下の方）
  const items2 = [...BODY, L("洋室 6帖", 0.92, 0.935, 0.7, 0.8), ...band];
  const p2 = planObiReplace({ items: items2, images: [], rows: rowsFor(items2) });
  t("帯の範囲に物件の内容があれば止める", p2.kind === "stop" && (p2.code === "body_in_band"), p2);
  // 帯の範囲に大きな画像（写真）
  const big: ObiBox[] = [{ x: 0.6, y: 0.885, w: 0.3, h: 0.11 }];
  const p3 = planObiReplace({ items, images: big, rows: rowsFor(items) });
  t("帯の範囲に大きな画像があれば止める", p3.kind === "stop", p3);
  // 帯の外にも AD
  const items4 = [...BODY, L("AD 2ヶ月", 0.35, 0.365, 0.7, 0.8), ...band];
  const p4 = planObiReplace({ items: items4, images: [], rows: rowsFor(items4) });
  t("帯の外に AD が残れば止める", p4.kind === "stop" && p4.code === "fee_outside_band", p4);
  // 業者向けの案内（図面の項目が無い）
  const notice = [L("仲介業者各位 初期費用について 火災保険 申込時必要書類", 0.1), L("株式会社サンプル TEL 06-0000-0000 大阪府知事(1)第1234号", 0.9)];
  const p5 = planObiReplace({ items: notice, images: [], rows: rowsFor(notice) });
  t("図面でない資料は止める", p5.kind === "stop" && p5.code === "not_zumen", p5);
  // 文字の層が無い（スキャン）
  const p6 = planObiReplace({ items: [], images: [{ x: 0, y: 0, w: 1, h: 1 }], rows: rowsFor([]) });
  t("文字の層が無ければ止める", p6.kind === "stop" && p6.code === "no_text", p6);
  // 回転
  const p7 = planObiReplace({ rotate: 270, items, images: [], rows: rowsFor(items) });
  t("回転したページは止める", p7.kind === "stop" && p7.code === "rotated", p7);
  // 帯の目印が無い（会社の情報が下に無い）
  const p8 = planObiReplace({ items: BODY, images: [], rows: rowsFor(BODY) });
  t("帯の目印が無ければ止める", p8.kind === "stop" && p8.code === "no_band_marker", p8);
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
