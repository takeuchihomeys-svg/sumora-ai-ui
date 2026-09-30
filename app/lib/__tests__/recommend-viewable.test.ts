// 実行: npx tsx app/lib/__tests__/recommend-viewable.test.ts
// 2026-10-01 竹内さんの YUMA の実送信: 資料が「現況居住中 入居可能時期2026年11月中旬」の2件（property_pickups id 2678 レオンコンフォート梅田北 703・
//   id 2670 レオパレス天満 107）で、1通目が退去予定に触れず内覧の誘導で締め、2通目は「退去予定…お申込し」＝食い違った。
//   下の terms.moveIn は DB の行そのまま。
import { readMaterialViewable, resolveRecommendViewable, buildVacatingLineNote, ensureVacatingLine, mentionsVacating, tidyVacatingAndClosing, type ViewableMaterialRow } from "../recommend-viewable";
import { resolveRecommendCta, setRecommendClosing, buildFirstMessageCtaNote, APPLY_CLOSING_LINE, RECEIPT_CLOSING_LINE } from "../recommend-cta";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }

const NOW = Date.parse("2026-10-01T03:00:00Z"); // 2026-10-01 12:00 JST
// ── DB の行そのまま ──
const ROW_2678: ViewableMaterialRow = { terms: { moveIn: { date: "2026-11", kind: "date", part: "中旬", current: "occupied", availableFrom: "2026-11-11" }, evidence: { moveIn: "現況居住中 入居可能時期2026年11月中旬" } } };
const ROW_2670: ViewableMaterialRow = { terms: { moveIn: { date: "2026-11", kind: "date", part: "中旬", current: "occupied", availableFrom: "2026-11-11" }, evidence: { moveIn: "現況居住中 入居可能時期2026年11月中旬" } } };
const ROW_2675: ViewableMaterialRow = { terms: { moveIn: { kind: "immediate", current: "vacant", availableFrom: "2026-09-30" }, evidence: { moveIn: "現況空き 入居可能時期即入居可" } } };
const ROW_2671: ViewableMaterialRow = { terms: { moveIn: { kind: "consult", current: "occupied", availableFrom: null }, evidence: { moveIn: "現況居住中 入居可能時期相談" } } };
const ROW_2668: ViewableMaterialRow = { terms: { moveIn: { kind: "occupied", current: "occupied", availableFrom: null }, evidence: { moveIn: "現況居住中 入居可能時期ー" } } };
const ROW_2674: ViewableMaterialRow = { terms: { moveIn: { date: "2026-10", kind: "date", part: "下旬", current: "vacant", availableFrom: "2026-10-21" }, evidence: { moveIn: "現況空き 入居可能時期2026年10月下旬" } } };
// リアプロの資料の形（property_pickups の直近14日の実物の形）
const ROW_RP_DATE: ViewableMaterialRow = { terms: { moveIn: { kind: "consult", current: "leaving", availableFrom: null }, evidence: { moveIn: "退去予定(10/17)/相談" } } };
const ROW_RP_PAST: ViewableMaterialRow = { terms: { moveIn: { kind: "consult", current: "leaving", availableFrom: null }, evidence: { moveIn: "退去予定(9/20)/相談" } } };
const ROW_ODD: ViewableMaterialRow = { terms: { moveIn: { kind: "immediate", current: "occupied", availableFrom: "2026-09-30" }, evidence: { moveIn: "現況居住中 入居可能時期即入居可" } } };
const ROW_BUILD: ViewableMaterialRow = { terms: { moveIn: { kind: "date", current: null, availableFrom: "2026-10-01" }, evidence: { moveIn: "建築中/2026年10月01日" } } };

const LINE_NOV = "退去予定のお部屋となり、11月中旬ごろご入居可能となります！！";

