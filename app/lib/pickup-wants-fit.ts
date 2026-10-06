// app/lib/pickup-wants-fit.ts（純関数・DB/LLM 依存なし）
// AIX【物件ピックアップした】で「今回送る束」とお客様の要望を1つずつ照らし、束全体で「合う／合わない／分からない」を決めて
// 生成に渡す（入口）・本文が合わない要望を合う物のように書いたかを見る（出口・注意だけ）。
//
// 2026-10-07 竹内（会話「し」・角田さん 瓦屋町・白基調）「会話を合わせるでAIXつけたら ここまで、具体的にできれば理想。
//   お客さんの希望の条件に合っていない部分をちゃんといれたうえで、具体的に内覧訴求している」
//   スタッフの理想（10/05 07:31 送信）:
//     瓦屋町周辺全域から築浅で初期費用を抑えられるお部屋ピックアップさせて頂きました！！
//     瓦屋町周辺で角田さんご希望のご条件に近いお部屋こちら2部屋となります！！
//     こちらの2部屋白基調のお部屋では御座いませんが、敷金礼金0円の為初期費用面を抑える事が出来ます！！
//     お気に召されたお部屋ご都合よろしいお日にちに全てご案内させて頂きます！！
//   AI の下書き（同じ場面・10/05 00:57）:「瓦屋町周辺全域から内装白・築浅で初期費用を抑えられるお部屋ピックアップさせて頂きました！！」
//     ＝合っていない「内装白」を合う物として書いた。出所は構成の「希望条件を文中に織り込む」（どの要望が束に合うかを知らない）。
// ■ 決め
//   - 照らすのは資料から決まる事実だけ（家賃・築年・敷金礼金・フリーレント・間取り・設備の照合 equipment.match・内装の色 interior-tone）
//   - 束全体で: 全部合う→「合う」／全部合わない（分からない物を除いて合う物が0）→「合わない」／混ざる→「一部」／照らせない→「分からない」
//   - 「合わない」は1部屋でも分からない物があれば言い切らない（unknown>0 なら「一部・分からない」側）。誤って「〇〇ではない」と書かせない側
//   - 生成に渡す言い回しはスタッフの実送信の型だけ（創作しない）: 「こちらのN部屋〇〇のお部屋では御座いませんが、△△の為□□！！」
//     （実送信 2026-04〜10 のピックアップ 612通で「〇〇では御座いませんが」5通・「〇〇は募集ございませんでしたので」10通）

// ■ 2026-10-07 追記（竹内・会話「Ryoichi kiritsuke」10/05 13:46 の AIX【物件ピックアップした】）
//   「今回の場合リノベ済みの物件はいっていない　それならリノベ済みがあると伝えるとうになる」
//   AI の下書き:「堺区周辺全域からRyoichiさんにオススメできる2LDK以上・築浅またはリノベのお部屋をピックアップ…」
//   希望条件「その他: 築浅かリノベ物件」の言葉をそのまま書いた。束 9部屋の資料（property_pickups.pdf_text）にリノベの記載は 0・
//   築年は 0/0/0/0/2/4/5/28/30 年（ソルプラーサ堺 築28・ベルメゾン堺 築30 は築浅でもリノベでもない）。
//   スタッフが送った文は「2LDK以上のお部屋」（築浅・リノベを両方消した）＝束で言える物だけを書く。
//   決め:
//   - 「リノベ」の希望を読む（renovation）。築年の希望と両方ある時は「築浅かリノベ」＝どちらかで合う（1部屋ずつ: 築年が合う or リノベ済み）
//   - リノベ済みは資料の文字（listing-renovation.renovationOfText・terms.renovated があればそれ）。読めない部屋は分からない
//   - 束の説明の語はその束が持つ側だけ: リノベ済み 0部屋→「築浅」だけ／築浅 0部屋→「リノベ済み」だけ／両方→「築浅またはリノベ済み」
//   - リノベ済みの数は別の行（info）で渡し、0部屋なら「リノベと書かない」と明記する。出口は 0部屋（分からない部屋も無い）の時に「リノベ」を書いた行へ注意
//   - 「2LDK以上」も読む（旧は「以上」付きの欄を読めず間取りを照らしていなかった）。部屋数×(LDK>DK>K>R) の順で下限以上か
import { parseConditionFields } from "./pickup-send-facts";
import { wantsWhiteInterior, type InteriorTone } from "./interior-tone";
import { renovationOfText } from "./listing-renovation";

