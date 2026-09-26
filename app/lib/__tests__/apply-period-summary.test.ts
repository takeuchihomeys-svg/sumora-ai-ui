// 「申込期間のまとめ（個人情報なし）」の純関数のテスト（自己完結ハーネス・個人情報は全部架空）
// 実行: npx tsx app/lib/__tests__/apply-period-summary.test.ts
// 2026-09-27 竹内「申込中の部分はクロードに切り替えて要約して（…切り替えた時に連動してクロードが申込期間の部分を要約して DeepSeek に渡す仕組み）」
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  piiReasons, parseApplySummary, renderApplySummaryBlock, checkApplySummary, tidyApplySummary, prepareApplyPeriodInput,
  scrubDerivedForDeepseek, isApplicationFieldMessage, APPLY_SUMMARY_SYSTEM, type ApplyPeriodSummary,
} from "../apply-period-summary";
import { keepIfMadeAfter, keepBrainMeta } from "../deepseek-cut";
import { preCutoffChunks, NO_CUTOFF } from "../post-apply";
import { sceneFromTpo } from "../opener-rates";

let passed = 0, failed = 0; const failures: string[] = [];
async function it(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const LINE = "2026-09-16T00:00:00.000Z";
const CTX = { conversationId: "conv-test", customerName: "山川 太一", partyAliases: ["山川太一"], knownNames: ["海野 花子"] };
const S = { names: true, family: true };
const D = { names: false, family: false };

// 実物の形（申込フォームの1通目・続き・否決の連絡）。値は全部架空
const FORM_1 = "・氏名、フリガナ 山川太一 ヤマカワタイチ\n・生年月日 1995年4月12日\n・現住所 大阪府大阪市北区天神橋9-9-9 サンプルハイツ301号\n・続柄 本人\n・勤務先 株式会社サンプル商事\n・年収 420万円\n・緊急連絡先 山川花 090-1111-2222";
const FORM_2 = "居住年数 ４年 賃貸ハイツ\n年収 400万\n勤続 5年 株式会社サンプル";
const REJECT = "管理会社に確認させていただき、保証会社の審査が通りませんでした。申し訳ございません";

async function main() {
  console.log("── piiReasons（決定論の検査）");
  await it("通る: 部屋の条件だけの文", () => ok(piiReasons("2LDK／家賃8万円以内／花隈駅周辺", CTX, S).length === 0, "条件は通る"));
  await it("通る: 区分だけの否決（保証会社の審査）", () => ok(piiReasons("審査否決（理由の区分: 保証会社の審査）", CTX, S).length === 0, "保証会社は区分"));
  await it("通る: 保証人不要の物件を希望（部屋の条件）", () => ok(piiReasons("保証人不要の物件を希望", CTX, S).length === 0, JSON.stringify(piiReasons("保証人不要の物件を希望", CTX, S))));
  await it("止める: 勤務先・年収の語", () => ok(piiReasons("勤務先は梅田", CTX, S).some((r) => r.startsWith("word:")), "勤務先"));
  await it("止める: 滞納・保証人", () => ok(piiReasons("過去の滞納で否決", CTX, S).length > 0 && piiReasons("保証人を立てる", CTX, S).length > 0, "信用"));
  await it("止める: 携帯番号（語なし）", () => ok(piiReasons("連絡は 090-1234-5678 まで", CTX, S).some((r) => /電話|mobile/.test(r)), JSON.stringify(piiReasons("連絡は 090-1234-5678 まで", CTX, S))));
  await it("止める: 当事者の名前（敬称なしでも登録名）", () => ok(piiReasons("山川太一の希望で2LDK", CTX, S).some((r) => r.includes("name")), "名前"));
  await it("止める: 敬称つきの別の名前", () => ok(piiReasons("田中様が同居予定", CTX, S).length > 0, "敬称"));
  await it("止める: 家族構成（要約だけ）", () => ok(piiReasons("妻と2人で入居", CTX, S).some((r) => r.startsWith("family:")), "家族"));
  await it("ブレインの判断には家族構成・名前を当てない（後段の読み替えが伏せる）", () => ok(piiReasons("山川太一さん 子供がいるので2LDK", CTX, D).length === 0, JSON.stringify(piiReasons("山川太一さん 子供がいるので2LDK", CTX, D))));
  await it("止める: 生年月日（昔の西暦）", () => ok(piiReasons("1995年4月12日生まれ", CTX, S).length > 0, "生年月日"));
  await it("通る: 入居希望日（今年の日付）", () => ok(piiReasons("2026年11月1日入居希望", CTX, { ...S, family: false }).length === 0, JSON.stringify(piiReasons("2026年11月1日入居希望", CTX, S))));
  await it("通る: 記録の時刻・UUID（ブレインの判断の欄）", () => ok(piiReasons("2026-09-20T01:23:45.000Z 1ed13988-1234-4567-8901-abcdefabcdef", CTX, D).length === 0, "ID"));
  await it("止める: 申込フォームの1通目", () => ok(piiReasons(FORM_1, CTX, S).length > 0, "form"));
  await it("止める: 線より前のお客様の発言をそのまま写した", () => {
    const net = preCutoffChunks(["洗濯機置き場が室内にあるお部屋でお願いしたいと思っております"]);
    ok(piiReasons("洗濯機置き場が室内にあるお部屋でお願いしたいと思っております", { ...CTX, netChunks: net }, S).includes("net:線より前の発言の写し"), "net");
  });

  console.log("── 入力の用意（Claude が見ない物は漏れない）");
  await it("申込フォームの1通目と続きの通を落とし、否決の連絡は残す", () => {
    const p = prepareApplyPeriodInput([
      { created_at: "2026-09-10T01:00:00Z", sender: "customer", text: FORM_1 },
      { created_at: "2026-09-10T01:05:00Z", sender: "customer", text: FORM_2 },
      { created_at: "2026-09-12T01:00:00Z", sender: "staff", text: REJECT },
    ], { names: ["山川 太一"] });
    ok(!/サンプルハイツ|サンプル商事|090-1111|420万|居住年数|勤続/.test(p.text), "個人情報が残っている");
    ok(/保証会社の審査が通りませんでした/.test(p.text), "否決の連絡が消えた");
    ok(!/サンプルハイツ/.test(p.staffText) && /保証会社/.test(p.staffText), "staffText");
  });
  await it("続きの通の指紋（欄の語2つ以上）・普通の文は当てない", () => {
    ok(isApplicationFieldMessage(FORM_2), "続き");
    ok(!isApplicationFieldMessage("勤務先から近いお部屋がいいです"), "1語");
  });

  console.log("── 出力の形・後処理・検査");
  const good: ApplyPeriodSummary = { properties: ["カシータ神戸元町JP"], outcome: "審査否決", reason: "保証会社の審査", preferences: ["花隈駅周辺", "1LDK"], promises: ["否決になった保証会社以外の物件を探す"], nextSteps: ["条件に合う別の物件をピックアップして送る"] };
  await it("選択肢の外は不明にする・否決以外は理由を付けない", () => {
    const a = parseApplySummary('{"properties":[],"outcome":"落ちた","reason":"年収が足りない","preferences":[]}')!;
    ok(a.outcome === "不明" && a.reason === null, JSON.stringify(a));
    const b = parseApplySummary('```json\n{"outcome":"審査否決","reason":"収入が少ない"}\n```')!;
    ok(b.outcome === "審査否決" && b.reason === "不明", JSON.stringify(b));
  });
  await it("長すぎる項目は捨てる（切って残さない）", () => {
    const a = parseApplySummary(JSON.stringify({ outcome: "キャンセル", preferences: ["あ".repeat(81), "2DK"] }))!;
    ok(a.preferences.length === 1 && a.preferences[0] === "2DK", JSON.stringify(a.preferences));
  });
  await it("読めない返答は null", () => ok(parseApplySummary("すみません") === null, "null"));
  await it("良い要約は通る", () => ok(checkApplySummary(good, CTX).length === 0, JSON.stringify(checkApplySummary(good, CTX))));
  await it("保証会社の名前・種類は止める（どこで否決かは信用の情報）", () => {
    ok(checkApplySummary({ ...good, promises: ["オリコフォレントインシュア以外の物件を探す"] }, CTX).includes("guarantor:会社名"), "会社名");
    ok(checkApplySummary({ ...good, promises: ["信販系以外の物件を探す"] }, CTX).includes("guarantor:種類"), "種類");
  });
  await it("お客様の現住所を『申込した物件』に書いた実物の形 → スタッフの発言に無いので落とす", () => {
    const t = tidyApplySummary({ ...good, properties: ["サンプルハイツ 301号室", "カシータ神戸元町JP"] }, "【カシータ神戸元町 JP 502号室】初期費用の御見積書です");
    ok(t.summary.properties.length === 1 && t.summary.properties[0] === "カシータ神戸元町JP", JSON.stringify(t));
    ok(t.dropped.includes("properties:スタッフの発言に無い"), "dropped");
  });
  await it("お客様がポータルのリンクで送ってきた物件は根拠にしてよい（実物: 申込した物件がお客様の見つけた物件）", () => {
    const p = prepareApplyPeriodInput([
      { created_at: "2026-09-10T01:00:00Z", sender: "customer", text: "サンプルタワー 10階 https://suumo.jp/chintai/bc_000000000/" },
      { created_at: "2026-09-10T02:00:00Z", sender: "customer", text: "今はコーポ架空 202に住んでいます" },
    ]);
    const t = tidyApplySummary({ ...good, properties: ["サンプルタワー 10階", "コーポ架空 202号室"] }, p.staffText);
    ok(JSON.stringify(t.summary.properties) === JSON.stringify(["サンプルタワー 10階"]), JSON.stringify(t.summary.properties));
  });
  await it("手続きの項目（書類・申込情報の受け取り）は落とす", () => {
    const t = tidyApplySummary({ ...good, nextSteps: ["本人確認書類の提出を待つ", "別の物件を送る"] }, "カシータ神戸元町JP");
    ok(t.summary.nextSteps.length === 1 && t.summary.nextSteps[0] === "別の物件を送る", JSON.stringify(t.summary.nextSteps));
  });
  await it("ブロックは決定論の形・場面の判定（sceneFromTpo）に当たる語を含まない", () => {
    const b = renderApplySummaryBlock(good, { from: "2026-09-20T04:00:00Z", to: "2026-09-24T03:00:00Z" });
    ok(b.includes("【申込期間のまとめ（個人情報なし）（9/20〜9/24）】") && b.includes("理由の区分: 保証会社の審査"), b);
    ok(sceneFromTpo(b) === null, "scene");
  });
  await it("中身が何も無い要約はブロックを作らない", () => ok(renderApplySummaryBlock({ properties: [], outcome: "不明", reason: null, preferences: [], promises: [], nextSteps: [] }) === "", "empty"));
  await it("Claude への指示に入れない物が明記されている", () => {
    for (const w of ["勤務先", "年収", "家族構成", "保証人", "緊急連絡先", "在留資格", "本人確認書類", "保証会社の名前"]) ok(APPLY_SUMMARY_SYSTEM.includes(w), w);
  });

  console.log("── 残っていた穴: 線より後にブレインが作った物");
  await it("文字の欄だけ落とし、選択肢・ID・時刻の欄は残す", () => {
    const meta = { action: "property_send", reply_mode: "aix", analyzed_msg_ts: "2026-09-20T00:00:00Z", template_id: "1ed13988-1234-4567-8901-abcdefabcdef", closing_strategy: "勤務先が梅田なので北区で探す", next_steps: ["保証人を立てて再申込", "別の物件を送る"], winning_pattern: "初期費用重視" };
    const r = scrubDerivedForDeepseek(meta);
    const v = r.value as typeof meta;
    ok(v.action === "property_send" && v.reply_mode === "aix" && v.analyzed_msg_ts === meta.analyzed_msg_ts && v.template_id === meta.template_id, "構造");
    ok(v.closing_strategy === null && v.next_steps.length === 1 && v.winning_pattern === "初期費用重視", JSON.stringify(v));
    ok(r.dropped === 2, String(r.dropped));
  });
  await it("セーブデータ（文）は行ごと落とす", () => {
    const r = scrubDerivedForDeepseek("希望: 2LDK\n年収400万で審査\n次: 物件を送る");
    ok(r.value === "希望: 2LDK\n次: 物件を送る" && r.dropped === 1, JSON.stringify(r));
  });
  await it("keepIfMadeAfter: 線がある会話だけ網を当てる（申込の記録なしは不変）", () => {
    const v = { note: "年収400万", ok: "2LDK" };
    ok(JSON.stringify(keepIfMadeAfter(v, "2026-09-20T00:00:00Z", NO_CUTOFF)) === JSON.stringify(v), "記録なしは不変");
    const c = keepIfMadeAfter(v, "2026-09-20T00:00:00Z", LINE) as typeof v;
    ok(c.note === null && c.ok === "2LDK", JSON.stringify(c));
    ok(keepIfMadeAfter(v, "2026-09-10T00:00:00Z", LINE) === null, "線より前は丸ごと落とす（今まで通り）");
    const m = keepBrainMeta({ analyzed_msg_ts: "2026-09-20T00:00:00Z", repeated_concern: "滞納歴を気にしている" }, LINE) as Record<string, unknown>;
    ok(m.repeated_concern === null, "brain meta");
  });

  console.log("── 配線（ソースに入っているか）");
  const src = (p: string) => readFileSync(join(__dirname, "..", "..", "..", p), "utf8");
  await it("返信生成: DeepSeek に回る時だけまとめを行動台帳の後ろに足す・無ければ after で作る", () => {
    const s = src("app/api/generate-reply/route.ts");
    ok(/loadApplyPeriodNote\(conversationId, deepseekCutoff\)/.test(s) && /\+ viewingReportNote \+ applyPeriodNote;/.test(s) && /after\(\(\) => ensureApplyPeriodSummary\(cid\)/.test(s), "generate-reply");
  });
  await it("AIX: cutActive の時だけ足す", () => ok(/aixRequestCtx\.getStore\(\)\?\.cutActive\s*\n?\s*\? \(await loadApplyPeriodNote/.test(src("app/api/aix/action/route.ts")) && /\+ aixViewingReportNote \+ aixApplyPeriodNote;/.test(src("app/api/aix/action/route.ts")), "aix"));
  await it("物件の評価: 網を通した要約を渡す（元の要約をそのまま渡さない）・まとめを足す", () => {
    const s = src("app/api/evaluate-property/route.ts");
    ok(/const keptSummary = /.test(s) && !/typeof customer\.ai_summary_json === "string"\s*\n\s*\? customer\.ai_summary_json/.test(s) && /contextParts\.push\(applyPeriodNote\.trim\(\)\)/.test(s), "evaluate");
  });
  await it("まとめを作る呼び出しは必ず Claude（申込以降の印・線の印 blocked）", () => {
    const s = src("app/lib/apply-period-summary-server.ts");
    ok(/\[LLM_POST_APPLY_HEADER\]: "1"/.test(s) && /\[LLM_CUTOFF_HEADER\]: "blocked"/.test(s), "headers");
  });
  await it("brain-sweep が拾う・migrate-schema に表がある", () => {
    ok(/pendingApplySummaryConversations\(2\)/.test(src("app/api/cron/brain-sweep/route.ts")), "sweep");
    ok(/CREATE TABLE IF NOT EXISTS apply_period_summaries/.test(src("app/api/migrate-schema/route.ts")), "migrate");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
}
main();
