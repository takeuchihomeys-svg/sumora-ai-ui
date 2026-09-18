// app/lib/__tests__/property-name-guard.test.ts
// 2026-09-19 竹内（ゆうこ事例）「物件名間違えてるし、ここで物件名いれると内覧する物件名間違えてしまう
//   可能性があるのでリスクがある。変に物件名を出さないようにする」
// 実行: npx tsx app/lib/__tests__/property-name-guard.test.ts（全 PASS で exit 0）
import { guardPropertyNames, collectPropertyNames, hasFixedViewing, normalizePropertyName, PROPERTY_NAME_NOTE } from "../property-name-guard";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ゆうこさんの会話（9/18 23:48〜23:58）。こちらが2件送り、お客様はどちらとも言っていない
const YUKO_KNOWN = ["Lala place難波ガルテン 1504号室", "サザンパークス 705号室"];
const YUKO_CUSTOMER = "物件間に行ける日分かりましたらまた連絡させていただきます🙇‍♀️";

console.log("── 物件名を集める");
{
  const names = collectPropertyNames([
    "【Lala place難波ガルテン 1504号室】\n初期費用さらに🌟88,000円割引させて頂き",
    "🌟サザンパークス 705号室\n\n新着でかなり条件のいいお部屋となります！！",
    "こちら最大限割引させて頂きました初期費用の御見積書となります😊！！", // 物件名なし
  ]);
  t("2件そろう", eq(names, ["Lala place難波ガルテン 1504号室", "サザンパークス 705号室"]), JSON.stringify(names));
  t("同じ名前は1つ", collectPropertyNames(["A 101号室", "A 101号室"]).length === 1);
  t("表記のゆれを吸収（全角・スペース・中黒）",
    normalizePropertyName("ＫＴＩレジデンス 西中島Ⅱ　202号室") === normalizePropertyName("KTIレジデンス西中島Ⅱ202号室"));
}

console.log("── ★ ゆうこ 9/18 23:58（候補2件・お客様はどれとも言っていない・受け止めだけ）");
{
  const bad = "はい😊！！\nサザンパークス 705号室のご内覧、ご都合よろしい日が分かりましたらいつでもご連絡ください！！\nご連絡お待ちしております！！";
  const r = guardPropertyNames({ text: bad, knownNames: YUKO_KNOWN, customerTurn: YUKO_CUSTOMER });
  t("★ 物件名が落ちる", r.removed.length === 1, JSON.stringify(r));
  t("★ 実送信と同じ文になる",
    r.text === "はい😊！！\nご内覧、ご都合よろしい日が分かりましたらいつでもご連絡ください！！\nご連絡お待ちしております！！", JSON.stringify(r.text));

  const bad2 = "はい😊！！\nサザンパークス 705号室ご案内させて頂きますので、ご都合よろしい日が分かりましたらご連絡ください！！";
  t("「〇〇号室ご案内」→「お部屋ご案内」（実送信の言い方）",
    guardPropertyNames({ text: bad2, knownNames: YUKO_KNOWN, customerTurn: YUKO_CUSTOMER }).text
      === "はい😊！！\nお部屋ご案内させて頂きますので、ご都合よろしい日が分かりましたらご連絡ください！！");

  const ok = "はい😊！！\nご内覧、ご都合よろしい日が分かりましたらいつでもご連絡ください！！";
  t("元から物件名が無い文は触らない", guardPropertyNames({ text: ok, knownNames: YUKO_KNOWN, customerTurn: YUKO_CUSTOMER }).text === ok);
}

console.log("── 候補が1件しか無ければ触らない（絞り込みが起きないので取り違えようがない）");
{
  const text = "はい😊！！\nサザンパークス 705号室のご内覧、ご都合よろしい日が分かりましたらご連絡ください！！";
  const r = guardPropertyNames({ text, knownNames: ["サザンパークス 705号室"], customerTurn: YUKO_CUSTOMER });
  t("1件だけ → 触らない", r.removed.length === 0, JSON.stringify(r.keptReason));
}

console.log("── お客様が名指ししていれば書き返してよい");
{
  const text = "かしこまりました！！\nサザンパークス 705号室のご内覧、ご都合よろしい日が分かりましたらご連絡ください！！";
  t("号室で名指し", guardPropertyNames({ text, knownNames: YUKO_KNOWN, customerTurn: "サザンパークス705号室が見たいです" }).keptReason === "お客様が名指しした");
  t("URL を送ってきた", guardPropertyNames({ text, knownNames: YUKO_KNOWN, customerTurn: "https://suumo.jp/chintai/bc_1/" }).keptReason === "お客様が名指しした");
  t("画像を送ってきた", guardPropertyNames({ text, knownNames: YUKO_KNOWN, customerTurn: "[画像]" }).keptReason === "お客様が名指しした");
}

console.log("── 内覧が既に決まっていれば再確認なので触らない（実送信 7/24）");
{
  const text = "ニアさんお世話になっております！！\n全然大丈夫です😊！！\n改めてご都合よろしいお日にちにエスリード長堀タワー 1007号室ご案内させて頂きます！！\n何卒よろしくお願い致します！！";
  const known = ["エスリード長堀タワー 1007号室", "別のお部屋 202号室"];
  t("★ 台帳に内覧がある → 触らない",
    guardPropertyNames({ text, knownNames: known, customerTurn: "すみません日程変更できますか", viewingFixed: true }).keptReason === "内覧の日時が決まっている");
  t("待ち合わせの送信から判定できる（本番・監査で同じ関数）",
    hasFixedViewing(["7/12 14:00にエスリード長堀タワー 1007号室 現地エントランスお待ち合わせで何卒よろしくお願い致します！！"]));
  t("待ち合わせが無ければ false", !hasFixedViewing(["お手隙の際にご査収ください😌！！"]));
}

