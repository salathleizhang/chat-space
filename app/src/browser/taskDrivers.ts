interface ScheduledJob {
  task: { id: string };
  nextAt: number;
  done?: boolean;
}

/** Worker 在供应商查询间释放锁；持久化的下一次查询同样是有效的任务驱动。 */
export function browserTaskDriverIds(
  jobs: ScheduledJob[], heldLockNames: string[], now = Date.now(),
): Set<string> {
  const prefix = "chatspace:job:";
  const ids = new Set(heldLockNames.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length)));
  // 允许外部心跳接手到期查询，但逾期超过静默告警窗口的调度不能伪装成健康。
  for (const job of jobs) {
    if (!job.done && Number.isFinite(job.nextAt) && job.nextAt >= now - 90_000) ids.add(job.task.id);
  }
  return ids;
}