export type FitResult = "ok" | "ng" | "unknown";

/** 束の1部屋の事実（売上サポの行 property_pickups から作る・pickupFitInputFromRow） */
export type PropertyFitInput = {
  name?: string | null;
  layout?: string | null;
  rentYen?: number | null;
  depositMonths?: number | null;
  keyMoneyMonths?: number | null;
  buildingAge?: number | null;
  newBuild?: boolean | null;
  freeRentMonths?: number | null;
  /** 設備の照合（property_pickups.equipment.match・その時の希望で照らした物） */
  equipment?: Array<{ label: string; result: "ok" | "ng" | "unlisted" }> | null;
  /** 内装の色（interior-tone の読み取り・無ければ null） */
  tone?: InteriorTone | null;
  /** リノベ済み（資料の文字・listing-renovation）。true＝済み・false＝資料に形が無い・null＝資料が無い */
  renovated?: boolean | null;
};

export type WantKey = "rent" | "age" | "initial_cost" | "white" | "layout" | "renovation" | `equip:${string}`;
export type WantFit = {
  key: WantKey;
  /** お客様の言い方に近い短い名前（「白基調」「築浅」「初期費用を抑える」） */
  label: string;
  ok: number; ng: number; unknown: number; total: number;
  /** 束全体の結論 */
  verdict: "合う" | "合わない" | "一部" | "分からない";
  /** 合う時の根拠（「敷金礼金0円」「築7年以内」） */
  evidence?: string;
  /** 数の材料だけ（合う/合わないの文にしない）。築浅かリノベの時のリノベ済みの数 */
  info?: boolean;
  /** 当てはまる部屋の名前（リノベ済みの部屋を名指しする時） */
  okNames?: string[];
};
export type BundleFit = {
  count: number; wants: WantFit[]; /** 全部の部屋に共通の良さ（要望に関係なく資料から） */ common: string[];
  /** 希望条件の言い方で、束の説明にそのまま写さない語（「築浅かリノベ物件」） */
  conditionPhrase?: string | null;
};

