import { SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY = 'required_permission';

export interface PermissionRequirement {
  modulo: string;
  accion: string;
}

export const RequirePermission = (modulo: string, accion: string) =>
  SetMetadata(PERMISSION_KEY, { modulo, accion } as PermissionRequirement);
