import {AutomationRunResult, runStates} from './AutomationRunResult';
import {useEffect, useRef, useState} from 'react';
import type {ScheduleRecord} from '../../shared/automation';

type State = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
type PreviewRun = {
  id: number; name: string; instructions: string; revision: number;
  state: State; outcome: 'completed' | 'failed'; retryOf: number | null;
};
const labels = Object.fromEntries(['queued','running','completed','failed','cancelled'].map(state => [state, `模拟${runStates[state as State]}`])) as Record<State, string>;
const active = (run: PreviewRun) => run.state === 'queued' || run.state === 'running';

/** Original frontend-only interaction demo. Never invokes execution, source, or notification APIs. */
export function AutomationExecutionPreview({schedules, ready, visible = true}: {
  schedules: ScheduleRecord[]; ready: boolean; visible?: boolean;
}) {
  const [scheduleId, setScheduleId] = useState('');
  const [outcome, setOutcome] = useState<'completed' | 'failed'>('completed');
  const [runs, setRuns] = useState<PreviewRun[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [filter, setFilter] = useState<State | ''>('');
  const sequence = useRef(0);
  const busy = useRef(false);
  const choices = schedules.filter(record => !record.deletedAt);
  const schedule = choices.find(record => record.id === scheduleId);
  const current = runs.find(active);
  const detail = runs.find(run => run.id === selected);
  useEffect(() => {
    if (!visible) {
      busy.current = false;
      setRuns(previous => previous.map(run => active(run) ? {...run, state:'cancelled'} : run));
      setSelected(null);
      return;
    }
    if (!current) return;
    const timer = window.setTimeout(() => {
      if (current.state === 'running') busy.current = false;
      setRuns(previous => previous.map(run => run.id === current.id && run.state === current.state
        ? {...run, state: run.state === 'queued' ? 'running' : run.outcome} : run));
    }, current.state === 'queued' ? 700 : 1200);
    return () => window.clearTimeout(timer);
  }, [current, visible]);
  function start(retry?: PreviewRun) {
    if (!visible || !ready || busy.current || runs.length >= 20 || (!retry && !schedule)) return;
    busy.current = true;
    const run: PreviewRun = {
      id: ++sequence.current, name: retry ? retry.name : schedule!.data.name,
      instructions: retry ? retry.instructions : schedule!.data.instructions,
      revision: retry ? retry.revision : schedule!.revision,
      state:'queued', outcome, retryOf: retry?.id ?? null,
    };
    setRuns(previous => [run, ...previous]);
    setFilter('');
    setSelected(run.id);
  }
  function cancel(id: number) {
    busy.current = false;
    setRuns(previous => previous.map(run => run.id === id && active(run) ? {...run, state:'cancelled'} : run));
  }
  return <section className="panel company-dataset" aria-label="原创本地执行模拟">
    <h2>原创 · 本地执行模拟</h2>
    <p>只演示状态与指令快照，不执行任务、读取资料或投递通知；与下方真实历史分开。</p>
    <p className="muted">记录仅留在本页内存，刷新即清空，切离运行页取消未结束模拟。</p>
    <div className="company-form-pair">
      <label>模拟任务定义<select value={scheduleId} onChange={event => setScheduleId(event.target.value)} disabled={!ready || Boolean(current)}>
        <option value="">请选择已保存定义</option>
        {choices.map(record => <option value={record.id} key={record.id}>{record.data.name}</option>)}
      </select></label>
      <label>模拟结果场景<select value={outcome} onChange={event => setOutcome(event.target.value as typeof outcome)} disabled={Boolean(current)}>
        <option value="completed">成功（仅展示指令快照）</option><option value="failed">失败（用于演示重试）</option>
      </select></label>
    </div>
    {!ready && <p role="status">定义尚未核实，暂不能开始模拟。</p>}
    {ready && choices.length === 0 && <p>请先保存一条任务定义，再体验模拟。</p>}
    
    <button className="secondary" disabled={!visible || !ready || !schedule || Boolean(current) || runs.length >= 20} onClick={() => start()}>开始本地模拟</button>
    {runs.length >= 20 && <p role="status">已达到 20 条上限，请先清空模拟记录。</p>}
    <button className="text-button" disabled={Boolean(current) || runs.length === 0} onClick={() => {setRuns([]); setSelected(null);}}>清空模拟记录</button>
    <label>模拟状态筛选<select value={filter} onChange={event => setFilter(event.target.value as State | '')}>
      <option value="">全部模拟状态</option>{Object.entries(labels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <p role="status" aria-live="polite">{current ? `第 ${current.id} 次：${labels[current.state]}` : runs[0] ? `最近模拟：${labels[runs[0].state]}` : '暂无模拟记录'}</p>
    <ul>{runs.filter(run => !filter || filter === run.state).map(run => <li key={run.id}>
      <span>#{run.id} · {run.name} · {labels[run.state]}{run.retryOf ? ` · 重试自 #${run.retryOf}` : ''}</span>{' '}
      <button className="text-button" onClick={() => setSelected(run.id)} aria-label={`查看模拟 ${run.id}`}>查看模拟详情</button>
      {active(run) && <button className="text-button" onClick={() => cancel(run.id)}>取消模拟</button>}
      {(run.state === 'failed' || run.state === 'cancelled') && <button className="text-button" disabled={!ready || !visible || Boolean(current) || runs.length >= 20} onClick={() => start(run)}>重新模拟 #{run.id}</button>}
    </li>)}</ul>
    {runs.length > 0 && !runs.some(run => !filter || filter === run.state) && <p>没有符合筛选的模拟记录。</p>}
    {detail && <section aria-label="模拟结果详情">
      <h3>模拟 #{detail.id} · {detail.name}</h3>
      <p>{labels[detail.state]} · 原定义版本 {detail.revision}{detail.retryOf ? ` · 使用 #${detail.retryOf} 的原始快照重试` : ''}</p>
      {detail.state === 'completed' ? <AutomationRunResult simulation result={{kind:'local-checkpoint',note:detail.instructions}}/>
        : detail.state === 'failed' ? <p>演示失败：这是手动选择的模拟场景，不是服务异常。可切换为成功场景后重新模拟；不会修改旧记录。</p>
        : detail.state === 'cancelled' ? <p>模拟已取消，未产生执行结果。可重新模拟。</p>
        : <p>模拟尚未完成，暂时没有结果。</p>}
      <button className="text-button" onClick={() => setSelected(null)}>收起模拟详情</button>
    </section>}
  </section>;
}
