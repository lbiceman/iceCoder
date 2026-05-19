/**
 * TaskGraph 配置与 Feature Flag。
 *
 * 依赖：无
 */

/** 读取 ICE_TASK_GRAPH 环境变量，判断是否启用 TaskGraph */
export function isTaskGraphEnabled(): boolean {
  const env = process.env['ICE_TASK_GRAPH'];
  if (env === undefined || env === '') return false;
  return env !== '0' && env.toLowerCase() !== 'false';
}
