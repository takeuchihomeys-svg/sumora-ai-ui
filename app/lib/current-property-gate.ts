// current_property（ブレインが今話している物件）の実在ゲート（純関数・2026-10-13）
//
// 旧（brain-core）: 号室を除いた名前が会話の文（history）に一字一句あるか、送付済み物件の名前と含み合う時だけ通し、それ以外は null（創作の物件名を止める）。
// 穴: 主語の抜けの6問（q082〜q087・Claude の確かめ）で current_property が 0/6（5問 null）。台帳の文（property-thread の ▶ 今の番の物件・候補）は
//   ブレインに届いていて、ブレインは候補の表示（「セレニテ難波プリエ 611号室」等・空白入り）を写すが、会話の文は「セレニテ難波プリエ611」と空白なし
//   → 一字一句が合わず落ちていた。
// 直し: ①空白（全角・半角）と全角半角の差を除いて比べる ②台帳の文（▶ の候補を含む物件ごとの状況）にある名前も「実在」に入れる。
//   創作の名前を止める線（会話・送付・台帳のどこにも無い名前は null）は変えない。戻す: CURRENT_PROPERTY_GATE_V2=off

import { matchLoose, isSameLoose, splitBrainNames } from "./property-name-loose";

// ─── 2026-10-13 当たり率の直し（区切り5 複数）: 今の番の物件の並び（current_properties）───
// 外れの型 i: お客様が「この二つ」「全てお願いします」と複数の物件を聞き、スタッフは2〜4件に答えたのに、ブレインの current_property は1件。
//   ブレインの出力（LLM）は変えず、ブレインの current_property（「A・B」「A、B」の並びは分ける）を先に、台帳の ▶ 今の番の物件（引用・名指し・推定）を
//   後ろに並べる（同じ物件は1つ）。AIX の物件名の候補に並べ、表示・照合は「どれか」で見る。戻す: CURRENT_PROPERTIES=off
export function currentPropertiesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.CURRENT_PROPERTIES ?? "").trim().toLowerCase() !== "off";
}
export function currentPropertiesOf(currentProperty: string | null | undefined, threadNote: string | null | undefined, env: Record<string, string | undefined> = process.env): string[] {
  if (!currentPropertiesEnabled(env)) return currentProperty?.trim() ? [currentProperty.trim()] : [];
  const out: string[] = [];
  const add = (n: string) => {
    const t = n.trim();
    if (!t || out.some((x) => x === t || isSameLoose(matchLoose(x, t)))) return;
    out.push(t.slice(0, 40));
  };
  for (const n of splitBrainNames(currentProperty)) add(n);
  for (const m of String(threadNote ?? "").matchAll(/^▶ 今の番の物件: (.+?)（/gm)) add(m[1]);
  return out.slice(0, 5);
}

type Env = Record<string, string | undefined>;

// ─── 2026-10-13 当たり率の直し（区切り2）: 実在ゲートの後の安全の線と、台帳の表記への寄せ ───
// 竹内さん「物件名をちゃんと読み取れないのか」→ 60日の外れのうち、ブレインの current_property が
//   ・URL の番号（「bc_100525219054」）がゲートを通った（会話の文に URL があるため）
//   ・画像の読み取りの文字化け（「プレサンス戸原橋ヴィプラス」正しくは芦原橋ヴィブラス・「カシーダ神戸元町ジェーピー」）
// だった。画像の読み取り（[画像] の行）にしか無い名前は、台帳（送った物件 sent_properties・AIX の記録の物件名）に近い名前があれば
// その表記に直し、無ければ通さない（null）。本文（画像以外の文）・台帳・▶ の候補にある名前はそのまま。戻す: CURRENT_PROPERTY_LEDGER_CANON=off
export function currentPropertyLedgerCanon(env: Env = process.env): boolean {
  return (env.CURRENT_PROPERTY_LEDGER_CANON ?? "").trim().toLowerCase() !== "off";
}
/** URL の番号・ポータルの名前・画面の仮の名前（「物件no.92」）・「canary物件（…）」は物件名ではない */
const URL_ID_NAME_RE = /^[a-z]{0,4}_?\d{6,}$|https?:|suumo|homes\.co|athome|^物件\s*(?:no\.?|番号)?\s*[0-9０-９①-⑳]+$|^canary物件/i;
export type CurrentPropertyRefine = { value: string | null; reason: "kept" | "url_id" | "ledger_canon" | "image_only_dropped" };
/**
 * @param raw 実在ゲートを通った current_property
 * @param src.texts 会話の文（画像の読み取りの行を含む）。`[画像]` で始まる行は画像の読み取り
 * @param src.ledgerNames 台帳の物件名（送った物件・AIX の記録の物件名）
 */
