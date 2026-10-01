// 2026-10-01 竹内「初回返信の条件を読み直すところ…全域つけたり…スタッフが改善している」
// condition-echo-polish.ts の回帰テスト。本文は下書き→実送信の実物（お客様の名前だけ置き換え）。
// 実行: npx tsx app/lib/__tests__/condition-echo-polish.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { polishConditionEcho, addZeniki, layoutOrToMataha, areaTailOf, ZENIKI_KINDS } from "../condition-echo-polish";
import { applySurfaceFixes } from "../validate-reply";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toEqual(exp: unknown) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
  };
}
const same = (s: string) => expect(polishConditionEcho(s, { zenikiKinds: ZENIKI_KINDS }).text).toBe(s);
/** ①（全域）は監査で止めて既定では当てない。当てた時の形を固定するテストは zenikiKinds を渡す */
const Z = { zenikiKinds: ZENIKI_KINDS };

describe("① 全域（2026-10-01 竹内さんの決定で既定 ON）", () => {
  it("既定（出口）で周辺→周辺全域", () => {
    const d = "北区（中崎西、大淀）・西区周辺から慶次さんのご希望条件に合うお部屋をピックアップしてお送りさせて頂きます！！";
    expect(polishConditionEcho(d).text).toBe(d.replace("西区周辺から", "西区周辺全域から"));
  });
  it("エリア→エリア全域（人の文 25/47）・周辺のエリア→周辺のエリア全域", () => {
    expect(polishConditionEcho("JR阪和線・大阪環状線エリアから、家賃4万5000円以内のお部屋をピックアップしてお送りさせて頂きます！！").text)
      .toBe("JR阪和線・大阪環状線エリア全域から、家賃4万5000円以内のお部屋をピックアップしてお送りさせて頂きます！！");
    expect(polishConditionEcho("8万円程で南森町周辺のエリアからオススメできるお部屋ピックアップさせていただきます😊！！").text)
      .toBe("8万円程で南森町周辺のエリア全域からオススメできるお部屋ピックアップさせていただきます😊！！");
  });
  it("府内→府全域・付近→付近全域", () => {
    expect(polishConditionEcho("大阪府内から家賃7万円以内のお部屋ピックアップしてお送りさせて頂きます！！").text).toBe("大阪府全域から家賃7万円以内のお部屋ピックアップしてお送りさせて頂きます！！");
    expect(polishConditionEcho("難波付近から1LDKのお部屋全てピックアップしてお送りさせて頂きます！！").text).toBe("難波付近全域から1LDKのお部屋全てピックアップしてお送りさせて頂きます！！");
  });
  it("二重にしない（もう全域・周辺全域全域にならない）", () => {
    const d = "難波・心斎橋エリア周辺全域から1DKのお部屋をピックアップしてお送りさせて頂きます！！";
    expect(polishConditionEcho(polishConditionEcho(d).text).text).toBe(d);
  });
  it("時間・距離のエリア（梅田まで30分圏内）は付けない／圏内全域はそのまま", () => {
    same("梅田まで30分圏内全域から、2LDKのお部屋をピックアップしお送りさせて頂きます！！");
    same("梅田まで30分圏内から、2LDKのお部屋をピックアップしお送りさせて頂きます！！");
  });
  it("報告の文は既定では付けない・includeReports（AIX）で付ける", () => {
    const r = "西九条駅周辺から香奈さんにオススメできるお部屋を7件ピックアップさせて頂きました😊！！";
    expect(polishConditionEcho(r).text).toBe(r);
    expect(polishConditionEcho(r, { includeReports: true }).text).toBe(r.replace("周辺から", "周辺全域から"));
  });
  it("08-30 初回: 北区（中崎西、大淀）・西区周辺から → 周辺全域から", () => {
    const d = "北区（中崎西、大淀）・西区周辺から慶次さんのご希望条件に合うお部屋をピックアップしてお送りさせて頂きます！！";
    expect(polishConditionEcho(d, Z).text).toBe("北区（中崎西、大淀）・西区周辺全域から慶次さんのご希望条件に合うお部屋をピックアップしてお送りさせて頂きます！！");
  });
  it("09-01: 条件の後ろのエリア（ご条件で枚方周辺から）も付く", () => {
    const d = "鉄筋鉄骨造・猫OK・家賃11万円以内・1SLDK〜2LDKのご条件で枚方周辺から再度お部屋ピックアップさせて頂きます！！";
    expect(polishConditionEcho(d, Z).applied).toEqual(["ZENIKI_ADDED:周辺"]);
    expect(polishConditionEcho(d, Z).text.includes("枚方周辺全域から")).toBe(true);
  });
  it("市内 → 市内全域", () => {
    expect(polishConditionEcho("ひとまず大阪市内から家賃5万円台のお部屋ピックアップさせていただきます！！", Z).text)
      .toBe("ひとまず大阪市内全域から家賃5万円台のお部屋ピックアップさせていただきます！！");
  });
  it("挨拶・締めの段落は触らない（全文で当てても復唱の文だけ変わる）", () => {
    const d = "ゆいさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n\n浪速区・西区周辺から7万円程・1K以上・6帖以上・浴室乾燥機とコンロ付きのお部屋をピックアップしてお送りさせて頂きます😌！！\n\n何卒よろしくお願い致します！！";
    expect(polishConditionEcho(d, Z).text).toBe(d.replace("西区周辺から", "西区周辺全域から"));
  });
});

