import { create } from 'zustand';

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  kind: 'success' | 'info' | 'warning' | 'error';
}

interface ToastState {
  messages: ToastMessage[];
  push: (message: Omit<ToastMessage, 'id'>) => string;
  remove: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  messages: [],
  push: (message) => {
    const id = crypto.randomUUID();
    set((state) => ({
      messages: [...state.messages, { ...message, id }].slice(-4),
    }));
    window.setTimeout(() => {
      set((state) => ({ messages: state.messages.filter((item) => item.id !== id) }));
    }, 5_000);
    return id;
  },
  remove: (id) =>
    set((state) => ({ messages: state.messages.filter((message) => message.id !== id) })),
}));
