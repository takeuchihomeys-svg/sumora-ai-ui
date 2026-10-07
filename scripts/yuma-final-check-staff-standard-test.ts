// scripts/yuma-final-check-staff-standard-test.ts — 最終チェックの「直らない RULE_VIOLATION」の直しの前後（DB に書かない・1回目のチェックだけ）
//
// 2026-10-07 竹内「最終チェックはちゃんと機能しているか」。見張り 28日で修正前→最後で減らなかった RULE_VIOLATION の下書き（実物・名前は YUMA）に
//   本番と同じ会社ルール（fetchPromptRules("generate_reply")）で runFinalCheck を当て、
//   FINAL_CHECK_STAFF_STANDARD=off（直しの前）と on（後）で RULE_VIOLATION の数と中身を比べる。
//   ⚠ 受け身の例外の1文（final-check.ts の rule_check の前置き）は前後とも入っている＝前は「ルールの除外と②の出口」だけを外した形。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-final-check-staff-standard-test.ts [回数=1]
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";

const CASES: Array<{ id: string; customer: string; draft: string }> = [
  { id: "780 生活保護・淀川区", customer: "まず生活保護者可能な賃貸\n1.入居時期　12月\n2.希望家賃　3万円〜4万円\n3.希望の広さ　広い方が良い1DK〜2DK\n4.気にしない\n5.希望エリア　大阪府淀川区\n6.気にしない\n7.初期費用の限度　安いに限る\n8.その他の要望　できればトイレ、風呂別。一階。",
    draft: "YUMAさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n大阪府淀川区周辺全域から家賃3万円〜4万円以内・1DK〜2DK・トイレ風呂別・1階のご条件で生活保護者様もご入居可能なお部屋をピックアップしてお送りさせて頂きます！！\nYUMAさんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます😌！！" },
  { id: "789 大阪市内 8〜14万", customer: "【お部屋お探し中！】\n①【ご入居の時期】⇒即日\n②【ご希望の家賃（◯万円〜◯万円）】⇒8〜14万円\n③【希望の広さ・間取り】⇒広さ40〜60平米、1LDK〜2LDK\n④【希望築年数】なるべく築浅もしくは10年未満\n⑤【ご希望のエリア・駅名】⇒大阪市内\n⑥【ご希望の駅徒歩分数】⇒5分以内\n⑦【初期費用の限度額】⇒出来ればなし\n⑧【その他ご要望あれば】⇒",
    draft: "YUMAさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n大阪市内全域から家賃8〜14万円・1LDK〜2LDK・40〜60平米・築10年以内・駅徒歩5分以内でYUMAさんにオススメできるお部屋をピックアップしてお送りさせて頂きます！！\n初期費用も最大限割引させて頂きYUMAさんのお引越しにかかる費用を出来る限り抑えさせて頂きます😌！！\nYUMAさんがご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます！！" },
  { id: "792 堺区 2LDK", customer: "▶︎【お部屋お探し中！】\n①【ご入居の時期】⇒11月末\n②【ご希望の家賃（8万円〜13万円）】⇒\n③【希望の広さ・間取り】⇒2LDK以上\n④【希望築年数】築浅かリノベ\n⑤【ご希望のエリア・駅名】⇒堺区\n⑥【ご希望の駅徒歩分数】⇒なし\n⑦【初期費用の限度額】⇒10万位\n⑧【その他ご要望あれば】⇒\n宜しくお願い致します。",
    draft: "YUMAさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n堺区周辺全域からYUMAさんご希望の家賃8万円〜13万円以内・2LDK以上・築浅またはリノベのお部屋をピックアップしてお送りさせて頂きます！！\n初期費用も最大限割引させて頂きYUMAさんのお引越しにかかる費用を出来る限り抑えさせて頂きます！！\nYUMAさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます😌！！" },
  { id: "777 天王寺 4.5万", customer: "①【ご入居の時期】⇒いつでも\n②【ご希望の家賃（◯万円〜◯万円）】⇒管理費込み込みで4.5万円以下\n③【希望の広さ・間取り】⇒特に無し\n④【希望築年数】古くて良いが5年以上は住みたい\n⑤【ご希望のエリア・駅名】⇒天王寺駅\n⑥【ご希望の駅徒歩分数】⇒近ければ近いほど良い10分程度\n⑦【初期費用の限度額】⇒やすくしてください\n⑧【その他ご要望あれば】⇒トイレシャワー付",
    draft: "YUMAさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n天王寺駅周辺全域から管理費込み4.5万円以下・駅徒歩10分程度・トイレシャワー付でYUMAさんにオススメできるお部屋をピックアップしてお送りさせて頂きます！！\n初期費用も最大限割引させて頂き、YUMAさんのお引越しにかかる費用を出来る限り抑えさせて頂きます！！\nYUMAさんがご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます😌！！" },
  { id: "549 旭区ほか", customer: "そうですね。11月頭くらいで1LDKから2LDKくらいで家賃45,000から65,000くらい、バス、トイレ別で旭区、東淀川区、守口市、吹田くらいで探しています。\n車なので、駅近くなくて大丈夫。\n初期費用はほぼ掛からない物件がいいです。",
    draft: "かしこまりました！！\n旭区・東淀川区・守口市・吹田周辺全域から家賃45,000〜65,000円・1LDK〜2LDK・初期費用を極力抑えられるお部屋をピックアップしてお送りさせて頂きます😊！！\nピックアップ出来次第ご連絡させて頂きます！！" },
  { id: "1076 茨木ほか（AIX 場面）", customer: "わかりました\n今月末には引越しを完了させたいのでお手数お掛けしますがお願いします\n茨木市、大東市、寝屋川なども視野に入れて大丈夫です",
    draft: "かしこまりました！！\n吹田市に加え、茨木市・大東市・寝屋川市も含めて、今月末までにご入居いただけるお部屋で小型犬可のお部屋をピックアップしてお送りさせて頂きます😌！！\nご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！" },
  { id: "311 西区ほか（AIX 場面）", customer: "【お部屋お探し中！】\n①【ご入居の時期】⇒10月下旬\n②【ご希望の家賃（◯万円〜◯万円）】⇒9-12\n③【希望の広さ・間取り】⇒32-45\n⑤【ご希望のエリア・駅名】⇒西区、浪速区、西成区など",
    draft: "YUMAさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n西区・浪速区・西成区周辺全域から家賃9〜12万・32〜45㎡でYUMAさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！\nYUMAさんがご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます😌！！\n何卒よろしくお願い致します！！" },
  // 対照（本物の違反が残るか）: 内覧の日時を返信で決めている
  { id: "対照 内覧日時の直接提示", customer: "内覧したいです", draft: "かしこまりました！！\n明日の14時にお部屋ご案内させて頂きます！！\n現地の住所は大阪市北区天満3-1-1となります！！" },
];