console.log("\n■ readMaterialViewable（資料の現況 → 今ご内覧頂けるか・退去予定の一文）");
{
  const a = readMaterialViewable(ROW_2678, NOW);
  t("★ 2678 レオンコンフォート梅田北 703（居住中・11月中旬）→ 内覧できない・一文は実送信の形", a.notViewable === true && a.line === LINE_NOV && a.moveInWhen === "11月中旬", JSON.stringify(a));
  t("★ 2670 レオパレス天満 107 も同じ", readMaterialViewable(ROW_2670, NOW).line === LINE_NOV);
  t("一文に年・「居住中」・「最短での入居可能時期」を書かない", !/2026|居住中|最短/.test(a.line ?? ""));
  t("★ 2675 プレサンス梅田北（空き・即入居可）→ 内覧できる・一文なし", readMaterialViewable(ROW_2675, NOW).notViewable === false && readMaterialViewable(ROW_2675, NOW).line === null);
  t("空きで入居可能が10月下旬 → 内覧できる（空室）", readMaterialViewable(ROW_2674, NOW).notViewable === false);
  t("居住中・入居可能時期 相談／ー → 内覧できない・一文は「退去予定のお部屋となります！！」だけ（時期を作らない）", readMaterialViewable(ROW_2671, NOW).line === "退去予定のお部屋となります！！" && readMaterialViewable(ROW_2668, NOW).line === "退去予定のお部屋となります！！" && readMaterialViewable(ROW_2671, NOW).notViewable === true);
  const rp = readMaterialViewable(ROW_RP_DATE, NOW);
  t("リアプロ「退去予定(10/17)/相談」→ 退去日から: 「10月17日退去予定のため、10月18日以降ご内覧可能となります！！」", rp.notViewable === true && rp.line === "10月17日退去予定のため、10月18日以降ご内覧可能となります！！" && rp.viewableFrom === "10月18日", JSON.stringify(rp));
  const past = readMaterialViewable(ROW_RP_PAST, NOW);
  t("退去予定日がもう過ぎている → 内覧できる（一文なし）", past.notViewable === false && past.line === null, JSON.stringify(past));
  t("居住中なのに即入居可（資料が食い違う）・建築中・行なし → 決めない（null）", readMaterialViewable(ROW_ODD, NOW).notViewable === null && readMaterialViewable(ROW_BUILD, NOW).notViewable === null && readMaterialViewable(null, NOW).notViewable === null && readMaterialViewable({}, NOW).notViewable === null);
}

console.log("\n■ resolveRecommendViewable（本文 → 資料 → ブレインの順・1通目と2通目が同じ関数）");
{
  const brainOk = { notViewable: false, viewableFrom: null };
  const v1 = resolveRecommendViewable({ text: null, material: ROW_2678, brain: brainOk, nowMs: NOW });
  t("★ 1通目（本文なし）: ブレインが「内覧できる」でも、資料が居住中なら内覧できない", v1.notViewable === true && v1.source === "material" && v1.line === LINE_NOV);
  const FIRST_NEW = "🌟レオンコンフォート梅田北 703号室\n\n…YUMAさんにかなりオススメ出来るお部屋となります！！\n\n" + LINE_NOV + "\n\n" + APPLY_CLOSING_LINE;
  const v2 = resolveRecommendViewable({ text: FIRST_NEW, material: ROW_2678, brain: brainOk, nowMs: NOW });
  t("★ 2通目（1通目の本文に退去日なし）: 同じ資料から同じ答え（1通目と食い違わない）", v2.notViewable === v1.notViewable && v2.line === v1.line && v2.source === "material");
  const v3 = resolveRecommendViewable({ text: "10月15日退去予定のため、10月16日以降ご内覧可能です！！", material: ROW_2675, brain: brainOk, nowMs: NOW });
  t("本文に退去予定日がある → それが先（資料が空きでも）・一文は作らない（本文に既にある）", v3.notViewable === true && v3.source === "text" && v3.viewableFrom === "10月16日" && v3.line === null, JSON.stringify(v3));
  const v4 = resolveRecommendViewable({ text: null, material: ROW_2675, brain: { notViewable: true, viewableFrom: "10月16日" }, nowMs: NOW });
  t("★ 資料が空き → ブレイン（会話全体＝別の物件の退去予定）より資料が先＝内覧できる", v4.notViewable === false && v4.source === "material" && v4.line === null);
  const v5 = resolveRecommendViewable({ text: null, material: null, brain: { notViewable: true, viewableFrom: "10月16日" }, nowMs: NOW });
  t("資料の行が無い（手で画像を入れた AIX）→ 今まで通りブレインの判断", v5.notViewable === true && v5.source === "brain" && v5.viewableFrom === "10月16日");
}

