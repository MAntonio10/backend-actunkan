import { BadRequestException } from '@nestjs/common';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  AlmacenamientoImagenesService,
  TAMANO_MAXIMO_BYTES,
} from './almacenamiento-imagenes.service';

describe('AlmacenamientoImagenesService', () => {
  let service: AlmacenamientoImagenesService;
  let carpetaTemporal: string;

  beforeEach(() => {
    carpetaTemporal = mkdtempSync(join(tmpdir(), 'qa-uploads-'));
    process.env.UPLOADS_DIR = carpetaTemporal;
    service = new AlmacenamientoImagenesService();
  });

  afterEach(() => {
    delete process.env.UPLOADS_DIR;
    rmSync(carpetaTemporal, { recursive: true, force: true });
  });

  const archivo = (extra: any = {}) => ({
    originalname: 'foto.png',
    buffer: Buffer.from('contenido-de-prueba'),
    mimetype: 'image/png',
    size: 19,
    ...extra,
  });

  it('escribe el archivo en disco y devuelve su nombre', () => {
    const nombre = service.guardar(archivo());

    expect(service.existe(nombre)).toBe(true);
    expect(readFileSync(service.rutaDe(nombre)).toString()).toBe('contenido-de-prueba');
  });

  // Usar el nombre del cliente permitiría rutas como `../../.env`.
  it('nunca conserva el nombre que envió el cliente', () => {
    const nombre = service.guardar(archivo({ originalname: '../../../.env' }));

    expect(nombre).not.toContain('..');
    expect(nombre).not.toContain('/');
    expect(nombre).not.toContain('\\');
  });

  it('genera nombres distintos para archivos con el mismo nombre original', () => {
    const a = service.guardar(archivo());
    const b = service.guardar(archivo());

    expect(a).not.toBe(b);
  });

  it('rechaza rutas que se salgan de la carpeta base', () => {
    expect(() => service.rutaDe('../../../etc/passwd')).toThrow(BadRequestException);
  });

  it('rechaza formatos que no son imagen', () => {
    expect(() => service.validar({ mimetype: 'application/pdf', size: 100 })).toThrow(
      BadRequestException,
    );
    expect(() => service.validar({ mimetype: 'text/html', size: 100 })).toThrow(
      BadRequestException,
    );
  });

  it('acepta los formatos de imagen permitidos', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(() => service.validar({ mimetype: mime, size: 100 })).not.toThrow();
    }
  });

  it('rechaza archivos que superan el máximo', () => {
    expect(() =>
      service.validar({ mimetype: 'image/png', size: TAMANO_MAXIMO_BYTES + 1 }),
    ).toThrow(BadRequestException);
  });

  it('no escribe nada si el archivo no pasa la validación', () => {
    expect(() => service.guardar(archivo({ mimetype: 'application/pdf' }))).toThrow(
      BadRequestException,
    );
    expect(existsSync(join(service.carpetaBase))).toBe(false);
  });

  it('eliminar un archivo inexistente no lanza error', () => {
    expect(() => service.eliminar('no-existe.png')).not.toThrow();
  });
});
