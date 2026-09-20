// app/lib/__tests__/post-apply-scene.test.ts
// 実行: npx tsx app/lib/__tests__/post-apply-scene.test.ts（自己完結ハーネス。全 PASS で exit 0）
//
// 2026-09-20 竹内「ブレインで足りていない部分はあるかな？実際スタッフが送る返信を生成する為にも」→「直す」
//
// 調査（scripts/find-brain-gaps.ts → audit-staff-other2.ts → audit-rule-effect.ts）で分かったこと:
//   ・返信生成が起きる場面 2,459件（30日・本番と同じ条件＝行動台帳あり）のうち
//     **直前スタッフ発言が other なのが 674件（27.4%）**
//   ・その中身は申込**後**の手続きに集中（apply_push は「打診」であって申込後ではない）
//   ・セルの有無で質が変わる（reply_context_snapshot の ruleId × was_ai_used）:
//     セルあり 44.4% 対 なし 24.6%／**直前=other なら 56.8% 対 8.3%**
//
// 直し: StaffTurnKind に docs_request / apply_done / screening_wait を足し、
//       それぞれに customer:"*" のセル（DR_ANY / AD_ANY / SW_ANY）を作った。
// このテストでいちばん大事なのは「**既存の分類が1件も変わらない**」こと（新しい判定は全判定の後に置いた）。
import {
  classifyLastStaffTurn, analyzeSubstance, classifyCustomerResponse, resolveTurnPair,
  STAFF_DOCS_REQUEST_RE, STAFF_APPLY_DONE_RE, STAFF_SCREENING_WAIT_RE,
  PAIR_MATRIX, STAFF_KIND_JA, fillPairPlaceholders, selectPairExample,
} from "../reply-context";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が無い`); },
    notToContain(sub: string) { if (String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が入ってはいけない`); },
  };
}
const kindOf = (text: string) => classifyLastStaffTurn(text, { recentAixRows: [], lastStaffAt: "2026-09-20T00:00:00Z" }).kind;

console.log("\n── ★ 退行がない（これまで分類できていた物は1件も変わらない）──");

// 本番の実送信から採った、既存の各 kind の代表文
const UNCHANGED: Array<[string, string]> = [
  ["viewing_invite", "かしこまりました！！\nお部屋ご案内させて頂きます！！\n直近ですと 9/14(月) 12:00〜14:00 ご案内可能です😊！！"],
  ["estimate_send", "【エストレーラ 305号室】\n初期費用の御見積書お送りさせて頂きます！！\nお手隙の際にご査収ください😌！！"],
  ["pickup_declared", "かしこまりました！！\n大阪市内に絞らせて頂き、オススメできるお部屋ピックアップさせて頂きます！！"],
  ["condition_ask", "お部屋探しのご条件お聞かせください😊！！"],
  ["apply_push", "お気に召されましたらお申込しお部屋抑えさせて頂きます！！"],
  ["farewell_ack", "この度はありがとうございました！！\nまたお部屋探しの際はいつでもお声がけください😌！！"],
  ["property_send", "🌟リアライズ小路 904\n（オススメポイント）\n・家賃77,000円・管理費10,000円\nお手隙の際にご査収ください😌！！"],
];
for (const [want, text] of UNCHANGED) {
  it(`★ 「${text.slice(0, 20)}…」は ${want} のまま`, () => { expect(String(kindOf(text))).toBe(want); });
}

it("★ 質問（末尾が疑問形）は question_to_customer のまま — 書類の語が入っていても取られない", () => {
  expect(kindOf("身分証明書はお持ちでしょうか？")).toBe("question_to_customer");
});

it("★ 拾わないと決めた形: 受領の感謝が主で、依頼が「ご住所…お送りの程」だけの文", () => {
  // 本物（Sky さん）。「ご住所」「勤務先」まで書類名に含めると
  //   「気になるお部屋ございましたらお送りの程」（物件の依頼）まで巻き込むので**意図的に拾わない**。
  //   設計知見「入口は厳しく」: 拾えない物が残っても、誤分類を作らない方を採る。
  expect(kindOf("Skyさん\nご情報お送りいただきありがとうございます😊！！\n\n大阪での転勤先のご住所分かりましたらお送りの程よろしくお願いいたします！！")).toBe("other");
});

it("★ 条件ヒアリングは condition_ask のまま", () => {
  expect(kindOf("こちらにご条件ご入力頂きますとオススメできるお部屋ピックアップしお送りさせて頂きます！！\nよろしければお手隙の際にご入力ください")).toBe("condition_ask");
});

console.log("\n── ★ 申込後の3場面（本物の実送信）──");

const DOCS: string[] = [
  "かしこまりました！！\nRODGE江坂お申し込みさせていただきます😊！！\n\nお申込みフォーマットのご入力と身分証明書の表裏のお写真お送りいただけましたらお申込み完了となります！！",
  "お送りいただきありがとうございます！！\n\n・お子様のお名前、フリガナ、生年月日、性別\n・連帯保証人様のご情報\n・隼斗さん、連帯保証人様の身分証明書表裏のお写真",
  "ほのかさんお世話になっております！！\n現在お申込が完了していない状況となります！！\n・緊急連絡先様情報\n・ほのかさんの本人確認書類",
];
for (const t of DOCS) it(`★ 書類の依頼:「${t.split("\n").pop()?.slice(0, 22)}…」→ docs_request`, () => { expect(kindOf(t)).toBe("docs_request"); });

