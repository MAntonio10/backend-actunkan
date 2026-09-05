import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PERMITE_USUARIO_ANULADO_KEY } from '../../common/decorators/permite-usuario-anulado.decorator';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';

const USUARIO = {
  id: 3,
  correo: 'cajero@test.com',
  nombre: 'Cajero',
  idPuesto: 1,
  anulado: false,
};

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: any;
  let prisma: any;
  let reflector: Reflector;
  let metadatos: Record<string, any>;

  const contexto = () =>
    ({
      switchToHttp: () => ({
        getRequest: () => peticion,
      }),
      getHandler: () => 'handler',
      getClass: () => 'clase',
    }) as any;

  let peticion: any;

  beforeEach(() => {
    metadatos = {};
    peticion = { headers: { authorization: 'Bearer token-valido' } };

    jwtService = { verifyAsync: jest.fn().mockResolvedValue({ sub: USUARIO.id }) };
    prisma = { usuario: { findUnique: jest.fn().mockResolvedValue(USUARIO) } };

    reflector = {
      getAllAndOverride: jest.fn((clave: string) => metadatos[clave]),
    } as any;

    guard = new JwtAuthGuard(jwtService, reflector, prisma);
  });

  const marcarHandler = (clave: string) => {
    metadatos[clave] = true;
  };

  describe('usuario activo', () => {
    it('deja pasar con un token válido', async () => {
      await expect(guard.canActivate(contexto())).resolves.toBe(true);
      expect(peticion.user.id).toBe(USUARIO.id);
    });

    it('rechaza sin cabecera Authorization', async () => {
      peticion.headers = {};

      await expect(guard.canActivate(contexto())).rejects.toThrow(UnauthorizedException);
    });

    it('una ruta pública no exige token', async () => {
      marcarHandler(IS_PUBLIC_KEY);
      peticion.headers = {};

      await expect(guard.canActivate(contexto())).resolves.toBe(true);
    });

    it('rechaza si el usuario del token ya no existe', async () => {
      prisma.usuario.findUnique.mockResolvedValue(null);

      await expect(guard.canActivate(contexto())).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('usuario anulado', () => {
    beforeEach(() => {
      prisma.usuario.findUnique.mockResolvedValue({ ...USUARIO, anulado: true });
    });

    it('se rechaza en cualquier handler corriente', async () => {
      await expect(guard.canActivate(contexto())).rejects.toThrow(UnauthorizedException);
    });

    /**
     * Baja no es repudio de lo actuado: las ventas ya se cobraron y no registrarlas
     * solo deja la caja descuadrada.
     */
    it('pasa en un handler marcado con @PermiteUsuarioAnulado', async () => {
      marcarHandler(PERMITE_USUARIO_ANULADO_KEY);

      await expect(guard.canActivate(contexto())).resolves.toBe(true);
    });

    // Nada se habilita por omisión: hay que declararlo handler por handler.
    it('el permiso no se hereda a handlers vecinos', async () => {
      metadatos[PERMITE_USUARIO_ANULADO_KEY] = undefined;

      await expect(guard.canActivate(contexto())).rejects.toThrow(UnauthorizedException);
    });
  });

  /**
   * El agujero que este control cierra: sin él bastaría refrescar tras la baja para
   * recuperar acceso completo, y la baja no serviría de nada.
   */
  describe('token de alcance reducido (soloSincronizacion)', () => {
    beforeEach(() => {
      jwtService.verifyAsync.mockResolvedValue({ sub: USUARIO.id, soloSincronizacion: true });
    });

    it('no sirve para el resto del sistema, aunque el usuario esté activo', async () => {
      await expect(guard.canActivate(contexto())).rejects.toThrow(
        /solo permite sincronizar ventas offline/i,
      );
    });

    it('sirve en los handlers de sincronización', async () => {
      marcarHandler(PERMITE_USUARIO_ANULADO_KEY);

      await expect(guard.canActivate(contexto())).resolves.toBe(true);
    });

    it('la petición queda marcada, para que la bitácora pueda distinguirlo', async () => {
      marcarHandler(PERMITE_USUARIO_ANULADO_KEY);
      await guard.canActivate(contexto());

      expect(peticion.user.soloSincronizacion).toBe(true);
    });

    it('un token corriente no queda marcado', async () => {
      jwtService.verifyAsync.mockResolvedValue({ sub: USUARIO.id });
      await guard.canActivate(contexto());

      expect(peticion.user.soloSincronizacion).toBe(false);
    });
  });
});
