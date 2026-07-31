import type { ProjectRow, ProjectsRepository } from '@e-agent/database';

import { DomainError } from './errors.js';

export interface ProjectActor {
  id: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

export function canAccessProject(project: ProjectRow, actor: ProjectActor): boolean {
  return (
    actor.role === 'owner' ||
    actor.role === 'admin' ||
    (project.ownerId !== null && project.ownerId === actor.id)
  );
}

/** 在领域层验证项目存在且当前角色拥有访问权，避免仅凭可猜测 ID 读取跨用户上下文。 */
export function assertProjectAccess(
  projects: Pick<ProjectsRepository, 'get'>,
  projectId: string,
  actor: ProjectActor,
): ProjectRow {
  const project = projects.get(projectId);
  if (project === undefined) throw new DomainError('NOT_FOUND', '项目不存在');
  if (!canAccessProject(project, actor)) {
    throw new DomainError('FORBIDDEN', '无权访问此项目');
  }
  return project;
}
