// app/lib/second-message-scene.ts
// AIX【物件オススメ】の直後に送る2通目（AIX テンプレート）の「場面ごとの形」を、実送信の実物で渡す（純関数・DB 依存なし）。
//
// 2026-09-30 竹内（YUMA に届いた2通目「…かなり珍しい好条件です！！／…この208号室ならではの強みです😊！！」を見て）:
//   「言い回しが AI くさいから原因見つけて改善する。実際使っている言い回しが出るように。
//    複数のなかの物件のなかでオススメや、新着物件のなかでオススメ等 状況によって違うのと、退去予定の物件や空室の物件によって訴求方法も変わる。
//    判断する為に状況把握補填できない部分等あれば追加する。資料もちゃんとよみとった方がよいなら、読みとったのを AIX テンプレートにも渡す」
//
// ■ 出所（本番と同じ body をローカルで組んで system / user の全文を読んだ）
//   手本（実送信の2通目）は届いていた。「お送りさせて頂きましたお部屋の中でも特に◯◯が…かなりオススメ出来るお部屋となります！！」が2件。
//   それなのに違う形になったのは、**最後に置いた指示が実送信の形と逆**だったから:
//     ・template-length「スタッフが書いているのは自分の見立て」「1通目に無い切り口（比較・見立て…）を1〜2文」「要点を1つに絞る」
//     ・aix-chain-note「宣言・設備・立地・費用を並べ直さない」「見立てを伝えて終わってよい」「呼びかけ35%・物件名36%・毎回は付けない」
//     ・recommend-cta「1通目の物件の見立てを1つだけ添えて終わる」
//   「見立て」が5回出てくる → モデルは評論の一文（「〜というのは、かなり珍しい好条件です」「〜ならではの強みです」「〜かと思います」）を作る。
//   割合（呼びかけ35%・内覧の誘い6.1%）は AIX 全種類の平均で、物件オススメの直後の2通目とは別物だった。
//
// ■ 実送信（scripts/audit-second-message-phrasing.ts・365日・YUMA と申込以降を除く・477組）
//   1通目が今の形（🌟建物 号室／…かなりオススメ出来るお部屋となります）の312組で、2通目でも「オススメ出来るお部屋」を重ねる 82.7%。
//   ＝2通目は「見立てを一言」ではなく、**テンプレート「1件特にオススメ」（使用257回）の形に理由を入れた1文＋締めの1文**。
//     (a) 複数の中で1件 219組: 中央値140字・2段落・3文。名前呼びかけ85%・かなりオススメ出来るお部屋79%・お気に召されましたら67%・費用を抑える事60%
//     (b) 新着 166組: 141字。「新着で1件◯◯さんにオススメ出来るお部屋が募集に出ました！！」・ご査収60%
//     (c) 1件だけ 58組: 152字。「こちらのお部屋如何でしょうか😊！！」47%
//     (d) 退去予定 88組: 「◯月◯日退去予定のため、◯月◯日以降ご内覧可能となります！！」＋ご査収56%
//   絵文字: 1個62%・2個24%・無し11%。位置は文の最後の「！！」の直前が86%（😊328・😌170）。「。」で終わる文0.3%・「！！」88%。
//   号室だけで呼ぶ（この208号室）0通。「強みです・ならでは・珍しい・好条件です・お値打ち・魅力です・かと思います」0通。
//
// ■ 手本は創作しない（feedback_no_invented_phrases）
//   下の EXAMPLES は全部スタッフが実際に送った2通目の本文そのまま。変えているのはお客様の名前だけ（今回のお客様の名前に置き換える）。
//   物件名・駅・金額はその時の物 → 今回の文に持ち込んでいないかを出口（leakedExampleFacts）で見る。

import type { RecommendationScenario } from "./recommendation-frame";

export type SecondSceneKey = "compare" | "new_listing" | "single";

