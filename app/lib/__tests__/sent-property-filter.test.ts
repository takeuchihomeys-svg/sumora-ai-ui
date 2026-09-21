// 一度送った物件を外す（竹内 2026-09-21）。
//
// 竹内「拡張ツールで物件出した事あるのは出さないようにできるか？
//   一度共有した物件を除いてLINEに送ることが出来ればかなり質高くなる」
//
// ⚠ いちばん大事なのは「誤って外さない」こと。
//   実測: 送っている物件名に号室が入っているのは 0.1%、1回の送信の 74.2% に同じ建物の別部屋が入っている。
//   名前だけで外すと別の部屋が消える。★ が付いたテストはその線を守るための物。
//
// 実行: npx tsx app/lib/__tests__/sent-property-filter.test.ts（全 PASS で exit 0）
import {
  normalizePropertyUrl, canMatch, isSameOutgoing, filterOutAlreadySent, urlKeysAreDistinct,
  renumberSummaries, parseSummaryHead, buildExcludedNotice, buildingWing, isSameBuilding, isUsablePropertyName,
  type OutgoingProperty, type SentProperty,
} from "../sent-property-filter";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toEqual(exp: unknown) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: unknown) { if (typeof actual === "string" ? !actual.includes(String(item)) : true) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
  };
}
const out = (p: Partial<OutgoingProperty> & { propertyName: string }): OutgoingProperty => ({ url: null, roomNo: null, ...p });

describe("URL を鍵にする", () => {
  it("★ U1 同じ物件の URL は、クエリが違っても同じと見なす（トークン・時刻が付く）", () => {
    const a = normalizePropertyUrl("https://www.realnetpro.com/print/bukken/123456.pdf?token=abc&t=1");
    const b = normalizePropertyUrl("https://www.realnetpro.com/print/bukken/123456.pdf?token=zzz&t=999");
    expect(a).toBe(b);
    expect(a).toBe("www.realnetpro.com/print/bukken/123456.pdf");
  });
  it("★ U2 別の物件の URL は別（path が違う）", () => {
    const a = normalizePropertyUrl("https://www.realnetpro.com/print/bukken/123456.pdf");
    const b = normalizePropertyUrl("https://www.realnetpro.com/print/bukken/999999.pdf");
    if (a === b) throw new Error("別物件が同じ鍵になっている");
  });
  it("★ U3 一時置き場（Vercel Blob）は鍵にしない（送るたびに変わるので当たらない）", () => {
    expect(normalizePropertyUrl("https://eggcrp3ajyl21x7a.public.blob.vercel-storage.com/x_1788015283592.pdf")).toBe("");
  });
  it("U4 壊れた URL・空でも落ちない", () => {
    expect(normalizePropertyUrl("")).toBe("");
    expect(normalizePropertyUrl(null)).toBe("");
    expect(normalizePropertyUrl("これはURLではない")).toBe("");
  });
  it("U5 大文字小文字・末尾のスラッシュを揃える", () => {
    expect(normalizePropertyUrl("https://WWW.RealNetPro.com/Print/A1/")).toBe("www.realnetpro.com/print/a1");
  });
});

