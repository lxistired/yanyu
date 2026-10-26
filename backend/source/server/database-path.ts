import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { AdapterError } from '../shared/contracts';
const fail = () =>
  new AdapterError('PROVIDER_ERROR', '本地数据库无法打开或版本不受支持；请检查路径、备份及单进程占用');
export function workspaceDatabasePath(root: string, relative: string): string {
  if (
    !relative ||
    isAbsolute(relative) ||
    !/^[A-Za-z0-9_./-]+\.sqlite$/.test(relative) ||
    relative.split(/[\\/]/).some((p) => p === '..' || p === '' || p === '.')
  )
    throw new AdapterError('INVALID_REQUEST', '数据库路径必须是工作目录内的安全相对 .sqlite 路径');
  const base = realpathSync(root);
  const path = resolve(base, relative);
  if (!path.startsWith(base + sep)) throw fail();
  // No symlink traversal in configured components. All paths are server-owned, never HTTP input.
  let current = base;
  for (const component of relative.split('/')) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) throw fail();
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return path;
}
/** Reserve new storage with owner-only permissions before SQLite can create it under umask 022. */
export function reservePrivateDatabaseFile(path: string) {
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail();
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      throw new AdapterError(
        'PROVIDER_ERROR',
        '已有数据库权限过宽；请由所有者先确认备份并收紧到仅所有者可访问，再重试。不会自动修改原文件权限',
      );
  }
}
export { fail as databaseOpenError };
