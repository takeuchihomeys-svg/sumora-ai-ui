// 2026-09-15 竹内（H 事例）: AIX【電話する】（電話をかける／電話終了後）の判定・文・数字の照合
// 実行: npx tsx app/lib/__tests__/phone-call.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { customerRequestsPhoneCall, buildCallRequestText, isValidLineCallUrl, buildCallRequestFlex, maskNumbersNotInNotes, CALL_BUTTON_MESSAGE_TEXT } from "../phone-call";
import { detectAixSceneEvidence } from "../aix-scene-evidence";
import { normalizeAixActionKey, AIX_STAFF_NOTES } from "../aix-taxonomy";
import { aixLedgerKind } from "../action-ledger";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

// ─── お客様が電話で話したいか（実データの発言） ───
const YES = [
  "ご相談があるのですがお電話では無理でしょうか？",
  "本日電話いける時間ありますか？",
  "本日電話連絡いける時間を教えてもらえますか？",
  "物件の事で聞きたい事がありますのでお手隙の際電話いけますか？",
  "竹内さん、ご返信ありがとうございます。不動産屋さんから多数横やりが入り困惑してます。1度お電話いただけませんか？",
  "明日の17時頃ご相談したいことがありましてお電話よろしいでしょうか",
  "お世話になっております。\n本日の13時からお電話可能でしょうか？",
  "鍵の件で本日中にお電話頂けると幸いです。",
  "今お電話できますか？",
];
const NO = [
  "管理会社様のお電話番号教えていただいてもよろしいでしょうか",
  "すまえるとゆう会社から電話ありました！",
  "一旦電話は大丈夫です",
  "電話大丈夫です",
  "はい！あと、今の家の解約について詳細聞くには長谷工ライフネットに電話すればいいですか？",
  "こちらのガス、電気にお電話してもよろしいでしょうか？",
  "不動産賃貸借契約書の\n電話はどちらも記入した方がいいでしょうか？💭",
  "電子契約はどなたにお電話したらいいですかね？",
  "03 4221 0317\nから電話あったのですが、申し込みの件ですかね？",
  "10時半頃に電話かけさせて頂きます。",
  "今はちょっと電話できません",
];
for (const t of YES) it(`電話の依頼: ${t.replace(/\n/g, " ").slice(0, 30)}`, () => expect(customerRequestsPhoneCall(t)).toBe(true));
for (const t of NO) it(`電話の依頼ではない: ${t.replace(/\n/g, " ").slice(0, 30)}`, () => expect(customerRequestsPhoneCall(t)).toBe(false));

// ─── 電話をかける: 案内文 ───
it("お客様から電話の依頼 → スタッフの実送信（H 9/15）と同じ", () => expect(buildCallRequestText({ customerAsked: true, customerName: "H" })).toBe("お電話大丈夫です😊！！\nこちらの電話をかけるボタンよりお電話お願い致します！！"));
it("こちらから用件つきでご案内", () => expect(buildCallRequestText({ customerAsked: false, customerName: "いぬい", purpose: "審査のお打ち合わせ" })).toBe("いぬいさん\n審査のお打ち合わせにつきましてお電話にてご説明させて頂きます😊！！\nお手隙の際にこちらの電話をかけるボタンよりお電話お願い致します！！"));
it("用件なし・こちらから", () => expect(buildCallRequestText({ customerAsked: false, customerName: "H" })).toBe("Hさん\nお手隙の際にこちらの電話をかけるボタンよりお電話お願い致します😊！！"));

// ─── 通話URL・カード ───
it("通話URL は line.me / lin.ee の https だけ", () => {
  expect(isValidLineCallUrl("https://lin.ee/AbCdEf1")).toBe(true);
  expect(isValidLineCallUrl("https://line.me/R/xxx")).toBe(true);
  expect(isValidLineCallUrl("http://lin.ee/AbCdEf1")).toBe(false);
  expect(isValidLineCallUrl("https://example.com/call")).toBe(false);
  expect(isValidLineCallUrl("")).toBe(false);
});
it("カードの「電話をかける」ボタンの行き先が通話URL", () => {
  const f = buildCallRequestFlex("https://lin.ee/AbCdEf1") as { type: string; contents: { footer: { contents: Array<{ action: { type: string; label: string; uri: string } }> } } };
  expect(f.type).toBe("flex");
  expect(f.contents.footer.contents[0].action.uri).toBe("https://lin.ee/AbCdEf1");
  expect(f.contents.footer.contents[0].action.label).toBe("電話をかける");
});

// ─── 電話終了後: メモに無い数字は伏せる ───
const notes = "独立系の保証会社中心に探す\n家賃8万円以内・リビング12帖・洋室6帖\n審査通過後に内覧を推奨\n保証会社通過まではキャンセル料不要";
it("メモの数字だけなら伏せない（全角の「！！」も変えない）", () => {
  const t = "お電話有難うございました😊！！\n家賃8万円以内、リビング12帖洋室6帖のお部屋ピックアップしお送りさせて頂きます！！";
  const r = maskNumbersNotInNotes(t, notes);
  expect(r.unmatched.length).toBe(0); expect(r.text).toBe(t);
});
it("メモに無い金額・時刻は〇〇（80,000円は 8万 と同じに見る）", () => {
  const r = maskNumbersNotInNotes("家賃80,000円以内で、明日15:00にご連絡させて頂きます！！", notes);
  expect(r.text).toBe("家賃80,000円以内で、明日〇〇:00にご連絡させて頂きます！！");
  expect(r.unmatched.join(",")).toBe("15");
});

// ─── 場面の証拠・登録 ───
it("場面の証拠 S10: 「お電話では無理でしょうか？」→ phone_call", () => {
  const e = detectAixSceneEvidence({ latestCustomerTurn: "ご相談があるのですがお電話では無理でしょうか？", hasCustomerImage: false });
  expect(e?.scene).toBe("S10_phone_request"); expect(e?.candidateAction).toBe("phone_call");
});
it("電話番号の質問は S10 にしない", () => expect(detectAixSceneEvidence({ latestCustomerTurn: "管理会社のお電話番号教えていただけますか？", hasCustomerImage: false })?.scene === "S10_phone_request").toBe(false));
it("AIX の登録（ブレインの語彙・台帳の種類）", () => {
  expect(normalizeAixActionKey("phone_call")).toBe("phone_call");
  expect(normalizeAixActionKey("電話をかける")).toBe("phone_call");
  expect(!!AIX_STAFF_NOTES.phone_followup).toBe(true);
  expect(aixLedgerKind("phone_call")?.kind).toBe("call_requested");
  expect(aixLedgerKind("phone_followup")?.kind).toBe("call_followup_sent");
});
it("会話に残す記録の文字", () => expect(CALL_BUTTON_MESSAGE_TEXT).toBe("[通話リクエスト] 電話をかけるボタン"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