export function refineCurrentProperty(
  raw: string | null,
  src: { texts: ReadonlyArray<string | null | undefined>; ledgerNames: ReadonlyArray<string | null | undefined>; threadNote?: string | null },
  env: Env = process.env,
): CurrentPropertyRefine {
  if (!raw) return { value: null, reason: "kept" };
  if (!currentPropertyLedgerCanon(env)) return { value: raw, reason: "kept" };
  if (URL_ID_NAME_RE.test(raw.trim())) return { value: null, reason: "url_id" };
  const core = raw.replace(/\s*[0-9０-９]{1,4}(号室?)?$/, "").trim() || raw;
  const k = propertyCmpKey(core);
  const ledger = src.ledgerNames.filter((n): n is string => !!n && !!n.trim());
  if (ledger.some((n) => propertyCmpKey(n).includes(k))) return { value: raw, reason: "kept" };
  const textOnly = src.texts.filter((t) => !!t && !/^\s*\[(?:画像|動画)\]/.test(t)).map((t) => propertyCmpKey(t)).join("\n");
  if (textOnly.includes(k) || (src.threadNote && propertyCmpKey(src.threadNote).includes(k))) return { value: raw, reason: "kept" };
  // 画像の読み取りにしか無い名前: 台帳の名前のうち、こちらの本文（画像以外の文）に書いた名前（＝スタッフが確かめた表記）で、
  //   同じ部屋（号室まで同じ）の物があればその表記に直す。台帳の名前も読み取りの化け（「セレニテ兼渡ブリエ」）のことがあるので本文に出る物だけ。
  //   階だけ（「Luxe難波WEST 11階角部屋」）は同じ階の別の部屋のことがあるので寄せない。
  //   60日の監査で「画像の読み取りにしか無い名前」は 131番あり、多くはお客様の画面の写しの正しい名前（「エレガンス藤井寺 1-C」等）
  //   → 通さないのでなく、そのまま残す（読み取りの化けは台帳の確かな表記がある時だけ直す）
  const near = ledger.find((n) => matchLoose(raw, n) === "same_room" && textOnly.includes(propertyCmpKey(n.replace(/\s*[0-9０-９]{1,4}\s*号室?$/, ""))));
  if (near) return { value: near.trim().slice(0, 40), reason: "ledger_canon" };
  return { value: raw, reason: "kept" };
}
export function currentPropertyGateV2(env: Env = process.env): boolean {
  return (env.CURRENT_PROPERTY_GATE_V2 ?? "").trim().toLowerCase() !== "off";
}

/** 比べる形（NFKC・空白なし・小文字） */
export function propertyCmpKey(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
}

export function currentPropertyExists(
  raw: string,
  core: string,
  src: { history: string; sentNames: ReadonlyArray<string | null | undefined>; threadNote?: string | null },
  env: Env = process.env,
): boolean {
  if (!raw || !core) return false;
  // 旧の判定（そのまま先に）
  if (src.history.includes(core)) return true;
  if (src.sentNames.some((n) => !!n && (n.includes(core) || raw.includes(n)))) return true;
  if (!currentPropertyGateV2(env)) return false;
  const k = propertyCmpKey(core);
  const rk = propertyCmpKey(raw);
  if (k.length < 2) return false;
  if (propertyCmpKey(src.history).includes(k)) return true;
  if (src.sentNames.some((n) => { const nk = propertyCmpKey(n); return !!nk && (nk.includes(k) || rk.includes(nk)); })) return true;
  if (src.threadNote && propertyCmpKey(src.threadNote).includes(k)) return true;
  return false;
}
