// 2番手で申込中（並行で探す）・【申込歴あり】・出口で値を伏せてから DeepSeek に渡す のテスト（自己完結ハーネス・LLM なし・本物のお客様の文は使わない＝全部作り物）
// 実行: npx tsx app/lib/__tests__/reapply-followups.test.ts
import {
  isApplied2ndText, isOffer2ndText, isParallelEndText, resolveParallelSecond, staffParallelChoiceOf, staffParallelChoiceAt, effectiveStatusForParallel, buildParallelBrainNote,
  PARALLEL_MEMO_ID, PARALLEL_MEMO_ON, PARALLEL_MEMO_OFF, PARALLEL_2ND_LABEL,
} from "../parallel-second";
import {
  postApplyDraftSkip, parallelEligible, parallelSecondActive, parallelSecondCutoff, resolveDeepseekEntrance, entranceMarkOf, formatCutoffMark, parseCutoffMark, NO_CUTOFF, type PostApplyFacts,
  judgeParallelSecond, deepseekSafeCutoff, deepseekPostApply,
} from "../post-apply";
import { resolveReapply } from "../reapply-customer";
import { maskApplicationValuesForAlt, altPiiValuesRemain, maskAltBody, altPiiSignal, altPiiSignalReapply, ALT_DOC_MASK } from "../alt-pii-gate";
import { reapplyBadgeText, REAPPLY_MARK_TEXT } from "../reapply-customer";
import { REAPPLY_HEADER_MARK } from "../staff-todo-list";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void | Promise<void>) { current = name; return fn(); }
async function it(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (c: boolean, m: string) => { if (!c) throw new Error(m); };
const T = (d: string) => new Date(d).toISOString();
const NOW = Date.parse("2026-10-21T03:00:00Z");
const ENV_ON: Record<string, string> = {};
/** 2番手で並行の会話を DeepSeek に回すスイッチ（既定 off） */
const ENV_DS: Record<string, string> = { REAPPLY_PARALLEL_DEEPSEEK: "on" };
const applying = (over: Partial<PostApplyFacts> = {}): PostApplyFacts => ({ status: "applying", applicationPushAt: T("2026-10-15T00:00:00Z"), ...over });

async function main() {
  await describe("2番手で申込んだ文の見分け", async () => {
    await it("申込んだ形は当たる", () => {
      for (const s of [
        "テストハイツ203号室、2番手で受理されました！！",
        "現在1番手の方が審査中となりお申込み2番手で受け付けている状況となります！！",
        "テストレジデンス1001号室、無事2番手でお申込み完了しております！！",
        "2番手でお申込みさせて頂きます！！",
        "テスト101号室2番手でお申込みと同時並行で別のお部屋もお探しします",
        "管理会社より2番手でのお申込みとのご連絡がございました。",
      ]) ok(isApplied2ndText(s), s);
    });
    await it("案内・問い・できない形は当たらない", () => {
      for (const s of [
        "現在1件お申込みが入っており、2番手でのお申込みが可能となります！！",
        "よろしければ2番手でお申込を行い、繰り上がりを待ちながら並行して物件をお探しさせて頂くのは如何でしょうか！！",
        "既にお申込みが入っており2番手でのお申込み受け付けていないお部屋となります",
        "こちらのマンションは2番手でのお申込が出来ない形との事です。",
        "2番手でお申込した場合1番手の方がキャンセルすると繰り上がります",
        // 同じ文の別の所の「させて頂きました」に当てない・「2番手以降」は部屋の状況の案内
        "物件の募集状況確認させて頂きましたところ、テスト本町は既に1番手のお申し込みが入っており、現在2番手以降でのお申込み受付となるお部屋となります",
        "お部屋の状況を確認させて頂きました、現在2番手でのお申込みとなるお部屋です",
        // 10/21 確かめ役（実データの形を作り物に）: 条件の形「〜ましたら」「よろしければ」「〜次第」は申込んだ文ではない
        "ご費用面もお気に召されましたら2番手ですがお部屋のお申込みもさせていただきます",
        "テストさんよろしければ2番手でお申し込みさせて頂き、並行してお部屋探しサポートさせて頂きます",
        "お送り頂き次第、テストハイツ102号室のお部屋お申込し2番手で抑えさせて頂きます",
      ]) ok(!isApplied2ndText(s), s);
    });
    await it("案内は isOffer2ndText・できない形は外す", () => {
      ok(isOffer2ndText("2番手でのお申込みが可能となります！！"), "可能");
      ok(!isOffer2ndText("2番手でのお申込み受け付けていないとのことです"), "受け付けていない");
    });
    await it("終わりの文（繰り上がり・自分の審査通過・1番手が通過）", () => {
      ok(isParallelEndText("1番手の方がキャンセルとなり繰り上がりました！！"), "繰り上がり");
      ok(isParallelEndText("審査通過のご連絡がありました！！"), "審査通過");
      ok(isParallelEndText("1番手の方が審査通過となりました"), "1番手が通過");
      ok(!isParallelEndText("1番手の方が審査否決となった場合繰り上がる形となります"), "仮定は終わりにしない");
    });
    // 2026-10-22 確かめ役: 先の約束・条件の形は終わりではない（be73fa13 の形を作り物に）／済んだ事は終わり
    await it("終わりの語の後ろが約束・条件の形なら終わりにしない", () => {
      for (const s of [
        "番手が繰り上がりましたらご連絡させて頂きます😊！！",
        "テストハイツ申込み番手が繰り上がりましたらご連絡させて頂きます！！",
        "繰り上がったらすぐお知らせいたします",
        "繰り上がった際はお電話が入ります",
        "1番手の方の審査が決まり次第ご連絡いたします",
        "審査通過しましたらご連絡します",
        "1番手の方の審査が承認されましたら2番手はキャンセルとなります",
        "審査否決となりましたら繰り上がります",
        "繰り上がり審査開始しましたらお客様の元にお電話が入る可能性ございます",
      ]) ok(!isParallelEndText(s), s);
      for (const s of [
        "番手が繰り上がりました！！",
        "番手が繰り上がりましたので審査開始となります",
        "繰り上がったとのご連絡がありました",
        "1番手の方が審査承認となりました",
        "1番手の方がキャンセルになり繰り上がりました",
        "審査否決となりました",
        "1番手の方で契約へと進みます",
        // 同じ文に約束と済んだ事がある時は済んだ事を取る
        "繰り上がりましたので、審査通過しましたらご連絡します",
        // 独立レビュー: 「から」「のでこちら」「ばかり」は条件の形ではない
        "繰り上がりましたから、審査開始となります",
        "審査通過しましたのでこちらから契約書をお送りします",
        "繰り上がりましたばかりです",
      ]) ok(isParallelEndText(s), s);
      for (const s of ["繰り上がらなかったら別を探します", "審査承認されれば契約となります", "お申込みキャンセルとなりましたらご連絡します"]) ok(!isParallelEndText(s), s);
    });
    await it("2〜9番手で申込んだ文も数える・保証会社の番手・誘い・案内・1番手・2桁は数えない", () => {
      for (const s of [
        "テストハイツ403号室3番手でお申し込みさせて頂きます！！",
        "3番手にてテストラピスナンバ501号室お申込みさせていただきます！！",
        "４番手で受理されました",
        "三番手でのお申込み完了しております",
      ]) ok(isApplied2ndText(s), s);
      for (const s of [
        "クレディセゾン（テスト系）の保証会社が2番手で控えています",
        "保証会社は2番手でのお申込み完了しております",
        "よろしければ3番手でお申込みさせて頂きます",
        "既に2件お申込みが入っており3番手以降でのお申込みが可能です",
        "現在お申込みが入っており、3番手でのお申込みが可能となっております",
        "無事一番手にてお申込み完了しております",
        "1番手でお申込み完了しております",
        "12番手で受理されました",
        "3番手でお申込みされますか",
      ]) ok(!isApplied2ndText(s), s);
      ok(isOffer2ndText("3番手でのお申込みが可能となっております"), "3番手の案内");
    });
    await it("「可能性」は案内ではない・繰り上がりを待つ形は番手の語が無くても数える", () => {
      for (const s of [
        "1番手に上がる可能性ございますので、テストさん2番手でお申込させて頂きます！！",
        "1番手繰り上がり連絡待ちながら、同時並行で11月末ごろまでにご入居可能なお部屋も並行して探させていただきます😊！！",
        "繰り上がりのご連絡待ちながら同時並行でお部屋探しも継続させていただきます",
        "管理会社より1番手繰り上がり連絡ございましたら、審査開始となります！！",
      ]) ok(isApplied2ndText(s), s);
      for (const s of [
        "2番手でのお申込みが可能となります",
        "繰り上がり待ちながら並行して探すのはいかがでしょうか",
        "よろしければ繰り上がりのご連絡待ちながら同時並行でお探しします",
        "1番手の方が否決の場合、繰り上がり連絡ございましたら審査開始となります",
        "お部屋の番手繰り上がりの待ちと同時並行で他お部屋のお申し込みいただくのをオススメいたします",
      ]) ok(!isApplied2ndText(s), s);
      ok(!isOffer2ndText("保証会社が2番手でお申込みとなります"), "保証会社の番手は案内にもしない");
    });
  });

  await describe("2番手で申込中（並行で探す）の判定", async () => {
    const msg = (sender: string, text: string, at: string) => ({ sender, text, createdAt: T(at) });
    await it("スタッフの『2番手で受理』→ 並行（自動・文）", () => {
      const st = resolveParallelSecond({ msgs: [msg("staff", "2番手で受理されております！！", "2026-10-16T00:00:00Z")], lastApplyAt: T("2026-10-15T00:00:00Z"), nowMs: NOW });
      eq([st.parallel, st.source, st.via], [true, "auto", "message"]);
    });
    await it("お客様の文・案内だけでは並行にしない", () => {
      eq(resolveParallelSecond({ msgs: [msg("customer", "2番手で受理されました", "2026-10-16T00:00:00Z")], lastApplyAt: T("2026-10-15T00:00:00Z"), nowMs: NOW }).parallel, false);
      eq(resolveParallelSecond({ msgs: [msg("staff", "2番手でのお申込みが可能となります！！", "2026-10-14T00:00:00Z")], lastApplyAt: T("2026-10-15T00:00:00Z"), nowMs: NOW }).parallel, false);
    });
    await it("ピッカー（ほかの方の申込あり）＋2番手の案内 → その後に申込の記録 ＝ 並行（ピッカー）", () => {
      const st = resolveParallelSecond({
        msgs: [msg("staff", "1番手で審査中のため2番手でのお申込みが可能となります！！", "2026-10-14T00:00:00Z")],
        pickers: [{ checkPattern: "mgmt_application_status", choices: { status: "申込あり" }, createdAt: T("2026-10-14T00:00:00Z") }],
        lastApplyAt: T("2026-10-15T00:00:00Z"), nowMs: NOW,
      });
      eq([st.parallel, st.via], [true, "picker"]);
    });
    await it("ピッカーが『なし』だけなら数えない", () => {
      const st = resolveParallelSecond({
        msgs: [msg("staff", "2番手でのお申込みが可能となります！！", "2026-10-14T00:00:00Z")],
        pickers: [{ checkPattern: "mgmt_application_status", choices: { status: "申込なし" }, createdAt: T("2026-10-14T00:00:00Z") }],
        lastApplyAt: T("2026-10-15T00:00:00Z"), nowMs: NOW,
      });
      eq(st.parallel, false);
    });
    await it("その後に繰り上がり・審査通過があれば終わり", () => {
      const msgs = [msg("staff", "2番手で受理されております！！", "2026-10-16T00:00:00Z"), msg("staff", "1番手の方がキャンセルとなり繰り上がりました！！", "2026-10-18T00:00:00Z")];
      eq(resolveParallelSecond({ msgs, lastApplyAt: T("2026-10-15T00:00:00Z"), nowMs: NOW }).parallel, false);
    });
    await it("戻した時刻より前の文（前回の申込の話）は数えない", () => {
      const st = resolveParallelSecond({ msgs: [msg("staff", "2番手で受理されております！！", "2026-10-01T00:00:00Z")], lastApplyAt: T("2026-10-15T00:00:00Z"), lastBackAt: T("2026-10-05T00:00:00Z"), nowMs: NOW });
      eq(st.parallel, false);
    });
    await it("スタッフの選択が最優先（はい／いいえ）", () => {
      eq(resolveParallelSecond({ msgs: [], staffChoice: true, nowMs: NOW }).parallel, true);
      eq(resolveParallelSecond({ msgs: [msg("staff", "2番手で受理されております！！", "2026-10-16T00:00:00Z")], staffChoice: false, lastApplyAt: T("2026-10-15T00:00:00Z"), nowMs: NOW }).parallel, false);
      eq(staffParallelChoiceOf([{ id: PARALLEL_MEMO_ID, text: PARALLEL_MEMO_ON }]), true);
      eq(staffParallelChoiceOf([{ id: PARALLEL_MEMO_ID, text: PARALLEL_MEMO_OFF }]), false);
      eq(staffParallelChoiceOf([{ id: PARALLEL_MEMO_ID, text: PARALLEL_MEMO_ON, retiredAt: T("2026-10-20T00:00:00Z") }]), null);
    });
    await it("下書き・ブレインに渡す status は物件提案中（申込中の時だけ）", () => {
      eq(effectiveStatusForParallel("applying", true), "proposing");
      eq(effectiveStatusForParallel("contract", true), "contract");
      eq(effectiveStatusForParallel("applying", false), "applying");
    });
    await it("ブレインの材料に個人の値が無い・札の文", () => {
      const n = buildParallelBrainNote();
      ok(n.includes(PARALLEL_2ND_LABEL), n);
      eq(altPiiSignalReapply(n.replace(/申込の中身（[^）]*）/, "")), null);
      eq(PARALLEL_2ND_LABEL, "2番手で申込中（並行で探す）");
    });
  });

  await describe("下書きの止め・DeepSeek の入口（この状態だけ緩める）", async () => {
    await it("並行の会話は下書きを止めない・並行でない申込中は今まで通り止める", () => {
      eq(postApplyDraftSkip(applying({ parallel2nd: true }), ENV_ON), false);
      eq(postApplyDraftSkip(applying(), ENV_ON), true);
      eq(postApplyDraftSkip(applying({ parallel2nd: true }), { REAPPLY_PARALLEL_2ND: "off" }), true);
    });
    await it("契約以降・失注・申込の記録が無い会話は並行に入らない（2026-10-21 戻した会話は入る＝戻した後の文だけ数える）", () => {
      eq(parallelEligible(applying({ status: "contract" })), false);
      eq(parallelEligible(applying({ status: "closed_lost" })), false);
      eq(parallelEligible({ status: "proposing" }), false);
      eq(parallelEligible({ status: "proposing", isPostApply: true, applicationPushAt: T("2026-10-01T00:00:00Z"), statusManualBackAt: T("2026-10-05T00:00:00Z") }), true);
      eq(parallelEligible({ status: "proposing", applicationPushAt: T("2026-10-01T00:00:00Z"), statusManualBackAt: T("2026-10-05T00:00:00Z") }), true);
      eq(parallelSecondActive(applying({ status: "contract", parallel2nd: true }), ENV_ON), false);
      // status が遅れて提案中のまま（記録で申込中）は入る
      eq(parallelEligible({ status: "proposing", applicationPushAt: T("2026-10-15T00:00:00Z") }), true);
    });
    await it("入口: 既定（REAPPLY_PARALLEL_DEEPSEEK 無し）は並行でも DeepSeek に渡さない（Claude・下書きは止めない）", () => {
      const e = resolveDeepseekEntrance(applying({ parallel2nd: true }), ENV_ON);
      eq([e.altPostApply, e.cutoff, e.masked], [true, null, false]);
      eq(entranceMarkOf(e.cutoff, e.masked), { kind: "blocked" });
      eq(postApplyDraftSkip(applying({ parallel2nd: true }), ENV_ON), false);
    });
    await it("入口: on の時、並行は申込以降に数えず・線は申込の記録と2番手の時刻の遅い方（申込の期間は渡さない・印 cut）", () => {
      const e = resolveDeepseekEntrance(applying({ parallel2nd: true }), ENV_DS);
      eq([e.altPostApply, e.cutoff, e.masked], [false, T("2026-10-15T00:00:00Z"), false]);
      eq(entranceMarkOf(e.cutoff, e.masked), { kind: "cut", at: T("2026-10-15T00:00:00Z") });
      // 2番手の時刻・書類・フォームが後なら線はそこ（線なし＝全部にはしない）
      eq(resolveDeepseekEntrance(applying({ parallel2nd: true, parallel2ndAt: T("2026-10-16T00:00:00Z"), idDocumentAt: T("2026-10-17T00:00:00Z") }), ENV_DS).cutoff, T("2026-10-17T00:00:00Z"));
      eq(resolveDeepseekEntrance(applying({ parallel2nd: true, applicationFormAt: T("2026-10-18T00:00:00Z") }), ENV_DS).cutoff, T("2026-10-18T00:00:00Z"));
    });
    await it("入口: 並行でも時刻が1つも無い・読めない時は渡さない（Claude）", () => {
      eq(parallelSecondCutoff({ status: "applying", parallel2nd: true }), null);
      eq(parallelSecondCutoff(applying({ parallel2nd: true, idDocumentAt: "bad" })), null);
      eq(parallelSecondCutoff(applying({ parallel2nd: true, applicationFormUnreadable: true })), null);
      eq(entranceMarkOf(null, false), { kind: "blocked" });
    });
    await it("スタッフが選んだ時刻が線の材料になる", () => {
      const st = resolveParallelSecond({ msgs: [], staffChoice: true, staffAt: T("2026-10-19T00:00:00Z") });
      eq([st.parallel, st.source, st.at], [true, "staff", T("2026-10-19T00:00:00Z")]);
      eq(staffParallelChoiceAt([{ id: PARALLEL_MEMO_ID, updatedAt: T("2026-10-19T00:00:00Z") }]), T("2026-10-19T00:00:00Z"));
    });
    await it("入口: 出口の網が止まっていれば masked にしない（Claude のまま）", () => {
      const e = resolveDeepseekEntrance(applying({ parallel2nd: true }), { ...ENV_DS, LLM_ALT_REAPPLY_GATE: "off" });
      eq([e.altPostApply, e.cutoff, e.masked], [true, null, false]);
      eq(resolveDeepseekEntrance(applying({ parallel2nd: true }), { ...ENV_DS, LLM_ALT_PII_GATE: "off" }).cutoff, null);
    });
    await it("入口: 並行でない申込中は今まで通り申込以降（渡さない）", () => {
      const e = resolveDeepseekEntrance(applying(), ENV_ON);
      eq([e.altPostApply, e.cutoff, e.masked], [true, null, false]);
      eq(entranceMarkOf(e.cutoff, e.masked), { kind: "blocked" });
    });
    await it("印 masked はヘッダで行き来できる・知らない値は blocked", () => {
      eq(parseCutoffMark(formatCutoffMark({ kind: "masked" })), { kind: "masked" });
      eq(parseCutoffMark("masked2"), { kind: "blocked" });
      // masked でも線がある時は cut（masked を作るのは線なしの時だけ）
      eq(entranceMarkOf(T("2026-10-10T00:00:00Z"), true).kind, "cut");
    });
  });

  await describe("出口で値を伏せる（maskApplicationValuesForAlt・作り物の申込フォーム）", async () => {
    const form = [
      "お客様: 申込者様記入欄",
      "・氏名、フリガナ テスト 太郎 テスト タロウ",
      "・生年月日 1995年3月12日",
      "・携帯番号 090-1234-5678",
      "・勤務先：テスト商事株式会社",
      "・年収 350万円",
      "・メール test.taro@example.com",
      "",
      "スタッフ: ありがとうございます！！テストハイツ203号室（家賃8万円）は10月25日に内見できます",
      "管理会社名：テスト不動産",
    ].join("\n");
    await it("伏せる前は網に当たる", () => {
      ok(altPiiSignal(form) !== null, "記入済みのフォーム");
      ok(altPiiValuesRemain(form) !== null, "値が残る");
    });
    await it("伏せた後は値が残らない・物件と内見の日・管理会社名は残る", () => {
      const m = maskApplicationValuesForAlt(form);
      eq(altPiiValuesRemain(m, { docs: true }), null, m);
      eq(altPiiSignal(m), null, m);
      for (const v of ["1995", "090-1234", "テスト商事", "350万", "example.com", "タロウ", "テスト 太郎"]) ok(!m.includes(v), `${v} が残った: ${m}`);
      for (const v of ["申込者様記入欄", "テストハイツ203号室", "家賃8万円", "10月25日", "管理会社名：テスト不動産"]) ok(m.includes(v), `${v} が消えた: ${m}`);
    });
    await it("書類の読み取りの束は丸ごと伏せる", () => {
      const doc = "お客様: [画像] 運転免許証\n氏名：テスト 花子\n生年月日：平成8年4月1日生\n住所：テスト県テスト市1-2-3\n公安委員会\n\nスタッフ: 確認しました！！";
      ok(altPiiValuesRemain(doc, { docs: true }) !== null, "伏せる前は当たる");
      const m = maskApplicationValuesForAlt(doc);
      ok(m.includes(ALT_DOC_MASK), m);
      ok(!m.includes("テスト 花子") && !m.includes("平成8年"), m);
      eq(altPiiValuesRemain(m, { docs: true }), null, m);
      ok(m.includes("確認しました"), m);
    });
    await it("指示文の語（本人確認書類・生年月日の欄の名前）だけの文は変えない", () => {
      const sys = "申込には申込フォーマットと本人確認書類（運転免許証またはマイナンバーカードの裏表）が必要です。生年月日・勤務先は聞かない。";
      eq(maskApplicationValuesForAlt(sys), sys);
      eq(altPiiValuesRemain(sys), null);
    });
    await it("本文（system・messages）を伏せて remain=null・元の本文は変えない", () => {
      const body = { system: [{ type: "text", text: "会話の材料:\n年収 420万円のお客様" }], messages: [{ role: "user", content: form }] };
      const r = maskAltBody(body);
      eq(r.remain, null);
      eq(r.changed, true);
      ok(!JSON.stringify(r.masked).includes("420万"), "system の年収が残った");
      ok(JSON.stringify(body).includes("420万"), "元の本文を書き換えた");
    });
    await it("入口の伏せで見出しが変わった束・欄の名前の無い「・値」だけの束も伏せる", () => {
      const t = ["スモラ: こちらご記入お願いします", "お客様: 【おお客様記入欄】", "・11月頭", "・テスト　タロウ", "・テスト県テスト市1-2-3", "・テスト工業", "・400万ボーナス別", "", "【緊急連絡先欄】", "・テスト　ハナコ", "スモラ: ありがとうございます！！"].join("\n");
      const m = maskApplicationValuesForAlt(t);
      for (const v of ["タロウ", "テスト市1-2-3", "テスト工業", "400万", "ハナコ"]) ok(!m.includes(v), `${v} が残った: ${m}`);
      ok(m.includes("【おお客様記入欄】") && m.includes("ありがとうございます"), m);
      eq(altPiiValuesRemain(m, { docs: true }), null, m);
      ok(altPiiValuesRemain(t, { docs: true }) !== null, "伏せる前は当たる");
    });
    await it("スタッフが書き写した勤め先の案内（【お仕事情報】・氏名と読み・勤め先の法人名）も伏せる", () => {
      const t = ["スモラ: 保証会社から連絡が来ましたらこちらでお答えください！！", "テスト 花子（テスト ハナコ）さん 【お仕事情報】", "株式会社テスト設備", "テスト県テスト市テスト町1-2-3-4階", "スモラ: 合同会社テスト会での就業年数と年収をご教示ください", "お客様: 1年です。250万円程度です。"].join("\n");
      const m = maskApplicationValuesForAlt(t);
      for (const v of ["ハナコ", "テスト設備", "1-2-3-4階", "テスト会", "250万"]) ok(!m.includes(v), `${v} が残った: ${m}`);
      eq(altPiiValuesRemain(m, { docs: true }), null, m);
    });
    await it("物件の文・自社の名乗り・設備の読み・指示文は変えない", () => {
      const t = ["スモラ: 蓮産業株式会社の竹内です。", "テストレジデンス 203号室 家賃7.5万円 WIC（ウォークインクローゼット）付き", "【所在地】テスト県テスト市テスト町1丁目4-31 【交通】テスト線 徒歩5分", "管理会社はテスト管理株式会社です"].join("\n");
      // 10/21 確かめ役の後: 丁目・番地の数字はいつも伏せる（物件の住所の数字も）＝町名・駅名・それ以外は変えない
      eq(maskApplicationValuesForAlt(t), t.replace("1丁目4-31", "［伏せ字］"));
      const sys ="・仕事内容を聞かれたら答える\n・氏名は呼び名だけ\n・年収は聞かない\n・勤務先は聞かない";
      eq(maskApplicationValuesForAlt(sys, { fieldStart: "customer" }), sys);
    });
    await it("画像のブロックはそのまま通す", () => {
      const body = { messages: [{ role: "user", content: [{ type: "image", text: undefined }, { type: "text", text: "年収 500万円" }] }] };
      const r = maskAltBody(body);
      eq((r.masked.messages[0].content as Array<{ type: string }>)[0].type, "image");
      eq(r.remain, null);
    });
  });

  await describe("出口の網の穴（10/21 確かめ役・作り物）", async () => {
    const M = (t: string) => maskApplicationValuesForAlt(t);
    const clean = (t: string, vals: string[]) => {
      const m = M(t);
      for (const v of vals) ok(!m.includes(v), `${v} が残った: ${m}`);
      eq(altPiiValuesRemain(m, { docs: true }), null, `伏せた後に値が残る判定: ${m}`);
      return m;
    };
    await it("① 「・」の後の生年月日（. / 和暦＋月日）", () => {
      clean("お客様: ・テスト太郎\n・1990.12.19\n・1994/8/13\n・昭和40年7/23", ["1990.12.19", "1994/8/13", "昭和40年7/23"]);
      ok(altPiiValuesRemain("お客様: ・1990.12.19", { docs: true }) !== null, "伏せる前は当たる");
    });
    await it("② 全角空白の見出し（同じ行・次の行）", () => {
      clean("お客様: 住　所：テスト県テスト市テスト町\n氏　名　試験 花子\n生 年 月 日 1988年2月3日", ["テスト県テスト市テスト町", "試験 花子", "1988"]);
      clean("お客様: 氏名\n試験 花子\n住所\nテスト市テスト町", ["試験 花子", "テスト市テスト町"]);
    });
    await it("③ ファイル名の中の名前", () => {
      const m = clean("お客様: [ファイル] 2024_試験_花子_給与明細.pdf を送ります", ["試験", "花子"]);
      ok(m.includes("給与明細"), m);
    });
    await it("④ 読みの文", () => {
      clean("お客様: フリガナはシケン ハナコです", ["シケン", "ハナコ"]);
      eq(M("お客様: ふりがなはいりますか？"), "お客様: ふりがなはいりますか？");
    });
    await it("⑤ お客様の住所（丁目・番地・号・建物名と部屋）", () => {
      const m1 = clean("お客様: 今はテスト区テスト丘3-13-3です！", ["3-13-3"]);
      ok(m1.includes("テスト区テスト丘") && m1.includes("です！"), m1);
      clean("お客様: テスト市テスト1-18-8ルシエル202に住んでます", ["1-18-8", "ルシエル202"]);
      clean("お客様: テスト町2丁目5番3号", ["2丁目", "5番3号"]);
      // 日付・時刻・広さ・徒歩は伏せない
      const keep = "お客様: 2026-10-21 の 10:00-12:00 に内見、徒歩5-10分、25㎡";
      eq(M(keep), keep);
    });
    await it("⑥ 在籍証明・会社名の行の法人名（スタッフの1通も）", () => {
      clean("スモラ: 在籍証明はテスト工業株式会社で取れました", ["テスト工業株式会社"]);
      clean("スタッフ: 会社名 有限会社テスト食品", ["テスト食品"]);
    });
    await it("2人目の確かめ役: 全角・西暦2桁・H/S・和暦の点・半角カナの長音・〒・様方・拡張子だけ・ローマ字・ひらがなの読み", () => {
      clean("お客様: ・１９９０．１２．１９\n誕生日は90/12/19\nH2.3.4生まれ\nＳ６０．７．２３\n平成2.3.4", ["１９９０", "90/12/19", "H2.3.4", "６０．７．２３", "平成2.3.4"]);
      clean("お客様: テスト町2丁目 7ｰ2ｰ201\nテスト町3丁目5\nテスト町12番地の3\n〒123-4567\nテスト町1234-5 試験様方", ["7ｰ2ｰ201", "ｰ201", "3丁目5", "12番地の3", "123-4567", "1234-5"]);
      clean("お客様: [ファイル] 試験花子.pdf\n[ファイル] shiken_hanako_kyuyo.pdf\nふりがなはしけんはなこ\nシケン ハナコと読みます", ["試験花子", "shiken", "hanako", "しけんはなこ", "シケン"]);
    });
    await it("2人目の確かめ役: 物件の名前の丁目・探す範囲・順番・部屋の番号・自社の事務所の住所は伏せない", () => {
      const keep = [
        "スモラ: 【テスト山東3丁目PJ 302号室】",
        "スモラ: 日本橋1丁目、2丁目全域からお調べしました",
        "スモラ: 申込順位は1-2番手です／部屋番号は101-102どちらでも",
        "スモラ: 鍵は弊社事務所（大阪市中央区瓦町3-4-10 日宝御堂ビル5階）でお渡しします",
        "お客様: 2024/10/21に内見、2024-10-21 10:00〜、2-3件見たいです",
        "スモラ: 平成20年3月築・2026.11.1入居・1-2ヶ月・約25-30万円",
        "お客様: ふりがなはいりますか",
        "スモラ: 読み方はなんと読みますか？",
      ].join("\n");
      eq(M(keep), keep);
      eq(altPiiValuesRemain(keep, { docs: true }), null);
    });
    await it("伏せきれない時は remain が立つ（fail closed → Claude）", () => {
      ok(altPiiValuesRemain("お客様: 住所はテスト丘3-13-3", { docs: true }) !== null, "番地の数字");
      ok(altPiiValuesRemain("お客様: カナはシケン", { docs: true }) !== null, "読みの文");
      const r = maskAltBody({ messages: [{ role: "user", content: "お客様: ・1990.12.19\nテスト丘3-13-3です" }] });
      eq(r.remain, null); ok(r.changed, "置き換えた");
    });
  });

  await describe("判定を1つにした（2026-10-21・ハブ・やることリスト・司令塔・個人情報の門が同じ judgeParallelSecond）", async () => {
    const msg = (sender: string, text: string, at: string) => ({ sender, text, createdAt: T(at) });
    const back = { status: "proposing", applicationPushAt: T("2026-10-12T00:00:00Z"), statusManualBackAt: T("2026-10-13T00:00:00Z") };
    await it("申込を続けたまま物件提案中へ戻した会話: 戻した後の「2番手で申込完了」で並行", () => {
      const st = judgeParallelSecond(back, { msgs: [msg("staff", "2番手でお申し込み完了しております！！", "2026-10-13T05:00:00Z")] }, NOW, ENV_ON);
      eq(st.parallel, true);
    });
    await it("戻す直前（2日以内）に伝えた「2番手で受理」→ 戻して並行（実データ a3cc571e の形）・それより前の文は数えない", () => {
      eq(judgeParallelSecond(back, { msgs: [msg("staff", "2番手で受理されております！！", "2026-10-12T20:00:00Z")] }, NOW, ENV_ON).parallel, true);
      eq(judgeParallelSecond(back, { msgs: [msg("staff", "2番手で受理されております！！", "2026-10-10T05:00:00Z")] }, NOW, ENV_ON).parallel, false);
    });
    await it("その後に否決・取り下げ・1番手が通過・繰り上がり → 並行ではない（申込歴あり側）", () => {
      for (const end of ["審査否決となりました", "お申込みキャンセルさせていただきます", "1番手の方が審査承認となりました", "繰り上がりました！！"]) {
        eq(judgeParallelSecond(back, { msgs: [msg("staff", "2番手で受理されております！！", "2026-10-12T20:00:00Z"), msg("staff", end, "2026-10-14T00:00:00Z")] }, NOW, ENV_ON).parallel, false, end);
      }
      // 仮定は終わりにしない
      ok(!isParallelEndText("1番手の方審査否決、キャンセルの場合繰り上がり審査開始となります"), "仮定");
    });
    await it("案内（「よろしければ2番手で…」「お気に召されましたら2番手で…」「2番手でのお申込可能」）は申込前でも申込中でも並行にしない", () => {
      for (const t of ["よろしければ2番手でお申し込みさせて頂きます！！", "お気に召されましたら2番手ですがお部屋のお申込みもさせていただきます！！", "2番手でのお申込可能となります！！"]) {
        eq(judgeParallelSecond(applying(), { msgs: [msg("staff", t, "2026-10-16T00:00:00Z")] }, NOW, ENV_ON).parallel, false, t);
        eq(judgeParallelSecond({ status: "viewing" }, { msgs: [msg("staff", t, "2026-10-16T00:00:00Z")] }, NOW, ENV_ON).parallel, false, t);
      }
    });
    await it("申込の記録が無い申込前の会話は、申込んだ文があっても並行にしない（申込前の止めはそもそも無い）", () => {
      eq(judgeParallelSecond({ status: "viewing" }, { msgs: [msg("staff", "2番手で受理されております！！", "2026-10-16T00:00:00Z")] }, NOW, ENV_ON).parallel, false);
    });
    await it("スタッフの選択（メモの行）が最優先・スイッチ off は全部 false", () => {
      eq(judgeParallelSecond(applying(), { msgs: [], memoItems: [{ id: PARALLEL_MEMO_ID, text: PARALLEL_MEMO_ON }] }, NOW, ENV_ON).parallel, true);
      eq(judgeParallelSecond(applying(), { msgs: [msg("staff", "2番手で受理されております！！", "2026-10-16T00:00:00Z")], memoItems: [{ id: PARALLEL_MEMO_ID, text: PARALLEL_MEMO_OFF }] }, NOW, ENV_ON).parallel, false);
      eq(judgeParallelSecond(applying(), { msgs: [msg("staff", "2番手で受理されております！！", "2026-10-16T00:00:00Z")] }, NOW, { REAPPLY_PARALLEL_2ND: "off" }).parallel, false);
    });
    await it("個人情報の門: 戻した会話でも並行なら DeepSeek の線を引かない（Claude）・申込以降に数える", () => {
      const f: PostApplyFacts = { ...back, parallel2nd: true };
      eq(deepseekSafeCutoff(f), null);
      eq(deepseekSafeCutoff(f, { reapply: true }), null);
      eq(deepseekPostApply(f, ENV_ON), true);
      const e = resolveDeepseekEntrance(f, ENV_ON);
      eq([e.altPostApply, e.cutoff], [true, null]);
      // 並行でない戻した会話は今まで通り戻した時刻より後
      eq(deepseekSafeCutoff(back), T("2026-10-13T00:00:00Z"));
    });
    await it("申込歴ありの札: 2番手で申込中なら付けない（並行でなければ今まで通り）", () => {
      eq(resolveReapply({ ...back, parallel2nd: true }).reapply, false);
      eq(resolveReapply(back).reapply, true);
    });
  });

  await describe("【申込歴あり】の文字（札・やることリスト・材料）", async () => {
    await it("札・見出しは【申込歴あり】でそろう", () => {
      eq(REAPPLY_MARK_TEXT, "【申込歴あり】");
      eq(REAPPLY_HEADER_MARK, REAPPLY_MARK_TEXT);
      eq(reapplyBadgeText({ pattern: "switched" }), "【申込歴あり】③別の物件に切替");
      ok(!/🔥/.test(reapplyBadgeText({ pattern: "unknown" })), "🔥 が残った");
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}
main();