console.log("── 【実データ】スタッフ実送信は1通も落とさない（11,830通で誤削除0）");
{
  // 監査（scripts/audit-property-name-guard.ts）で実際に引っかかり、線を引き直す根拠になった文
  const keep: Array<{ text: string; known: string[]; turn?: string; fixed?: boolean }> = [
    // 待ち合わせ（日時あり）
    { text: "かしこまりました😊！！\n9/28（月）ご案内させて頂きます！！\n9/28 12:00にジュネスニッコー 1003号室 現地エントランスお待ち合わせで何卒よろしくお願い致します！！", known: ["A 101号室", "B 202号室"] },
    // 「17時」「18時半」の形
    { text: "お世話になっております！！\n本日17時にZio VIII 清水丘 801号室のご案内させて頂きます！\n本日は何卒よろしくお願い致します！！", known: ["A 101号室", "B 202号室"] },
    { text: "きえさんお世話になっております！！\n本日18時半モラーダ301号室ご案内させて頂きます！", known: ["A 101号室", "B 202号室"] },
    // 申込・審査
    { text: "かしこまりました！！\n402号室お申込みさせていただきます😊！！", known: ["A 101号室", "B 202号室"] },
    { text: "yasukiさん\nお電話ありがとうございました！！\nS-RESIDENCE南堀江711号室息子様名義でお部屋お申込みさせていただきます😊！！", known: ["A 101号室", "B 202号室"] },
    // 募集状況・事実
    { text: "かずやさん お世話になっております！！\nメゾン アッシュ 602号室既に1番手でお申込み入っており2番手以降での申込みが可能です！！", known: ["A 101号室", "B 202号室"] },
    { text: "はい！！\n中型犬飼育可能なお部屋はジーメゾン泉佐野ルシエール303号室のみとなります！！", known: ["A 101号室", "B 202号室"] },
    { text: "901号室が正確なお部屋番号となります！！", known: ["A 101号室", "B 202号室"] },
    { text: "105号室の残り1部屋のみとなりますので、お手数をおかけいたしますが、早めにご入力頂けますと幸いです😌！！", known: ["A 101号室", "B 202号室"] },
    { text: "BKB仙石屋敷202号室\n2026年4月築の新築のお部屋となり、まだ前居住者の方いらっしゃらないお部屋となります😊！！", known: ["A 101号室", "B 202号室"] },
    // 物件を送る締め（ご査収）
    { text: "・サニーコート西川2 102\n・エルピス旭町 201号室\nお手隙の際にご査収ください！！", known: ["A 101号室", "B 202号室"] },
    // 室内写真を送った
    { text: "ZioⅧ清水丘801号室の室内写真と動画撮影しお送りさせていただきました！！\nこちらもお手隙の際にご査収ください😊！！", known: ["A 101号室", "B 202号室"] },
    // 本文に2件書いている（絞っていないので取り違えようがない）
    { text: "かしこまりました！！\nブルーメ 201号室・グレイスフルヴィラ 203号室の2件ご案内させて頂きます😊！！\nくぼさんのご都合よろしいお日にちをお聞かせください！！", known: ["ブルーメ 201号室", "グレイスフルヴィラ 203号室"] },
    { text: "はい！！\n両方内見出来ます！！\n304号室と502号室ご案内させて頂きます😊！！", known: ["A 304号室", "B 502号室"] },
  ];
  for (const k of keep) {
    const r = guardPropertyNames({ text: k.text, knownNames: k.known, customerTurn: k.turn ?? "", viewingFixed: k.fixed });
    t(`「${k.text.replace(/\n/g, " ").slice(0, 26)}…」→ 触らない`, r.text === k.text && r.removed.length === 0, `${r.keptReason} ${JSON.stringify(r.removed)}`);
  }
}

console.log("── 会話に無い物件名は落とさない（3回目の監査で797通の誤検知）");
{
  // 物件名は管理会社の資料・ポータルの画像から**こちらが初めて書く**（お客様は URL や画像で送る）
  const text = "お待たせ致しました！！\nセラヴィ津久野 403号室現在募集中となります！！";
  const r = guardPropertyNames({ text, knownNames: ["別のお部屋 101号室"], customerTurn: "" });
  t("★ 会話に無くても落とさない（unknown には出す）", r.removed.length === 0 && r.unknown.length === 1, JSON.stringify(r));
}

console.log("── fail-closed");
{
  t("空文字", guardPropertyNames({ text: "" }).removed.length === 0);
  t("物件名なし", guardPropertyNames({ text: "はい😊！！\n引き続き何卒よろしくお願い致します！！" }).keptReason === "物件名なし");
  t("候補の材料が無ければ触らない", guardPropertyNames({ text: "サザンパークス 705号室のご内覧お待ちしております！！" }).removed.length === 0);
  t("プロンプトの1行に線が書いてある", PROPERTY_NAME_NOTE.includes("1つに絞った物件名を書かない"));
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
