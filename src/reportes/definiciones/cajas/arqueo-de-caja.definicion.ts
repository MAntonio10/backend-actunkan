import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DefinicionReporte, FilaReporte } from '../../contratos';
import { aDecimal } from '../../formato.util';
import { fechaHora, kpiMoneda, totalesDe } from '../comunes';

const COLUMNAS_MOVIMIENTOS = [
  {
    clave: 'concepto',
    titulo: 'Concepto',
    formato: 'texto' as const,
    ancho: 0.45,
  },
  { clave: 'documentos', titulo: 'Documentos', formato: 'entero' as const },
  {
    clave: 'monto',
    titulo: 'Monto',
    formato: 'moneda' as const,
    total: 'suma' as const,
  },
];

const COLUMNAS_DONACIONES = [
  {
    clave: 'numeroRecibo',
    titulo: 'Recibo',
    formato: 'texto' as const,
    anchoMinimo: 90,
  },
  {
    clave: 'donante',
    titulo: 'Donante',
    formato: 'texto' as const,
    ancho: 0.4,
  },
  {
    clave: 'fecha',
    titulo: 'Fecha',
    formato: 'fechaHora' as const,
    anchoMinimo: 95,
  },
  {
    clave: 'monto',
    titulo: 'Monto',
    formato: 'moneda' as const,
    total: 'suma' as const,
  },
];

/**
 * Arqueo detallado de un turno: de dónde salió cada quetzal que debería estar en el cajón.
 *
 * El reporte entero es `soloSupervisor`. No basta con marcar las columnas: aquí **todo**
 * es la cifra que un cajero no debe ver, incluido el desglose que permitiría deducirla.
 * Es la misma frontera que traza `GET /cajas/:id/arqueo`, que exige `Cajas.Editar`.
 */
