import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;

  constructor() {
    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const user = process.env.SMTP_USER || '';
    const pass = process.env.SMTP_PASS || '';
    const secure = process.env.SMTP_SECURE === 'true';
    const rejectUnauthorized = process.env.SMTP_REJECT_UNAUTHORIZED === 'true';

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user && pass ? { user, pass } : undefined,
      tls: {
        rejectUnauthorized,
      },
    });
  }

  /**
   * Escapa HTML antes de interpolar datos del usuario en el cuerpo del correo:
   * el nombre lo controla quien crea/edita el usuario y el correo sí renderiza HTML.
   */
  private escaparHtml(valor: string): string {
    return String(valor ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async enviarCodigoRestablecimiento(correo: string, nombre: string, codigo: string) {
    const from = process.env.SMTP_FROM || '"Aktun Kan" <noreply@aktunkan.com>';
    const nombreSeguro = this.escaparHtml(nombre);

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #0f172a; text-align: center;">Aktun Kan - Restablecimiento de Contraseña</h2>
        <p>Hola <strong>${nombreSeguro}</strong>,</p>
        <p>Hemos recibido una solicitud para restablecer la contraseña de su cuenta. Su código de verificación de 6 dígitos es:</p>
        <div style="background-color: #f1f5f9; padding: 15px; text-align: center; border-radius: 8px; font-size: 28px; font-weight: bold; letter-spacing: 5px; color: #0284c7; margin: 20px 0;">
          ${codigo}
        </div>
        <p style="font-size: 13px; color: #64748b;">Este código de verificación expira en <strong>15 minutos</strong>.</p>
        <p style="font-size: 13px; color: #64748b;">Si usted no solicitó este cambio, por favor ignore este correo.</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
        <p style="font-size: 11px; color: #94a3b8; text-align: center;">Sistema de Gestión Parque Aktun Kan</p>
      </div>
    `;

    try {
      if (process.env.SMTP_USER) {
        await this.transporter.sendMail({
          from,
          to: correo,
          subject: 'Código de verificación para restablecer contraseña - Aktun Kan',
          html: htmlContent,
        });
        this.logger.log(`Correo con código de verificación enviado exitosamente a ${correo}`);
      } else {
        this.logger.warn(`[MODO DESARROLLO / SIN SMTP CONFIGURADO] Código de verificación para ${correo}: [ ${codigo} ]`);
      }
    } catch (error) {
      this.logger.error(`Error al enviar correo a ${correo}:`, error);
      this.logger.warn(`[CÓDIGO DE RESPALDO EN CONSOLA] Código de verificación para ${correo}: [ ${codigo} ]`);
    }
  }
}
