// current_property（ブレインが今話している物件）の実在ゲート（純関数・2026-10-13）
//
// 旧（brain-core）: 号室を除いた名前が会話の文（history）に一字一句あるか、送付済み物件の名前と含み合う時だけ通し、それ以外は null（創作の物件名を止める）。
// 穴: 主語の抜けの6問（q082〜q087・Claude の確かめ）で current_property が 0/6（5問 null）。台帳の文（property-thread の ▶ 今の番の物件・候補）は
//   ブレインに届いていて、ブレインは候補の表示（「セレニテ難波プリエ 611号室」等・空白入り）を写すが、会話の文は「セレニテ難波プリエ611」と空白なし
//   → 一字一句が合わず落ちていた。
// 直し: ①空白（全角・半角）と全角半角の差を除いて比べる ②台帳の文（▶ の候補を含む物件ごとの状況）にある名前も「実在」に入れる。
//   創作の名前を止める線（会話・送付・台帳のどこにも無い名前は null）は変えない。戻す: CURRENT_PROPERTY_GATE_V2=off

type Env = Record<string, string | undefined>;
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