const DONE: string[] = [
  "Skyさん\n無事1番手でお申込み完了しております😊！！\n審査の進捗あり次第ご連絡させていただきます😌！！",
  "はるかさん\nご対応ありがとうございます😊！！\n管理会社に無事お申込み完了しているかと申込み番手確認させていただきます！！",
];
for (const t of DONE) it(`★ 申込完了の報告:「${t.split("\n")[1]?.slice(0, 22)}…」→ apply_done`, () => {
  const k = kindOf(t);
  if (k !== "apply_done" && k !== "screening_wait") throw new Error(`apply_done か screening_wait を期待したが ${k}`);
});

const WAIT: string[] = [
  "審査の進捗あり次第ご連絡させていただきます😌！！",
  "保証会社より本人確認のお電話がございますので、ご対応のほどよろしくお願いいたします！！",
  "お申込み後保証会社の審査に移ります。（審査期間3日〜1週間）",
];
for (const t of WAIT) it(`★ 審査の進捗待ち:「${t.slice(0, 24)}…」→ screening_wait`, () => { expect(kindOf(t)).toBe("screening_wait"); });

console.log("\n── ★ セルが選ばれる（ここが効果の本体）──");

const pairOf = (staffText: string, custText: string) => {
  const staff = classifyLastStaffTurn(staffText, { recentAixRows: [], lastStaffAt: "2026-09-20T00:00:00Z" });
  const sub = analyzeSubstance(custText, undefined, { staffAskedQuestion: staff.kind === "question_to_customer" });
  const cust = classifyCustomerResponse(sub, staff, {});
  return resolveTurnPair(staff, cust, sub, staffText, { customerName: "テスト" });
};

it("★ 書類の依頼 → お客様が書類を送った（other）でセルが選ばれる", () => {
  const p = pairOf(DOCS[1], "林明人　ハヤシアキト\n1963年　昭和38年10月9日");
  expect(p.ruleId).toBe("DR_ANY");
});

it("★ 書類の依頼 → 画像だけ（other）でもセルが選ばれる", () => {
  const p = pairOf(DOCS[0], "[画像] 本人確認書類");
  expect(p.ruleId).toBe("DR_ANY");
});

it("★ 審査の進捗待ち → 「どうなりましたでしょうか？」でセルが選ばれる", () => {
  const p = pairOf(WAIT[0], "どうなりましたでしょうか？");
  if (!p.ruleId) throw new Error("セルが選ばれなかった");
});

it("★ 既存の ANY_* が勝つ（優先順位 ②staff:* × customer一致 が ③staff一致 × customer:* より先）", () => {
  // 条件変更は ANY_CONDITION_CHANGE が拾う。DR_ANY に奪わせない
  const p = pairOf(DOCS[0], "やっぱり家賃8万円以内でお願いします！");
  if (p.ruleId === "DR_ANY") throw new Error("DR_ANY が既存セルを奪った");
});

console.log("\n── ★ セルが渡す文が安全（創作させない）──");

it("★ DR_ANY の必須要素は「受け止め」1つだけ（文を足す指示を増やさない）", () => {
  const r = PAIR_MATRIX.find((x) => x.id === "DR_ANY")!;
  expect(r.mustInclude.length).toBe(1);
  expect(r.mustInclude[0].label).toContain("受け止め");
});

it("★ 3セルとも「新しい物件の提案」「内覧のご案内提案」を禁止している（申込中に別の話を持ち出さない）", () => {
  for (const id of ["DR_ANY", "AD_ANY", "SW_ANY"]) {
    const r = PAIR_MATRIX.find((x) => x.id === id)!;
    const mn = r.mustNot.join("／");
    if (!/新しい物件の提案/.test(mn)) throw new Error(`${id} に物件提案の禁止が無い`);
    if (!/内覧のご案内提案/.test(mn)) throw new Error(`${id} に内覧提案の禁止が無い`);
  }
});

it("★ AD_ANY / SW_ANY は審査の結果・日数の断言を禁止している（会話の外の事実を創作させない）", () => {
  for (const id of ["AD_ANY", "SW_ANY"]) {
    const r = PAIR_MATRIX.find((x) => x.id === id)!;
    if (!/断言/.test(r.mustNot.join("／"))) throw new Error(`${id} に断言の禁止が無い`);
  }
});

it("★ DR_ANY は履歴に無い書類名の創作を禁止している", () => {
  const r = PAIR_MATRIX.find((x) => x.id === "DR_ANY")!;
  expect(r.mustNot.join("／")).toContain("創作禁止");
});

