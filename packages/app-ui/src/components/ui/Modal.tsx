import { X } from 'lucide-react';
import { useEffect, type PropsWithChildren, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { IconButton } from './IconButton';

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  footer?: ReactNode;
  onClose: () => void;
}

export function Modal({
  children,
  description,
  footer,
  onClose,
  open,
  title,
}: PropsWithChildren<ModalProps>): React.JSX.Element | null {
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div aria-modal className="modal-backdrop" role="dialog">
      <button aria-label="关闭对话框" className="modal-backdrop__dismiss" onClick={onClose} />
      <section className="modal">
        <header className="modal__header">
          <span>
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </span>
          <IconButton label="关闭" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </section>
    </div>,
    document.body,
  );
}