describe("★ 建物ごとに外す（竹内さんの選択・既定）", () => {
  it("★ B1 一度送ったマンションは、別の部屋でも外す", () => {
    const sent: SentProperty[] = [{ property_name: "セレニテ梅田北グランデ", room_no: "805", property_url: null }];
    const r = filterOutAlreadySent([out({ propertyName: "セレニテ梅田北グランデ", roomNo: "1203" })], sent);
    expect(r.dropped.length).toBe(1);
    expect(r.dropped[0].reason).toBe("building");
  });
  it("★ B2 号室が無くても外せる（実測で号室は 0.1% しか取れない）", () => {
    const sent: SentProperty[] = [{ property_name: "スプランディッド本町グラン", room_no: "", property_url: null }];
    const r = filterOutAlreadySent([out({ propertyName: "スプランディッド本町グラン" })], sent);
    expect(r.dropped.length).toBe(1);
    expect(r.keep).toEqual([]);
  });
  it("★★ B3 「〇〇Ⅱ」「〇〇Ⅲ」は**別の建物**なので外さない", () => {
    // similarity は2文字の集合なので「ii」と「iii」が 1.000 になる。棟を分けないとここで別建物が消える
    const sent: SentProperty[] = [{ property_name: "マスターズレジデンス道頓堀Ⅱ", room_no: "", property_url: null }];
    const r = filterOutAlreadySent([out({ propertyName: "マスターズレジデンス道頓堀Ⅲ" })], sent);
    expect(r.dropped.length).toBe(0);
    expect(r.keep).toEqual([0]);
  });
  it("★★ B4 棟が付いた物と付かない物も別（〇〇west と 〇〇westⅡ）", () => {
    const sent: SentProperty[] = [{ property_name: "スプランディッド上本町WEST", room_no: "", property_url: null }];
    const r = filterOutAlreadySent([out({ propertyName: "スプランディッド上本町WESTⅡ" })], sent);
    expect(r.dropped.length).toBe(0);
  });
  it("★★ B5 名前が似ているだけの別のマンションは外さない（0.97 の線）", () => {
    // 実測: 「ブエナビスタ難波サウスタワー」↔「ブエナビスタ難波サウス」は 0.952
    const sent: SentProperty[] = [{ property_name: "ブエナビスタ難波サウス", room_no: "", property_url: null }];
    const r = filterOutAlreadySent([out({ propertyName: "ブエナビスタ難波サウスタワー" })], sent);
    expect(r.dropped.length).toBe(0);
  });
  it("★★ B6 1回の送信の中の同じマンションは**全部残す**（竹内さんの選択）", () => {
    const r = filterOutAlreadySent([
      out({ propertyName: "セレニテ梅田北グランデ", roomNo: "1104" }),
      out({ propertyName: "セレニテ梅田北グランデ", roomNo: "805" }),
      out({ propertyName: "セレニテ梅田北グランデ", roomNo: "302" }),
    ], []);
    expect(r.keep).toEqual([0, 1, 2]);
    expect(r.dropped.length).toBe(0);
  });
  it("★ B7 同じ回でも「同じ部屋」が2回入っていれば外す", () => {
    const r = filterOutAlreadySent([
      out({ propertyName: "セレニテ梅田北グランデ", roomNo: "1104" }),
      out({ propertyName: "セレニテ梅田北グランデ", roomNo: "1104" }),
    ], []);
    expect(r.keep).toEqual([0]);
    expect(r.dropped[0].reason).toBe("room");
  });
  it("★ B8 表記ゆれ（全角・記号・空白）は同じ建物として外す", () => {
    const sent: SentProperty[] = [{ property_name: "porte bonheur(ポルトボヌール)", room_no: "", property_url: null }];
    const r = filterOutAlreadySent([out({ propertyName: "porte bonheur ポルトボヌール" })], sent);
    expect(r.dropped.length).toBe(1);
  });
  it("★ B9 まったく別のマンションは外さない", () => {
    const sent: SentProperty[] = [{ property_name: "グランパシフィック梅南", room_no: "", property_url: null }];
    const r = filterOutAlreadySent([out({ propertyName: "グランパシフィック生野東" })], sent);
    expect(r.dropped.length).toBe(0);
  });
  it("★★ B11 名前を読み取れなかった物件（既定値「物件」）同士を消し合わせない", () => {
    // 拡張は名前を取れないと "物件" を入れる（実測 239件・1.1%）。
    // 建物ごとに外す作りでは、この同士が名前一致して**読めなかっただけの物件が全部消える**。
    const sent: SentProperty[] = [{ property_name: "物件", room_no: "", property_url: null }];
    const r = filterOutAlreadySent([out({ propertyName: "物件" })], sent);
    expect(r.dropped.length).toBe(0);
    expect(r.keep).toEqual([0]);
  });
  it("★★ B12 号室が一致しても、名前が既定値なら外さない", () => {
    const sent: SentProperty[] = [{ property_name: "物件", room_no: "301", property_url: null }];
    const r = filterOutAlreadySent([out({ propertyName: "物件", roomNo: "301" })], sent, "room");
    expect(r.dropped.length).toBe(0);
  });
  it("★ B13 画面の文字が混ざった名前も判定に使わない", () => {
    const sent: SentProperty[] = [{ property_name: "設備・詳細", room_no: "", property_url: null }];
    const r = filterOutAlreadySent([out({ propertyName: "設備・詳細" })], sent);
    expect(r.dropped.length).toBe(0);
  });
  it("★ B14 URL が一致していれば、名前が読めなくても外す（URL は確実）", () => {
    const u = "https://www.realnetpro.com/print/9.pdf";
    const sent: SentProperty[] = [{ property_name: "物件", room_no: "", property_url: u }];
    const r = filterOutAlreadySent([
      out({ propertyName: "物件", url: `${u}?t=2` }),
      out({ propertyName: "別物件", url: "https://www.realnetpro.com/print/10.pdf" }),
    ], sent);
    expect(r.dropped.length).toBe(1);
    expect(r.dropped[0].reason).toBe("url");
  });
  it("B15 使える名前かの判定", () => {
    expect(isUsablePropertyName("セレニテ梅田北グランデ")).toBe(true);
    expect(isUsablePropertyName("雅苑")).toBe(true);
    expect(isUsablePropertyName("物件")).toBe(false);
    expect(isUsablePropertyName("設備・詳細")).toBe(false);
    expect(isUsablePropertyName("58,000円")).toBe(false);
    expect(isUsablePropertyName("")).toBe(false);
    expect(isUsablePropertyName(null)).toBe(false);
  });
  it("B10 棟の取り出し", () => {
    expect(buildingWing("マスターズレジデンス道頓堀ii")).toBe("ii");
    expect(buildingWing("マスターズレジデンス道頓堀iii")).toBe("iii");
    expect(buildingWing("スプランディッド難波2")).toBe("2");
    expect(buildingWing("富田団地73号棟")).toBe("73号棟");
    expect(buildingWing("フランセーヌi番館")).toBe("i番館");
    expect(buildingWing("セレニテ梅田北グランデ")).toBe("");
  });
});

