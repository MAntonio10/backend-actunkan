import {
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CLAVES_REPORTE, REGISTRO_REPORTES } from '../definiciones';
import { GenerarReporteDto } from '../dto/generar-reporte.dto';
import {
  parametrosDeclarados,
  parametrosNoDeclarados,
} from '../parametros.util';
import { IaClienteService, MensajeIA } from './ia-cliente.service';
import { esquemaRespuesta, promptDelSistema } from './prompt';

export interface Interpretacion {
  clave: string;
  interpretacion: string;
  formato: 'pdf' | 'excel';
  filtros: GenerarReporteDto;
}

/** Vida de la caché de interpretaciones. */
const TTL_CACHE_MS = 10 * 60 * 1000;
const MAXIMO_ENTRADAS_CACHE = 200;

@Injectable()
export class InterpretacionService {
  private readonly logger = new Logger(InterpretacionService.name);

  /**
   * Caché de instrucciones ya interpretadas.
   *
   * La capa gratuita ronda las 250 peticiones al día, y dos personas pidiendo "las ventas
   * de hoy" no deberían gastar dos. Se guarda la interpretación, nunca el resultado: los
   * datos se vuelven a consultar siempre, así que una venta registrada entre medias sí
   * aparece.
   */
  private readonly cache = new Map<
    string,
    { valor: Interpretacion; expira: number }
  >();

  constructor(private readonly cliente: IaClienteService) {}

  get estaConfigurada(): boolean {
    return this.cliente.estaConfigurada;
  }

  private claveDeCache(instruccion: string): string {
    return instruccion.trim().toLocaleLowerCase('es').replace(/\s+/g, ' ');
  }

  private leerDeCache(instruccion: string): Interpretacion | null {
    const clave = this.claveDeCache(instruccion);
    const entrada = this.cache.get(clave);
    if (!entrada) return null;
    if (entrada.expira < Date.now()) {
      this.cache.delete(clave);
      return null;
    }
    return entrada.valor;
  }

  private guardarEnCache(instruccion: string, valor: Interpretacion) {
    // Tope simple para que la caché no crezca sin control en un proceso de larga vida.
    if (this.cache.size >= MAXIMO_ENTRADAS_CACHE) {
      const primera = this.cache.keys().next();
      if (!primera.done) this.cache.delete(primera.value);
    }
    this.cache.set(this.claveDeCache(instruccion), {
      valor,
      expira: Date.now() + TTL_CACHE_MS,
    });
  }

  /**
   * Quita las cercas de markdown si vinieran.
   *
   * El modo estricto de `json_schema` no está documentado en el endpoint compatible con
   * OpenAI de Gemini, y sigue en beta: hay que contar con que a veces devuelva el JSON
   * envuelto en ```json.
   */
  private limpiarJson(texto: string): string {
    const limpio = texto.trim();
    const cerca = limpio.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return (cerca ? cerca[1] : limpio).trim();
  }

  /**
   * Valida la respuesta cruda.
   *
   * Se usa `GenerarReporteDto`, **el mismo DTO que valida la ruta manual**. Si aquí se
   * validara con otra cosa, una petición en lenguaje natural podría colar un filtro que la
   * ruta normal rechaza.
   */
  private async validar(crudo: string): Promise<Interpretacion> {
    let objeto: any;
    try {
      objeto = JSON.parse(this.limpiarJson(crudo));
    } catch {
      throw new Error('la respuesta no es JSON válido');
    }

    if (
      typeof objeto?.clave !== 'string' ||
      !REGISTRO_REPORTES.has(objeto.clave)
    ) {
      throw new Error(
        `'${objeto?.clave}' no es un reporte del catálogo. Válidos: ${CLAVES_REPORTE.join(', ')}`,
      );
    }

    const definicion = REGISTRO_REPORTES.get(objeto.clave)!;

    const dto = plainToInstance(GenerarReporteDto, objeto.filtros ?? {}, {
      excludeExtraneousValues: false,
    });

    const errores = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
      skipMissingProperties: true,
    });

    if (errores.length > 0) {
      const detalle = errores
        .map((error) => Object.values(error.constraints ?? {}).join('; '))
        .join(' | ');
      throw new Error(`los filtros no son válidos: ${detalle}`);
    }

    // Un filtro que ese reporte no declara se rechazaría al ejecutarlo. Se
    // comprueba aquí para que el error entre en el bucle de corrección y el
    // modelo lo arregle solo, en vez de llegarle al usuario como un 400.
    const sobrantes = parametrosNoDeclarados(definicion, dto);
    if (sobrantes.length > 0) {
      throw new Error(
        `el reporte '${objeto.clave}' no acepta ${sobrantes.join(', ')}; ` +
          `solo acepta ${[...parametrosDeclarados(definicion)].join(', ')}`,
      );
    }

    return {
      clave: objeto.clave,
      interpretacion:
        typeof objeto.interpretacion === 'string' &&
        objeto.interpretacion.trim()
          ? objeto.interpretacion.trim()
          : `Reporte '${REGISTRO_REPORTES.get(objeto.clave)!.titulo}'.`,
      // Cualquier cosa que no sea explícitamente 'excel' se trata como PDF: el
      // predeterminado tiene que ser el formato imprimible.
      formato: objeto.formato === 'excel' ? 'excel' : 'pdf',
      filtros: dto,
    };
  }

  /**
   * Traduce una instrucción en lenguaje natural a una clave de reporte y unos filtros.
   *
   * Es lo único de todo el módulo que sale a internet, y solo hace eso: elegir qué reporte
   * ejecutar. Las cifras las produce después la misma definición determinista que usa la
   * ruta predeterminada.
   */
  async interpretar(instruccion: string): Promise<Interpretacion> {
    const enCache = this.leerDeCache(instruccion);
    if (enCache) {
      this.logger.log(
        'Instrucción resuelta desde la caché; no se consumió cuota de IA.',
      );
      return enCache;
    }

    const mensajes: MensajeIA[] = [
      { role: 'system', content: promptDelSistema() },
      { role: 'user', content: instruccion },
    ];

    const esquema = esquemaRespuesta();
    let ultimoError = '';

    // Dos intentos: el segundo lleva el error del primero como corrección. Más reintentos
    // solo gastarían cuota; a partir de ahí es mejor devolver el control al usuario.
    for (let intento = 1; intento <= 2; intento++) {
      const crudo = await this.cliente.completarJson(mensajes, esquema);

      try {
        const interpretacion = await this.validar(crudo);
        this.guardarEnCache(instruccion, interpretacion);
        return interpretacion;
      } catch (error: any) {
        ultimoError = error.message;
        this.logger.warn(
          `Interpretación inválida en el intento ${intento}: ${ultimoError}`,
        );

        if (intento === 1) {
          mensajes.push({ role: 'assistant', content: crudo });
          mensajes.push({
            role: 'user',
            content:
              `Esa respuesta no sirve porque ${ultimoError}. Corrígela y responde otra vez ` +
              'solo con el objeto JSON, respetando el esquema.',
          });
        }
      }
    }

    // Nunca un 500: el usuario tiene que poder seguir trabajando eligiendo el reporte a mano.
    throw new UnprocessableEntityException(
      'No se pudo interpretar la petición. Reformúlela indicando qué información necesita y ' +
        `de qué período, o elija uno de los reportes disponibles: ${CLAVES_REPORTE.join(', ')}.`,
    );
  }
}
