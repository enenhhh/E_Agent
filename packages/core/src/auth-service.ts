import type {
  AuthResponse,
  CreateMemberRequest,
  LoginRequest,
  RegisterRequest,
  Role,
  UpdateMemberRequest,
  User,
} from '@e-agent/contracts';
import type { AuditRepository, UsersRepository } from '@e-agent/database';
import { hashPassword, type TokenService, verifyPassword } from '@e-agent/security';

import { DomainError } from './errors.js';
import { mapUser } from './mappers.js';

/** 本地账户认证；仅允许首个注册用户自助引导为 Owner。 */
export class AuthService {
  public constructor(
    private readonly users: UsersRepository,
    private readonly tokens: TokenService,
    private readonly audit?: AuditRepository,
  ) {}

  public isInitialized(): boolean {
    return this.users.count() > 0;
  }

  public async register(input: RegisterRequest): Promise<AuthResponse> {
    if (this.users.count() > 0) {
      throw new DomainError('FORBIDDEN', '系统已完成初始化，请由管理员创建成员');
    }
    if (this.users.findByEmail(input.email) !== undefined) {
      throw new DomainError('CONFLICT', '邮箱已存在');
    }
    const passwordHash = await hashPassword(input.password);
    const user = this.users.createInitialOwner({
      email: input.email,
      displayName: input.displayName,
      passwordHash,
    });
    if (user === undefined) {
      throw new DomainError('FORBIDDEN', '系统已完成初始化，请由管理员创建成员');
    }
    return this.issue(mapUser(user));
  }

  public async login(input: LoginRequest): Promise<AuthResponse> {
    const user = this.users.findByEmail(input.email);
    if (
      user === undefined ||
      !user.active ||
      !(await verifyPassword(input.password, user.passwordHash))
    ) {
      throw new DomainError('UNAUTHORIZED', '邮箱或密码不正确');
    }
    return this.issue(mapUser(user));
  }

  public getUser(id: string): User {
    const user = this.users.findById(id);
    if (user === undefined || !user.active) {
      throw new DomainError('UNAUTHORIZED', '用户不存在或已停用');
    }
    return mapUser(user);
  }

  public listUsers(actor: { id: string; role: Role }): User[] {
    this.assertManager(actor);
    return this.users.list().map(mapUser);
  }

  public async createUser(
    input: CreateMemberRequest,
    actor: { id: string; role: Role },
  ): Promise<User> {
    this.assertCanGrant(actor, input.role);
    if (this.users.findByEmail(input.email) !== undefined) {
      throw new DomainError('CONFLICT', '邮箱已存在');
    }
    const created = this.users.create({
      email: input.email,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      role: input.role,
    });
    this.audit?.record({
      actorId: actor.id,
      action: 'user.create',
      targetType: 'user',
      targetId: created.id,
      metadata: { role: created.role },
    });
    return mapUser(created);
  }

  public updateUser(
    id: string,
    input: UpdateMemberRequest,
    actor: { id: string; role: Role },
  ): User {
    this.assertManager(actor);
    const target = this.users.findById(id);
    if (target === undefined) throw new DomainError('NOT_FOUND', '成员不存在');
    this.assertCanManageTarget(actor, target.role);
    if (input.role !== undefined) this.assertCanGrant(actor, input.role);
    if (id === actor.id && (input.active === false || input.role !== undefined)) {
      throw new DomainError('FORBIDDEN', '不能停用或变更自己的角色');
    }
    if (target.role === 'owner' && (input.active === false || input.role !== undefined)) {
      throw new DomainError('FORBIDDEN', 'Owner 角色不能被停用或降级');
    }
    const updated = this.users.update(id, input);
    if (updated === undefined) throw new DomainError('NOT_FOUND', '成员不存在');
    this.audit?.record({
      actorId: actor.id,
      action: 'user.update',
      targetType: 'user',
      targetId: id,
      metadata: { fields: Object.keys(input).sort() },
    });
    return mapUser(updated);
  }

  public deleteUser(id: string, actor: { id: string; role: Role }): void {
    this.assertManager(actor);
    const target = this.users.findById(id);
    if (target === undefined) throw new DomainError('NOT_FOUND', '成员不存在');
    this.assertCanManageTarget(actor, target.role);
    if (id === actor.id) throw new DomainError('FORBIDDEN', '不能删除自己的账户');
    if (target.role === 'owner') throw new DomainError('FORBIDDEN', 'Owner 账户不能删除');
    if (!this.users.delete(id)) throw new DomainError('NOT_FOUND', '成员不存在');
    this.audit?.record({
      actorId: actor.id,
      action: 'user.delete',
      targetType: 'user',
      targetId: id,
      metadata: { role: target.role },
    });
  }

  private issue(user: User): AuthResponse {
    const { token, claims } = this.tokens.issue({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
    return {
      accessToken: token,
      expiresAt: new Date(claims.exp * 1_000).toISOString(),
      user,
    };
  }

  private assertManager(actor: { role: Role }): void {
    if (actor.role !== 'owner' && actor.role !== 'admin') {
      throw new DomainError('FORBIDDEN', '只有 Owner 或 Admin 可以管理成员');
    }
  }

  private assertCanGrant(actor: { role: Role }, role: Exclude<Role, 'owner'>): void {
    this.assertManager(actor);
    if (actor.role === 'admin' && role === 'admin') {
      throw new DomainError('FORBIDDEN', 'Admin 不能授予 Admin 角色');
    }
  }

  private assertCanManageTarget(actor: { role: Role }, targetRole: Role): void {
    this.assertManager(actor);
    if (actor.role === 'admin' && (targetRole === 'owner' || targetRole === 'admin')) {
      throw new DomainError('FORBIDDEN', 'Admin 不能管理 Owner 或其他 Admin');
    }
  }
}