const toHalf = (s: string) => s.replace(/[０-９．]/g, (c) => (c === "．" ? "." : String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
const manToYen = (s: string): number | null => { const m = toHalf(s).match(/(\d+(?:\.\d+)?)\s*万/); return m ? Math.round(parseFloat(m[1]) * 10000) : null; };

export type CustomerWantsForFit = {
  rentMax: number | null;
  /** 築年の上限（築年数の欄・無ければ「築浅」の時 10） */
  ageMax: number | null;
  /** 築浅と書いた（ラベルを「築浅」にする） */
  saidNewish: boolean;
  initialCost: boolean;
  white: boolean;
  layouts: string[];
  /** 「2LDK以上」の下限（無ければ null） */
  layoutMin?: string | null;
  /** リノベ（リフォーム済み）の希望。築年の希望と両方ある時は「どちらかで合う」 */
  renovation?: boolean;
  /** 希望条件に書かれた言い方（「築浅かリノベ物件」）＝そのまま束の説明に写さない語 */
  ageRenovPhrase?: string | null;
};

/** 間取りの大きさの順（部屋数×10＋LDK3/DK2/K1/R0）。読めなければ null */
export function layoutRank(layout: string | null | undefined): number | null {
  const m = toHalf(String(layout ?? "")).toUpperCase().replace(/\s/g, "").match(/^(\d)S?(LDK|DK|K|R)$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 10 + (m[2] === "LDK" ? 3 : m[2] === "DK" ? 2 : m[2] === "K" ? 1 : 0);
}

/** 希望条件の文（AixModal の customer_conditions・page.tsx formatConditions の形）から照らす要望を読む */
export function customerWantsForFit(conditionsText: string | null | undefined): CustomerWantsForFit {
  const text = String(conditionsText ?? "");
  const f = parseConditionFields(text);
  const free = [f.get("希望"), f.get("その他"), f.get("追加条件"), f.get("NG")].filter(Boolean).join("\n");
  const rentMax = f.get("家賃") ? manToYen(String(f.get("家賃")).split(/[〜~]/).pop() ?? "") : null;
  const ageField = f.get("築年数") ? parseInt(toHalf(String(f.get("築年数"))).replace(/[^\d]/g, ""), 10) : NaN;
  const saidNewish = /築浅|築年数?(?:が)?(?:浅|新し)|新しめ|新築/.test(free);
  const ageMax = Number.isFinite(ageField) && ageField > 0 ? ageField : saidNewish ? 10 : null;
  const initialCost = /初期費用|敷金礼金|敷礼|ゼロゼロ|敷金.{0,3}礼金.{0,3}(?:0|０|無|なし)/.test(free);
  const white = wantsWhiteInterior(free);
  const layoutField = f.get("間取り") ? toHalf(String(f.get("間取り"))).toUpperCase() : "";
  const minM = layoutField.match(/(\d[SLDKR]+)\s*以上/);
  const layoutMin = minM && layoutRank(minM[1]) != null ? minM[1] : null;
  const layouts = layoutMin ? [] : layoutField ? layoutField.split(/[、,・\s]+/).filter((s) => /^\d[SLDKR]+$/.test(s)) : [];
  // リノベの希望（「リノベ」「リノベーション」「フルリノベ」「リフォーム済み」）。「リノベ不要」「リノベじゃなくていい」は読まない
  const renovation = /リノベ|リフォーム済|改装済/.test(free) && !/リノベ(?:ーション)?(?:は)?(?:不要|いらない|なし|無し|じゃなく|でなく)/.test(free);
  const phrase = free.split(/[\s・、,，\n]+/).find((tok) => /(?:築浅|新築|築年|築\d).*リノベ|リノベ.*(?:築浅|新築|築年|築\d)/.test(tok)) ?? null;
  return { rentMax, ageMax, saidNewish, initialCost, white, layouts, layoutMin, renovation, ageRenovPhrase: phrase ? phrase.replace(/\[[^\]]*\]$/, "") : null };
}

function verdictOf(ok: number, ng: number, unknown: number): WantFit["verdict"] {
  if (ok + ng === 0) return "分からない";
  if (ng === 0 && unknown === 0) return "合う";
  if (ok === 0 && unknown === 0) return "合わない";
  return "一部";
}

/** 束と要望を照らす（決定論） */
export function bundleWantsFit(props: readonly PropertyFitInput[], w: CustomerWantsForFit): BundleFit {
  const n = props.length;
  const out: WantFit[] = [];
  const add = (key: WantKey, label: string, judge: (p: PropertyFitInput) => FitResult, evidence?: string) => {
    let ok = 0, ng = 0, unknown = 0;
    for (const p of props) { const r = judge(p); if (r === "ok") ok++; else if (r === "ng") ng++; else unknown++; }
    const verdict = verdictOf(ok, ng, unknown);
    out.push({ key, label, ok, ng, unknown, total: n, verdict, ...(verdict === "合う" && evidence ? { evidence } : {}) });
  };
  if (n === 0) return { count: 0, wants: [], common: [] };
  if (w.rentMax != null) add("rent", `家賃${w.rentMax / 10000}万円以内`, (p) => (p.rentYen == null ? "unknown" : p.rentYen <= w.rentMax! ? "ok" : "ng"));
  const ageJudge = (p: PropertyFitInput): FitResult => (p.newBuild ? "ok" : p.buildingAge == null || w.ageMax == null ? "unknown" : p.buildingAge <= w.ageMax ? "ok" : "ng");
  const renoJudge = (p: PropertyFitInput): FitResult => (p.renovated === true ? "ok" : p.renovated === false ? "ng" : "unknown");
  const ageLabel = w.saidNewish ? "築浅" : `築${w.ageMax}年以内`;
  if (w.ageMax != null && w.renovation) {
    // 築浅かリノベ（どちらかで合う）。語は束が持つ側だけ（リノベ済み0部屋なら「築浅」・築浅0部屋なら「リノベ済み」）
    const renoOk = props.filter((p) => renoJudge(p) === "ok").length;
    const ageOk = props.filter((p) => ageJudge(p) === "ok").length;
    const label = renoOk === 0 ? ageLabel : ageOk === 0 ? "リノベ済み" : `${ageLabel}またはリノベ済み`;
    const maxAge = Math.max(...props.map((p) => (p.newBuild ? 0 : p.buildingAge ?? 999)));
    add("age", label,
      (p) => { const a = ageJudge(p), r = renoJudge(p); return a === "ok" || r === "ok" ? "ok" : a === "ng" && r === "ng" ? "ng" : "unknown"; },
      renoOk === 0 ? (maxAge === 0 ? "新築" : maxAge < 999 ? `築${maxAge}年以内` : undefined) : undefined);
  } else if (w.ageMax != null) {
    const maxAge = Math.max(...props.map((p) => (p.newBuild ? 0 : p.buildingAge ?? 999)));
    add("age", ageLabel, ageJudge, maxAge === 0 ? "新築" : maxAge < 999 ? `築${maxAge}年以内` : undefined);
  }
  if (w.renovation) {
    // リノベ済みの数（築浅かリノベの時は数の材料だけ＝「では御座いませんが」の文にしない）
    add("renovation", "リノベ済み", renoJudge);
    const r = out[out.length - 1];
    if (w.ageMax != null) r.info = true;
    const names = props.filter((p) => renoJudge(p) === "ok").map((p) => p.name ?? "").filter(Boolean);
    if (names.length) r.okNames = names;
  }
  if (w.initialCost) {
    add("initial_cost", "初期費用を抑える（敷金礼金0円）",
      (p) => (p.depositMonths == null || p.keyMoneyMonths == null ? "unknown" : p.depositMonths === 0 && p.keyMoneyMonths === 0 ? "ok" : "ng"),
      "敷金礼金0円");
  }
  if (w.white) add("white", "白基調の内装", (p) => (p.tone?.whiteBased === true ? "ok" : p.tone?.whiteBased === false ? "ng" : "unknown"));
  if (w.layouts.length) add("layout", `間取り${w.layouts.join("・")}`, (p) => (!p.layout ? "unknown" : w.layouts.includes(p.layout.toUpperCase()) ? "ok" : "ng"));
  else if (w.layoutMin) {
    const min = layoutRank(w.layoutMin)!;
    add("layout", `${w.layoutMin}以上`, (p) => { const r = layoutRank(p.layout); return r == null ? "unknown" : r >= min ? "ok" : "ng"; });
  }
  // 設備の照合（行の equipment.match のラベルごと）
  const labels = [...new Set(props.flatMap((p) => (p.equipment ?? []).map((m) => m.label)))];
  for (const lb of labels) {
    add(`equip:${lb}`, lb, (p) => { const m = (p.equipment ?? []).find((x) => x.label === lb); return !m || m.result === "unlisted" ? "unknown" : m.result; });
  }
  // 全部の部屋に共通の良さ（要望に無くても資料で言える物・言い回しの材料）
  const common: string[] = [];
  if (props.every((p) => p.depositMonths === 0 && p.keyMoneyMonths === 0)) common.push("敷金礼金0円");
  if (props.every((p) => (p.freeRentMonths ?? 0) > 0)) common.push("フリーレント付き");
  if (props.every((p) => p.newBuild)) common.push("新築");
  return { count: n, wants: out, common, conditionPhrase: w.ageRenovPhrase ?? null };
}

/** 照らした要望のうち、文にしてよい物があるか（合う・合わないが1つ以上） */
export function hasUsableFit(fit: BundleFit): boolean {
  // 数の材料（築浅かリノベの時のリノベ済みの数）は、0部屋と言い切れる時（分からない部屋が無い）に「リノベと書かない」を渡すため数える
  return fit.wants.some((x) => (x.info ? renovationAbsent(x) : x.verdict === "合う" || x.verdict === "合わない"));
}

/** リノベ済みの部屋が束に無いと言い切れる（済み0・分からない0） */
function renovationAbsent(x: WantFit): boolean {
  return x.key === "renovation" && x.ok === 0 && x.unknown === 0 && x.total > 0;
}

/**
 * 生成に渡すブロック（入口）。合わない要望がある時は③にスタッフの実送信の型で正直に書く指示を付ける。
 * 渡すのは「合う」「合わない」だけ・「一部」「分からない」は書かせない
 */
export function buildBundleFitNote(fit: BundleFit): string {
  if (!fit.count || !hasUsableFit(fit)) return "";
  const main = fit.wants.filter((x) => !x.info);
  const ok = main.filter((x) => x.verdict === "合う");
  const ngAll = main.filter((x) => x.verdict === "合わない");
  const renoInfo = fit.wants.find((x) => x.info && x.key === "renovation") ?? null;
  // 家賃・築年・間取りの外れは「では御座いませんが」で言わない（スタッフは条件を広げた時の書き方＝構成の expanded で書く）。
  //   初期費用（敷金・礼金あり）も言わない: 礼金があっても見積書の割引で初期費用は下げられる（「初期費用を抑えられない」と言う事実ではない）
  const NUMERIC = new Set(["rent", "age", "layout", "initial_cost"]);
  const ng = ngAll.filter((x) => !NUMERIC.has(x.key));
  // 初期費用の外れは注記に載せない（10/07 Claude の確かめで「文にしない」と書いても「敷金礼金0円のお部屋ではなく」と書いた）
  const ngNum = ngAll.filter((x) => NUMERIC.has(x.key) && x.key !== "initial_cost");
  /** ③で理由に添える言葉（築浅と書いた人には「築浅」） */
  const goodWord = (x: WantFit) => (x.key === "age" && x.label === "築浅" ? "築浅" : x.evidence ?? x.label);
  const unsure = main.filter((x) => x.verdict === "一部" || x.verdict === "分からない");
  const n = fit.count;
  const lines = [
    `【今回お送りする${n}部屋とお客様のご要望（資料から決めた事実・この通りに書く）】`,
    ok.length ? `・合う${n >= 2 ? `（${n}部屋とも）` : ""}: ${ok.map((x) => `${x.label}${x.evidence ? `＝${x.evidence}` : ""}`).join("／")}` : "",
    ng.length ? `・合わない${n >= 2 ? `（${n}部屋とも）` : ""}: ${ng.map((x) => x.label).join("／")}` : "",
    ngNum.length ? `・合わない（家賃・築年・間取り＝この注記では文にしない。広げた時の書き方は構成の説明どおり）: ${ngNum.map((x) => x.label).join("／")}` : "",
    unsure.length ? `・部屋で違う・資料で分からない（文に書かない）: ${unsure.map((x) => `${x.label}${x.verdict === "一部" ? `（${x.total}部屋中${x.ok}部屋）` : ""}`).join("／")}` : "",
    // 2026-10-07（Ryoichi）: 築浅かリノベの希望で、束にリノベ済みが無い時は「リノベ」と書かせない／ある時は名指しの部屋だけ
    renoInfo && renovationAbsent(renoInfo) ? `・リノベ済みの部屋: 今回の${n}部屋に無い（資料の文字で確かめた）→「リノベ」「リノベーション」「リフォーム済み」と書かない` : "",
    renoInfo && renoInfo.ok > 0 && renoInfo.ok < n ? `・リノベ済みの部屋: ${(renoInfo.okNames ?? []).join("・") || `${renoInfo.ok}部屋`}だけ（${n}部屋中${renoInfo.ok}部屋）→ 束全体を「リノベのお部屋」と書かない` : "",
    fit.conditionPhrase ? `→ 希望条件の言い方「${fit.conditionPhrase}」を束の説明としてそのまま写さない（束の部屋が満たす側の語だけ・上の「合う」の名前で書く）。` : "",
    "→ ②のピックアップ行に入れる要望は「合う」の物だけ（「合わない」「分からない」要望を「〜のお部屋」と合う物のように書かない）。",
  ];
  if (ng.length) {
    // 理由に添える良さの順（スタッフの理想＝敷金礼金0円→築浅→設備。家賃は理由にしない側＝一番後ろ）
    const rank = (x: WantFit) => (x.key === "initial_cost" ? 0 : x.key === "age" ? 1 : x.key.startsWith("equip:") ? 2 : x.key === "layout" ? 3 : 4);
    const good = ok.slice().sort((a, z) => rank(a) - rank(z))[0];
    const these = n === 1 ? "こちらのお部屋" : `こちらの${n}部屋`;
    const what = ng[0].label.replace(/の内装$/, "");
    // 言い回しはスタッフの実送信の型だけ（会話「し」10/05・あっぴ 10/05・ざきを 07/22・67f 07/24 の「〇〇では御座いませんが」）
    const example = !good
      ? `「${what}のお部屋では御座いませんが」に②の行を続ける（実送信:「カウンターキッチンのお部屋では御座いませんが新着で、〇〇さんにオススメ出来るお部屋が募集に出ました！！」）`
      : good.key === "initial_cost"
        ? `「${these}${what}のお部屋では御座いませんが、${good.evidence ?? "敷金礼金0円"}の為初期費用面を抑える事が出来ます！！」`
        : `「${these}${what}のお部屋では御座いませんが、${goodWord(good)}のお部屋となります！！」`;
    lines.push(
      `→ 「合わない」要望は伏せずに1文で正直に伝える${good ? `（合う所＝${goodWord(good)} を理由に添える）` : "（合う要望が無いので代わりの良さは書かない）"}。スタッフの実送信の型: ${example}。合う要望の事実だけで書き、無い事実を足さない`,
    );
    if (n >= 2) lines.push(`→ 件数を書くなら「こちら${n}部屋となります」（実送信の型）。`);
  }

  return lines.filter(Boolean).join("\n");
}

/** 出口で「その要望を書いた」と見る語（合わない要望だけに当てる） */
const WANT_WORD_RE: Record<string, RegExp> = {
  white: /白基調|内装白|白い内装|白内装|ホワイト/,
  age: /築浅|新築|築年数?(?:が)?(?:浅|新し)/,
  // 初期費用は当てない（礼金があっても見積書の割引で抑えられる＝「抑えられる」は誤りではない）
};
/** 「リノベ済み」を言う語（束にリノベ済みが無い時だけ当てる） */
const RENOVATION_WORD_RE = /リノベ|リフォーム済|改装済/;
/** 否定・無かった事を言う行（その行の要望の語は「合う」と言っていない） */
const NEGATED_LINE_RE = /では(?:ござ|御座)いません|ではない|ではありません|じゃない|ございませんでした|御座いませんでした|ありませんでした|出ておりませんでした/;

/**
 * 出口（注意だけ・本文は書き換えない＝設計知見「出口は誤削除0でなければ入れない」）:
 * 「合わない」要望を、否定の言い方（では御座いませんが・ではない）の無い行に書いたか。当たれば注意の文（無ければ null）
 */
export function findUnmetWantClaims(text: string, fit: BundleFit): string | null {
  const ng = fit.wants.filter((x) => x.verdict === "合わない" && !x.info);
  // 2026-10-07（Ryoichi）: 束にリノベ済みが無い（済み0・分からない0）のに「リノベ」と書いた（築浅かリノベの時も・リノベだけの時も）
  const renoAbsent = fit.wants.find((x) => renovationAbsent(x)) ?? null;
  const partAge = fit.wants.filter((x) => x.key === "age" && x.verdict === "一部" && x.ng > 0);
  if (!ng.length && !renoAbsent && !partAge.length) return null;
  const hits: string[] = [];
  const parts: string[] = [];
  for (const line of String(text ?? "").split("\n")) {
    if (NEGATED_LINE_RE.test(line)) continue;
    for (const w of ng) {
      const re = WANT_WORD_RE[w.key as string];
      if (re && re.test(line)) hits.push(w.label);
    }
    if (renoAbsent && RENOVATION_WORD_RE.test(line)) hits.push("リノベ済み");
    // 築浅が「一部」（外れる部屋がある）なのに束全体を築浅と書いた（Ryoichi: 9部屋中 築28・築30 の2部屋）
    for (const w of partAge) if (WANT_WORD_RE.age.test(line)) parts.push(`「${w.label.replace(/またはリノベ済み$/, "")}」は${w.total}部屋中${w.ng}部屋が外れます`);
  }
  const u = [...new Set(hits)];
  const pu = [...new Set(parts)];
  if (!u.length && !pu.length) return null;
  const head = [u.length ? `今回の${fit.count}部屋は「${u.join("・")}」に合っていません` : "", ...pu].filter(Boolean).join("／");
  return `${head}（資料から）。合う物のように書いていないか確かめてから送信してください`;
}

/** 売上サポの行（property_pickups）→ 照合の入力（間取り・家賃は parsePickupFact・内装の色は別に読む） */
export function pickupFitInputFromRow(row: {
  property_name?: string | null;
  terms?: { deposit?: number | null; keyMoney?: number | null; buildingAge?: number | null; newBuild?: boolean | null; freeRent?: { months?: number | null } | null; renovated?: boolean | null } | null;
  equipment?: { match?: Array<{ label: string; result: "ok" | "ng" | "unlisted" }> | null } | null;
  /** 資料の文字（リノベ済みを読む・terms.renovated が無い行＝10/06d より前の行のため） */
  pdf_text?: string | null;
}, fact?: { layout: string | null; rentYen: number | null } | null, tone?: InteriorTone | null): PropertyFitInput {
  const t = row.terms ?? null;
  return {
    name: row.property_name ?? null,
    layout: fact?.layout ?? null,
    rentYen: fact?.rentYen ?? null,
    depositMonths: t?.deposit ?? null,
    keyMoneyMonths: t?.keyMoney ?? null,
    buildingAge: t?.buildingAge ?? null,
    newBuild: t?.newBuild ?? null,
    freeRentMonths: t?.freeRent?.months ?? null,
    equipment: row.equipment?.match ?? null,
    tone: tone ?? null,
    // 判定の時に残した印（10/06d 以降の行）を先に・無ければ資料の文字で読む（文字が無ければ null）。物件名の「（フルリノベーション）」も見る
    renovated: t?.renovated === true || renovationOfText(row.property_name ?? null) === true ? true
      : typeof t?.renovated === "boolean" ? t.renovated : renovationOfText(row.pdf_text ?? null),
  };
}
