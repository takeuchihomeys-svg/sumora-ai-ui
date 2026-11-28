// app/lib/__tests__/aix-edit-count.test.ts — #839 物件オススメの直しの組を数えるためだけに残す（伏せ・読み手に拾われない）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCountOnlyRow, maskPropertyFacts, aixEditCountOn, AIX_EDIT_COUNT_SOURCE, residueOf } from "../aix-edit-count";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => { try { fn(); pass++; console.log("  OK  " + name); } catch (e) { fail++; console.log("  NG  " + name + "\n      " + (e as Error).message); } };
const ROOT = join(__dirname, "..", "..", "..");

t("既定 off", () => { assert.equal(aixEditCountOn({}), false); assert.equal(aixEditCountOn({ AIX_EDIT_COUNT_RECOMMENDATION: "on" }), true); });
t("物件の名前・号室・金額・URL を伏せる（作り物）", () => {
  const m = maskPropertyFacts("テストハイツ 203号室 家賃6.5万円 初期費用128,000円 https://suumo.jp/x", ["テストハイツ"]);
  assert.doesNotMatch(m, /テストハイツ|203|6\.5|128,000|suumo/);
  assert.match(m, /〈物件〉.*〈号室〉.*〈金額〉.*〈URL〉/);
});
t("行は数えるためだけ: source・却下済み・理由なし", () => {
  const r = buildCountOnlyRow({ actionType: "property_recommendation", category: "物件オススメ【AIX】", sent: "〇〇さん こちらテストハイツ 203号室オススメです！！", original: "こちらテストハイツオススメです", propertyNames: ["テストハイツ"] })!;
  assert.equal(r.source, AIX_EDIT_COUNT_SOURCE);
  assert.equal(r.is_dismissed, true);
  assert.equal(r.dismissed_reason, null);
  assert.doesNotMatch(r.template_text + r.original_text, /テストハイツ|203/);
});
t("申込の書類・個人の値が残る文は残さない", () => {
  assert.equal(buildCountOnlyRow({ actionType: "property_recommendation", category: "x", sent: "申込者様記入欄 勤務先電話", original: "a" }), null);
  assert.equal(buildCountOnlyRow({ actionType: "property_recommendation", category: "x", sent: "", original: "a" }), null);
});
// 読み手に拾われない: ai_template_candidates を読む所はどれも、source を名指し／is_dismissed=false／id／却下の理由が null でない行 で読む（aix_edit_count の行はどれにも当たらない）
t("読み手の門（手本・RAG・学びの入口が aix_edit_count の行を読まない）", () => {
  const files = ["app/api/ai-template-candidates/route.ts", "app/api/aix/action/route.ts", "app/api/aix/improvement-meeting/route.ts", "app/api/corpus2skill/route.ts", "app/api/cron/auto-template-candidates/route.ts", "app/api/cron/morning-report/route.ts", "scripts/lib/self-improve-growth.ts", "scripts/audit-aix-edit-diff.ts"];
  const OK_GATE = /\.eq\("source", "(?:aix_edit|improvement|opus_weekly|auto)"\)|\.eq\("is_dismissed", false\)|\.eq\("id",|\.not\("dismissed_reason", "is", null\)|\.update\(|\.insert\(/;
  // 重複の確かめだけで文を学ばない読み（数えるだけの行が当たっても候補が1つ減るだけ）
  const ALLOW = [/select\("category, template_text, is_dismissed, is_adopted"\)/];
  for (const f of files) {
    const s = readFileSync(join(ROOT, f), "utf8");
    let i = -1;
    while ((i = s.indexOf('from("ai_template_candidates")', i + 1)) >= 0) {
      const win = s.slice(i, i + 700);
      if (ALLOW.some((re) => re.test(win.slice(0, 200)))) continue;
      assert.ok(OK_GATE.test(win), `${f} の ${s.slice(0, i).split("\n").length} 行目の読みに門が無い`);
      assert.doesNotMatch(win.slice(0, 300), /aix_edit_count/, `${f} が aix_edit_count を読んでいる`);
    }
  }
});
t("伏せ方の確かめ: 伏せる前は当たり・伏せた後の行は残りなし（作り物）", () => {
  const raw = "テスト太郎さん テストハイツ 203号室 6.5万円 090-1234-5678 test@example.com https://suumo.jp/x";
  const hits = residueOf(raw);
  for (const k of ["号室", "金額", "携帯番号", "メール", "URL"]) assert.ok(hits.includes(k), `${k} が当たらない: ${hits.join(",")}`);
  // 携帯番号・メールの入った文は、そもそも残さない（申込の書類・個人の値の網）
  assert.equal(buildCountOnlyRow({ actionType: "property_recommendation", category: "x", sent: raw, original: "a", propertyNames: ["テストハイツ"] }), null);
  const sent = "テスト太郎さん テストハイツ 203号室 家賃6.5万円 https://suumo.jp/x ご案内させて頂きます！！";
  const r = buildCountOnlyRow({ actionType: "property_recommendation", category: "x", sent, original: "こちらテストハイツオススメです", propertyNames: ["テストハイツ"], knownNames: ["テスト太郎"] })!;
  assert.deepEqual(residueOf(r.template_text), []);
  assert.deepEqual(residueOf(r.original_text), []);
});
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