describe("★ 部屋ごとに戻した時（SKIP_SENT_LEVEL=room）", () => {
  it("★ N1 号室も URL も無ければ突き合わせない", () => {
    expect(canMatch(out({ propertyName: "スプランディッド本町グラン" }))).toBe(false);
  });
  it("★ N2 名前が完全に同じでも、号室が無ければ**外さない**", () => {
    const sent: SentProperty[] = [{ property_name: "スプランディッド本町グラン", room_no: "1003", property_url: null }];
    const r = filterOutAlreadySent([out({ propertyName: "スプランディッド本町グラン" })], sent, "room");
    expect(r.dropped.length).toBe(0);
    expect(r.keep).toEqual([0]);
    expect(r.unmatchable).toBe(1);
  });
  it("★ N3 前に送った側に号室が無ければ、こちらに号室があっても外さない", () => {
    const sent: SentProperty[] = [{ property_name: "エスリード新北野", room_no: "", property_url: null }];
    const r = filterOutAlreadySent([out({ propertyName: "エスリード新北野", roomNo: "502" })], sent, "room");
    expect(r.dropped.length).toBe(0);
  });
  it("★ N4 同じ建物の別の部屋は外さない", () => {
    const sent: SentProperty[] = [{ property_name: "セレニテ梅田北グランデ", room_no: "805", property_url: null }];
    const r = filterOutAlreadySent([out({ propertyName: "セレニテ梅田北グランデ", roomNo: "1203" })], sent, "room");
    expect(r.dropped.length).toBe(0);
    expect(r.keep).toEqual([0]);
  });
  it("★ N5 名前が似ていても別物件なら外さない（0.95 の線）", () => {
    const sent: SentProperty[] = [{ property_name: "グランパシフィック梅南", room_no: "501", property_url: null }];
    const r = filterOutAlreadySent([out({ propertyName: "グランパシフィック生野東", roomNo: "501" })], sent, "room");
    expect(r.dropped.length).toBe(0);
  });
});

