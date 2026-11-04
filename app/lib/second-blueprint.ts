// app/lib/second-blueprint.ts — AIX の2通目を返信と同じ「文の設計図」の型に乗せる（純関数）
//
// 2026-11-03 作業員6（竹内さん KB P1「構成を考えるブレインを、返信・AIX の1通目・2通目・テンプレートの全部の文の生成に置く」・統括の順番 2）。
//   2通目の訴求の判断（second-appeal-judge.ts の AppealJudge＝判断→書き手が従うの先例）を ComposeIntent に移し、buildBlueprint で設計図にする。
//   竹内さんの2通目の型の要約と手本（takeuchiFormSummary・pickTakeuchiExamples）は、設計図の根拠として残す（写す物ではない）。
//   スイッチ AIX_SECOND_BLUEPRINT=on（既定 off＝今の judgedAppealNote のまま）。
// テスト: app/lib/__tests__/second-blueprint.test.ts
import { buildBlueprint, blueprintNote, type ComposeIntent, type ComposeBlueprint } from "./compose-blueprint";
import { takeuchiFormSummary, pickTakeuchiExamples, type AppealJudge, type SecondTakeuchiInput } from "./second-appeal-judge";
import { elementsOf } from "./second-appeal-points";

export function secondBlueprintOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_SECOND_BLUEPRINT ?? "").trim().toLowerCase() === "on";
}

/** 2通目の訴求の判断 → 構成の意図（主語は物件・メインの1文は一番の訴求・2番目は添えの訴求1つ・締めは判断のまま） */
export function intentFromAppealJudge(j: AppealJudge): ComposeIntent {
  return {
    purpose: "appeal",
    why: j.first.why,
    feel: "このお部屋は自分に合っている",
    next: j.closing === "apply" ? "apply" : j.closing === "viewing" ? "viewing" : "none",
    main: { subject: "property", what: j.first.text },
    adds: j.second && j.count === 2 ? ["appeal"] : [],
    closing: j.closing === "apply" ? "apply_cta" : j.closing === "viewing" ? "viewing_cta" : "receipt",
    confidence: "high",
    source: "brain",
  };
}

/** 2通目の設計図（名前はメインの1文の頭に・挨拶の段は置かない＝竹内さんの2通目は1通目の直後で挨拶なし） */
export function secondBlueprint(j: AppealJudge): ComposeBlueprint {
  const intent = intentFromAppealJudge(j);
  const bp = buildBlueprint({ intent, requirements: [], greet: "none" });
  const main = bp.parts.find((p) => p.role === "main");
  if (main) main.say = `〇〇さん（名前）＋${j.first.text}（理由: ${j.first.why}）・言い方の型: ${j.form}`;
  const add = bp.parts.find((p) => p.role === "add");
  if (add && j.second) add.say = `${j.second.text}（理由: ${j.second.why}）・1つだけ`;
  return bp;
}

/** 書き手への注記（設計図＋竹内さんの型と手本を根拠に）。今の judgedAppealNote の置き換え */
export function secondBlueprintNote(j: AppealJudge, scene: string, data: SecondTakeuchiInput): string {
  const bp = secondBlueprint(j);
  const wantEls = [...elementsOf(j.first.text), ...(j.second ? elementsOf(j.second.text) : [])];
  const ex = pickTakeuchiExamples(data.examples, scene, wantEls, 3);
  // 2026-11-03 sbp の採点: ご査収の番に内覧の誘いが足されていた（締めの注記が二重・設計図に「誘いを足さない」が無かった）→ 締めを1か所で明示
  const closingLine = ({
    viewing: "内覧へ（「お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！」の1文・その後に「お手隙の際にご査収ください😌！！」）",
    apply: "申込へ（「お気に召されましたらお申込しお部屋抑えさせて頂きます！！」の1文・その後に「お手隙の際にご査収ください😌！！」）",
    receipt: "ご査収だけ（「お手隙の際にご査収ください😌！！」の1文だけ・内覧や申込の誘いは足さない）",
  } as const)[j.closing];
  return [
    blueprintNote(bp),
    `・締め（ここだけで決める・他の締めの指示より優先）: ${closingLine}（理由: ${j.closingWhy}）`,
    // 2026-11-04 grp-aix の悪化（d13194c8・18aff1b4）: この1行が訴求の点の数字（帖数・徒歩の分）まで止め、竹内さんの文にある数字を落とした → 訴求の点に付く数字は書いてよいと分ける
    "・上に無い設備・駅・築年を並べ足さない（ただし上の訴求の点に付く数字＝間取りの帖数・駅の徒歩の分・築年月は、1通目・資料のまま書いてよい）。事実は1通目・資料にある事だけ。金額・節約額は書かない（初期費用は「敷金礼金なしで初期費用を抑える事ができ」の言い方まで）。",
    takeuchiFormSummary(scene, data.forms),
    ex.length ? `【竹内さんの2通目の手本（設計図の根拠・写さず構成だけ見る）】\n${ex.map((t, k) => `${k + 1}) ${t.replace(/\n+/g, " ")}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}
