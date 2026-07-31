#!/usr/bin/env node

import { validateDesktopInstallerConfig } from '../lib/desktop-installer-config.mjs';

const result = await validateDesktopInstallerConfig();
console.log(`桌面安装器配置校验通过：E Agent ${result.version}`);