/** 訴求シナリオ → 2通目の場面。代替・追加・初回は「1件だけ」の形 */
export function secondSceneOf(scenario: RecommendationScenario | null | undefined): SecondSceneKey {
  if (scenario === "compare") return "compare";
  if (scenario === "new_listing") return "new_listing";
  return "single";
}

const N = "{{NAME}}";

type Example = {
  /** 実送信の本文（お客様の名前だけ {{NAME}}） */
  text: string;
  /** 退去予定の通か */
  vacating: boolean;
  /**
   * その時の物件名・駅（今回の文に持ち込んではいけない語）。
   * ⚠ 日付・年・きりの良い金額（今月末・10月1日・2017年・7万円）は入れない: 全件監査で、別の物件の実送信 16/477 が当たった（誤って作り直しになる）
   */
  facts: string[];
};

/** スタッフが実際に送った2通目（本文そのまま）。日付は実送信の日 */
export const SECOND_MESSAGE_EXAMPLES: Record<SecondSceneKey, Example[]> = {
  compare: [
    { // 2026-09-28
      text: `お送りさせて頂きましたお部屋の中でも特にLuxe難波西2 1009が芦原橋駅徒歩3分・敷金礼金なしで初期費用をかなり抑える事ができ、${N}さんにかなりオススメ出来るお部屋となります！！\n\n${N}さんお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！`,
      vacating: false, facts: ["Luxe難波西", "芦原橋"],
    },
    { // 2026-08-29
      text: `お送りさせて頂きましたお部屋の中でもヴェルテックス07が敷金礼金なし・2017年築で築年数浅く、${N}さんにかなりオススメ出来るお部屋となります！！\n\n${N}さんお気に召されたお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！`,
      vacating: false, facts: ["ヴェルテックス"],
    },
    { // 2026-09-29
      text: `お送りさせて頂きましたお部屋の中でも特にエグゼ難波東 906号室が堺筋線「日本橋」駅徒歩8分・家賃管理費込98,000円・2K・角部屋で、${N}さんにかなりオススメ出来るお部屋となります！！\n\n${N}さんお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！`,
      vacating: false, facts: ["エグゼ難波東", "日本橋"],
    },
    { // 2026-09-25
      text: `お送りさせて頂きましたお部屋の中でも特にパークハイム永和105が敷金礼金なし・ペット2匹まで可・敷地内駐車場空き1台と、${N}さんにかなりオススメ出来るお部屋となります！！\n\nお手隙の際にご査収ください！！`,
      vacating: false, facts: ["パークハイム永和", "ペット2匹"],
    },
    { // 2026-09-23（退去予定）
      text: `お送りさせていただきましたお部屋の中でもアドバンス大阪セレーネが築浅6年のトイレ独立洗面台が別れた使い勝手良いお部屋となります！！\n\n11月1日退去予定のお部屋となり、少し先となりますが、家賃7万円以内に抑えられるかなりオススメ物件となります！！\n\nお手隙の際にご査収ください😊！！`,
      vacating: true, facts: ["アドバンス大阪セレーネ", "築浅6年"],
    },
  ],
  new_listing: [
    { // 2026-09-12
      text: `新着で1件${N}さんにオススメ出来るお部屋が募集に出ました！！\nお気に召されましたらお部屋ご案内させて頂きます！！\nお気軽にお申し付けください😌✨`,
      vacating: false, facts: [],
    },
    { // 2026-09-08
      text: `1件新着で${N}さんにオススメ出来るお部屋募集に出ました😊！！\n初期費用面もかなり抑える事ができます！！\nお手隙の際にご査収ください😌！！`,
      vacating: false, facts: [],
    },
    { // 2026-09-01
      text: `新着で1件、${N}さんにオススメ出来るお部屋が募集に出ました！\n\nお気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！\nお手隙の際にご査収ください😌！！`,
      vacating: false, facts: [],
    },
    { // 2026-09-25（退去予定）
      text: `新着で1件Veena弁天402が、2025年3月築で築年数も新しく費用を抑える事ができ、${N}さんにかなりオススメ出来るお部屋となります！！\n\n9月30日退去予定のため、10月1日以降ご内覧可能となります！！\n\nお手隙の際にご査収ください😊！！`,
      vacating: true, facts: ["Veena弁天"],
    },
    { // 2026-09-18（退去予定）
      text: `今月末退去予定で1件${N}さんにかなりオススメ出来るお部屋が募集に出ました！！\nお気に召されましたら退去後お部屋ご案内させて頂きます😌！！\nお手隙の際にご査収ください！`,
      vacating: true, facts: [],
    },
  ],
  single: [
    { // 2026-08-17
      text: `こちらのお部屋如何でしょうか😊！！\n2015年築家賃管理費込61,000円、Wi-Fi無料の為毎月の費用を抑える事が出来ます！！\n${N}さんお気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！`,
      vacating: false, facts: ["61,000"],
    },
    { // 2026-09-19
      text: `こちらのお部屋如何でしょうか！！\n家賃管理費込67,000円、独立洗面、御堂筋線大国町駅徒歩7分、なんば駅徒歩10分の立地となります😊！！\nお手隙の際にご査収ください😌！！`,
      vacating: false, facts: ["大国町", "なんば駅"],
    },
    { // 2026-09-08
      text: `${N}さんこちらのお部屋如何でしょうか！！\n桜川駅まで徒歩7分、初期費用面もかなり抑える事ができます😊！！\nお部屋もご内覧可能となります！！\n${N}さんお手隙の際にご査収ください！`,
      vacating: false, facts: ["桜川"],
    },
    { // 2026-09-08（成約した会話・退去予定）
      text: `クレール元町 203が築年数も新しくリビング、洋室共に広々とした${N}さんにかなりオススメ出来るお部屋となります！！\n\nお手隙の際にご査収ください😊！！`,
      vacating: true, facts: ["クレール元町"],
    },
    { // 2026-09-20（退去予定）
      text: `こちらのお部屋如何でしょうか😌！！\n9月末退去予定予定のため10月1日以降ご内覧出来ます！！\nお気に召されましたら10月1日以降お部屋ご案内させて頂きます！！\nお手隙の際にご査収ください😌！！`,
      vacating: true, facts: [],
    },
  ],
};

