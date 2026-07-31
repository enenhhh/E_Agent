import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ResolveContext {
  parentURL?: string;
}

interface ResolveResult {
  format?: string | null;
  shortCircuit?: boolean;
  url: string;
}

type NextResolve = (specifier: string, context: ResolveContext) => ResolveResult;

const pluginRoot = resolve(process.env['E_AGENT_PLUGIN_ROOT'] ?? '.');

/**
 * 拒绝插件入口导入 Node 内置模块、外部包及插件目录之外的文件。
 *
 * 该加载器是纵深防御，不构成针对恶意本机代码的绝对安全边界。
 */
export function resolveHook(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): ResolveResult {
  if (!isPluginParent(context.parentURL)) {
    return nextResolve(specifier, context);
  }
  if (
    specifier.startsWith('node:') ||
    (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:'))
  ) {
    throw new Error(`插件不允许直接导入模块：${specifier}`);
  }
  const result = nextResolve(specifier, context);
  if (!result.url.startsWith('file:')) {
    throw new Error(`插件不允许加载协议：${new URL(result.url).protocol}`);
  }
  const target = fileURLToPath(result.url);
  if (!isWithin(pluginRoot, target)) {
    throw new Error('插件模块不能逃逸插件目录');
  }
  return result;
}

function isPluginParent(parentUrl: string | undefined): boolean {
  if (parentUrl === undefined || !parentUrl.startsWith('file:')) {
    return false;
  }
  return isWithin(pluginRoot, fileURLToPath(parentUrl));
}

function isWithin(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return (
    (relation === '' && resolve(parent) === resolve(child)) ||
    (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}
