import { create } from 'zustand';

import {
  TransportError,
  type EAgentTransport,
  type LoginInput,
  type SetupInput,
} from '../lib/transport';
import type { SessionInfo } from '../types';

type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'unauthenticated' | 'setup-required';

interface AuthState {
  status: AuthStatus;
  session: SessionInfo | null;
  error: string | null;
  bootstrapTokenRequired: boolean;
  bootstrap: (transport: EAgentTransport) => Promise<void>;
  login: (transport: EAgentTransport, input: LoginInput) => Promise<void>;
  setup: (transport: EAgentTransport, input: SetupInput) => Promise<void>;
  logout: (transport: EAgentTransport) => Promise<void>;
  clearError: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '身份验证失败，请稍后重试。';
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'idle',
  session: null,
  error: null,
  bootstrapTokenRequired: false,

  bootstrap: async (transport) => {
    set({ status: 'loading', error: null });
    try {
      const session = await transport.getSession();
      set({
        status: session ? 'authenticated' : 'unauthenticated',
        session,
        bootstrapTokenRequired: false,
      });
    } catch (error) {
      if (error instanceof TransportError && error.code === 'SETUP_REQUIRED') {
        set({
          status: 'setup-required',
          session: null,
          bootstrapTokenRequired: error.bootstrapTokenRequired === true,
        });
        return;
      }
      set({
        status: 'unauthenticated',
        session: null,
        error: errorMessage(error),
        bootstrapTokenRequired: false,
      });
    }
  },

  login: async (transport, input) => {
    set({ status: 'loading', error: null });
    try {
      const session = await transport.login(input);
      set({ status: 'authenticated', session, bootstrapTokenRequired: false });
    } catch (error) {
      set({ status: 'unauthenticated', session: null, error: errorMessage(error) });
      throw error;
    }
  },

  setup: async (transport, input) => {
    set({ status: 'loading', error: null });
    try {
      const session = await transport.setup(input);
      set({ status: 'authenticated', session, bootstrapTokenRequired: false });
    } catch (error) {
      set({ status: 'setup-required', session: null, error: errorMessage(error) });
      throw error;
    }
  },

  logout: async (transport) => {
    try {
      await transport.logout();
    } finally {
      set({
        status: 'unauthenticated',
        session: null,
        error: null,
        bootstrapTokenRequired: false,
      });
    }
  },

  clearError: () => set({ error: null }),
}));