let h: LlmTestHarness | null = null;
async function main() {
  const reps = Math.max(1, Number(process.argv[2] ?? 1));
  h = await setupLlmTest("yuma-final-check-staff-standard-test");
  h.assertYuma(YUMA);
  h.assertSceneSafe(CASES.flatMap((c) => [c.customer, c.draft]), "fc-staff-standard");
  const { runFinalCheck } = await import("../app/lib/final-check");
  const { fetchPromptRules } = await import("../app/lib/prompt-rules");
  const rules = await fetchPromptRules("generate_reply");
  const tally: Record<string, { rv: number; other: number; n: number }> = {};
  for (let k = 0; k < reps; k++) {
    for (const c of CASES) {
      for (const mode of ["off", "on"] as const) {
        process.env.FINAL_CHECK_STAFF_STANDARD = mode;
        const ctx = { lastCustomerMessage: c.customer, customerName: "YUMA", isAix: true, recentMessages: [{ sender: "customer", text: c.customer }],
          // 選んだルールのキャッシュ（同じ文字列なら使い回す）を前後で分ける
          dbRules: mode === "on" ? rules + "\n" : rules };
        const r = await runFinalCheck(c.draft, ctx, { timeoutMs: 30000 });
        const rv = r.issues.filter((i) => i.code === "RULE_VIOLATION");
        const t = (tally[`${c.id}|${mode}`] ??= { rv: 0, other: 0, n: 0 });
        t.n++; t.rv += rv.length; t.other += r.issues.length - rv.length;
        console.log(`[${k + 1}] ${c.id} ${mode}: ${r.issues.map((i) => `${i.code}:${i.severity}`).join(",") || "指摘なし"}`);
        for (const i of rv) console.log(`    RV: ${i.message.slice(0, 90)} ／ ${i.evidence.slice(0, 60)}`);
      }
    }
  }
  delete process.env.FINAL_CHECK_STAFF_STANDARD;
  console.log("\n=== RULE_VIOLATION の数（前 off → 後 on）・他の指摘 ===");
  for (const c of CASES) {
    const a = tally[`${c.id}|off`], b = tally[`${c.id}|on`];
    console.log(`${c.id}: RV ${a.rv}→${b.rv}（${a.n}回）・他 ${a.other}→${b.other}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
