import { EAgentApp } from '@e-agent/app-ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@e-agent/app-ui/styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('缺少应用根节点。');
}

createRoot(root).render(
  <StrictMode>
    <EAgentApp mode="web" />
  </StrictMode>,
);
