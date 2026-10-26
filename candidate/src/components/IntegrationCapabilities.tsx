import { useEffect, useState } from 'react';
import { api, errorMessage } from '../adapters/api';
import type { IntegrationCapability } from '../../shared/integration-capabilities';
import { Notice, Spinner } from './common';
export function IntegrationCapabilities({ source = 'server' }: { source?: 'server' | 'synthetic' }) {
  const synthetic = source === 'synthetic';
  const title = synthetic ? '合成能力展示' : '服务端注册能力';
  const [items, setItems] = useState<IntegrationCapability[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api
      .integrations(controller.signal)
      .then(
        (value) => {
          if (!controller.signal.aborted) setItems(value);
        },
        (cause) => {
          if (!controller.signal.aborted) {
            setItems([]);
            setError(errorMessage(cause));
          }
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);
  return (
    <section className="panel integration-capabilities" aria-label={title}>
      <div className="section-heading">
        <h2>{title}</h2>
        <button
          className="secondary"
          disabled={loading}
          onClick={() => {
            // A previous eligibility result is no longer current once a new check begins.
            setItems([]);
            setLoading(true);
            setRevision((value) => value + 1);
          }}
        >
          {synthetic ? '重新读取合成展示' : '重新检查资格'}
        </button>
      </div>
      <p className="muted">
        {synthetic
          ? '此入口仅展示合成能力数据，不是实时服务注册或资格检查；不证明任何外部服务已接通。此页不会配置密钥或发起模型调用。'
          : '“当前允许调用”只表示服务端资格判断，不证明网络、凭证、供应商兼容、余额或费用。此页不会配置密钥或发起模型调用。'}
      </p>
      <p className="muted">
        此页不是全部本地功能的可用性清单。
      </p>
      {loading && (
        <p role="status">
          <Spinner /> {synthetic ? '正在读取合成能力展示' : '正在读取本地能力清单'}
        </p>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {!loading && !error && !items.length && <Notice>当前没有此类能力条目；不代表本地文档或专用手动清单不可用，请以各功能页的当前状态为准。</Notice>}
      <div className="company-grid">
        {items.map((item) => (
          <article className="company-card" key={item.id}>
            <h3>{item.label}</h3>
            <p className="company-symbol">
              {item.kind} · {item.id}
            </p>
            <dl className="automation-facts">
              <dt>执行接口</dt>
              <dd>{item.implemented ? '已实现' : '尚未实现连接器'}</dd>
              <dt>服务端配置</dt>
              <dd>{item.configured ? '已注入' : '未配置'}</dd>
              <dt>当前资格</dt>
              <dd>{item.available ? '当前允许调用' : '不可调用'}</dd>
            </dl>
            {!item.implemented && (
              <p className="automation-warning">仅有能力声明，需要继续实现和验收；填入配置不会使其可用。</p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
