// Keep nulls in the source document; omit unknown metadata only when rendering.
export function knownActionValue(value) {
  if(typeof value!=='string')return null;
  const text=value.trim();
  return !text||/^(不明|未定|未設定|未確認|担当者不明|期限不明|unknown|n\/a|null)$/i.test(text)?null:text;
}
