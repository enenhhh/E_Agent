import { AnimatePresence, motion } from 'framer-motion';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';

import { useToastStore, type ToastMessage } from '../../stores/toast-store';

import { IconButton } from './IconButton';

const icons: Record<ToastMessage['kind'], React.JSX.Element> = {
  success: <CircleCheck size={18} />,
  info: <Info size={18} />,
  warning: <TriangleAlert size={18} />,
  error: <CircleAlert size={18} />,
};

export function ToastViewport(): React.JSX.Element {
  const messages = useToastStore((state) => state.messages);
  const remove = useToastStore((state) => state.remove);

  return (
    <div aria-live="polite" className="toast-viewport">
      <AnimatePresence initial={false}>
        {messages.map((message) => (
          <motion.article
            animate={{ opacity: 1, x: 0 }}
            className={`toast toast--${message.kind}`}
            exit={{ opacity: 0, x: 24 }}
            initial={{ opacity: 0, x: 24 }}
            key={message.id}
            layout
          >
            <span className="toast__icon">{icons[message.kind]}</span>
            <span className="toast__copy">
              <strong>{message.title}</strong>
              {message.description ? <span>{message.description}</span> : null}
            </span>
            <IconButton label="关闭通知" onClick={() => remove(message.id)}>
              <X size={15} />
            </IconButton>
          </motion.article>
        ))}
      </AnimatePresence>
    </div>
  );
}
