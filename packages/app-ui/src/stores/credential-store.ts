import { create } from 'zustand';

import type { CredentialInput, EAgentTransport, ProviderInput } from '../lib/transport';
import type { Credential, ProviderConfig } from '../types';

interface CredentialState {
  providers: ProviderConfig[];
  credentials: Credential[];
  loading: boolean;
  checking: boolean;
  error: string | null;
  load: (transport: EAgentTransport) => Promise<void>;
  createProvider: (transport: EAgentTransport, input: ProviderInput) => Promise<ProviderConfig>;
  updateProvider: (
    transport: EAgentTransport,
    id: string,
    input: Partial<ProviderInput>,
  ) => Promise<ProviderConfig>;
  create: (transport: EAgentTransport, input: CredentialInput) => Promise<void>;
  update: (
    transport: EAgentTransport,
    id: string,
    input: Partial<CredentialInput>,
  ) => Promise<void>;
  remove: (transport: EAgentTransport, id: string) => Promise<void>;
  check: (transport: EAgentTransport, id?: string) => Promise<void>;
}

export const useCredentialStore = create<CredentialState>((set) => ({
  providers: [],
  credentials: [],
  loading: false,
  checking: false,
  error: null,

  load: async (transport) => {
    set({ loading: true, error: null });
    try {
      const [providers, credentials] = await Promise.all([
        transport.listProviders(),
        transport.listCredentials(),
      ]);
      set({ providers, credentials, loading: false });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : '服务商与密钥列表加载失败。',
      });
    }
  },

  createProvider: async (transport, input) => {
    set({ error: null });
    try {
      const provider = await transport.createProvider(input);
      set((state) => ({
        providers: [...state.providers.filter((item) => item.id !== provider.id), provider],
      }));
      return provider;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '服务商添加失败。' });
      throw error;
    }
  },

  updateProvider: async (transport, id, input) => {
    set({ error: null });
    try {
      const provider = await transport.updateProvider(id, input);
      set((state) => ({
        providers: state.providers.map((item) => (item.id === id ? provider : item)),
        credentials: state.credentials.map((credential) =>
          credential.providerId === id
            ? {
                ...credential,
                provider: provider.name,
                providerName: provider.name,
                providerType: provider.type,
                strategy: provider.keyStrategy,
              }
            : credential,
        ),
      }));
      return provider;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '服务商保存失败。' });
      throw error;
    }
  },

  create: async (transport, input) => {
    set({ error: null });
    try {
      const credential = await transport.createCredential(input);
      set((state) => ({ credentials: [...state.credentials, credential] }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '密钥添加失败。' });
      throw error;
    }
  },

  update: async (transport, id, input) => {
    set({ error: null });
    try {
      const credential = await transport.updateCredential(id, input);
      set((state) => ({
        credentials: state.credentials.map((item) => (item.id === id ? credential : item)),
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '密钥保存失败。' });
      throw error;
    }
  },

  remove: async (transport, id) => {
    try {
      await transport.deleteCredential(id);
      set((state) => ({
        credentials: state.credentials.filter((credential) => credential.id !== id),
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '密钥删除失败。' });
      throw error;
    }
  },

  check: async (transport, id) => {
    set({ checking: true, error: null });
    try {
      if (id) {
        const credential = await transport.checkCredential(id);
        set((state) => ({
          credentials: state.credentials.map((item) => (item.id === id ? credential : item)),
          checking: false,
        }));
      } else {
        const credentials = await transport.checkAllCredentials();
        set({ credentials, checking: false });
      }
    } catch (error) {
      set({
        checking: false,
        error: error instanceof Error ? error.message : '健康检查失败。',
      });
      throw error;
    }
  },
}));
