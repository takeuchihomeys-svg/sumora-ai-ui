// 「このお客様の申込がどこまで進んでいるか」（竹内 2026-09-21）。
//
// 竹内「先ほどの実際に申し込んだかのところ判断できるようにする」
//
// ★★ は**他人の申込をこのお客様の申込と数えない**ための線（実測でここが混ざっていた）。
// 実行: npx tsx app/lib/__tests__/application-stage.test.ts（全 PASS で exit 0）
import { resolveApplicationStage, buildApplicationStageNote } from "../application-stage";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: unknown) { if (typeof actual === "string" ? !actual.includes(String(item)) : true) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
    notToContain(item: unknown) { if (typeof actual === "string" && actual.includes(String(item))) throw new Error(`expected NOT to contain ${JSON.stringify(item)}`); },
  };
}

describe("★★ 他人の申込をこのお客様の申込と数えない", () => {
  it("★★ O1 「1番手でお申込みがはいっておりますので、2番手以降」は他人の申込", () => {
    const v = resolveApplicationStage(["1番手でお申込みがはいっておりますので、2番手以降でのお申込みとなります。"]);
    expect(v.submitted).toBe(false);
  });
  it("★★ O2 「現在お申込みが入っており、3番手でのお申込みが可能」も他人", () => {
    const v = resolveApplicationStage(["現在お申込みが入っており、3番手でのお申込みが可能となっております！！"]);
    expect(v.submitted).toBe(false);
  });
  it("★★ O3 物件確認の結果報告（申込が入ってしまった）も他人", () => {
    const v = resolveApplicationStage(["お送り頂きました物件は既にお申込みが入っております！！"]);
    expect(v.submitted).toBe(false);
  });
  it("★★ O4 「お部屋ご退去までにお申込み入る可能性もございます」は予測であって申込ではない", () => {
    const v = resolveApplicationStage(["お部屋ご退去までにお申込み入る可能性もございます！！"]);
    expect(v.submitted).toBe(false);
  });
  it("★★ O5 同じ通に他人の申込とこちらの申込が混ざっていても、こちらを拾う", () => {
    const v = resolveApplicationStage([
      "1番手でお申込みがはいっておりますので、2番手以降でのお申込みとなります。\n無事一番手にてお申込み完了しております！！",
    ]);
    expect(v.submitted).toBe(true);
  });
});

describe("★ 段階を見分ける（実送信の文そのまま）", () => {
  it("★ S1 何も無ければ none", () => {
    expect(resolveApplicationStage(["こちらお部屋の詳細となります！！", "お手隙の際にご査収ください😌！！"]).stage).toBe("none");
  });
  it("★ S2 案内しただけは guided（まだ申し込んでいない）", () => {
    const v = resolveApplicationStage(["お気に召されましたらお申込みしお部屋押さえさせて頂きます😊！！"]);
    expect(v.stage).toBe("guided");
    expect(v.submitted).toBe(false);
  });
  it("★ S3 「お申込みさせていただきます」は declared", () => {
    const v = resolveApplicationStage(["1303号室お申込みさせて頂きます😊！！"]);
    expect(v.stage).toBe("declared");
    expect(v.submitted).toBe(false);
  });
  it("★ S4 申込に必要な情報の依頼は info_requested", () => {
    const v = resolveApplicationStage(["こちらお申込に必要なご情報となります😊！！", "【緊急連絡先欄】"]);
    expect(v.stage).toBe("info_requested");
    expect(v.submitted).toBe(false);
  });
  it("★ S5 「無事一番手にてお申込み完了しております」は submitted", () => {
    const v = resolveApplicationStage(["無事一番手にてお申込み完了しております！！"]);
    expect(v.stage).toBe("submitted");
    expect(v.submitted).toBe(true);
  });
  it("★ S6 審査の話が出ていれば screening", () => {
    const v = resolveApplicationStage(["保証会社審査通過後オーナーによる最終審査に移ります。"]);
    expect(v.stage).toBe("screening");
    expect(v.submitted).toBe(true);
  });
  it("★ S7 進んだ方を採る（案内 → 完了 の順に並んでいても完了）", () => {
    const v = resolveApplicationStage([
      "お気に召されましたらお申込みしお部屋押さえさせて頂きます😊！！",
      "こちらでお申込完了させて頂きます！！",
    ]);
    expect(v.stage).toBe("submitted");
  });
  it("S8 根拠が残る", () => {
    const v = resolveApplicationStage(["無事1番手にてお申込み完了しております😊！！"]);
    if (!v.evidence) throw new Error("根拠が空");
  });
  it("S9 空でも落ちない", () => {
    expect(resolveApplicationStage([]).stage).toBe("none");
    expect(resolveApplicationStage([null, undefined, ""]).stage).toBe("none");
  });
});