it("★ 例文に他のお客様の名前・物件名が入っていない", () => {
  for (const id of ["DR_ANY", "AD_ANY", "SW_ANY"]) {
    const r = PAIR_MATRIX.find((x) => x.id === id)!;
    for (const s of [r.example, r.exampleFallback ?? ""]) {
      if (/[ぁ-んァ-ヶ一-龥]{2,6}さん/.test(s.replace(/〇〇さん|\{name\}/g, ""))) throw new Error(`${id} の例文に名前: ${s}`);
      if (/【[^】]{3,}】|号室/.test(s)) throw new Error(`${id} の例文に物件名: ${s}`);
    }
  }
});

it("★ 実際に渡る文にプレースホルダが残らない", () => {
  const p = pairOf(DOCS[0], "[画像] 本人確認書類");
  const ex = selectPairExample(p, "[画像] 本人確認書類");
  const all = [fillPairPlaceholders(p.rule?.direction ?? "", p), ex.text ?? "",
    ...(p.rule?.mustInclude ?? []).map((m) => fillPairPlaceholders(m.fix, p))].join("\n");
  expect(all).notToContain("{name}");
  expect(all).notToContain("〇〇さん");
});

console.log("\n── 新しい種類が全部の表に載っている（分類を増やしたら出口も定義する）──");

it("★ 日本語ラベルが3種類とも定義されている（往復文脈の summary に出る）", () => {
  for (const k of ["docs_request", "apply_done", "screening_wait"] as const) {
    if (!STAFF_KIND_JA[k]) throw new Error(`STAFF_KIND_JA に ${k} が無い`);
  }
});

it("★ 3種類ともセルを持っている（下流の落ちる列がある）", () => {
  for (const k of ["docs_request", "apply_done", "screening_wait"]) {
    if (!PAIR_MATRIX.some((r) => r.staff === k)) throw new Error(`${k} のセルが無い`);
  }
});

console.log("\n── ★ 全件監査で見つけた誤分類（直した形を固定する）──");

it("★ 申込**前**の保証会社の説明は screening_wait にしない", () => {
  // 本物。旧 regex は「保証会社…審査」で拾って、審査が動いている場面と混同していた
  expect(kindOf("エスポワールの保証会社　株式会社Casaという独立系の保証会社となり比較的審査通過しやすいお部屋となります😊！！")).toBe("other");
  expect(kindOf("過去滞納歴ある方でも独立系の保証会社となりますので審査通過する可能性も十分にございます😊！！")).toBe("other");
});

it("★ 進行中の審査は今までどおり拾う", () => {
  expect(kindOf("管理会社に確認させていただき未だ保証会社審査中とのご返事でした。\n審査催促させていただきました😊！！")).toBe("screening_wait");
  expect(kindOf("お父様に保証会社より本人確認のお電話がございます！！")).toBe("screening_wait");
});

console.log("\n── ★ 実送信と突き合わせて直した所（2026-09-20 竹内「実際送ったのと比べてまちがったのが出る可能性」）──");

it("★ AD_ANY の必須は「質問への回答」でも満たせる（受け止めだけを必須にしない）", () => {
  const r = PAIR_MATRIX.find((x) => x.id === "AD_ANY")!;
  const m = r.mustInclude[0];
  // 本物の実送信（申込完了の報告の後、お客様の番手の質問に答えた文）
  const real = "1番手お申込み中の方がキャンセルもしくは審査否決の場合に2番手お申込み者の方が1番手に繰り上がり審査開始となります！！";
  if (!m.detect.test(real)) throw new Error(`実送信が必須を満たさない: ${real.slice(0, 40)}`);
  // 受け止めの形も今までどおり満たす
  for (const s of ["はい😊！！", "かしこまりました！！", "承知いたしました"]) {
    if (!m.detect.test(s)) throw new Error(`受け止めが満たせない: ${s}`);
  }
});

it("★ AD_ANY と SW_ANY は同じ考え方（受け止め or 事実での回答）で揃っている", () => {
  for (const id of ["AD_ANY", "SW_ANY"]) {
    const r = PAIR_MATRIX.find((x) => x.id === id)!;
    if (!/回答/.test(r.mustInclude[0].label)) throw new Error(`${id} が回答を認めていない`);
  }
});

console.log("\n── regex の歯止め（広げすぎない）──");

it("★ ふつうの物件紹介・内覧案内に当たらない", () => {
  const safe = [
    "🌟リアライズ小路 904\n・家賃77,000円・管理費10,000円\nお手隙の際にご査収ください😌！！",
    "明日16時お部屋ご案内させて頂きます！！",
    "かしこまりました！！\n募集状況確認させて頂きます！！",
    "最大限割引しました初期費用の御見積書お送りさせて頂きます！！",
  ];
  for (const s of safe) {
    for (const [n, re] of [["DOCS", STAFF_DOCS_REQUEST_RE], ["DONE", STAFF_APPLY_DONE_RE], ["WAIT", STAFF_SCREENING_WAIT_RE]] as Array<[string, RegExp]>) {
      if (re.test(s)) throw new Error(`${n} が「${s.slice(0, 26)}…」に当たった`);
    }
  }
});

console.log(`\n${failed === 0 ? "✅ 全 PASS" : "❌ 失敗あり"}  ${passed} passed / ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
