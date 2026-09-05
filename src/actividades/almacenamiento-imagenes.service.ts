import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { extname, join, resolve } from 'path';

/**
 * Guarda las imágenes en disco y deja en la base solo la ruta.
 *
 * Meter binarios en la base la haría crecer sin control y penalizaría cada consulta
 * que tocara la tabla: los backups se vuelven enormes y el motor pagina datos que
 * casi nunca se leen. Con archivos en disco, la fila pesa unos cientos de bytes.
 */
export const MIMES_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const TAMANO_MAXIMO_BYTES = 5 * 1024 * 1024;

@Injectable()
export class AlmacenamientoImagenesService {
  private readonly logger = new Logger(AlmacenamientoImagenesService.name);

  get carpetaBase(): string {
    return resolve(process.env.UPLOADS_DIR || join(process.cwd(), 'uploads'), 'actividades');
  }

  private asegurarCarpeta() {
    if (!existsSync(this.carpetaBase)) {
      mkdirSync(this.carpetaBase, { recursive: true });
    }
  }

  /**
   * El nombre lo genera el servidor. Usar el del cliente permitiría rutas como
   * `../../.env` y sobrescribir archivos ajenos.
   */
  private generarNombre(nombreOriginal: string): string {
    const ext = extname(nombreOriginal).toLowerCase().slice(0, 10).replace(/[^.a-z0-9]/g, '');
    return `${Date.now()}-${randomBytes(8).toString('hex')}${ext || '.img'}`;
  }

  validar(archivo: { mimetype: string; size: number }) {
    if (!MIMES_PERMITIDOS.includes(archivo.mimetype)) {
      throw new BadRequestException(
        `Formato no permitido. Solo se aceptan: ${MIMES_PERMITIDOS.join(', ')}.`,
      );
    }

    if (archivo.size > TAMANO_MAXIMO_BYTES) {
      throw new BadRequestException(
        `La imagen supera el máximo de ${TAMANO_MAXIMO_BYTES / 1024 / 1024} MB.`,
      );
    }
  }

  /** Devuelve el nombre con el que quedó guardado el archivo. */
  guardar(archivo: { originalname: string; buffer: Buffer; mimetype: string; size: number }): string {
    this.validar(archivo);
    this.asegurarCarpeta();

    const nombre = this.generarNombre(archivo.originalname);
    writeFileSync(join(this.carpetaBase, nombre), archivo.buffer);

    return nombre;
  }

  /**
   * Resuelve la ruta absoluta comprobando que quede dentro de la carpeta base.
   * Sin esta verificación, un nombre manipulado podría leer cualquier archivo del servidor.
   */
  rutaDe(nombreArchivo: string): string {
    const ruta = resolve(this.carpetaBase, nombreArchivo);

    if (!ruta.startsWith(this.carpetaBase)) {
      throw new BadRequestException('Nombre de archivo inválido.');
    }

    return ruta;
  }

  existe(nombreArchivo: string): boolean {
    return existsSync(this.rutaDe(nombreArchivo));
  }

  /** Borrar el archivo no debe tumbar la operación: la fila ya se eliminó. */
  eliminar(nombreArchivo: string) {
    try {
      const ruta = this.rutaDe(nombreArchivo);
      if (existsSync(ruta)) unlinkSync(ruta);
    } catch (error: any) {
      this.logger.warn(`No se pudo borrar la imagen '${nombreArchivo}': ${error.message}`);
    }
  }
}