export const arqueoDeCaja: DefinicionReporte = {
  clave: 'arqueo-de-caja',
  titulo: 'Arqueo de caja',
  descripcion:
    'Arqueo detallado de un turno de caja concreto: monto inicial, ventas en efectivo, ' +
    'donaciones recibidas, monto esperado, monto contado y la diferencia, con el listado ' +
    'de las donaciones del turno. Requiere indicar de qué caja o turno se trata. Solo lo ' +
    'puede consultar un supervisor.',
  categoria: 'Cajas',
  moduloOrigen: 'Cajas',
  soloSupervisor: true,
  orientacionSugerida: 'vertical',
  filtros: [
    {
      clave: 'caja',
      etiqueta: 'Caja',
      tipo: 'aperturaCaja',
      descripcion:
        'Número identificador del turno o apertura de caja del que se quiere el arqueo.',
      requerido: true,
    },
  ],

  async ejecutar({ prisma, filtros }) {
    const idApertura = filtros.idAperturaCaja;
    if (!idApertura) {
      throw new BadRequestException(
        'El arqueo requiere indicar de qué caja se trata. Envíe el número de la apertura.',
      );
    }

    const apertura = await prisma.aperturaCaja.findFirst({
      where: { id: idApertura, anulado: false },
      select: {
        id: true,
        montoInicial: true,
        fechaCreacion: true,
        observaciones: true,
        usuario: { select: { nombre: true } },
        estado: { select: { nombre: true } },
        cierresCaja: {
          where: { anulado: false },
          orderBy: { fechaCierre: 'desc' },
          take: 1,
          select: {
            fechaCierre: true,
            montoFinal: true,
            montoEsperado: true,
            diferencia: true,
            observaciones: true,
          },
        },
      },
    });

    if (!apertura) {
      throw new NotFoundException(
        `No se encontró una apertura de caja vigente con el ID ${idApertura}.`,
      );
    }

    const [ventas, donacionesAgregado, donaciones, offline] = await Promise.all(
      [
        // Solo lo efectivamente cobrado en efectivo: una tarjeta pendiente no es dinero
        // que esté en el cajón. Es el mismo criterio de CajasService.calcularArqueo.
        prisma.ticketPago.aggregate({
          where: {
            anulado: false,
            estadoPago: 'PAGADO',
            opcionPago: { esEfectivo: true },
            tickets: { idAperturaCaja: idApertura, anulado: false },
          },
          _sum: { monto: true },
          _count: { _all: true },
        }),
        prisma.donacion.aggregate({
          where: { idAperturaCaja: idApertura, anulado: false },
          _sum: { monto: true },
          _count: { _all: true },
        }),
        prisma.donacion.findMany({
          where: { idAperturaCaja: idApertura, anulado: false },
          orderBy: { fechaCreacion: 'asc' },
          select: {
            numeroRecibo: true,
            nombreDonante: true,
            monto: true,
            fechaCreacion: true,
          },
        }),
        // Ventas offline cobradas por un importe distinto del que correspondía. No altera
        // el esperado a propósito: en el cajón está lo que se cobró, no lo que se debió
        // cobrar. Va como cifra aparte porque, si no, un cobro de menos no deja huella.
        prisma.ticket.aggregate({
          where: {
            idAperturaCaja: idApertura,
            anulado: false,
            origenOffline: true,
            montoRecalculado: { not: null },
          },
          _count: { _all: true },
          _sum: { montoTotal: true, montoRecalculado: true },
        }),
      ],
    );

    const cierre = apertura.cierresCaja[0];
    const montoInicial = aDecimal(apertura.montoInicial);
    const ventasEfectivo = aDecimal(ventas._sum.monto);
    const totalDonaciones = aDecimal(donacionesAgregado._sum.monto);
    const montoEsperado = montoInicial
      .plus(ventasEfectivo)
      .plus(totalDonaciones);
    const montoContado = cierre ? aDecimal(cierre.montoFinal) : null;
    const diferencia = montoContado ? montoContado.minus(montoEsperado) : null;

    const movimientos: FilaReporte[] = [
      {
        concepto: 'Monto inicial',
        documentos: null,
        monto: montoInicial.toFixed(4),
      },
      {
        concepto: 'Ventas cobradas en efectivo',
        documentos: ventas._count._all ?? 0,
        monto: ventasEfectivo.toFixed(4),
      },
      {
        concepto: 'Donaciones recibidas',
        documentos: donacionesAgregado._count._all ?? 0,
        monto: totalDonaciones.toFixed(4),
      },
    ];

    const filasDonaciones: FilaReporte[] = donaciones.map((donacion) => ({
      numeroRecibo: donacion.numeroRecibo,
      donante: donacion.nombreDonante ?? 'Donante anónimo',
      fecha: fechaHora(donacion.fechaCreacion),
      monto: aDecimal(donacion.monto).toFixed(4),
    }));

    const ticketsDesviados = offline._count._all ?? 0;
    const discrepancia = ticketsDesviados
      ? aDecimal(offline._sum.montoTotal).minus(
          aDecimal(offline._sum.montoRecalculado),
        )
      : new Prisma.Decimal(0);

    const kpis = [
      kpiMoneda('Monto esperado', montoEsperado),
      montoContado
        ? kpiMoneda('Monto contado', montoContado)
        : { etiqueta: 'Monto contado', valor: 'Caja sin cerrar' },
      diferencia
        ? kpiMoneda(
            'Diferencia',
            diferencia,
            diferencia.isNegative() ? 'Faltante' : 'Sobrante',
          )
        : { etiqueta: 'Diferencia', valor: '—' },
    ];

    if (ticketsDesviados > 0) {
      kpis.push(
        kpiMoneda(
          'Discrepancia offline',
          discrepancia,
          `${ticketsDesviados} venta(s) cobrada(s) por un importe distinto al de la tarifa`,
        ),
      );
    }

    const secciones = [
      {
        titulo: 'Movimientos del turno',
        columnas: COLUMNAS_MOVIMIENTOS,
        filas: movimientos,
        totales: {
          ...totalesDe(COLUMNAS_MOVIMIENTOS, movimientos),
          concepto: 'MONTO ESPERADO',
        },
      },
    ];

    if (filasDonaciones.length > 0) {
      secciones.push({
        titulo: 'Donaciones del turno',
        columnas: COLUMNAS_DONACIONES,
        filas: filasDonaciones,
        totales: totalesDe(COLUMNAS_DONACIONES, filasDonaciones),
      } as (typeof secciones)[number]);
    }

    return {
      titulo: `Arqueo de caja #${apertura.id}`,
      subtitulo: `${apertura.usuario?.nombre ?? 'Sin cajero'} · abierta el ${fechaHora(apertura.fechaCreacion)}`,
      filtrosAplicados: [
        { etiqueta: 'Caja', valor: `#${apertura.id}` },
        { etiqueta: 'Cajero', valor: apertura.usuario?.nombre ?? '—' },
        { etiqueta: 'Estado', valor: apertura.estado?.nombre ?? '—' },
        ...(cierre
          ? [
              {
                etiqueta: 'Cerrada',
                valor: fechaHora(cierre.fechaCierre) ?? '—',
              },
            ]
          : []),
      ],
      kpis,
      secciones,
      orientacion: 'vertical',
      notas: [
        'El monto esperado es el inicial más las ventas cobradas en efectivo más las ' +
          'donaciones. Las ventas con tarjeta no entran: no son dinero en el cajón.',
        'La discrepancia offline no altera el monto esperado. En el cajón está lo que se ' +
          'cobró, no lo que se debió cobrar; restarla haría aparecer el error del cobro ' +
          'como un error del cajero al contar.',
        ...(ticketsDesviados === 0
          ? []
          : ['Una discrepancia negativa significa que se cobró de menos.']),
      ],
    };
  },
};
