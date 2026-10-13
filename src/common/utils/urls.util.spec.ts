import {
  origenesCors,
  problemasDeDespliegue,
  urlApi,
  urlAplicacion,
  urlCancelado,
  urlExito,
  urlWebhook,
} from './urls.util';

/**
 * Lo que se fija acá es el contrato del despliegue.
 *
 * Importa porque los fallos de este archivo son silenciosos: un link de pago que
 * vuelve a `localhost` se cobra igual, el visitante paga de verdad y el pase nunca
 * se confirma. No hay excepción, ni log de error, ni test que se ponga rojo si esto
 * no lo cubre.
 */
describe('urls.util', () => {
  const ENTORNO = { ...process.env };

  beforeEach(() => {
    for (const clave of [
      'APP_URL',
      'API_URL',
      'CORS_ORIGINS',
      'RECURRENTE_SUCCESS_URL',
      'RECURRENTE_CANCEL_URL',
      'RECURRENTE_WEBHOOK_SECRET',
      'TRUST_PROXY',
      'NODE_ENV',
      'PORT',
    ]) {
      delete process.env[clave];
    }
  });

  afterAll(() => {
    process.env = ENTORNO;
  });

  describe('derivación desde APP_URL', () => {
    it('arma las URL de retorno a partir de una sola variable', () => {
      process.env.APP_URL = 'https://app.midominio.com';

      expect(urlExito()).toBe('https://app.midominio.com/pago/exito');
      expect(urlCancelado()).toBe('https://app.midominio.com/pago/cancelado');
    });

    it('tolera la barra final, que es el error de copiado típico', () => {
      process.env.APP_URL = 'https://app.midominio.com/';

      expect(urlExito()).toBe('https://app.midominio.com/pago/exito');
    });

    it('permite sobrescribir una ruta concreta sin tocar las demás', () => {
      process.env.APP_URL = 'https://app.midominio.com';
      process.env.RECURRENTE_SUCCESS_URL = 'https://otro.com/gracias';

      expect(urlExito()).toBe('https://otro.com/gracias');
      expect(urlCancelado()).toBe('https://app.midominio.com/pago/cancelado');
    });

    it('arma la URL del webhook desde API_URL', () => {
      process.env.API_URL = 'https://api.midominio.com';

      expect(urlWebhook()).toBe('https://api.midominio.com/webhooks/recurrente');
    });
  });

  describe('valores por omisión', () => {
    it('en desarrollo cae a localhost, que es donde corre el front', () => {
      expect(urlAplicacion()).toBe('http://localhost:3000');
      expect(urlApi()).toBe('http://localhost:4000');
    });

    /**
     * En producción NO se inventa un valor. Un `localhost` por omisión es peor que
     * la ausencia: parece funcionar y manda al visitante a su propia máquina.
     */
    it('en producción no inventa ninguna dirección', () => {
      process.env.NODE_ENV = 'production';

      expect(urlAplicacion()).toBe('');
      expect(urlApi()).toBe('');
    });
  });

  describe('CORS', () => {
    it('una lista explícita manda sobre APP_URL', () => {
      process.env.APP_URL = 'https://app.midominio.com';
      process.env.CORS_ORIGINS =
        'https://app.midominio.com, https://admin.midominio.com/';

      expect(origenesCors()).toEqual([
        'https://app.midominio.com',
        'https://admin.midominio.com',
      ]);
    });

    it('sin lista, basta APP_URL', () => {
      process.env.APP_URL = 'https://app.midominio.com';

      expect(origenesCors()).toEqual(['https://app.midominio.com']);
    });

    // `null` significa «abrir a cualquier origen», y quien llama decide si lo acepta.
    it('sin ninguna de las dos, queda abierto', () => {
      expect(origenesCors()).toBeNull();
    });
  });

  describe('problemasDeDespliegue', () => {
    const configuracionCompleta = () => {
      process.env.NODE_ENV = 'production';
      process.env.APP_URL = 'https://app.midominio.com';
      process.env.API_URL = 'https://api.midominio.com';
      process.env.TRUST_PROXY = 'true';
      process.env.RECURRENTE_WEBHOOK_SECRET = 'whsec_loQueSea';
    };

    it('no reporta nada cuando todo está puesto', () => {
      configuracionCompleta();

      expect(problemasDeDespliegue()).toEqual([]);
    });

    it.each([
      ['APP_URL', 'APP_URL'],
      ['API_URL', 'API_URL'],
      ['TRUST_PROXY', 'TRUST_PROXY'],
      ['RECURRENTE_WEBHOOK_SECRET', 'RECURRENTE_WEBHOOK_SECRET'],
    ])('señala la falta de %s', (_caso, clave) => {
      configuracionCompleta();
      delete process.env[clave];

      expect(problemasDeDespliegue().join(' ')).toContain(clave);
    });

    it('señala http:// donde debería haber https://', () => {
      configuracionCompleta();
      process.env.APP_URL = 'http://app.midominio.com';

      expect(problemasDeDespliegue().join(' ')).toContain('http://');
    });

    it('señala una URL que quedó apuntando a localhost', () => {
      configuracionCompleta();
      process.env.APP_URL = 'https://app.midominio.com';
      process.env.RECURRENTE_SUCCESS_URL = 'http://localhost:3000/pago/exito';

      expect(problemasDeDespliegue().join(' ')).toContain('localhost');
    });
  });
});