describe("外してよい物は外す", () => {
  it("★ D1 URL が一致したら外す", () => {
    const url = "https://www.realnetpro.com/print/bukken/123456.pdf";
    const sent: SentProperty[] = [{ property_name: "別名で記録されていても", room_no: "", property_url: `${url}?t=1` }];
    const r = filterOutAlreadySent([out({ propertyName: "フォルモント寺田町", url: `${url}?t=2` })], sent);
    expect(r.dropped.length).toBe(1);
    expect(r.dropped[0].reason).toBe("url");
    expect(r.keep).toEqual([]);
  });
  it("★ D2 名前が同じで号室も同じなら外す", () => {
    const sent: SentProperty[] = [{ property_name: "フォルモント寺田町", room_no: "304", property_url: null }];
    const r = filterOutAlreadySent([out({ propertyName: "フォルモント寺田町", roomNo: "304" })], sent);
    expect(r.dropped.length).toBe(1);
    expect(r.dropped[0].reason).toBe("room");
  });
  it("★ D3 号室の表記ゆれ（0304 / 304号室）を揃えて外す", () => {
    const sent: SentProperty[] = [{ property_name: "フォルモント寺田町", room_no: "0304", property_url: null }];
    const r = filterOutAlreadySent([out({ propertyName: "フォルモント寺田町", roomNo: "304号室" })], sent);
    expect(r.dropped.length).toBe(1);
  });
  it("★ D4 同じ送信の中の重複も外す（実測では再送の37.5%が1日以内）", () => {
    const url = "https://www.realnetpro.com/print/bukken/1.pdf";
    const r = filterOutAlreadySent([
      out({ propertyName: "A", url }),
      out({ propertyName: "A", url: `${url}?x=2` }),   // 同じ物件が2回入っている
      out({ propertyName: "B", url: "https://www.realnetpro.com/print/bukken/2.pdf" }),
    ], []);
    expect(r.keep).toEqual([0, 2]);
    expect(r.dropped.length).toBe(1);
  });
  it("★ D5 並びは元のまま返す（PDF と説明文の対応が崩れない）", () => {
    // ⚠ 名前は2文字以上にする（1文字だと isUsablePropertyName で判定に使われない＝外さない側に倒れる）
    const sent: SentProperty[] = [{ property_name: "ベータ荘", room_no: "202", property_url: null }];
    const r = filterOutAlreadySent([
      out({ propertyName: "アルファ荘", roomNo: "101" }),
      out({ propertyName: "ベータ荘", roomNo: "202" }),
      out({ propertyName: "ガンマ荘", roomNo: "303" }),
    ], sent);
    expect(r.keep).toEqual([0, 2]);
  });
  it("D6 何も送っていなければ全部残る", () => {
    const r = filterOutAlreadySent([out({ propertyName: "A", roomNo: "101" })], []);
    expect(r.keep).toEqual([0]);
    expect(r.dropped.length).toBe(0);
  });
  it("D7 空でも落ちない", () => {
    const r = filterOutAlreadySent([], []);
    expect(r.keep).toEqual([]);
  });
  it("D8 名前が空の行は触らない", () => {
    const r = filterOutAlreadySent([out({ propertyName: "  " })], [{ property_name: "A", room_no: "1", property_url: null }]);
    expect(r.keep).toEqual([0]);
  });
});

