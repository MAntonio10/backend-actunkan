import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService, ESTADO_ABIERTA } from '../cajas/cajas.service';
import { EjecutorInfo } from '../common/utils/ejecutor.util';
import {
  aInstanteReal,
  anioDeNegocio,
  enHoraDeNegocio,
  getFechaUTC6,
} from '../common/utils/date.util';
import { generarCorrelativo } from '../common/utils/correlativo.util';
import {
  construirPayloadQr,
  firmarNumeroTicket,
  verificarFirmaDispositivo,
} from '../common/utils/qr.util';
import { resolverTarifaGuiaEn } from '../tarifas/resolver-tarifa.util';
import { ESTADO_PAGO_PAGADO } from '../pagos/pagos.service';
import {
  TicketsService,
  TIPO_TICKET_GUIA,
  TIPO_TICKET_VISITANTE,
} from './tickets.service';
import { conciliarLotesVencidos } from './conciliar-vencidos.util';
import { ConciliarLoteDto, CrearLoteOfflineDto } from './dto/lote-offline.dto';
import { EmitirOfflineDto, VentaOfflineDto } from './dto/emitir-offline.dto';
import { DeclararDescartesDto } from './dto/descartar-offline.dto';

export const LOTE_ACTIVO = 'ACTIVO';
export const LOTE_CONCILIADO = 'CONCILIADO';
export const LOTE_INVALIDADO = 'INVALIDADO';

export const FOLIO_RESERVADO = 'RESERVADO';
export const FOLIO_EMITIDO = 'EMITIDO';
export const FOLIO_NO_UTILIZADO = 'NO_UTILIZADO';
export const FOLIO_INVALIDADO = 'INVALIDADO';

/** Hora a la que vence la jornada operativa; configurable. */
const HORA_EXPIRACION = Number(process.env.OFFLINE_EXPIRA_HORA ?? 6);

const MODULO_BITACORA = 'Tickets';

/**
 * Venta de tickets sin conexión.
 *
 * El visitante recibe un pase con QR válido desde el momento de la venta; al
 * reconectar, la cola sube y cada pase se convierte en un ticket real.
 *
 * DOS MODOS, Y EL VIGENTE ES EL SEGUNDO
 * -------------------------------------
 *  - **Por lote:** el servidor entrega folios pre-firmados mientras hay red y el
 *    equipo los consume sin ella. Implementado y funcionando, pero ya no es el
 *    camino que usa la taquilla.
 *  - **Por dispositivo (vigente):** la taquilla registra su llave pública una vez
 *    con red y después firma sus propios pases, sin reservar nada por adelantado.
 *
 * Lo que comparten —la cola, la idempotencia por `idLocal`, el resultado por ítem,
 * el acotado de la fecha declarada, solo efectivo— vive en `procesarVenta`, que no
 * se entera de cuál modo está en curso. Lo que cambia lo encapsula el contexto:
 * de dónde sale el folio, qué lo respalda y cuál es el piso de la fecha.
 *
 * El contrato vivo es `DOCUMENTACION_ENDPOINTS.md` §18. `ESPECIFICACION_OFFLINE.md`
 * describe el modelo por lote y lleva un aviso al frente diciéndolo: sirve para la
 * semántica de la cola, es historia para todo lo que diga de reservar folios.
 */
@Injectable()
export class OfflineService {
  private readonly logger = new Logger(OfflineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cajasService: CajasService,
    private readonly ticketsService: TicketsService,
  ) {}

  private async obtenerNombreEjecutor(tx: any, ejecutor?: EjecutorInfo) {
    let nombreEjecutor = ejecutor?.email;
    if (ejecutor?.id) {
      const uEj = await tx.usuario.findUnique({ where: { id: ejecutor.id } });
      if (uEj) nombreEjecutor = uEj.nombre;
    }
    return nombreEjecutor;
  }

  /**
   * Fin de la jornada: las 06:00 del día siguiente **en Guatemala**.
   *
   * Antes usaba `setHours`, que fija la hora del reloj del proceso: con el servidor
   * en UTC eso era medianoche en la taquilla y el lote vencía seis horas antes de lo
   * previsto, en plena madrugada de trabajo.
   */
  private calcularExpiracion(desde: Date): Date {
    return enHoraDeNegocio(HORA_EXPIRACION, 1, desde);
  }

  private folioConQr(folio: any) {
    return {
      numeroTicket: folio.numeroTicket,
      firma: folio.firma,
      // Lo arma el servidor con la misma función que la emisión online: si el
      // frontend reprodujera el formato, un cambio futuro rompería los pases
      // offline y el problema aparecería recién en la puerta de la cueva.
      qr: construirPayloadQr(folio.numeroTicket, folio.firma),
    };
  }

  private formatearLote(lote: any) {
    const folios = (lote.folios ?? []).filter(
      (f: any) => f.estado === FOLIO_RESERVADO,
    );

    return {
      idLote: lote.id,
      idAperturaCaja: lote.idAperturaCaja,
      idUsuario: lote.idUsuario,
      idDispositivo: lote.idDispositivo,
      estado: lote.estado,
      fechaCreacion: lote.fechaCreacion,
      expiraEn: lote.expiraEn,
      fechaConciliacion: lote.fechaConciliacion,
      expirado: lote.expiraEn <= getFechaUTC6(),
      folios: folios.map((f: any) => this.folioConQr(f)),
    };
  }

  // -------------------------------------------------------------------------
  // 1. Reservar folios
  // -------------------------------------------------------------------------