console.log("\n■ 締めの種類（resolveRecommendCta）と1通目の指示");
{
  const FIT = { verdict: "pass", reason_codes: ["RENT_OK", "FIT_ALL"] };
  const v = resolveRecommendViewable({ text: null, material: ROW_2678, brain: { notViewable: false, viewableFrom: null }, nowMs: NOW });
  const d = resolveRecommendCta({ pickup: FIT, reaction: null, notViewable: v.notViewable });
  t("★ 刺さる＋資料が居住中 → 申込の誘導（内覧の誘導ではない）", d.kind === "apply");
  t("刺さらない＋資料が居住中 → ご査収", resolveRecommendCta({ pickup: { verdict: "pass", reason_codes: ["RENT_OK", "RENT_BAND_LOW", "FIT_ALL"] }, reaction: null, notViewable: v.notViewable }).kind === "receipt");
  const v0 = resolveRecommendViewable({ text: null, material: ROW_2675, brain: { notViewable: false, viewableFrom: null }, nowMs: NOW });
  t("刺さる＋空室 → 内覧の誘導（今まで通り）", resolveRecommendCta({ pickup: FIT, reaction: null, notViewable: v0.notViewable }).kind === "viewing");
  const note = buildVacatingLineNote(v);
  t("退去予定の一文の指示: 一文をそのまま・内覧の誘導を書かない・即入居可能を書かない", note.includes(`「${LINE_NOV}」`) && note.includes("内覧の誘導") && note.includes("即入居可能"));
  t("空室・ブレインが出どころの時は指示なし", buildVacatingLineNote(v0) === "" && buildVacatingLineNote({ notViewable: true, viewableFrom: "10月16日", line: null, source: "brain" }) === "");
  t("1通目の締めの指示（申込）と並べて食い違わない", buildFirstMessageCtaNote(d, { viewableFrom: v.viewableFrom }).includes(APPLY_CLOSING_LINE));
}

console.log("\n■ ensureVacatingLine（出口・足すだけ）");
{
  const v = resolveRecommendViewable({ text: null, material: ROW_2678, brain: { notViewable: false, viewableFrom: null }, nowMs: NOW });
  // 9/30 夜に YUMA に実際に届いた1通目の形（退去予定に触れず内覧の誘導）を、締めを申込に揃えた後の形
  const FIRST_703 = "🌟レオンコンフォート梅田北 703号室\n\n2020年築で築年数浅く、家賃管理費込82,000円・バス・トイレ別で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";
  const closed = setRecommendClosing(FIRST_703, "apply").text;
  const r = ensureVacatingLine(closed, v);
  t("★ 1通目: 内覧の誘導 → 申込の誘導に揃え、退去予定の一文を締めの直前に入れる", r.added && r.text === `🌟レオンコンフォート梅田北 703号室\n\n2020年築で築年数浅く、家賃管理費込82,000円・バス・トイレ別で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n${LINE_NOV}\n\n${APPLY_CLOSING_LINE}`, r.text);
  t("内覧の誘導が残らない", !/ご都合よろしいお日にちに/.test(r.text));
  const r2 = ensureVacatingLine(r.text, v);
  t("本文が既に退去予定に触れていれば何もしない（2回入れない）", !r2.added && r2.text === r.text);
  const rc = ensureVacatingLine(setRecommendClosing(FIRST_703, "receipt").text, v);
  t("ご査収の時も締めの直前に入れる", rc.added && rc.text.endsWith(`${LINE_NOV}\n\n${RECEIPT_CLOSING_LINE}`), rc.text);
  const noClose = ensureVacatingLine("お送りさせて頂きましたお部屋の中でも特にレオパレス天満 107号室が大阪天満宮駅徒歩7分で、YUMAさんにかなりオススメ出来るお部屋となります😊！！", v);
  t("締めの段落が無い本文（2通目）→ 最後の段落として足す", noClose.added && noClose.text.endsWith(`\n\n${LINE_NOV}`));
  const v0 = resolveRecommendViewable({ text: null, material: ROW_2675, brain: { notViewable: false, viewableFrom: null }, nowMs: NOW });
  t("空室の物件には何もしない", !ensureVacatingLine(FIRST_703, v0).added && ensureVacatingLine(FIRST_703, v0).text === FIRST_703);
  t("ブレインが出どころ（一文が無い）の時は何もしない", !ensureVacatingLine(FIRST_703, { notViewable: true, viewableFrom: "10月16日", line: null, source: "brain" }).added);
  t("mentionsVacating: 退去予定・退去後・ご退去 を読む／入居可能だけでは読まない", mentionsVacating("9月末退去予定のお部屋") && mentionsVacating("お気に召されましたら退去後お部屋ご案内") && !mentionsVacating("即入居可能です") && !mentionsVacating(null));
}

