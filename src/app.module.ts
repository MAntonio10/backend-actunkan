import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { PuestosModule } from './puestos/puestos.module';
import { ModulosModule } from './modulos/modulos.module';
import { AccionesModule } from './acciones/acciones.module';
import { ModuloAccionesModule } from './modulo-acciones/modulo-acciones.module';
import { UsuariosModule } from './usuarios/usuarios.module';
import { BitacoraModule } from './bitacora/bitacora.module';
import { CajasModule } from './cajas/cajas.module';
import { GastosModule } from './gastos/gastos.module';
import { TiposGastoModule } from './tipos-gasto/tipos-gasto.module';
import { GuiasModule } from './guias/guias.module';
import { PagosModule } from './pagos/pagos.module';
import { TarifasModule } from './tarifas/tarifas.module';
import { TicketsModule } from './tickets/tickets.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './auth/guards/permissions.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    /**
     * Límite de peticiones por IP. Evita que una ráfaga tumbe el servidor y frena
     * la fuerza bruta contra el login.
     *
     * Se declara UN SOLO límite global: si se definieran varios perfiles con nombre,
     * el guard los aplicaría todos a todas las rutas, y el más restrictivo acabaría
     * limitando la API entera. Las rutas sensibles bajan su techo con `@Throttle`
     * (ver auth.controller.ts).
     */
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: Number(config.get('THROTTLE_TTL_SEGUNDOS') ?? 60) * 1000,
            limit: Number(config.get('THROTTLE_LIMITE') ?? 120),
          },
        ],
      }),
    }),
    PrismaModule,
    AuthModule,
    PuestosModule,
    ModulosModule,
    AccionesModule,
    ModuloAccionesModule,
    UsuariosModule,
    BitacoraModule,
    CajasModule,
    GastosModule,
    TiposGastoModule,
    GuiasModule,
    PagosModule,
    TarifasModule,
    TicketsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // El orden importa: el límite de peticiones va primero para que una ráfaga se
    // descarte antes de verificar el token o consultar permisos en la base de datos.
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
  ],
})
export class AppModule {}