  async reservar(dto: CrearLoteOfflineDto, ejecutor?: EjecutorInfo) {
    if (!ejecutor?.id) {
      throw new BadRequestException(
        'No se pudo determinar el usuario que reserva los folios.',
      );
    }

    const cajaActual = await this.cajasService.obtenerActual();
    if (!cajaActual) {
      throw new BadRequestException(
        'No hay una caja abierta para reservar folios. Abra la caja antes de vender.',
      );
    }

    return this.prisma.$transaction(
      async (tx) => {
        const caja = await tx.aperturaCaja.findUnique({
          where: { id: cajaActual.id },
          include: { estado: true },
        });

        if (!caja || caja.anulado || caja.estado.nombre !== 'Abierta') {
          throw new BadRequestException(
            'No hay una caja abierta para reservar folios. Abra la caja antes de vender.',
          );
        }

        // Una taquilla que ya tiene llave firma sus propios pases: no tiene por qué
        // reservar folios. Y reservarlos no sería inocuo — un lote vigente bloquea el
        // cierre de su caja, así que un equipo con un build viejo dejaría al
        // taquillero con una caja que no cierra por folios que nadie va a usar.
        const taquillaRegistrada = await tx.dispositivoTaquilla.findUnique({
          where: { idDispositivo: dto.idDispositivo },
          select: { serie: true, revocado: true },
        });

        if (taquillaRegistrada && !taquillaRegistrada.revocado) {
          throw new ConflictException({
            codigo: 'DISPOSITIVO_YA_FIRMA',
            serie: taquillaRegistrada.serie,
            message:
              `La taquilla ${taquillaRegistrada.serie} emite con su propia firma y no necesita ` +
              'folios reservados. Actualice la aplicación del dispositivo si sigue pidiéndolos.',
          });
        }

        const ahora = getFechaUTC6();

        // Los lotes vencidos de este dispositivo se cierran solos al reservar el
        // del día siguiente. Si no, quedarían en ACTIVO para siempre y bloquearían
        // el cierre de su caja: el frontend no puede conciliarlos porque su lote
        // "actual" ya es otro, y el viejo puede ni estar en el dispositivo.
        const vencidos = await tx.loteOffline.findMany({
          where: {
            idDispositivo: dto.idDispositivo,
            estado: LOTE_ACTIVO,
            expiraEn: { lte: ahora },
          },
        });

        if (vencidos.length > 0) {
          await conciliarLotesVencidos(tx, vencidos, {
            idUsuario: ejecutor.id,
            usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
            motivo: `reserva de un lote nuevo para el dispositivo ${dto.idDispositivo}`,
          });
        }

        const activo = await tx.loteOffline.findFirst({
          where: {
            idDispositivo: dto.idDispositivo,
            estado: LOTE_ACTIVO,
            expiraEn: { gt: ahora },
          },
        });

        if (activo) {
          throw new ConflictException({
            codigo: 'LOTE_ACTIVO_EXISTENTE',
            idLote: activo.id,
            message:
              `El dispositivo ya tiene el lote ${activo.id} activo. ` +
              'Concílielo antes de reservar otro, o recupérelo con GET /tickets/lotes-offline/activo.',
          });
        }

        const lote = await tx.loteOffline.create({
          data: {
            idUsuario: ejecutor.id,
            idAperturaCaja: caja.id,
            idDispositivo: dto.idDispositivo,
            estado: LOTE_ACTIVO,
            fechaCreacion: ahora,
            expiraEn: this.calcularExpiracion(ahora),
          },
        });

        const anio = anioDeNegocio();
        const folios: any[] = [];

        for (let i = 0; i < dto.cantidad; i++) {
          // El mismo contador que usa la emisión online: es lo que garantiza que
          // un folio reservado nunca choque con una venta hecha mientras tanto.
          const numeroTicket = await generarCorrelativo(
            tx,
            process.env.TICKET_SERIE || 'TCK',
            anio,
          );

          folios.push(
            await tx.folioReservado.create({
              data: {
                idLote: lote.id,
                numeroTicket,
                firma: firmarNumeroTicket(numeroTicket),
                estado: FOLIO_RESERVADO,
              },
            }),
          );
        }

        await BitacoraService.registrarEnTransaccion(tx, {
          idUsuario: ejecutor.id,
          usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
          accion: 'RESERVAR_FOLIOS_OFFLINE',
          modulo: MODULO_BITACORA,
          descripcion:
            `Se reservaron ${folios.length} folios (${folios[0].numeroTicket} a ` +
            `${folios[folios.length - 1].numeroTicket}) en el lote ${lote.id} ` +
            `para el dispositivo ${dto.idDispositivo}, caja ${caja.id}.`,
        });

        return this.formatearLote({ ...lote, folios });
      },
      // Serializable: el correlativo depende de que dos reservas concurrentes
      // no lean el mismo último número.
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 30000,
      },
    );
  }

  // -------------------------------------------------------------------------
  // 2. Recuperar el lote activo
  // -------------------------------------------------------------------------

  /**
   * Para cuando se reinstala la aplicación o se borra el almacenamiento local.
   * Exige que coincidan usuario y dispositivo: vuelve a exponer folios
   * pre-firmados, y no debe poder usarse desde otra sesión para extraerlos.
   */
  async obtenerActivo(idDispositivo: string, ejecutor?: EjecutorInfo) {
    if (!ejecutor?.id) {
      throw new BadRequestException('No se pudo determinar el usuario.');
    }

    const lote = await this.prisma.loteOffline.findFirst({
      where: {
        idDispositivo,
        idUsuario: ejecutor.id,
        estado: LOTE_ACTIVO,
      },
      include: { folios: { orderBy: { id: 'asc' } } },
      orderBy: { id: 'desc' },
    });

    if (!lote) {
      return { hayLoteActivo: false, lote: null };
    }

    return { hayLoteActivo: true, lote: this.formatearLote(lote) };
  }

  // -------------------------------------------------------------------------
  // 3. Subir la cola de ventas
  // -------------------------------------------------------------------------

  async emitirOffline(dto: EmitirOfflineDto, ejecutor?: EjecutorInfo) {
    if (!ejecutor?.id) {
      throw new BadRequestException(
        'No se pudo determinar el usuario que sube la recaudación.',
      );
    }

    if (Boolean(dto.idLote) === Boolean(dto.dispositivo)) {
      throw new BadRequestException(
        'Envíe exactamente uno: `dispositivo` (pases firmados por la taquilla) o `idLote` (folios reservados).',
      );
    }

    const contexto = dto.dispositivo
      ? await this.contextoPorDispositivo(dto, ejecutor)
      : await this.contextoPorLote(dto.idLote!, ejecutor);

    const resultados: any[] = [];

    // Cada venta en su propia transacción: una con datos malos no debe abortar
    // las otras 49, que corresponden a dinero ya cobrado.
    for (const venta of dto.ventas) {
      try {
        resultados.push(await this.procesarVenta(contexto, venta, ejecutor));
      } catch (error: any) {
        resultados.push({
          idLocal: venta.idLocal,
          estado: 'RECHAZADO',
          ...this.clasificarFallo(error, 'CATALOGO_INVALIDO'),
        });
      }
    }

    return {
      procesadas: resultados.filter((r) => r.estado === 'CREADO').length,
      resultados,
    };
  }

  /**
   * Lo que `procesarVenta` necesita saber, venga de un lote o de un dispositivo.
   *
   * La lógica de dinero —tarifa a la fecha, discrepancia, caja, guía— es idéntica en
   * los dos modos y no debe enterarse de cuál está en curso. Lo único que cambia es
   * de dónde sale el folio y qué lo respalda, y eso vive detrás de `tomarFolio`.
   */
  private async contextoPorLote(idLote: number, ejecutor: EjecutorInfo) {
    const lote = await this.prisma.loteOffline.findUnique({
      where: { id: idLote },
    });

    if (!lote) {
      throw new NotFoundException(
        `No se encontró el lote offline con el ID ${idLote}.`,
      );
    }

    if (lote.idUsuario !== ejecutor.id) {
      throw new BadRequestException('El lote pertenece a otro usuario.');
    }

    return {
      etiqueta: `lote ${lote.id}`,
      idAperturaCaja: lote.idAperturaCaja,
      idLote: lote.id,
      idDispositivoTaquilla: null as number | null,
      invalidado: lote.estado === LOTE_INVALIDADO,
      motivoInvalidado: `El lote ${lote.id} fue invalidado; sus folios ya no pueden emitirse.`,
      // Convertido a instante: se compara contra la fecha que declara el
      // dispositivo, que es un instante real. Sin esto el piso queda 6 h antes.
      fechaMinima: aInstanteReal(new Date(lote.fechaCreacion)),
      tomarFolio: (tx: any, numeroTicket: string) =>
        this.tomarFolio(tx, lote, numeroTicket),
      // El folio reservado pasa a EMITIDO y queda apuntando a su ticket: es lo que
      // impide que el mismo folio respalde dos cobros.
      sellarFolio: (tx: any, folio: any, idTicket: number) =>
        this.marcarEmitido(tx, folio.id, idTicket),
    };
  }

  /**
   * Modo por dispositivo: no hay folio reservado, la firma de la taquilla es el
   * respaldo del pase.
   *
   * Se exige que la caja siga ABIERTA. Al no haber lote, el servidor perdió la señal
   * que hoy impide cerrar una caja con cobros sin subir, así que este es el punto
   * donde se protege el arqueo: una venta que llega tarde se rechaza con un código
   * propio y alguien la resuelve a la vista, en vez de colarse a un arqueo congelado.
   */
  private async contextoPorDispositivo(
    dto: EmitirOfflineDto,
    ejecutor: EjecutorInfo,
  ) {
    const taquilla = await this.prisma.dispositivoTaquilla.findUnique({
      where: { idDispositivo: dto.dispositivo! },
    });

    if (!taquilla) {
      throw new NotFoundException(
        `No hay ninguna taquilla registrada como '${dto.dispositivo}'.`,
      );
    }

    if (taquilla.revocado) {
      throw new BadRequestException(
        'Esta taquilla fue dada de baja. Sus pases pendientes los debe resolver un supervisor.',
      );
    }

    if (!dto.idAperturaCaja) {
      throw new BadRequestException(
        'Falta `idAperturaCaja`: la recaudación sin conexión tiene que entrar a una caja concreta.',
      );
    }

    const apertura = await this.prisma.aperturaCaja.findUnique({
      where: { id: dto.idAperturaCaja },
      include: { estado: true },
    });

    if (!apertura || apertura.anulado) {
      throw new NotFoundException(
        `No se encontró la apertura de caja ${dto.idAperturaCaja}.`,
      );
    }

    if (apertura.estado?.nombre !== ESTADO_ABIERTA) {
      const error: any = new ConflictException({
        codigo: 'CAJA_YA_CERRADA',
        idAperturaCaja: apertura.id,
        message:
          `La caja ${apertura.id} ya se cerró y su arqueo está congelado. ` +
          'Un supervisor tiene que registrar esta recaudación como ajuste posterior al cierre.',
      });
      throw error;
    }

    return {
      etiqueta: `taquilla ${taquilla.serie}`,
      idAperturaCaja: apertura.id,
      idLote: null as number | null,
      idDispositivoTaquilla: taquilla.id,
      invalidado: false,
      motivoInvalidado: '',
      /**
       * El piso es la APERTURA DE LA CAJA, no el alta de la taquilla.
       *
       * El reloj lo pone el dispositivo, así que la fecha es tan confiable como el
       * equipo. Con el alta como piso, una taquilla registrada hace meses podía
       * declarar una venta de cualquier día de ese rango — y la tarifa se resuelve a
       * la fecha declarada. Si los precios subieron, retrodatar abarata el esperado,
       * y entonces un monto menor al real deja de contar como discrepancia: la
       * diferencia se la queda quien cobró y el sistema no ve nada raro.
       *
       * Acotar al turno lo cierra: la venta entra a ESTA caja, así que no puede ser
       * anterior a que se abriera. Es lo que hacía el modelo de lotes, donde el piso
       * era la creación del lote, del mismo día.
       */
      fechaMinima: aInstanteReal(new Date(apertura.fechaCreacion)),
      tomarFolio: (tx: any, numeroTicket: string, firma?: string) =>
        this.tomarFolioFirmado(tx, taquilla, numeroTicket, firma),
      /**
       * Acá no hay nada que sellar, y por eso esto existe.
       *
       * En este modo no se reserva folio: el respaldo del pase es la firma de la
       * taquilla, así que no hay fila `FolioReservado` que marcar. El sellado tiene
       * que ser parte del contexto —como `tomarFolio`— porque si no, el camino común
       * llama a `marcarEmitido` con el `id: null` que devuelve `tomarFolioFirmado` y
       * SQL Server rechaza la venta entera. Lo que evita el folio repetido acá es el
       * `@unique` de `numeroTicket`, comprobado antes de crear el ticket.
       */
      sellarFolio: async () => undefined,
    };
  }

  /**
   * Verifica un folio que trae el propio dispositivo.
   *
   * Sustituye a la reserva previa: como no hay `FolioReservado` que consultar, lo
   * que prueba que el pase es legítimo es la firma, que solo puede haber hecho la
   * llave privada de esa taquilla. La unicidad la sigue garantizando el `@unique`
   * de `numeroTicket`, y la serie evita que un equipo numere en la de otro.
   */
  private async tomarFolioFirmado(
    tx: any,
    taquilla: any,
    numeroTicket: string,
    firma?: string,
  ) {
    const correlativo = this.validarFormatoFolio(numeroTicket, taquilla.serie);

    if (
      !verificarFirmaDispositivo(numeroTicket, firma, taquilla.llavePublica)
    ) {
      throw this.rechazo(
        'FIRMA_INVALIDA',
        `La firma del folio ${numeroTicket} no corresponde a esta taquilla.`,
      );
    }

    // Mismo dinero cobrado dos veces con el mismo folio: hay que revisarlo a mano,
    // igual que en el modo por lote.
    const yaExiste = await tx.ticket.findUnique({ where: { numeroTicket } });
    if (yaExiste) {
      throw this.rechazo(
        'FOLIO_YA_EMITIDO',
        `El folio ${numeroTicket} ya respalda otra recaudación (ticket ${yaExiste.id}).`,
      );
    }

    // Se deja constancia del correlativo más alto que llegó de esta taquilla. Es lo
    // que permite notar después un salto —folios emitidos que nunca se subieron— y
    // lo que el dispositivo consulta para saber por dónde seguir numerando si
    // reinstala la aplicación. Va dentro de la misma transacción que el ticket: si
    // la venta se cae, el contador no queda adelantado sobre un folio inexistente.
    // `foliosRendidos` sube SIEMPRE; `ultimoCorrelativo` solo cuando el folio es más
    // alto que lo visto. La resta entre ambos es lo que delata un cobro desviado: el
    // folio se emitió —y por eso cuenta en el máximo— pero nadie respondió por él.
    await tx.dispositivoTaquilla.update({
      where: { id: taquilla.id },
      data: {
        foliosRendidos: { increment: 1 },
        ultimoUso: getFechaUTC6(),
        ...(correlativo > (taquilla.ultimoCorrelativo ?? 0)
          ? { ultimoCorrelativo: correlativo }
          : {}),
      },
    });

    if (correlativo > (taquilla.ultimoCorrelativo ?? 0)) {
      taquilla.ultimoCorrelativo = correlativo;
    }

    return { id: null, numeroTicket, firma: firma! };
  }

  /**
   * Comprueba que el folio tenga la forma exacta y devuelve su correlativo.
   *
   * No alcanza con mirar que contenga la serie. El dispositivo numera solo, con su
   * propio reloj, así que una tablet con la fecha mal puesta produciría folios de
   * otro año —`TCK-D03-2027-000001` en pleno 2026— y nadie lo notaría hasta que
   * alguien buscara esa venta por fecha y no apareciera. El año se acota al actual
   * y al anterior: lo segundo es necesario porque una venta del 31 de diciembre
   * puede subirse el 1 de enero, y esa sí es legítima.
   */
  private validarFormatoFolio(numeroTicket: string, serie: string): number {
    const prefijo = (process.env.TICKET_SERIE || 'TCK').toUpperCase();
    // Se usa `[0-9]` y no `\d` a propósito: dentro de un template literal la barra
    // simple se pierde y el patrón termina buscando la letra 'd' en vez de un
    // dígito. Compila, corre, y rechaza todo folio legítimo.
    const patron = new RegExp(`^${prefijo}-${serie}-([0-9]{4})-([0-9]{6})$`);
    const coincidencia = patron.exec(numeroTicket);

    if (!coincidencia) {
      throw this.rechazo(
        'FOLIO_DE_OTRA_SERIE',
        `El folio ${numeroTicket} no tiene la forma ${prefijo}-${serie}-AAAA-NNNNNN de esta taquilla.`,
      );
    }

    const anio = Number(coincidencia[1]);
    const actual = anioDeNegocio();

    if (anio !== actual && anio !== actual - 1) {
      throw this.rechazo(
        'FOLIO_DE_OTRA_SERIE',
        `El folio ${numeroTicket} está numerado en el año ${anio}. Revise la fecha del dispositivo.`,
      );
    }

    return Number(coincidencia[2]);
  }

  /**
   * Declara cobros hechos sin conexión y descartados antes de subirlos.
   *
   * No impide el desvío: quien controle el dispositivo puede no declarar nada. Lo
   * que hace es quitarle el silencio. Cada descarte queda con su monto, su folio y
   * su responsable en bitácora, y suma a `foliosRendidos` — así que lo que NO se
   * declara deja un hueco entre `ultimoCorrelativo` y lo rendido, visible en
   * `GET /dispositivos` sin que nadie tenga que sospechar primero.
   *
   * Exige `Sincronizacion.Anular`, que es permiso de supervisión: el mismo criterio
   * que anular un cierre de caja, y por la misma razón — quien cobra no debería
   * poder borrar su propio cobro sin que se note.
   */
  async declararDescartes(dto: DeclararDescartesDto, ejecutor?: EjecutorInfo) {
    if (!ejecutor?.id) {
      throw new BadRequestException(
        'No se pudo determinar el usuario que declara los descartes.',
      );
    }

    const taquilla = await this.prisma.dispositivoTaquilla.findUnique({
      where: { idDispositivo: dto.dispositivo },
    });

    if (!taquilla) {
      throw new NotFoundException(
        `No hay ninguna taquilla registrada como '${dto.dispositivo}'.`,
      );
    }

    // Una taquilla revocada SÍ puede declarar. Es justo el caso en que más importa:
    // el equipo se dio de baja y lo que traía pendiente tiene que poder rendirse.
    const apertura = await this.prisma.aperturaCaja.findUnique({
      where: { id: dto.idAperturaCaja },
    });

    if (!apertura || apertura.anulado) {
      throw new NotFoundException(
        `No se encontró la apertura de caja ${dto.idAperturaCaja}.`,
      );
    }

    const resultados: any[] = [];

    for (const descarte of dto.descartes) {
      try {
        resultados.push(
          await this.registrarDescarte(taquilla, apertura, descarte, ejecutor),
        );
      } catch (error: any) {
        resultados.push({
          numeroTicket: descarte.numeroTicket,
          estado: 'RECHAZADO',
          ...this.clasificarFallo(error, 'DESCARTE_INVALIDO'),
        });
      }
    }

    return {
      declarados: resultados.filter((r) => r.estado === 'REGISTRADO').length,
      resultados,
    };
  }

  private async registrarDescarte(
    taquilla: any,
    apertura: any,
    descarte: any,
    ejecutor: EjecutorInfo,
  ) {
    const correlativo = this.validarFormatoFolio(
      descarte.numeroTicket,
      taquilla.serie,
    );

    // La firma prueba que ese folio salió de esta taquilla. Sin comprobarla, un
    // equipo podría declarar como descartados folios de otro y ensuciarle el cuadre.
    if (
      !verificarFirmaDispositivo(
        descarte.numeroTicket,
        descarte.firma,
        taquilla.llavePublica,
      )
    ) {
      throw this.rechazo(
        'FIRMA_INVALIDA',
        `La firma del folio ${descarte.numeroTicket} no corresponde a esta taquilla.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Un folio que ya es ticket no se puede declarar descartado: sería borrar del
      // cuadre una venta que sí entró.
      const existe = await tx.ticket.findUnique({
        where: { numeroTicket: descarte.numeroTicket },
      });

      if (existe) {
        throw this.rechazo(
          'FOLIO_YA_EMITIDO',
          `El folio ${descarte.numeroTicket} ya es un ticket registrado (${existe.id}) y no puede declararse descartado.`,
        );
      }

      // Reintentar la declaración tras un timeout ambiguo no puede duplicar el
      // registro ni contar dos veces el folio como rendido.
      const yaDeclarado = await tx.descarteOffline.findUnique({
        where: { numeroTicket: descarte.numeroTicket },
      });

      if (yaDeclarado) {
        return {
          numeroTicket: descarte.numeroTicket,
          estado: 'DUPLICADO_IGNORADO',
          idDescarte: yaDeclarado.id,
        };
      }

      const ahora = getFechaUTC6();
      const monto = new Prisma.Decimal(descarte.montoCobrado);
      // Por omisión el caso grave: quien no declare el tipo queda registrado como
      // dinero cobrado y tirado, que es lo que hay que explicar.
      const tipo = descarte.tipo === 'ANULADO' ? 'ANULADO' : 'DESCARTADO';

      const registro = await tx.descarteOffline.create({
        data: {
          numeroTicket: descarte.numeroTicket,
          montoDeclarado: monto,
          tipo,
          motivo: descarte.motivo ?? null,
          idDispositivoTaquilla: taquilla.id,
          idAperturaCaja: apertura.id,
          idUsuario: ejecutor.id,
          // Mismo tratamiento que la fecha de una venta: se acota al turno porque
          // viene del reloj del dispositivo, y se convierte porque la columna guarda
          // reloj de pared igual que la `fechaCreacion` de su lado. Guardarla cruda
          // dejaba dos convenciones en la misma fila, y el primer reporte que la
          // leyera mostraría el descarte seis horas corrido respecto de los tickets.
          fechaDescarte: getFechaUTC6(
            this.acotarFecha(
              new Date(descarte.fechaDescarte),
              aInstanteReal(new Date(apertura.fechaCreacion)),
            ),
          ),
          fechaCreacion: ahora,
        },
      });

      await tx.dispositivoTaquilla.update({
        where: { id: taquilla.id },
        data: {
          foliosRendidos: { increment: 1 },
          ultimoUso: ahora,
          ...(correlativo > (taquilla.ultimoCorrelativo ?? 0)
            ? { ultimoCorrelativo: correlativo }
            : {}),
        },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        // Acciones distintas a propósito: en la bitácora se filtra por acción, y
        // mezclarlas obligaría a leer cada descripción para separar lo grave.
        accion:
          tipo === 'ANULADO'
            ? 'ANULAR_RECAUDACION_OFFLINE'
            : 'DESCARTAR_RECAUDACION_OFFLINE',
        modulo: 'Sincronizacion',
        descripcion:
          (tipo === 'ANULADO'
            ? `Se anuló sin conexión la venta del folio ${descarte.numeroTicket} de la taquilla `
            : `Se descartó sin subir el cobro del folio ${descarte.numeroTicket} de la taquilla `) +
          `${taquilla.serie}, por Q${monto.toFixed(2)}, contra la caja ${apertura.id}.` +
          (descarte.motivo
            ? ` Motivo: ${descarte.motivo}`
            : ' Sin motivo declarado.'),
      });

      return {
        numeroTicket: descarte.numeroTicket,
        estado: 'REGISTRADO',
        tipo,
        idDescarte: registro.id,
      };
    });
  }

  /** Marca un error con su código de rechazo para la respuesta por ítem. */
  private rechazo(codigo: string, mensaje: string) {
    const error: any = new BadRequestException(mensaje);
    error.codigoOffline = codigo;
    return error;
  }

  private async procesarVenta(
    contexto: any,
    venta: VentaOfflineDto,
    ejecutor: EjecutorInfo,
  ) {
    // 1. Idempotencia: si ya se registró, no crear nada.
    const existente = await this.prisma.ticket.findFirst({
      where: { idLocal: venta.idLocal },
    });

    if (existente) {
      return {
        idLocal: venta.idLocal,
        estado: 'DUPLICADO_IGNORADO',
        ticket: await this.ticketsService.findOne(existente.id),
      };
    }

    if (contexto.invalidado) {
      throw this.rechazo('LOTE_INVALIDADO', contexto.motivoInvalidado);
    }

    // 4. La fecha viene del reloj del dispositivo y no es confiable: se acota al
    //    rango en que la venta pudo existir. El piso lo pone el contexto —la
    //    creación del lote, o la apertura de la caja en el modo por dispositivo—.
    //    Un reloj mal puesto mandaría la venta al arqueo de otro día, o la haría
    //    recalcular con una tarifa que no regía.
    const fechaEmision = this.acotarFecha(
      new Date(venta.fechaEmision),
      contexto.fechaMinima,
    );

    return this.prisma.$transaction(
      async (tx) => {
        const folioVisitante = await contexto.tomarFolio(
          tx,
          venta.numeroTicket,
          venta.firma,
        );
        const folioGuia = venta.numeroTicketGuia
          ? await contexto.tomarFolio(
              tx,
              venta.numeroTicketGuia,
              venta.firmaGuia,
            )
          : null;

        const {
          atraccion,
          origen,
          tipoRecorrido,
          opcionPago,
          idPais,
          detalles,
          totalPersonas,
        } = await this.ticketsService.prepararEmision(tx, venta, fechaEmision);

        // 3. Sin pasarela no hay cobro con tarjeta: offline solo se vende en efectivo.
        if (!opcionPago.esEfectivo) {
          throw this.rechazo(
            'PAGO_NO_EFECTIVO',
            `La forma de pago '${opcionPago.nombre}' no es efectivo. La recaudación offline solo acepta efectivo.`,
          );
        }

        const guia = await this.ticketsService.resolverGuia(
          tx,
          venta,
          getFechaUTC6(),
          // El mismo guía nuevo puede acompañar a varios grupos del turno: la
          // primera venta lo crea y las demás lo reutilizan, en vez de perderse.
          true,
        );

        /**
         * `montoCobrado` es el **total de la venta**, y una venta con guía sin
         * carnet emite dos tickets. Hay que repartirlo entre ellos: el guía se
         * lleva su tarifa y el resto es del visitante.
         *
         * Asignarle el total al ticket del visitante y además crear el del guía
         * por su tarifa haría que el arqueo contara el dinero del guía dos veces
         * (35 + 15 = 50 cuando al cajón entraron 35), y el cajero aparecería con
         * un faltante que no existe.
         *
         * El reparto conserva el total: `cobradoVisitante + cobradoGuia` siempre
         * es exactamente `montoCobrado`, que es lo que hay en el cajón.
         */
        const montoCobrado = new Prisma.Decimal(venta.montoCobrado);
        const montoVisitantesRecalculado = detalles.reduce(
          (suma: Prisma.Decimal, d: any) => suma.plus(d.subtotal),
          new Prisma.Decimal(0),
        );

        let tarifaGuia: any = null;
        let montoGuia = new Prisma.Decimal(0);

        if (folioGuia) {
          if (!guia) {
            throw this.rechazo(
              'CATALOGO_INVALIDO',
              'Se envió un folio de guía pero la recaudación no lleva guía.',
            );
          }

          tarifaGuia = await resolverTarifaGuiaEn(tx, fechaEmision);
          if (!tarifaGuia) {
            throw this.rechazo(
              'CATALOGO_INVALIDO',
              'No había una tarifa de guía vigente en la fecha de la recaudación.',
            );
          }

          montoGuia = new Prisma.Decimal(tarifaGuia.precio);
        }

        // Si se cobró menos que la tarifa del guía, el faltante se refleja ahí y el
        // ticket del visitante queda en 0, nunca en negativo.
        const cobradoGuia = montoGuia.greaterThan(montoCobrado)
          ? montoCobrado
          : montoGuia;
        const cobradoVisitante = montoCobrado.minus(cobradoGuia);

        // La discrepancia se juzga sobre el total de la venta, no ticket por ticket.
        const esperadoTotal = montoVisitantesRecalculado.plus(montoGuia);
        const hayDiscrepancia = !esperadoTotal.equals(montoCobrado);

        const ahora = getFechaUTC6();

        const grupo = await tx.grupoEmision.create({
          data: {
            idUsuario: ejecutor.id,
            // 7. La venta ocurrió en el turno que dice el contexto —el del lote, o
            //    el de la caja abierta cuando se armó la taquilla— y ahí tiene que
            //    cuadrar, no en la caja que esté abierta al momento de subirla.
            idAperturaCaja: contexto.idAperturaCaja,
            fechaCreacion: ahora,
          },
        });

        const datosComunes = {
          idGrupoEmision: grupo.id,
          idTipoRecorrido: tipoRecorrido.id,
          idAperturaCaja: contexto.idAperturaCaja,
          idUsuario: ejecutor.id,
          idAtraccion: atraccion.id,
          idOrigen: origen.id,
          idPais,
          idGuia: guia?.id ?? null,
          idLoteOffline: contexto.idLote,
          idDispositivoTaquilla: contexto.idDispositivoTaquilla,
          fechaEmisionOffline: getFechaUTC6(fechaEmision),
          origenOffline: true,
          fechaCreacion: ahora,
          fechaActualizacion: ahora,
        };

        const ticketVisitante = await tx.ticket.create({
          data: {
            ...datosComunes,
            idLocal: venta.idLocal,
            numeroTicket: folioVisitante.numeroTicket,
            tipoTicket: TIPO_TICKET_VISITANTE,
            nombre: venta.nombreGrupo,
            cantidadPersonas: totalPersonas,
            montoTotal: cobradoVisitante,
            // 8. Solo se guarda cuando difiere: es la señal de un cobro mal hecho.
            montoRecalculado: hayDiscrepancia
              ? montoVisitantesRecalculado
              : null,
            observaciones: venta.notas,
            qrFirma: folioVisitante.firma,
            visitantePorTickets: { create: detalles },
            ticketPagos: {
              create: {
                idOpcionPago: opcionPago.id,
                monto: cobradoVisitante,
                estadoPago: ESTADO_PAGO_PAGADO,
                fechaPago: getFechaUTC6(fechaEmision),
                fechaCreacion: ahora,
                fechaActualizacion: ahora,
              },
            },
          },
        });

        await contexto.sellarFolio(tx, folioVisitante, ticketVisitante.id);
        const tickets = [ticketVisitante];

        if (folioGuia) {
          const ticketGuia = await tx.ticket.create({
            data: {
              ...datosComunes,
              // El idLocal identifica la venta, y va en el ticket del visitante.
              // Repetirlo acá chocaría con el índice único.
              numeroTicket: folioGuia.numeroTicket,
              tipoTicket: TIPO_TICKET_GUIA,
              nombre: guia.nombre,
              cantidadPersonas: 1,
              montoTotal: cobradoGuia,
              // Solo difiere si se cobró menos que la tarifa del guía.
              montoRecalculado: cobradoGuia.equals(montoGuia)
                ? null
                : montoGuia,
              observaciones: `Ticket de guía sin carnet asociado al grupo '${venta.nombreGrupo}'.`,
              qrFirma: folioGuia.firma,
              ticketPagos: {
                create: {
                  idOpcionPago: opcionPago.id,
                  monto: cobradoGuia,
                  estadoPago: ESTADO_PAGO_PAGADO,
                  fechaPago: getFechaUTC6(fechaEmision),
                  fechaCreacion: ahora,
                  fechaActualizacion: ahora,
                },
              },
            },
          });

          await contexto.sellarFolio(tx, folioGuia, ticketGuia.id);
          tickets.push(ticketGuia);
        }

        await BitacoraService.registrarEnTransaccion(tx, {
          idUsuario: ejecutor.id,
          usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
          accion: 'EMITIR_TICKET_OFFLINE',
          modulo: MODULO_BITACORA,
          descripcion:
            `Recaudación OFFLINE de ${contexto.etiqueta} sincronizada: ` +
            `${tickets.map((t) => t.numeroTicket).join(', ')} para '${venta.nombreGrupo}'. ` +
            `Vendida ${getFechaUTC6(fechaEmision).toISOString()}, cobrada ${montoCobrado.toString()}` +
            (folioGuia
              ? ` (visitante ${cobradoVisitante} + guía ${cobradoGuia})`
              : '') +
            (hayDiscrepancia
              ? `, esperada ${esperadoTotal.toString()} (DISCREPANCIA).`
              : '.'),
        });

        return {
          idLocal: venta.idLocal,
          estado: 'CREADO',
          discrepancia: hayDiscrepancia
            ? {
                montoCobrado: montoCobrado.toString(),
                montoRecalculado: esperadoTotal.toString(),
                diferencia: montoCobrado.minus(esperadoTotal).toString(),
              }
            : null,
          ticket: await this.ticketsService.findOne(ticketVisitante.id, tx),
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 20000,
      },
    );
  }

  /**
   * Acota la fecha declarada al rango en que la venta pudo existir.
   *
   * El piso lo decide el modo y llega en `fechaMinima`: la creación del lote, o la
   * apertura de la caja cuando la taquilla firma sus pases. Antes de eso no pudo
   * haber venta; después de ahora, tampoco.
   *
   * `fechaMinima` tiene que venir ya convertida a instante real. Las fechas de la
   * base son reloj de pared y la del dispositivo es un instante: compararlas sin
   * convertir dejaba el piso seis horas antes y aceptaba ventas anteriores a la
   * caja, que es justo lo que este acotado existe para impedir.
   */
  private acotarFecha(fecha: Date, fechaMinima: Date): Date {
    const minimo = fechaMinima;
    const maximo = new Date();

    if (isNaN(fecha.getTime()) || fecha < minimo) return minimo;
    if (fecha > maximo) return maximo;
    return fecha;
  }

  /**
   * Clasifica un error que cayó al catch por ítem.
   *
   * Los rechazos previstos llevan `codigoOffline` puesto por `rechazo()`: son datos
   * que el taquillero puede corregir, o ventas que no van a entrar nunca. Lo que NO
   * lleva código es un fallo del servidor, y etiquetarlo como `CATALOGO_INVALIDO`
   * —el valor por omisión que había— era doblemente malo: mandaba a revisar la
   * atracción y el país de una venta que estaba bien, y como la documentación dice
   * que un rechazo del servidor no se reintenta, invitaba a descartar dinero cobrado
   * por un bug nuestro.
   *
   * Pasó de verdad: un `folioReservado.update()` con `id: null` dejó toda la emisión
   * firmada por taquilla sin poder sincronizar, reportado como catálogo inválido.
   *
   * `ERROR_INTERNO` dice lo contrario de forma explícita —conservar y reintentar— y
   * el detalle real queda en el log del servidor, que es donde sirve.
   */
  private clasificarFallo(error: any, codigoPorDefecto: string) {
    if (error?.codigoOffline) {
      return {
        codigo: error.codigoOffline as string,
        mensaje: error?.message ?? 'No se pudo registrar la recaudación.',
      };
    }

    if (
      error instanceof BadRequestException ||
      error instanceof NotFoundException
    ) {
      return {
        codigo: codigoPorDefecto,
        mensaje: error?.message ?? 'No se pudo registrar la recaudación.',
      };
    }

    this.logger.error(
      `Fallo no previsto al procesar una recaudación sin conexión: ${error?.message}`,
      error?.stack,
    );

    return {
      codigo: 'ERROR_INTERNO',
      mensaje:
        'El servidor falló al registrar esta recaudación. NO la descarte: ' +
        'consérvela en la cola y vuelva a sincronizar más tarde.',
    };
  }

  /** Verifica que el folio sirva para esta venta y lo devuelve. */
  private async tomarFolio(tx: any, lote: any, numeroTicket: string) {
    const folio = await tx.folioReservado.findUnique({
      where: { numeroTicket },
    });

    if (!folio) {
      throw this.rechazo(
        'FOLIO_NO_RESERVADO',
        `El folio ${numeroTicket} no corresponde a ningún folio reservado.`,
      );
    }

    if (folio.idLote !== lote.id) {
      throw this.rechazo(
        'FOLIO_DE_OTRO_LOTE',
        `El folio ${numeroTicket} pertenece al lote ${folio.idLote}, no al ${lote.id}.`,
      );
    }

    // Distinto de FOLIO_NO_RESERVADO a propósito: acá el dispositivo gastó dos
    // veces el mismo folio en ventas distintas, así que hay dinero cobrado que se
    // va a perder y alguien tiene que revisarlo.
    if (folio.estado === FOLIO_EMITIDO) {
      throw this.rechazo(
        'FOLIO_YA_EMITIDO',
        `El folio ${numeroTicket} ya respalda otra recaudación (ticket ${folio.idTicket}).`,
      );
    }

    if (folio.estado !== FOLIO_RESERVADO) {
      throw this.rechazo(
        'FOLIO_NO_RESERVADO',
        `El folio ${numeroTicket} está en estado ${folio.estado} y no puede emitirse.`,
      );
    }

    return folio;
  }

  private async marcarEmitido(tx: any, idFolio: number, idTicket: number) {
    await tx.folioReservado.update({
      where: { id: idFolio },
      data: { estado: FOLIO_EMITIDO, idTicket },
    });
  }

  // -------------------------------------------------------------------------
  // 4. Conciliar
  // -------------------------------------------------------------------------

  async conciliar(
    idLote: number,
    dto: ConciliarLoteDto,
    ejecutor?: EjecutorInfo,
  ) {
    const lote = await this.prisma.loteOffline.findUnique({
      where: { id: idLote },
      include: { folios: true },
    });

    if (!lote) {
      throw new NotFoundException(
        `No se encontró el lote offline con el ID ${idLote}.`,
      );
    }

    if (lote.estado === LOTE_CONCILIADO) {
      throw new BadRequestException(`El lote ${idLote} ya fue conciliado.`);
    }

    if (lote.estado === LOTE_INVALIDADO) {
      throw new BadRequestException(
        `El lote ${idLote} está invalidado y no puede conciliarse.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const ahora = getFechaUTC6();

      // Todo folio que quedó sin vender pasa a NO_UTILIZADO: así la auditoría no
      // ve huecos inexplicados en la secuencia de folios.
      const sinUsar = lote.folios.filter(
        (f: any) => f.estado === FOLIO_RESERVADO,
      );

      await tx.folioReservado.updateMany({
        where: { idLote, estado: FOLIO_RESERVADO },
        data: { estado: FOLIO_NO_UTILIZADO },
      });

      const emitidos = lote.folios.filter(
        (f: any) => f.estado === FOLIO_EMITIDO,
      );

      // El cliente declara lo que hizo; el contraste revela ventas que se
      // perdieron (almacenamiento corrupto, cola borrada). No se bloquea la
      // conciliación por esto: dejaría la caja sin poder cerrarse.
      const emitidosSet = new Set(emitidos.map((f: any) => f.numeroTicket));
      const advertencias = (dto?.foliosUtilizados ?? [])
        .filter((numero) => !emitidosSet.has(numero))
        .map((numeroTicket) => ({
          numeroTicket,
          detalle: 'Declarado utilizado, sin ticket registrado',
        }));

      const conciliado = await tx.loteOffline.update({
        where: { id: idLote },
        data: { estado: LOTE_CONCILIADO, fechaConciliacion: ahora },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'CONCILIAR_LOTE_OFFLINE',
        modulo: MODULO_BITACORA,
        descripcion:
          `Se concilió el lote ${idLote}: ${emitidos.length} emitidos, ` +
          `${sinUsar.length} no utilizados` +
          (advertencias.length
            ? `, ${advertencias.length} declarados vendidos SIN ticket registrado ` +
              `(${advertencias.map((a) => a.numeroTicket).join(', ')}).`
            : '.'),
      });

      return {
        idLote: conciliado.id,
        estado: conciliado.estado,
        emitidos: emitidos.length,
        noUtilizados: sinUsar.length,
        advertencias,
      };
    });
  }

  // -------------------------------------------------------------------------
  // 5. Invalidar
  // -------------------------------------------------------------------------

  /**
   * Para dispositivo perdido o robado. **Destruye las ventas offline que no se
   * hubieran subido todavía**: ese dinero quedaría cobrado sin ticket. Usar solo
   * cuando el dispositivo no va a volver.
   */
  async invalidar(idLote: number, ejecutor?: EjecutorInfo) {
    const lote = await this.prisma.loteOffline.findUnique({
      where: { id: idLote },
      include: { folios: true },
    });

    if (!lote) {
      throw new NotFoundException(
        `No se encontró el lote offline con el ID ${idLote}.`,
      );
    }

    if (lote.estado === LOTE_INVALIDADO) {
      throw new BadRequestException(`El lote ${idLote} ya está invalidado.`);
    }

    return this.prisma.$transaction(async (tx) => {
      const porInvalidar = lote.folios.filter(
        (f: any) => f.estado === FOLIO_RESERVADO,
      ).length;

      await tx.folioReservado.updateMany({
        where: { idLote, estado: FOLIO_RESERVADO },
        data: { estado: FOLIO_INVALIDADO },
      });

      const invalidado = await tx.loteOffline.update({
        where: { id: idLote },
        data: { estado: LOTE_INVALIDADO },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'INVALIDAR_LOTE_OFFLINE',
        modulo: MODULO_BITACORA,
        descripcion:
          `Se invalidó el lote ${idLote} del dispositivo ${lote.idDispositivo}: ` +
          `${porInvalidar} folios quedaron inutilizables. La recaudación no subida se pierde.`,
      });

      return {
        idLote: invalidado.id,
        estado: invalidado.estado,
        foliosInvalidados: porInvalidar,
      };
    });
  }
}