describe("★★ 審査の一般論・制度の説明を「審査中」と数えない（全件監査で見つけた誤判定）", () => {
  it("★★ G1 「審査通過しやすいお部屋」は物件の特徴（申込していない）", () => {
    for (const s of [
      "阿波座・本町・桜川周辺エリア全域から審査通過しやすいお部屋ピックアップしお送りさせていただきます！！",
      "豊崎で募集中の審査通りやすいお部屋ございませんでしたので、北区全域からお探しします！！",
      "審査通過する為に保証会社を取り扱う事が出来る独立系の保証会社を中心にお部屋ピックアップします！！",
    ]) {
      const v = resolveApplicationStage([s]);
      if (v.stage === "screening") throw new Error(`審査中と誤判定: ${s}`);
      expect(v.submitted).toBe(false);
    }
  });
  it("★★ G2 制度の説明も「審査中」ではない", () => {
    for (const s of [
      "※保証会社審査通過後オーナー審査移行までキャンセル可能です！",
      "お部屋お申込みを行なってから、ご入居の審査が3日〜10日程必要となります。",
    ]) {
      const v = resolveApplicationStage([s]);
      if (v.stage === "screening") throw new Error(`審査中と誤判定: ${s}`);
    }
  });
  it("★★ G3 願望（審査通過しますよう）も審査中ではない", () => {
    expect(resolveApplicationStage(["無事審査通過しますようにサポートさせて頂きます！！"]).stage).toBe("none");
  });
  it("★ G4 本物の審査は今までどおり拾う", () => {
    for (const s of [
      "現在審査中となります！！",
      "確認させていただきましたが、こちら保証会社審査中とのご返事でした。",
      "メロディーハイム九条の管理会社より保証会社審査否決とのご連絡がございました。",
      "審査通過しましたのでご連絡させて頂きます😊！！",
    ]) {
      expect(resolveApplicationStage([s]).stage).toBe("screening");
    }
  });
  it("★★ G5 他人の審査（1番手の方・繰り上がり）は数えない", () => {
    // 「1番手審査の方否決・キャンセルの場合、繰り上がり審査開始となります！！」＝ 他人の審査の説明
    const v = resolveApplicationStage(["1番手審査の方否決・キャンセルの場合、繰り上がり審査開始となります！！"]);
    if (v.stage === "screening") throw new Error("他人の審査を数えている");
  });
});

describe("★ 生成に渡す材料（申込が済んでいない時こそ書く）", () => {
  it("★★ M1 申込していない時は「申込が済んだ前提の文は書かない」と渡す", () => {
    for (const s of [["こちらお部屋の詳細となります！！"], ["お気に召されましたらお申込みしお部屋押さえさせて頂きます！！"]]) {
      const n = buildApplicationStageNote(resolveApplicationStage(s));
      expect(n).toContain("まだお申込み");
      expect(n).toContain("申込が済んだ前提の文は書かない");
    }
  });
  it("★ M2 完了していればお礼を書いてよいと渡す", () => {
    const n = buildApplicationStageNote(resolveApplicationStage(["無事一番手にてお申込み完了しております！！"]));
    expect(n).toContain("お申込みは完了している");
    expect(n).notToContain("書かない前提");
  });
  it("★ M3 審査中は結果を断言させない", () => {
    const n = buildApplicationStageNote(resolveApplicationStage(["保証会社審査通過後オーナー審査に移ります"]));
    expect(n).toContain("断言せず");
  });
  it("M4 どの段階でも空文字にならない", () => {
    for (const s of [[], ["お気に召されましたらお申込み"], ["お申込みさせて頂きます"], ["【緊急連絡先欄】"], ["お申込完了"], ["審査中"]]) {
      if (!buildApplicationStageNote(resolveApplicationStage(s))) throw new Error("材料が空");
    }
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
