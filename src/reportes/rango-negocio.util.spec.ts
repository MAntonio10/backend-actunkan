import { BadRequestException } from '@nestjs/common';
import {
  MAXIMO_DIAS_RANGO,
  describirPeriodo,
  finDelDiaNegocio,
  inicioDelDiaNegocio,
  rangoNegocio,
} from './rango-negocio.util';

describe('rango-negocio.util', () => {
  const tzOriginal = process.env.TZ;

  afterEach(() => {
    process.env.TZ = tzOriginal;
  });

  describe('inicioDelDiaNegocio', () => {
    it('devuelve la medianoche UTC del día pedido', () => {
      expect(inicioDelDiaNegocio('2026-08-01').toISOString()).toBe(
        '2026-08-01T00:00:00.000Z',
      );
    });

    /**
     * Es la razón de ser de este archivo.
     *
     * `new Date(2026, 7, 1)` usa la zona del proceso: en el servidor (UTC) da un valor y
     * en la máquina de quien desarrolla (UTC-6) da otro seis horas distinto. Los reportes
     * pasarían las pruebas en un sitio y darían cifras corridas en el otro.
     */
    it('no depende de la zona horaria del proceso', () => {
      process.env.TZ = 'UTC';
      const enUtc = inicioDelDiaNegocio('2026-08-01').toISOString();

      process.env.TZ = 'America/Guatemala';
      const enGuatemala = inicioDelDiaNegocio('2026-08-01').toISOString();

      expect(enGuatemala).toBe(enUtc);
    });

    it('rechaza un formato que no sea AAAA-MM-DD', () => {
      expect(() => inicioDelDiaNegocio('01/08/2026')).toThrow(
        BadRequestException,
      );
      expect(() => inicioDelDiaNegocio('2026-8-1')).toThrow(
        BadRequestException,
      );
    });

    it('rechaza una fecha que no existe en el calendario', () => {
      expect(() => inicioDelDiaNegocio('2026-02-31')).toThrow(
        BadRequestException,
      );
    });
  });

  describe('finDelDiaNegocio', () => {
    /**
     * El borde superior es exclusivo. Con `lte: 23:59:59.999` se pierden las ventas del
     * último instante del día: `DateTime2` guarda fracciones más finas que el milisegundo.
     */
    it('es la medianoche del día siguiente, no las 23:59:59.999', () => {
      expect(finDelDiaNegocio('2026-08-31').toISOString()).toBe(
        '2026-09-01T00:00:00.000Z',
      );
    });

    it('cruza bien el cambio de año', () => {
      expect(finDelDiaNegocio('2026-12-31').toISOString()).toBe(
        '2027-01-01T00:00:00.000Z',
      );
    });
  });

  describe('rangoNegocio', () => {
    it('cubre el mes completo con el último día incluido', () => {
      const { desde, hasta } = rangoNegocio('2026-08-01', '2026-08-31');
      expect(desde.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      expect(hasta.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });

    it('admite un rango de un solo día', () => {
      const { desde, hasta } = rangoNegocio('2026-08-15', '2026-08-15');
      expect(hasta.getTime() - desde.getTime()).toBe(86_400_000);
    });

    it('rechaza un rango invertido', () => {
      expect(() => rangoNegocio('2026-08-31', '2026-08-01')).toThrow(
        BadRequestException,
      );
    });

    it('rechaza un rango más largo que el máximo permitido', () => {
      expect(() => rangoNegocio('2020-01-01', '2026-01-01')).toThrow(
        new RegExp(String(MAXIMO_DIAS_RANGO)),
      );
    });
  });

  describe('describirPeriodo', () => {
    it('describe un solo día', () => {
      expect(describirPeriodo('2026-08-15', '2026-08-15')).toBe(
        '15 de agosto de 2026',
      );
    });

    it('describe un rango dentro del mismo mes', () => {
      expect(describirPeriodo('2026-08-01', '2026-08-31')).toBe(
        '1 al 31 de agosto de 2026',
      );
    });

    it('describe un rango entre meses del mismo año', () => {
      expect(describirPeriodo('2026-08-01', '2026-09-15')).toBe(
        '1 de agosto al 15 de septiembre de 2026',
      );
    });

    it('describe un rango entre años', () => {
      expect(describirPeriodo('2026-12-15', '2027-01-10')).toBe(
        '15 de diciembre de 2026 al 10 de enero de 2027',
      );
    });
  });
});
