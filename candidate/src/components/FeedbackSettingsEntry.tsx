import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FeedbackWorkspace } from './FeedbackWorkspace';

/** Ordinary settings host. The caller supplies its already-verified owner and route/read lifetime. */
export function FeedbackSettingsEntry({
  available,
  expectedOwnerScope,
  lifecycleKey,
}: {
  available: boolean;
  expectedOwnerScope: string | null;
  lifecycleKey: string;
}) {
  const frame = useMemo(
    () => ({ available, expectedOwnerScope, lifecycleKey }),
    [available, expectedOwnerScope, lifecycleKey],
  );
  const committed = useRef<object>(frame);
  const opener = useRef<HTMLButtonElement>(null);
  const [opened, setOpened] = useState<object | null>(null);
  useLayoutEffect(() => {
    committed.current = frame;
    return () => {
      committed.current = {};
    };
  }, [frame]);
  const close = () => {
    if (committed.current !== frame) return;
    setOpened((current) => (current === frame ? null : current));
    // This stable entry remains in the same settings page; route teardown never calls close.
    if (opener.current?.isConnected) opener.current.focus();
  };
  return (
    <section className="feedback-entry" aria-label="帮助与反馈入口">
      <h2>帮助与反馈</h2>
      <p>明确保存后可在当前工作区查看反馈记录。向配置的支持接口提交需要另行核对内容和接收方。</p>
      <button
        ref={opener}
        type="button"
        aria-expanded={opened === frame}
        onClick={() => {
          if (committed.current === frame) setOpened(frame);
        }}
      >
        我的反馈
      </button>
      {opened === frame && (
        <FeedbackWorkspace
          available={available}
          expectedOwnerScope={expectedOwnerScope}
          lifecycleKey={lifecycleKey}
          onClose={close}
        />
      )}
    </section>
  );
}
