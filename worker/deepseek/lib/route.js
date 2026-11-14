/*
 * 路由：把 /<site>/v1/* 拆成站点 + 站点内路径。
 * 没写站点前缀的老路径按 legacy 处理（等价于 deepseek 站点）。
 */

export const SITE_IDS = ['deepseek', 'doubao'];

const SITE_PREFIX = /^\/([a-z0-9_-]+)(\/.*)?$/;

export function route(pathname) {
  const p = String(pathname || '/').replace(/\/+$/, '') || '/';
  const m = p.match(SITE_PREFIX);
  if (m && SITE_IDS.indexOf(m[1]) >= 0) {
    const rest = m[2] || '';
    // /<site> 与 /<site>/health 都算该站点的健康检查
    if (rest === '' || rest === '/') return { site: m[1], path: '/health', legacy: false };
    return { site: m[1], path: rest, legacy: false };
  }
  if (p === '/health' || p === '/') return { site: 'deepseek', path: '/health', legacy: true };
  return { site: 'deepseek', path: p, legacy: true };
}
