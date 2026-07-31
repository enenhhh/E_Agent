import { useState, type FormEvent } from 'react';

import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Modal';

export function InstallExtensionModal({
  kind,
  onClose,
  onInstall,
  open,
}: {
  kind: 'skill' | 'plugin';
  open: boolean;
  onClose: () => void;
  onInstall: (source: string) => Promise<void>;
}): React.JSX.Element {
  const [source, setSource] = useState('');
  const [installing, setInstalling] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setInstalling(true);
    try {
      await onInstall(source.trim());
      setSource('');
      onClose();
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Modal
      description="安装包会先完成清单校验、路径安全检查和权限审查，不会执行生命周期脚本。"
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            取消
          </Button>
          <Button
            disabled={!source.trim()}
            form="extension-install-form"
            loading={installing}
            type="submit"
            variant="primary"
          >
            检查并安装
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title={`安装${kind === 'skill' ? ' Skill' : '插件'}`}
    >
      <form id="extension-install-form" onSubmit={(event) => void submit(event)}>
        <Field
          description="支持 HTTPS Git URL 或已授权的本地绝对路径。Git 安装会固定到具体提交哈希。"
          label="来源"
          onChange={(event) => setSource(event.target.value)}
          placeholder={
            kind === 'skill'
              ? 'https://github.com/example/my-skill.git'
              : 'https://github.com/example/e-agent-plugin.git'
          }
          required
          value={source}
        />
      </form>
    </Modal>
  );
}
