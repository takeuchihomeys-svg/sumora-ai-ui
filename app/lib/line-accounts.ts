// app/lib/line-accounts.ts
// LINE アカウントのキー（英語）。line_contacts.account の日本語名・画面の表示名もここで英語キーに直す。
// 2026-09-15 通話URL（アカウントごと）の登録で send-line-message と line-call-url が同じ解決を使うため切り出した

export const LINE_ACCOUNT_KEYS = ["sumora", "ieyasu", "giga", "hasu"] as const;
export type LineAccountKey = (typeof LINE_ACCOUNT_KEYS)[number];

/** 日本語名 → 英語キー */
export const LINE_ACCOUNT_KEY_MAP: Record<string, LineAccountKey> = {
  "イエヤス": "ieyasu",
  "ギガ賃貸": "giga",
  "スモラ": "sumora",
};

/** 表示名（通話URL の登録画面など） */
export const LINE_ACCOUNT_LABELS: Record<LineAccountKey, string> = {
  sumora: "スモラ",
  ieyasu: "イエヤス",
  giga: "ギガ賃貸",
  hasu: "HASU",
};

/** 英語キー・日本語名のどちらでも英語キーに（分からなければ null） */
export function normalizeLineAccountKey(raw: string | null | undefined): LineAccountKey | null {
  const s = (raw ?? "").trim();
  if ((LINE_ACCOUNT_KEYS as readonly string[]).includes(s)) return s as LineAccountKey;
  return LINE_ACCOUNT_KEY_MAP[s] ?? null;
}