describe("① 触らない形（人の文で割れている／区切りの から でない／報告の文）", () => {
  it("もう全域がある", () => same("都島駅・桜ノ宮駅周辺全域から家賃7万円〜10万円以内・1LDKまたは2LDKのRC造でチンシャンさんにオススメできるお部屋をピックアップしてお送りさせて頂きます！！"));
  it("沿線・沿い", () => same("南海本線・南海高野線・阪和線・御堂筋線沿いからペット2匹可・2人入居可能な1LDK以上のお部屋をピックアップしてお送りさせて頂きます！！"));
  it("素の区の並び（全域あり3／なし6）", () => same("神戸市西区・垂水区・須磨区から管理費込み5万前後・2LDK以上・築浅・ペット可でuraraさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！"));
  it("通勤の から（宗右衛門町2-3から自転車10分）", () => same("宗右衛門町2-3から自転車10分〜15分・駅徒歩10分以内・1LDK以上・20万円以内で、犬猫1匹ずつ飼育可能・キッチンのシンクが広いお部屋をピックアップしてお送りさせて頂きます！！"));
  it("通勤の から の後ろの区切り（梅田から20分以内周辺全域から）", () => same("梅田から20分以内周辺全域から家賃8万円以内のお部屋ピックアップしてお送りさせて頂きます！！"));
  it("物件を送った後の報告の文（AIX の領分）", () => same("西九条駅周辺から香奈さんにオススメできる女性の一人暮らし向けで綺麗なお部屋を7件ピックアップさせて頂きました😊！！"));
  it("ピックアップの無い文", () => same("難波周辺から通われるとの事ですので、駅近のお部屋も確認させて頂きます！！"));
  it("区切りの判定: areaTailOf", () => {
    expect(areaTailOf("堺筋本町・本町周辺から家賃10〜12万円のお部屋ピックアップしてお送りさせて頂きます！！")).toEqual({ kind: "周辺", hasZeniki: false });
    expect(areaTailOf("大阪府全域から家賃7万円以内のお部屋ピックアップさせて頂きます！！")).toEqual({ kind: "府内", hasZeniki: true });
    expect(addZeniki("天王寺エリアから家賃を抑えたマンションをピックアップしてお送りさせて頂きます😊！！").tail).toBe("エリア");
    expect(addZeniki("中央区・浪速区から家賃をもう少し上げたお部屋をピックアップしてお送りさせて頂きます😊！！").tail).toBe(null);
  });
});

describe("② 間取りの か → または", () => {
  it("10-01 初回（チンシャンさん）: 1LDKか2LDK → 1LDKまたは2LDK", () => {
    const d = "都島駅・桜ノ宮駅周辺全域から家賃7万円〜10万円以内・1LDKか2LDK・RC造でチンシャンさんにオススメできるお部屋をピックアップしてお送りさせて頂きます！！";
    expect(polishConditionEcho(d).text).toBe("都島駅・桜ノ宮駅周辺全域から家賃7万円〜10万円以内・1LDKまたは2LDK・RC造でチンシャンさんにオススメできるお部屋をピックアップしてお送りさせて頂きます！！");
  });
  it("間取りでない「か」は触らない", () => {
    expect(layoutOrToMataha("1LDKかどうか確認させて頂きます").count).toBe(0);
    expect(layoutOrToMataha("ワンルームか1Kで").text).toBe("ワンルームまたは1Kで");
  });
  it("ピックアップの語より後ろ・ピックアップの無い文は触らない", () => {
    same("1LDKか2LDKかお決まりでしたらお知らせください！！");
  });
});

describe("出口（validate-reply.applySurfaceFixes）に通っている", () => {
  it("復唱の手直し（全域・か→または）が applied に残る", () => {
    const r = applySurfaceFixes("北区・西区周辺から1LDKか2LDKのお部屋をピックアップしてお送りさせて頂きます！！", { customerName: "佐藤" });
    expect(r.text).toBe("北区・西区周辺全域から1LDKまたは2LDKのお部屋をピックアップしてお送りさせて頂きます！！");
    expect(r.applied.includes("LAYOUT_KA_TO_MATAHA×1")).toBe(true);
  });
  it("「くらい」だけが当たった時も本文に戻る（09-22 の取りこぼし）", () => {
    const r = applySurfaceFixes("浪速区・西区周辺全域から7万円くらい・1K以上のお部屋をピックアップしてお送りさせて頂きます😌！！", { customerName: "佐藤" });
    expect(r.text).toBe("浪速区・西区周辺全域から7万円程・1K以上のお部屋をピックアップしてお送りさせて頂きます😌！！");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
