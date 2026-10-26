import type {ScheduleRunData} from '../../shared/automation';
import {Notice} from './common';

export const runStates = {
  queued: '待执行', running: '执行中', completed: '已完成', cancelled: '已取消',
  unavailable: '不可执行', skipped: '已跳过', failed: '失败',
};
/** Shared result rendering; simulation must be explicit and can only show a snapshot. */
export function AutomationRunResult({result, simulation = false}: {
  result: ScheduleRunData['result']; simulation?: boolean;
}) {
  if (!result) return null;
  if (result.kind === 'local-checkpoint') return <Notice kind="success">
    {simulation ? '模拟快照（仅回显，未执行）：' : '本地快照：'}{result.note || '空指令快照'}。没有执行研究或模型调用。
  </Notice>;
  if (simulation) return null;
  if (result.kind === 'local-evidence-report') return <p className="automation-prewrap">
    已保存固定证据报告 · {result.artifactId}。请在定时报告页重新验证同意和来源后打开。
  </p>;
  if (result.kind === 'local-notification') return <Notice kind="success">通知已存入应用内收件箱，没有发送外部消息。</Notice>;
  return null;
}
