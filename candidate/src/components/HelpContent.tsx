import type { AppCapabilities } from '../adapters/api';
import { Notice } from './common';
import './workbench.css';
export type HelpDestination = 'workspace' | 'planner' | 'roadshow' | 'automation' | 'settings' | 'usage';
export function HelpContent({
  capabilities,
  capabilityError,
  capabilityState,
  onNavigate,
  onClose,
}: {
  capabilities: AppCapabilities | null;
  capabilityError?: string;
  capabilityState?: 'not-read';
  onNavigate: (page: HelpDestination) => void;
  onClose: () => void;
}) {
  const open = (destination: HelpDestination) => {
    onClose();
    onNavigate(destination);
  };
  return (
    <div className="help-content workbench-surface">
      <p>按当前服务能力使用研究工作台。读取说明不会保存偏好、提交问题、批准计划或启动服务。</p>
      {capabilityState === 'not-read' || capabilityError || !capabilities ? (
        <Notice kind={capabilityState !== 'not-read' && capabilityError ? 'error' : 'info'}>
          {capabilityState === 'not-read'
            ? '此入口未读取实时服务状态；请以各功能页显示的当前可用状态为准。'
            : capabilityError
            ? '服务状态读取失败，当前能力未知。'
            : '正在确认服务状态，尚不能确认本地存储、模型或 ASR 是否可用。'}
        </Notice>
      ) : (
        <>
          <section>
            <h3>本地记录与重启</h3>
            <p>
              {capabilities.persistence === 'sqlite-local'
                ? '本地 SQLite 已配置，已成功提交的记录可在同一数据目录重启后读取；未保存的表单编辑不会自动持久化。'
                : '当前为内存模式，重启后记录可能丢失。显示偏好与持久化工作台以各页面实际可用状态为准。'}
            </p>
            <p>
              {capabilities.auth === 'fixed-demo-principal'
                ? '固定演示身份用于单用户回环地址，不是企业登录或生产访问控制。'
                : capabilities.auth === 'trusted-server-adapter'
                  ? '身份由可信服务端适配器解析；每次受保护读取仍会检查当前权限。'
                  : '身份适配器尚未配置，受保护服务会拒绝访问。'}
            </p>
          </section>
          {capabilities.workspace && (
            <section>
              <h3>会话与资料导航</h3>
              <p>
                从工作台继续真实本地会话，或管理工作区与分组。工作台问题框只带入草稿；资料内容与来源仍需在授权页面核对。
              </p>
              <button className="text-button" onClick={() => open('workspace')}>
                打开工作区管理
              </button>
            </section>
          )}
          <section>
            <h3>模型与计划</h3>
            <p>
              {capabilities.model === 'unconfigured'
                ? '研究模型未配置，模型生成不可用。仍可使用当前已配置的本地资料工作流；不会用预设文本冒充生成结果。'
                : capabilities.model === 'registered'
                  ? '模型由服务端注册。允许调用只代表资格检查结果，不证明网络、凭证、供应商兼容或余额。'
                  : '当前模型包含演示或离线夹具能力；合成结果不能当作真实供应商验收。'}
            </p>
            {capabilities.plans && (
              <>
                <p>
                  查看计划、回答澄清、明确批准与执行是不同操作。显示偏好不能替代批准，也不授予资料或费用权限。
                </p>
                <button className="text-button" onClick={() => open('planner')}>
                  查看研究计划
                </button>
              </>
            )}
          </section>
          <section>
            <h3>录音与转写</h3>
            <p>
              {capabilities.asr === 'local'
                ? '已配置本机 ASR。上传与转写仍需按页面明确操作；实际识别质量需核对。'
                : capabilities.asr === 'unconfigured'
                  ? 'ASR 未配置，不能运行转写。浏览器录音如可用仍需设备权限，录音草稿不等于已完成转写。'
                  : '当前是演示或快照转写，不能代表实际识别质量。'}
            </p>
            <button className="text-button" onClick={() => open('roadshow')}>
              查看录音与转写
            </button>
          </section>
          {capabilities.automation && (
            <section>
              <h3>通知范围</h3>
              <p>
                这里只提供应用内通知。保存日程或标记通知已读不代表邮件、IM、日历邀请或系统推送已送达；本地定时处理还依赖服务运行状态。
              </p>
              <button className="text-button" onClick={() => open('automation')}>
                查看定时与站内通知
              </button>
            </section>
          )}
        </>
      )}
      <section>
        <h3>如何理解用量记录</h3>
        <p>
          手动模型计划用量只汇总已保存的相应运行元数据。对话和旧版研究的历史 Token
          未存储，无法补算；ASR、定时证据和支付不在范围内。
        </p>
        <p>
          未知不是零。仅适配器已报告并保存的数量可相加；金额、币种和供应商账单保持未知。本地取消不证明上游停止计费或退款。
        </p>
        <button className="text-button" onClick={() => open('usage')}>
          查看手动模型计划用量
        </button>
      </section>
      <p className="muted">
        TTS、实时会议、IM、硬件和支付若仅有能力声明，仍未实现实际服务。这里不会提供购买入口或发起外部诊断请求。
      </p>
      <div className="workbench-actions">
        <button className="secondary" onClick={() => open('settings')}>
          查看服务与显示偏好
        </button>
        <button className="primary" onClick={onClose}>
          关闭说明
        </button>
      </div>
    </div>
  );
}
