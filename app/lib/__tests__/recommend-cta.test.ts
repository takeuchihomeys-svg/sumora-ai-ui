// 物件オススメ（1件・新着1件）と2通目の締めを刺さり具合で3つに分ける（竹内 2026-09-30）。
//
// テストの材料は**実物**:
//   ・YUMA の実送信テスト（2026-09-30）の1通目・2通目（sends/*_chain_r*.json）
//   ・実送信（scripts/audit-recommend-cta.ts・365日・物件オススメ1件858通）の締めの形
//
// 実行: npx tsx app/lib/__tests__/recommend-cta.test.ts（全 PASS で exit 0）
import {
  resolveRecommendCta, appealFromPickup, setRecommendClosing, readClosingKind, hasClosingKind,
  buildFirstMessageCtaNote, buildSecondMessageCtaNote, removeRecommendClosing, pickupForFirstMessage, headOfFirstMessage, hasClosingSentence,
  VIEWING_CLOSING_LINE, RECEIPT_CLOSING_LINE, APPLY_CLOSING_LINE,
} from "../recommend-cta";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: string) { if (typeof actual !== "string" || !actual.includes(item)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
    notToContain(item: string) { if (typeof actual === "string" && actual.includes(item)) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(item)}`); },
  };
}

// ── 実物 ──
/** YUMA 9/30 r1（SWISS梅田東・空室）の1通目。締めが「ごゆっくりご確認ください」（実送信の形は「ご査収ください」） */
const R1_FIRST = "🌟SWISS梅田東 307\n\n敷金礼金なし・家賃管理費込88,000円の好条件で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n洋室7帖の1Kで、独立洗面台や2口ガスコンロ、温水洗浄便座など水回り設備も充実しております！！中崎町駅徒歩3分で梅田にも出やすい立地です！！\n\n敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！インターネット無料のため毎月の通信費も抑えられます！！\n\nお手隙の際にごゆっくりご確認ください😊！！";
/** r3（エスリード福島）の1通目・ご査収 */
const R3_FIRST = "🌟エスリードレジデンス大阪福島フロント 0205\n\n敷金礼金なし・家賃管理費込85,000円で初期費用をかなり抑えてご入居頂ける点が、YUMAさんにかなりオススメ出来るお部屋となります！！\n\nJR東西線「新福島」駅徒歩3分、環状線「福島」駅徒歩5分と梅田へのアクセスも良好な立地です！！\n\nお手隙の際にご査収ください😊！！";
/** 実送信: 退去予定の物件 */
const VACATING = "🌟UMEDA ILAND REIDENCE 302号室\n\n家賃管理費込80,000円で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n9月30日退去予定のため、10月1日以降にご内覧可能です！！";
/** r4 の2通目（別の物件 Go Palace を持ち出して比べた形・「お気に召されましたら」は実送信の形） */
const R4_SECOND = "Ｇｏ　Ｐａｌａｃｅ　Ｆｕｋｕｓｈｉｍａ203号室は家賃管理費込72,500円で敷金礼金なし、2017年築の角部屋とお値打ちな条件なので、私個人的にはこちらがオススメです😊！！\n\nお気に召されましたらご都合よろしいお日にちにご案内させて頂きます😌！！";
/** r2 の2通目（1通目に無い別の物件・締めなし・受けの一文で終わる） */
const R2_SECOND = "ファーストフィオーレ難波ウエスト901号室は家賃管理費込75,000円の角部屋で、2018年築と築浅です！！\n\n敷金礼金なしで初期費用も抑えられます😊！！\n\n気になる点があれば、いつでもお気軽にご連絡ください😌！！";

const PASS_ALL = { verdict: "pass", reason_codes: ["RENT_OK", "WALK_OK", "FLOOR_PLAN_MATCH", "FIT_ALL", "MOVE_IN_OK", "AREA_STATION_MATCH", "BUILDING_AGE_OK", "AD_HIGH"] };

describe("刺さり具合（採点）", () => {
  it("★ pass・全部合う・外れ寄りなし → 刺さる", () => { expect(appealFromPickup(PASS_ALL)?.appeal).toBe("strong"); });
  it("実物の札（YUMA の採点）に FIT_ALL があっても築の幅・徒歩超過があれば刺さらない", () => {
    expect(appealFromPickup({ verdict: "pass", reason_codes: ["FIT_ALL", "RENT_OK", "BUILDING_AGE_WIDE"] })?.appeal).toBe("weak");
    expect(appealFromPickup({ verdict: "pass", reason_codes: ["FIT_ALL", "WALK_SLIGHTLY_OVER"] })?.appeal).toBe("weak");
  });
  it("hold は刺さらない・全部合うの札が無い pass も刺さらない", () => {
    expect(appealFromPickup({ verdict: "hold", reason_codes: ["FIT_ALL", "MOVE_IN_LATE"] })?.appeal).toBe("weak");
    expect(appealFromPickup({ verdict: "pass", reason_codes: ["RENT_OK", "WALK_OK"] })?.appeal).toBe("weak");
    expect(appealFromPickup({ verdict: "pass", reason_codes: ["FIT_ONE_MISS", "RENT_OK"] })?.appeal).toBe("weak");
  });
  it("採点が読めない（行なし・札なし）→ null（決められない）", () => {
    expect(appealFromPickup(null)).toBe(null);
    expect(appealFromPickup({ verdict: "pass", reason_codes: [] })).toBe(null);
  });
});

describe("締めの種類（3つ）", () => {
  it("★ ① 刺さる＋今内覧できる → 内覧誘導", () => {
    expect(resolveRecommendCta({ pickup: PASS_ALL, notViewable: false }).kind).toBe("viewing");
  });
  it("★ ② 刺さる＋退去予定 → 申込誘導", () => {
    expect(resolveRecommendCta({ pickup: PASS_ALL, notViewable: true }).kind).toBe("apply");
  });
  it("★ ③ そこまで刺さらない → ご査収（退去予定でも申込に誘わない）", () => {
    expect(resolveRecommendCta({ pickup: { verdict: "hold", reason_codes: ["RENT_OK"] }, notViewable: false }).kind).toBe("receipt");
    expect(resolveRecommendCta({ pickup: { verdict: "hold", reason_codes: ["RENT_OK"] }, notViewable: true }).kind).toBe("receipt");
  });
  it("採点も反応も無ければご査収（押しすぎない）", () => {
    expect(resolveRecommendCta({ notViewable: false }).kind).toBe("receipt");
  });
  it("採点が無くお客様が前向きなら刺さる", () => {
    expect(resolveRecommendCta({ reaction: { kind: "positive", positiveKind: "appraisal" }, notViewable: false }).kind).toBe("viewing");
  });
  it("お客様が懸念・条件変更を言っている時は採点が良くても押さない", () => {
    expect(resolveRecommendCta({ pickup: PASS_ALL, reaction: { kind: "concern", positiveKind: null }, notViewable: false }).kind).toBe("receipt");
    expect(resolveRecommendCta({ pickup: PASS_ALL, reaction: { kind: "condition_change", positiveKind: null }, notViewable: false }).kind).toBe("receipt");
  });
  it("採点が刺さらない時は、お客様が前向きでも上書きしない（別の物件への前向きかもしれない）", () => {
    expect(resolveRecommendCta({ pickup: { verdict: "hold", reason_codes: ["RENT_OK"] }, reaction: { kind: "positive", positiveKind: "appraisal" }, notViewable: false }).kind).toBe("receipt");
  });
});

describe("1通目の締めを揃える（出口）", () => {
  it("★ R1 の「ごゆっくりご確認ください」を実送信の形「ご査収」に揃える（本文は落とさない）", () => {
    const r = setRecommendClosing(R1_FIRST, "receipt");
    expect(r.text).toContain("お手隙の際にご査収ください😊！！");
    expect(r.text).notToContain("ごゆっくり");
    expect(r.text).toContain("洋室7帖の1Kで、独立洗面台");
    expect(r.text).toContain("インターネット無料のため毎月の通信費も抑えられます");
    expect(r.text.split("\n\n").length).toBe(R1_FIRST.split("\n\n").length);
  });
  it("★ ① 刺さる: ご査収を内覧誘導（実送信の形）に差し替える", () => {
    const r = setRecommendClosing(R3_FIRST, "viewing");
    expect(r.text).toContain(VIEWING_CLOSING_LINE);
    expect(r.text).notToContain("ご査収");
    expect(r.text).toContain("駅徒歩3分");
  });
  it("★ ② 退去予定: 退去予定の行は残し、申込誘導を足す", () => {
    const r = setRecommendClosing(VACATING, "apply");
    expect(r.text).toContain("9月30日退去予定のため、10月1日以降にご内覧可能です！！");
    expect(r.text).toContain(APPLY_CLOSING_LINE);
    expect(readClosingKind(r.text)).toBe("apply");
  });
  it("③ 退去予定＋刺さらない: 退去予定の行を残してご査収を足す", () => {
    const r = setRecommendClosing(VACATING, "receipt");
    expect(r.text).toContain("10月1日以降にご内覧可能です");
    expect(r.text).toContain(RECEIPT_CLOSING_LINE);
  });
  it("既に同じ締めなら何も変えない（冪等）", () => {
    const once = setRecommendClosing(R3_FIRST, "viewing").text;
    const twice = setRecommendClosing(once, "viewing");
    expect(twice.text).toBe(once);
    expect(twice.applied.length).toBe(0);
  });
  it("申込誘導の実物を内覧誘導に差し替えられる", () => {
    const t = "🌟X 101\n\nかなりオススメ出来るお部屋となります！！\n\nお気に召されましたらお申込しお部屋抑えさせて頂きます！！";
    expect(setRecommendClosing(t, "viewing").text).toContain(VIEWING_CLOSING_LINE);
  });
  it("建築中の通（「※…建築中のため…のみで締める」）は触らない", () => {
    const t = "🌟X 101\n\nかなりオススメ出来るお部屋となります！！\n\n※こちらのお部屋は建築中のため、11月のご入居となります！！";
    expect(setRecommendClosing(t, "receipt").text).toBe(t);
  });
  it("金額・号室を含む段落は締めと見ない（消さない）", () => {
    const t = "🌟X 101\n\nお気に召されましたら家賃85,000円で抑えさせて頂きます";
    const r = setRecommendClosing(t, "receipt");
    expect(r.text).toContain("家賃85,000円で抑えさせて頂きます");
    expect(r.text).toContain(RECEIPT_CLOSING_LINE);
  });
});

describe("2通目", () => {
  it("★ R2 の2通目（受けの一文で終わる）: 内覧誘導は「気になる点があれば」の前に入れて、本文は落とさない", () => {
    const r = setRecommendClosing(R2_SECOND, "viewing");
    const paras = r.text.split("\n\n");
    expect(paras[paras.length - 2]).toBe(VIEWING_CLOSING_LINE);
    expect(paras[paras.length - 1]).toContain("気になる点があれば");
    expect(r.text).toContain("2018年築と築浅です");
  });
  // 2026-10-01 竹内「締めは2通目だけでも大丈夫・構成として」＋了承「実送信の形に合わせる」: 2通目には必ず締め（1通目は締めを書かない）
  it("★ 1通目が同じ締めで終わっていても2通目の指示に締めを出す（旧「重ねない」はやめた）＋別の物件を比べない", () => {
    const d = resolveRecommendCta({ pickup: { verdict: "hold", reason_codes: ["RENT_OK"] }, notViewable: false }); // receipt
    expect(hasClosingKind(R3_FIRST, "receipt")).toBe(true);
    const n = buildSecondMessageCtaNote(d, { firstMessage: R3_FIRST });
    expect(n).notToContain("重ねない");
    expect(n).toContain(RECEIPT_CLOSING_LINE);
    expect(n).toContain("別の物件を持ち出して比べない");
  });
  it("1通目に締めが無ければ2通目の指示に実送信の形を出す", () => {
    const d = resolveRecommendCta({ pickup: PASS_ALL, notViewable: false });
    const n = buildSecondMessageCtaNote(d, { firstMessage: "🌟X 101\n\nかなりオススメ出来るお部屋となります！！" });
    expect(n).toContain(VIEWING_CLOSING_LINE);
  });
  it("R4 の2通目「私個人的にはこちらがオススメ」は指示に写されない（指示に無い）", () => {
    const d = resolveRecommendCta({ pickup: PASS_ALL, notViewable: true });
    const n = buildSecondMessageCtaNote(d, { firstMessage: "🌟FEEL UMEDA 202\n\nかなりオススメ" });
    expect(n).toContain(APPLY_CLOSING_LINE);
    expect(n).toContain("こちらの方が」「私個人的には」も書かない");
  });
});

describe("入口（1通目の指示）", () => {
  it("3つの締めの定型が指示に出る（言い回しを足させない）", () => {
    const a = buildFirstMessageCtaNote(resolveRecommendCta({ pickup: PASS_ALL, notViewable: false }));
    expect(a).toContain(VIEWING_CLOSING_LINE);
    const b = buildFirstMessageCtaNote(resolveRecommendCta({ pickup: PASS_ALL, notViewable: true }), { viewableFrom: "10月1日" });
    expect(b).toContain(APPLY_CLOSING_LINE);
    expect(b).toContain("10月1日以降にご内覧可能");
    const c = buildFirstMessageCtaNote(resolveRecommendCta({ notViewable: false }));
    expect(c).toContain(RECEIPT_CLOSING_LINE);
    expect(c).toContain("言い回しを足さない");
  });
});

describe("1通目の物件に当たる採点の行", () => {
  const rows = [
    { property_name: "SWISS梅田東", room_no: "307", verdict: "pass", reason_codes: ["FIT_ALL"], created_at: "2026-09-30T00:00:00Z" },
    { property_name: "Ｇｏ　Ｐａｌａｃｅ　Ｆｕｋｕｓｈｉｍａ", room_no: "203", verdict: "hold", reason_codes: ["RENT_OK"], created_at: "2026-09-30T00:00:00Z" },
    { property_name: "エスリードレジデンス大阪福島フロント", room_no: "0205", verdict: "pass", reason_codes: ["FIT_ALL"], created_at: "2026-09-30T00:00:00Z" },
  ];
  it("見出しから建物名・号室を読み、同じ部屋の行だけ選ぶ（全角・先頭0の違いを吸収）", () => {
    expect(pickupForFirstMessage(rows, headOfFirstMessage(R1_FIRST))?.property_name).toBe("SWISS梅田東");
    expect(pickupForFirstMessage(rows, headOfFirstMessage(R3_FIRST))?.room_no).toBe("0205");
  });
  it("別の建物・別の号室の行は使わない", () => {
    expect(pickupForFirstMessage(rows, { name: "SWISS梅田東", room: "308" })).toBe(null);
    expect(pickupForFirstMessage(rows, { name: "別の建物", room: "307" })).toBe(null);
    expect(pickupForFirstMessage(rows, null)).toBe(null);
  });
});

// 2026-09-30 YUMA の実送信（S-RESIDENCE福島玉川Deux 208）: 本文が「お気に召しましたら…」（召し）で締めたのを締めと見分けられず、
//   同じ誘導がもう1行足されて2回届いた
describe("締めの言い回しの揺れ（お気に召しましたら）", () => {
  const YUMA_208 = "🌟S-RESIDENCE福島玉川Deux 208号室\n\n2023年10月築で築年数浅く、玉川駅徒歩4分・家賃管理費込81,000円の1K（22.56㎡）で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n独立洗面台や浴室乾燥機も備わっております。空室のため即入居可能です。\n\nお気に召しましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";
  it("★「お気に召しましたら…ご案内」も締めとして読み、誘導を2回にしない", () => {
    const r = setRecommendClosing(YUMA_208, "viewing");
    expect((r.text.match(/ご案内させて頂きます/g) ?? []).length).toBe(1);
  });
  it("ご査収に揃える時は「お気に召しましたら…」の行を置き換える", () => {
    const r = setRecommendClosing(YUMA_208, "receipt");
    expect(/お気に召/.test(r.text)).toBe(false);
    expect(r.text.trimEnd().endsWith("お手隙の際にご査収ください😊！！")).toBe(true);
  });
});

// 2026-09-30 夜 YUMA の実送信（資料が居住中の2件の2通目）: モデルが退去予定の文と同じ行に申込の誘導を続けて書き、
//   「定型だけの段落・行」と見分けられず同じ締めがもう1行足された（申込の誘導が2回届いた）。下の2通は LINE に届いた本文そのまま
describe("締めが本文の行の途中・行末に既にある（文単位で見る）", () => {
  const APPLY = "お気に召されましたらお申込しお部屋抑えさせて頂きます😊！！";
  const BODY_703 = "お送りさせて頂きましたお部屋の中でも特にレオンコンフォート梅田北 703号室がバス・トイレ別・2020年築で築年数浅く、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n退去予定のお部屋となり、2026年11月中旬が最短での入居可能時期となります！！" + APPLY;
  const SENT_703 = BODY_703 + "\n\n" + APPLY; // 実際に届いた形（同じ締めが2回）
  const BODY_107 = "お送りさせて頂きましたお部屋の中でも特にレオパレス天満 107号室が大阪天満宮駅徒歩7分・バス・トイレ別で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n退去予定のお部屋となり、2026年11月中旬が最短での入居可能時期となります！！" + APPLY;
  const count = (t: string) => (t.match(/お申込しお部屋抑えさせて頂きます/g) ?? []).length;
  it("★ レオンコンフォート梅田北 703: モデルの出力（行末に申込の誘導）に同じ締めを足さない", () => {
    const r = setRecommendClosing(BODY_703, "apply");
    expect(r.text).toBe(BODY_703);
    expect(r.applied.length).toBe(0);
    expect(count(r.text)).toBe(1);
  });
  it("★ レオパレス天満 107: 同じ", () => {
    const r = setRecommendClosing(BODY_107, "apply");
    expect(count(r.text)).toBe(1);
    expect(r.applied.length).toBe(0);
  });
  it("★ 実際に届いた形（2回）に当てると、最後の定型だけの段落を落として1回にする（本文は落とさない）", () => {
    const r = setRecommendClosing(SENT_703, "apply");
    expect(count(r.text)).toBe(1);
    expect(r.text).toBe(BODY_703);
  });
  it("行末に申込の誘導がある本文の後ろに、別の種類（内覧の誘導）の定型だけの段落 → その段落だけ落とす", () => {
    const r = setRecommendClosing(BODY_703 + "\n\n" + VIEWING_CLOSING_LINE, "apply");
    expect(r.text).toBe(BODY_703);
  });
  it("hasClosingSentence / hasClosingKind: 行の途中の締めも読む（2通目が1通目の締めを重ねないための確認）", () => {
    expect(hasClosingSentence(BODY_703, "apply")).toBe(true);
    expect(hasClosingSentence(BODY_703, "viewing")).toBe(false);
    expect(hasClosingKind(BODY_703, "apply")).toBe(true);
    expect(hasClosingSentence("10月15日退去予定のため、10月16日以降ご内覧可能となります！！", "viewing")).toBe(false);
    expect(hasClosingSentence("かなりオススメ出来るお部屋となります！！お手隙の際にご査収ください😊！！", "receipt")).toBe(true);
  });
  it("締めがどこにも無い本文には今まで通り足す", () => {
    const body = "お送りさせて頂きましたお部屋の中でも特にレオパレス天満 107号室が大阪天満宮駅徒歩7分で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n退去予定のお部屋となり、11月中旬ごろご入居可能となります！！";
    const r = setRecommendClosing(body, "apply");
    expect(r.text).toBe(body + "\n\n" + APPLY);
  });
  it("午後の実物（お気に召しましたら…の揺れ）も1回のまま", () => {
    const t208 = "🌟S-RESIDENCE福島玉川Deux 208号室\n\n…YUMAさんにかなりオススメ出来るお部屋となります！！\n\nお気に召しましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！\n\n" + VIEWING_CLOSING_LINE;
    const r = setRecommendClosing(t208, "viewing");
    expect((r.text.match(/ご案内させて頂きます/g) ?? []).length).toBe(1);
  });
});

// 2026-10-01 竹内「物件オススメ締めの部分 状況的に2通目だけでも大丈夫・構成として」: 1通目は締めの文を落とす（事実の文は1文字も消さない）
describe("1通目は締めを書かない（removeRecommendClosing）", () => {
  // YUMA に 9/30 15:22 に届いた1通目（実物そのまま）
  const LEON = "🌟レオンコンフォート梅田北 703号室\n\n家賃管理費込75,000円・1K・21.37㎡で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n2020年1月築（築6年）の室内も綺麗な1Kで、独立洗面台や室内洗濯機置場、システムキッチンも備わっております！！収納スペース・シューズボックスもあり収納面もしっかり確保されております！！中崎町駅徒歩9分・中津駅徒歩10分と梅田へも出やすい立地です！！\n\n退去予定のお部屋となり、11月中旬ごろご入居可能となります！！\n\nお気に召されましたらお申込しお部屋抑えさせて頂きます😊！！";
  it("★ 実物（退去予定＋申込の誘導）: 締めの段落だけ落ちて、退去予定の一文で終わる", () => {
    const r = removeRecommendClosing(LEON);
    expect(r.removed.length).toBe(1);
    expect(r.text).toBe(LEON.replace("\n\nお気に召されましたらお申込しお部屋抑えさせて頂きます😊！！", ""));
  });
  it("★ 9/30 13:04 の実物（内覧の誘導が2回）: 2回とも落ちる", () => {
    const t = "🌟S-RESIDENCE福島玉川Deux 208号室\n\n2023年10月築で築年数浅く、玉川駅徒歩4分・家賃管理費込81,000円の1K（22.56㎡）で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\nお気に召しましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！\n\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";
    const r = removeRecommendClosing(t);
    expect(r.removed.length).toBe(2);
    expect(r.text).toBe("🌟S-RESIDENCE福島玉川Deux 208号室\n\n2023年10月築で築年数浅く、玉川駅徒歩4分・家賃管理費込81,000円の1K（22.56㎡）で、YUMAさんにかなりオススメ出来るお部屋となります！！");
  });
  it("ご査収（R3 の1通目）・名前つき（〇〇さんお気に召されましたら）も落ちる", () => {
    expect(removeRecommendClosing(R3_FIRST).text).toBe(R3_FIRST.replace("\n\nお手隙の際にご査収ください😊！！", ""));
    const t = "🌟X 101\n\n家賃管理費込77,500円の2DKとなります！！\n\n327さんお気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！";
    expect(removeRecommendClosing(t).text).toBe("🌟X 101\n\n家賃管理費込77,500円の2DKとなります！！");
  });
  it("同じ行の事実の文は残して締めの文だけ落とす", () => {
    const t = "🌟X 101\n\n空室のため即入居可能です！！お手隙の際にご査収ください😊！！";
    expect(removeRecommendClosing(t).text).toBe("🌟X 101\n\n空室のため即入居可能です！！");
  });
  it("文の途中から誘導に続く文（〜ので、お気に召されましたら）・見積書の行は触らない", () => {
    const t1 = "🌟X 101\n\n空室・即入居可能のお部屋となりますので、静岡さんお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";
    expect(removeRecommendClosing(t1).removed.length).toBe(0);
    const t2 = "🌟X 101\n\nインターネット無料で毎月の通信費も抑えられます！！\n\n🌟最大限割引しました初期費用の御見積書同封させて頂きました！";
    expect(removeRecommendClosing(t2).text).toBe(t2);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
