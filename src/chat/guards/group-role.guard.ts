import { ForbiddenException } from '@nestjs/common';

export type GroupRole = 'owner' | 'admin' | 'member';

/**
 * Check if a user has one of the required roles in a group conversation.
 * Throws ForbiddenException if not authorized.
 */
export function checkGroupRole(
  participants: { userId: string; role?: string }[],
  userId: string,
  requiredRoles: GroupRole[],
): { userId: string; role: string } {
  const participant = participants.find((p) => p.userId === userId);
  if (!participant) {
    throw new ForbiddenException('Bạn không thuộc nhóm này');
  }

  const role = participant.role || 'member';
  if (!requiredRoles.includes(role as GroupRole)) {
    throw new ForbiddenException('Bạn không có quyền thực hiện thao tác này');
  }

  return { userId: participant.userId, role };
}