describe("★ URL が物件を区別できていない時は URL を使わない（自分を守る確認）", () => {
  it("★ G1 1回の送信で URL の鍵がぶつかったら、URL は鍵にしない", () => {
    // もしリアプロの印刷用PDFが「path は同じでクエリで物件を指す」形なら、
    // path だけの鍵は全物件で同じになる。そのまま使うと2件目以降が全部消える。
    const same = "https://www.realnetpro.com/print.pdf";
    const r = filterOutAlreadySent([
      out({ propertyName: "A", url: `${same}?id=1` }),
      out({ propertyName: "B", url: `${same}?id=2` }),
      out({ propertyName: "C", url: `${same}?id=3` }),
    ], []);
    expect(r.urlUnusable).toBe(true);
    expect(r.keep).toEqual([0, 1, 2]);   // 1件も消えない
    expect(r.dropped.length).toBe(0);
  });
  it("★ G2 その時は号室での判定だけが残る（号室があれば外せる）", () => {
    const same = "https://www.realnetpro.com/print.pdf";
    const sent: SentProperty[] = [{ property_name: "アルファ荘", room_no: "101", property_url: null }];
    const r = filterOutAlreadySent([
      out({ propertyName: "アルファ荘", roomNo: "101", url: `${same}?id=1` }),
      out({ propertyName: "ベータ荘", roomNo: "202", url: `${same}?id=2` }),
    ], sent);
    expect(r.urlUnusable).toBe(true);
    expect(r.keep).toEqual([1]);
    expect(r.dropped[0].reason).toBe("room");
  });
  it("★ G3 URL が物件ごとに違えばそのまま使う", () => {
    const r = filterOutAlreadySent([
      out({ propertyName: "A", url: "https://www.realnetpro.com/print/1.pdf" }),
      out({ propertyName: "B", url: "https://www.realnetpro.com/print/2.pdf" }),
    ], []);
    expect(r.urlUnusable).toBe(false);
  });
  it("G4 URL が1件だけ・0件なら問題なし", () => {
    expect(urlKeysAreDistinct([out({ propertyName: "A", url: "https://x.realnetpro.com/1.pdf" })])).toBe(true);
    expect(urlKeysAreDistinct([out({ propertyName: "A" })])).toBe(true);
    expect(urlKeysAreDistinct([])).toBe(true);
  });
  it("★ G4' 一部だけぶつかるのは「同じ物件が2回入っている」なので URL は使う", () => {
    const u = "https://www.realnetpro.com/print/1.pdf";
    expect(urlKeysAreDistinct([
      out({ propertyName: "A", url: u }),
      out({ propertyName: "A", url: `${u}?x=2` }),
      out({ propertyName: "B", url: "https://www.realnetpro.com/print/2.pdf" }),
    ])).toBe(true);
  });
  it("★ G4'' 2件で両方同じ時は外さない側に倒す（区別が付かないので）", () => {
    const u = "https://www.realnetpro.com/print.pdf";
    expect(urlKeysAreDistinct([
      out({ propertyName: "A", url: `${u}?id=1` }),
      out({ propertyName: "B", url: `${u}?id=2` }),
    ])).toBe(false);
  });
  it("G5 一時置き場の URL は鍵にならないので、ぶつかっても判定に影響しない", () => {
    const b = "https://eggcrp3ajyl21x7a.public.blob.vercel-storage.com/";
    expect(urlKeysAreDistinct([
      out({ propertyName: "A", url: `${b}a.pdf` }),
      out({ propertyName: "B", url: `${b}a.pdf` }),
    ])).toBe(true);
  });
});

describe("番号の詰め直し", () => {
  it("★ R1 外した後は 1 から振り直す", () => {
    expect(renumberSummaries(["【1】A\n5万円", "【3】C\n6万円"])).toEqual(["【1】A\n5万円", "【2】C\n6万円"]);
  });
  it("★ R2 🌟 の印は落とす（この後もう一度付け直すため）", () => {
    expect(renumberSummaries(["【2🌟★】A", "【5🌟】B"])).toEqual(["【1】A", "【2】B"]);
  });
  it("R3 1行目以外は触らない", () => {
    expect(renumberSummaries(["【9】A\n【メモ】そのまま"])[0]).toBe("【1】A\n【メモ】そのまま");
  });
  it("R4 番号が無い説明文はそのまま", () => {
    expect(renumberSummaries(["A\n5万円"])).toEqual(["A\n5万円"]);
  });
});

describe("説明文から物件を読む（merge-pdfs の記録と同じ形）", () => {
  it("★ P1 号室が付いていれば分ける", () => {
    expect(parseSummaryHead("【1】心斎橋SPOT21　604号室\n5.8万円")).toEqual({ propertyName: "心斎橋SPOT21", roomNo: "604" });
  });
  it("★ P2 号室が無ければ空（この物件は外さない側に回る）", () => {
    expect(parseSummaryHead("【2🌟】ソルテラスOSAKA塚本\n5.2万円")).toEqual({ propertyName: "ソルテラスOSAKA塚本", roomNo: "" });
  });
  it("P3 空・印だけなら null", () => {
    expect(parseSummaryHead("")).toBe(null);
    expect(parseSummaryHead("【1】")).toBe(null);
  });
});

describe("スタッフへの知らせ", () => {
  it("★ E1 外した物が無ければ何も出さない", () => {
    expect(buildExcludedNotice([])).toBe("");
  });
  it("★ E2 件数と名前を出す", () => {
    const n = buildExcludedNotice([{ index: 0, property: out({ propertyName: "フォルモント寺田町", roomNo: "304" }), reason: "room" }]);
    expect(n).toContain("1件を除きました");
    expect(n).toContain("フォルモント寺田町 304号室");
  });
  it("E3 多い時は件数だけ（LINE が長くなるのを防ぐ）", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ index: i, property: out({ propertyName: `物件${i}`, roomNo: `${i}01` }), reason: "room" as const }));
    const n = buildExcludedNotice(many);
    expect(n).toContain("9件を除きました");
    if (n.includes("物件0")) throw new Error("名前まで出している");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
