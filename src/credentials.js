import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

// 指定された既存ファイルをメモリへ読み込み、秘密値をログへ出さない。
export function loadOpenAIKey({ workspace = process.cwd(), env = process.env } = {}) {
  if (env.OPENAI_API_KEY?.trim()) return { configured: true, source: 'environment' };
  if (!env.OPENAI_API_KEY_FILE) return { configured: false, source: null };
  const target = resolve(workspace, env.OPENAI_API_KEY_FILE);
  const local = relative(realpathSync(workspace), target);
  if (local.startsWith('..') || isAbsolute(local)) throw new Error('キーのファイルは作業ディレクトリ内で指定してください。');
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(target) !== target || stat.size > 64000) throw new Error('キーのファイルを安全に読み込めません。');
  const values = [...new Set(readFileSync(target, 'utf8').match(/\bsk-[A-Za-z0-9_-]{20,}/g) ?? [])];
  if (values.length !== 1) throw new Error('キーのファイルにはOpenAIキーを一つだけ設定してください。');
  env.OPENAI_API_KEY = values[0];
  return { configured: true, source: 'file' };
}
