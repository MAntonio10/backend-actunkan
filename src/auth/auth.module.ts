import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { SesionesService } from './sesiones.service';
import { AuthController } from './auth.controller';
import { UsuariosModule } from '../usuarios/usuarios.module';
import { MailModule } from '../mail/mail.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    UsuariosModule,
    MailModule,
    PrismaModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const secret = configService.get<string>('JWT_SECRET');

        // Sin valor por defecto a propósito: un secreto quemado en el código queda
        // publicado en el repositorio y permite firmar tokens de cualquier usuario.
        // Es preferible que la app no arranque a que arranque sin autenticación real.
        if (!secret || secret.trim().length < 32) {
          throw new Error(
            'JWT_SECRET no está configurado o es demasiado corto (mínimo 32 caracteres). ' +
              'Defínalo en las variables de entorno antes de iniciar la aplicación.',
          );
        }

        return {
          secret,
          signOptions: {
            expiresIn: '24h',
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, SesionesService],
  exports: [AuthService, SesionesService, JwtModule],
})
export class AuthModule {}