/** 手本の名前を今回のお客様の名前にする。名前が分からない時は呼びかけごと落とす（伏せ字を残さない） */
export function renderExample(text: string, name: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (n) return text.split(N).join(n);
  return text.replace(/\{\{NAME\}\}さん(?:に(?=(?:かなり)?オススメ)|、)?/g, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// 資料の事実（1通目の物件に当たる property_pickups の行から・資料の字のまま）
// ─────────────────────────────────────────────────────────────────────────────

/** property_pickups の行のうち使う所だけ（ゆるい型。読めない所は無視する） */
export type SecondMaterialRow = {
  property_name?: string | null;
  room_no?: string | null;
  terms?: {
    deposit?: number | null; keyMoney?: number | null; freeRent?: unknown; newBuild?: boolean | null;
    moveIn?: { kind?: string | null; current?: string | null; availableFrom?: string | null } | null;
    evidence?: { moveIn?: string | null; built?: string | null; deposit?: string | null } | null;
  } | null;
  location?: {
    stations?: Array<{ line?: string | null; station?: string | null; walk?: number | null }> | null;
    area?: { why?: string | null; code?: string | null } | null;
  } | null;
  equipment?: {
    match?: Array<{ label?: string | null; result?: string | null }> | null;
    facts?: Record<string, { s?: string | null; ev?: string | null } | null> | null;
  } | null;
};

/** 資料の現況から「退去予定（まだご内覧頂けない）」か。分からなければ null */
export function vacatingFromMaterial(row: SecondMaterialRow | null | undefined): boolean | null {
  const cur = row?.terms?.moveIn?.current ?? null;
  if (cur === "leaving" || cur === "occupied") return true;
  if (cur === "vacant") return false;
  return null;
}

/** お客様に書いてよい設備（資料に「あり」と出ている物だけ・資料の字のまま）。社内向けの項目（構造の判定・駐車場なし等）は出さない */
const EQUIP_KEYS = ["washbasin", "bath_dryer", "net_free", "autolock", "delivery_box", "gas_stove", "system_kitchen", "washlet", "bath_toilet", "pet", "elevator", "garbage24"] as const;

/**
 * 1通目の物件の資料の事実。推す理由はここに書いてある事だけを使わせる。
 * 行が無い・読める事が1つも無い時は空文字（何も主張しない）。AD・採点・点数は出さない。
 */
export function buildSecondMaterialNote(row: SecondMaterialRow | null | undefined): string {
  if (!row) return "";
  const L: string[] = [];
  const t = row.terms ?? null;
  const ev = t?.evidence ?? null;
  const vac = vacatingFromMaterial(row);
  if (ev?.moveIn || vac !== null) {
    const raw = ev?.moveIn ?? "";
    if (vac === true && !/退去予定/.test(raw)) {
      // 資料の現況が「居住中」の行: お客様への言い方は「退去予定のお部屋」。資料の「居住中」をそのまま渡すと「現在ご入居中のため」と書かれた（YUMA 9/30）
      const when = raw.match(/入居可能時期\s*([^\s]+)/)?.[1] ?? "";
      L.push(`・現況: 退去予定のお部屋（まだご内覧頂けない）${/[0-9０-９]+\s*[年月]/.test(when) ? `／入居可能時期（資料）: ${when}` : ""}`);
    } else {
      L.push(`・現況（資料）: ${raw || (vac ? "退去予定" : "空室")} → ${vac === true ? "退去予定のお部屋（まだご内覧頂けない）" : vac === false ? "空室（ご内覧頂けるお部屋）" : "内覧できるかは資料から分からない"}`);
    }
  }
  const st = (row.location?.stations ?? []).filter((s) => s?.station && typeof s.walk === "number").slice(0, 2);
  if (st.length) L.push(`・駅: ${st.map((s) => `${s.line ? `${s.line} ` : ""}${s.station}駅 徒歩${s.walk}分`).join("／")}`);
  if (ev?.built) L.push(`・築年（資料）: ${ev.built.replace(/^築年数/, "")}${t?.newBuild ? "（新築）" : ""}`);
  if (typeof t?.deposit === "number" && typeof t?.keyMoney === "number") {
    L.push(t.deposit === 0 && t.keyMoney === 0
      ? "・敷金・礼金: どちらもなし → 「敷金礼金なしで初期費用を抑える事ができ」と書ける"
      : `・敷金・礼金: ${t.deposit === 0 ? "敷金なし" : "敷金あり"}・${t.keyMoney === 0 ? "礼金なし" : "礼金あり"} → 「敷金礼金なし」「初期費用を抑える事ができ」は書かない`);
  }
  const fit = (row.equipment?.match ?? []).filter((m) => m?.result === "ok" && m.label).map((m) => String(m.label));
  const why = row.location?.area?.why;
  if (why && /MATCH/.test(String(row.location?.area?.code ?? ""))) fit.push(why);
  if (fit.length) L.push(`・お客様のご希望に合う点（資料で確かめた物）: ${[...new Set(fit)].join("／")}`);
  const unlisted = (row.equipment?.match ?? []).filter((m) => m?.result === "unlisted" && m.label).map((m) => String(m.label));
  if (unlisted.length) L.push(`・ご希望のうち資料に記載が無い物（合うと書かない）: ${unlisted.join("／")}`);
  const facts = row.equipment?.facts ?? {};
  const eq = EQUIP_KEYS.map((k) => (facts[k]?.s === "ok" ? facts[k]?.ev : null)).filter((x): x is string => !!x);
  if (eq.length) L.push(`・資料にある設備: ${[...new Set(eq)].join("・")}`);
  if (L.length === 0) return "";
  return ["【1通目の物件の資料の事実（資料の字のまま。理由に使うのはここと1通目に書いてある事だけ）】", ...L].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口: 場面ごとの形
// ─────────────────────────────────────────────────────────────────────────────

export type SecondSceneInput = {
  scene: SecondSceneKey;
  /** 退去予定（まだご内覧頂けない）。資料の現況 → ブレインの判断の順で呼び出し側が決める */
  vacating: boolean;
  /** お客様の名前（分からなければ空） */
  name: string;
  /** 1通目の見出しの物件（「建物名 208号室」）。読めなければ null */
  propertyLabel: string | null;
  /** これまでに送った物件の件数（分かれば） */
  sentCount?: number | null;
};

const SCENE_LABEL: Record<SecondSceneKey, string> = {
  compare: "複数のお部屋をお送りした中で、この1件を特にオススメする",
  new_listing: "新着で募集に出た1件をオススメする",
  single: "1件だけをお送りしてオススメする（ほかのお部屋と比べない）",
};

/**
 * 物件オススメの直後の2通目の形（プロンプトの最後に置く）。
 * 指示の言葉に「見立て・魅力・強み・特別感」等を入れない（指示の語がそのまま本文に出る）。「〜を添えろ」型の強制もしない。
 */
export function buildSecondSceneNote(i: SecondSceneInput): string {
  const nm = i.name.trim();
  const san = nm ? `${nm}さん` : "";
  const label = i.propertyLabel ?? "（1通目の見出しの建物名と号室）";
  const pool = SECOND_MESSAGE_EXAMPLES[i.scene];
  // 退去予定の時は退去予定の実物を先に、空室の時は空室の実物だけ
  const picked = (i.vacating ? [...pool.filter((e) => e.vacating), ...pool.filter((e) => !e.vacating)] : pool.filter((e) => !e.vacating)).slice(0, 4);
  const L: string[] = [];
  L.push("【この2通目の形（物件オススメの直後。ここより前の指示と食い違う所はこちらが正）】");
  L.push(`場面: ${SCENE_LABEL[i.scene]}${typeof i.sentCount === "number" && i.sentCount > 0 ? `（これまでにお送りした物件 ${i.sentCount}件）` : ""}／${i.vacating ? "退去予定のお部屋（まだご内覧頂けない）" : "空室のお部屋（ご内覧頂ける）"}`);
  L.push("スタッフはこの場面の2通目を決まった形で送っている。下の実物と同じ形・同じ言い回しで書く（言い回しを自分で作らない）。");
  L.push("");
  L.push("■ 形");
  if (i.scene === "compare") {
    L.push(`・1段落目は1文: 「お送りさせて頂きましたお部屋の中でも特に${label}が」＋理由＋「、${san ? `${san}に` : ""}かなりオススメ出来るお部屋となります！！」`);
  } else if (i.scene === "new_listing") {
    L.push(`・書き出しは「新着で1件${san ? `${san}に` : ""}オススメ出来るお部屋が募集に出ました！！」。物件名を入れる時は「新着で1件${label}が」＋理由＋「、${san ? `${san}に` : ""}かなりオススメ出来るお部屋となります！！」`);
    L.push("・「お送りさせて頂きましたお部屋の中でも」とは書かない（新着の1件で、比べる相手が無い）");
  } else {
    L.push(`・書き出しは「こちらのお部屋如何でしょうか😊！！」、または「${label}が」＋理由＋「、${san ? `${san}に` : ""}かなりオススメ出来るお部屋となります！！」`);
    L.push("・「お送りさせて頂きましたお部屋の中でも」「新着で」とは書かない（1件だけをお送りした場面）");
  }
  // ⚠ ここに言い回しの例（「費用を抑える事ができ」等）を書かない: YUMA のテストで、礼金のある物件にその語がそのまま出た（指示の語は本文に出る）
  L.push("・理由は、上の【資料の事実】と1通目にある事実を1〜2つ。「・」か「で、」でつないで同じ1文の中に入れる（下の実物の入れ方）。");
  L.push("　理由を別の文に切り出さない。事実をつないで「かなりオススメ出来るお部屋となります！！」で結び、その後に設備や感想の文を足さない。");
  L.push("　敷金礼金・初期費用の事は、【資料の事実】に「敷金・礼金: どちらもなし」とある時だけ書く。");
  L.push(`・物件は建物名から書く（${label}）。号室だけで呼ばない（実送信477組で0通）。2回目からは「こちらのお部屋」。`);
  if (i.vacating) {
    L.push("・退去予定のお部屋: 退去予定日・ご内覧可能日は、1通目か【資料の事実】に日付がある時だけ「（退去予定日）退去予定のため、（その翌日）以降ご内覧可能となります！！」の形で書く。退去の日付が無ければ「退去予定のお部屋となります！！」とだけ書く（日付・理由の言葉を作らない。【資料の事実】に入居可能時期がある時は「退去予定のお部屋となり、（資料の入居可能時期）が最短での入居可能時期となります！！」）。1通目が既に退去予定の一文を書いていれば重ねない。");
  }
  L.push("・最後は締めの1文だけ（下の【この2通目の締め】の指示のとおり）。締めの後に「気になる点があれば〜」等の一文を足さない。");
  L.push("・文の終わりは「！！」。「。」で終わる文にしない（実送信で0.3%）。");
  L.push("・絵文字は1個入れる（多くて2個）。置く所は文の最後の「！！」の直前だけ（😊。「ご査収ください」の文は😌か😊）。文の途中には置かない。締めの文が無い時はオススメの文の最後に😊。");
  L.push(`・呼びかけ: ${san ? `「${san}」を文の中に入れる（実送信85%）。挨拶の行・「${san}」だけの行は書かない` : "名前は書かない"}。長さは100〜150字・2段落まで。`);
  L.push("");
  L.push(`■ この場面でスタッフが実際に送った2通目（本文そのまま。物件名・駅・金額・日付はその時の物なので今回の文に持ち込まない）`);
  picked.forEach((e, k) => { L.push(`--- 実物${k + 1} ---`); L.push(renderExample(e.text, nm)); });
  return L.join("\n");
}

const COST_CLAIM_RE = /敷金礼金(?:なし|無し|ゼロ|0円|０円)|敷礼(?:なし|0|ゼロ)|初期費用[^\n。！!]{0,12}抑え|費用を(?:かなり)?抑える事/;

/**
 * 出口の検査: 資料では敷金か礼金があるのに、2通目が「敷金礼金なし」「初期費用を抑える事ができ」と書いた（書いていればその語）。
 * 手本の言い回し（「築年数も新しく費用を抑える事ができ」）がそのまま写る事故の線（YUMA 9/30: 礼金1ヶ月の物件に出た）。
 * 資料の敷金・礼金が読めない時・1通目が同じ事を書いている時は何も言わない（判定できない）。
 */
export function unfoundedCostClaim(text: string | null | undefined, row: SecondMaterialRow | null | undefined, firstMessage: string | null | undefined): string | null {
  const d = row?.terms?.deposit, k = row?.terms?.keyMoney;
  if (typeof d !== "number" || typeof k !== "number") return null;
  if (d === 0 && k === 0) return null;
  const m = String(text ?? "").match(COST_CLAIM_RE);
  if (!m) return null;
  if (COST_CLAIM_RE.test(String(firstMessage ?? ""))) return null;
  return m[0];
}

/**
 * 出口の検査: 手本の物件名・駅・金額が今回の文に入り込んでいないか（入っていればその語）。
 * allowed（1通目・資料の事実）にある語は、今回の物件の事実なので数えない。
 */
export function leakedExampleFacts(text: string | null | undefined, allowed: string | null | undefined): string[] {
  const t = String(text ?? "");
  const ok = String(allowed ?? "");
  const out: string[] = [];
  for (const list of Object.values(SECOND_MESSAGE_EXAMPLES)) {
    for (const e of list) for (const f of e.facts) {
      if (f.length >= 3 && t.includes(f) && !ok.includes(f) && !out.includes(f)) out.push(f);
    }
  }
  return out;
}
