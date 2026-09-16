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

  /**
   * Envía al cliente el enlace para pagar sus entradas con tarjeta.
   *
   * A diferencia del código de restablecimiento, **este método sí lanza** cuando
   * el envío falla o cuando no hay SMTP configurado. Aquel puede tragarse el
   * error porque el código queda en el log y el usuario puede pedir otro; acá no:
   * el taquillero está delante del visitante y le va a decir «ya le llegó el
   * correo». Un fallo silencioso lo convierte en una mentira, y el visitante se
   * va del parque esperando un correo que nunca salió.
   */
  async enviarEnlacePago(datos: {
    correo: string;
    nombre?: string | null;
    numeroTicket: string;
    montoTotal: string;
    atraccion?: string | null;
    checkoutUrl: string;
  }): Promise<void> {
    const from = process.env.SMTP_FROM || '"Aktun Kan" <noreply@aktunkan.com>';

    if (!process.env.SMTP_USER) {
      this.logger.error(
        `No hay SMTP configurado: no se pudo enviar el enlace de pago del ticket ${datos.numeroTicket}.`,
      );
      throw new Error(
        'El envío de correos no está configurado en el servidor. Comparta el enlace por otro medio.',
      );
    }

    const nombre = this.escaparHtml(datos.nombre || 'visitante');
    const folio = this.escaparHtml(datos.numeroTicket);
    const monto = this.escaparHtml(datos.montoTotal);
    const atraccion = datos.atraccion ? this.escaparHtml(datos.atraccion) : null;
    // El enlace lo produce la pasarela y lo guarda el servidor; aun así se escapa
    // antes de meterlo en el HTML, que es donde una comilla rompería el atributo.
    const enlace = this.escaparHtml(datos.checkoutUrl);

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #14532d; text-align: center; margin-top: 0;">Parque Regional Municipal Actún Kan</h2>
        <p>Hola <strong>${nombre}</strong>,</p>
        <p>Gracias por su visita. Para completar la compra de sus entradas, realice el pago con tarjeta en el siguiente enlace seguro:</p>
        <p style="text-align: center; margin: 24px 0;">
          <a href="${enlace}" style="background-color: #2F6B3D; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">Pagar mis entradas</a>
        </p>
        <table style="width: 100%; font-size: 14px; border-collapse: collapse; margin: 16px 0;">
          <tr><td style="padding: 6px 0; color: #64748b;">Folio</td><td style="padding: 6px 0; text-align: right; font-weight: bold;">${folio}</td></tr>
          ${atraccion ? `<tr><td style="padding: 6px 0; color: #64748b;">Atracción</td><td style="padding: 6px 0; text-align: right;">${atraccion}</td></tr>` : ''}
          <tr><td style="padding: 6px 0; color: #64748b;">Total a pagar</td><td style="padding: 6px 0; text-align: right; font-weight: bold;">${monto}</td></tr>
        </table>
        <p style="font-size: 13px; color: #64748b;">Su código QR de ingreso <strong>permanecerá inactivo</strong> y será rechazado en la garita hasta que la pasarela confirme la transacción. En cuanto el pago se acredite, el pase queda válido automáticamente.</p>
        <p style="font-size: 13px; color: #64748b;">Si el botón no funciona, copie y pegue este enlace en su navegador:<br /><span style="word-break: break-all;">${enlace}</span></p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
        <p style="font-size: 11px; color: #94a3b8; text-align: center;">Este correo se envió desde la taquilla del Parque Regional Municipal Actún Kan. Si usted no solicitó estas entradas, ignórelo.</p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from,
        to: datos.correo,
        subject: `Enlace de pago de sus entradas - Actún Kan (${datos.numeroTicket})`,
        html: htmlContent,
      });
      this.logger.log(
        `Enlace de pago del ticket ${datos.numeroTicket} enviado a ${datos.correo}.`,
      );
    } catch (error: any) {
      this.logger.error(
        `Error al enviar el enlace de pago del ticket ${datos.numeroTicket} a ${datos.correo}: ${error?.message}`,
      );
      throw new Error(
        'No se pudo enviar el correo. Verifique la dirección o comparta el enlace por otro medio.',
      );
    }
  }
}