console.log("\n■ tidyVacatingAndClosing（退去予定の一文の字を戻す・同じ行の締めを次の段落に分ける）");
{
  const v = resolveRecommendViewable({ text: null, material: ROW_2678, brain: { notViewable: false, viewableFrom: null }, nowMs: NOW });
  // 2026-10-01 ローカル生成（1通目・DeepSeek）で出た最後の段落そのまま
  const HEAD = "🌟レオンコンフォート梅田北 703\n\n家賃管理費込75,000円・2020年1月築（築6年）で独立洗面台や室内洗濯機置場も備わったお部屋で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\n";
  const GEN = HEAD + "退去予定のお部屋となり、11月中旬ご入居可能となります！！お気に召されましたらお申込しお部屋抑えさせて頂きます😊！！";
  const r = tidyVacatingAndClosing(GEN, v);
  t("★「ごろ」抜けを決まった一文に戻し、同じ行の締めを次の段落に分ける", r.text === HEAD + LINE_NOV + "\n\n" + APPLY_CLOSING_LINE && r.applied.includes("closing_split") && r.applied.includes("vacating_line_exact"), r.text);
  t("そのあと締めを揃えても1回のまま", setRecommendClosing(r.text, "apply").text === r.text);
  // 9/30 夜に YUMA に届いた2通目の最後の段落（古い言い方「最短での入居可能時期」は別の内容なので字は触らない・締めだけ分ける）
  const OLD = "…かなりオススメ出来るお部屋となります！！\n\n退去予定のお部屋となり、2026年11月中旬が最短での入居可能時期となります！！お気に召されましたらお申込しお部屋抑えさせて頂きます😊！！";
  const ro = tidyVacatingAndClosing(OLD, v);
  t("別の言い方の退去予定の文は書き換えない（締めだけ次の段落へ）", ro.text === "…かなりオススメ出来るお部屋となります！！\n\n退去予定のお部屋となり、2026年11月中旬が最短での入居可能時期となります！！\n\n" + APPLY_CLOSING_LINE, ro.text);
  const ok = HEAD + LINE_NOV + "\n\n" + APPLY_CLOSING_LINE;
  t("整っている文は何もしない", tidyVacatingAndClosing(ok, v).applied.length === 0 && tidyVacatingAndClosing(ok, v).text === ok);
  const real = "お世話になっております！！\n今月末退去予定でかなりオススメ出来る条件のお部屋募集に出ました😊！！\nお気に召されましたらお申込しお部屋抑えさせて頂きます！！\nお手隙の際にご査収ください😌！！";
  t("実送信（締めが行ごとに分かれている）は何もしない", tidyVacatingAndClosing(real, null).text === real);
  const real2 = "新着でオススメ出来るお部屋が募集に出ました😊！！\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！お手隙の際にご査収ください！";
  t("実送信（締めの文が2つ同じ行）は分けない", tidyVacatingAndClosing(real2, null).text === real2);
  t("文の数・字は減らない（分けるだけ）", r.text.replace(/\s/g, "").length >= GEN.replace(/\s/g, "").length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
