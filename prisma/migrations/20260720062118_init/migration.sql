BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Usuario] (
    [id] INT NOT NULL IDENTITY(1,1),
    [idPuesto] INT NOT NULL,
    [nombre] NVARCHAR(255) NOT NULL,
    [correo] NVARCHAR(255) NOT NULL,
    [contrasena] NVARCHAR(255) NOT NULL,
    [telefono] NVARCHAR(50) NOT NULL,
    [fechaCreacion] DATETIME2 NOT NULL,
    [fechaActualizacion] DATETIME2 NOT NULL,
    [anulado] BIT NOT NULL CONSTRAINT [Usuario_anulado_df] DEFAULT 0,
    CONSTRAINT [Usuario_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Usuario_correo_key] UNIQUE NONCLUSTERED ([correo])
);

-- CreateTable
CREATE TABLE [dbo].[Modulo] (
    [id] INT NOT NULL IDENTITY(1,1),
    [nombre] NVARCHAR(100) NOT NULL,
    [anulado] BIT NOT NULL CONSTRAINT [Modulo_anulado_df] DEFAULT 0,
    [fechaCreacion] DATETIME2 NOT NULL,
    [fechaActualizacion] DATETIME2 NOT NULL,
    CONSTRAINT [Modulo_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Modulo_nombre_key] UNIQUE NONCLUSTERED ([nombre])
);

-- CreateTable
CREATE TABLE [dbo].[Permisos] (
    [id] INT NOT NULL IDENTITY(1,1),
    [idModulo] INT NOT NULL,
    [idUsuario] INT NOT NULL,
    [ver] BIT NOT NULL,
    [agregar] BIT NOT NULL,
    [editar] BIT NOT NULL,
    [anular] BIT NOT NULL,
    [exportar] BIT NOT NULL,
    CONSTRAINT [Permisos_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Puestos] (
    [id] INT NOT NULL IDENTITY(1,1),
    [nombre] NVARCHAR(100) NOT NULL,
    [descripcion] NVARCHAR(max),
    [anulado] BIT NOT NULL CONSTRAINT [Puestos_anulado_df] DEFAULT 0,
    [fechaCreacion] DATETIME2 NOT NULL,
    [fechaActualizacion] DATETIME2 NOT NULL,
    CONSTRAINT [Puestos_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Puestos_nombre_key] UNIQUE NONCLUSTERED ([nombre])
);

-- CreateTable
CREATE TABLE [dbo].[Ticket] (
    [id] INT NOT NULL IDENTITY(1,1),
    [idTipoRecorrido] INT NOT NULL,
    [idAperturaCaja] INT NOT NULL,
    [idUsuario] INT NOT NULL,
    [nombre] NVARCHAR(255) NOT NULL,
    [observaciones] NVARCHAR(255),
    [fechaCreacion] DATETIME2 NOT NULL,
    [fechaActualizacion] DATETIME2 NOT NULL,
    [anulado] BIT NOT NULL CONSTRAINT [Ticket_anulado_df] DEFAULT 0,
    [Qr] NVARCHAR(1000) NOT NULL,
    CONSTRAINT [Ticket_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[VisitantePorTicket] (
    [id] INT NOT NULL IDENTITY(1,1),
    [idTicket] INT NOT NULL,
    [idTipoVisitante] INT NOT NULL,
    [cantidad] INT NOT NULL,
    CONSTRAINT [VisitantePorTicket_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[TipoRecorrido] (
    [id] INT NOT NULL IDENTITY(1,1),
    [nombre] NVARCHAR(1000) NOT NULL,
    [fechaCreacion] DATETIME2 NOT NULL,
    [fechaActualizacion] DATETIME2 NOT NULL,
    [anulado] BIT NOT NULL,
    CONSTRAINT [TipoRecorrido_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[TipoVisitante] (
    [id] INT NOT NULL IDENTITY(1,1),
    [nombre] NVARCHAR(255) NOT NULL,
    [fechaCreacion] DATETIME2 NOT NULL,
    [fechaActualizacion] DATETIME2 NOT NULL,
    [anulado] BIT NOT NULL CONSTRAINT [TipoVisitante_anulado_df] DEFAULT 0,
    CONSTRAINT [TipoVisitante_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[OpcionPago] (
    [id] INT NOT NULL IDENTITY(1,1),
    [nombre] NVARCHAR(100) NOT NULL,
    [anulado] BIT NOT NULL CONSTRAINT [OpcionPago_anulado_df] DEFAULT 0,
    [fechaCreacion] DATETIME2 NOT NULL,
    [fechaActualizacion] DATETIME2 NOT NULL,
    CONSTRAINT [OpcionPago_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[TicketPago] (
    [id] INT NOT NULL IDENTITY(1,1),
    [idTicket] INT NOT NULL,
    [idOpcionPago] INT NOT NULL,
    [numeroComprobante] NVARCHAR(100),
    [idPagoPasarela] NVARCHAR(255),
    [monto] DECIMAL(18,4) NOT NULL,
    [fechaCreacion] DATETIME2 NOT NULL,
    [fechaActualizacion] DATETIME2 NOT NULL,
    [anulado] BIT NOT NULL CONSTRAINT [TicketPago_anulado_df] DEFAULT 0,
    CONSTRAINT [TicketPago_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[AperturaCaja] (
    [id] INT NOT NULL IDENTITY(1,1),
    [idUsuario] INT NOT NULL,
    [fechaCreacion] DATETIME2 NOT NULL,
    [fechaActualizacion] DATETIME2 NOT NULL,
    [idEstado] INT NOT NULL,
    [montoInicial] DECIMAL(18,4) NOT NULL,
    [observaciones] NVARCHAR(max),
    [anulado] BIT NOT NULL CONSTRAINT [AperturaCaja_anulado_df] DEFAULT 0,
    CONSTRAINT [AperturaCaja_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[EstadoCaja] (
    [id] INT NOT NULL IDENTITY(1,1),
    [nombre] NVARCHAR(255) NOT NULL,
    CONSTRAINT [EstadoCaja_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Gastos] (
    [id] INT NOT NULL IDENTITY(1,1),
    [idTipoGasto] INT NOT NULL,
    [idAperturaCaja] INT,
    [descripcion] NVARCHAR(255) NOT NULL,
    [monto] DECIMAL(18,4) NOT NULL,
    [fechaCreacion] DATETIME2 NOT NULL,
    [fechaActualizacion] DATETIME2 NOT NULL,
    [anulado] BIT NOT NULL CONSTRAINT [Gastos_anulado_df] DEFAULT 0,
    CONSTRAINT [Gastos_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[TipoGasto] (
    [id] INT NOT NULL IDENTITY(1,1),
    [nombre] NVARCHAR(255) NOT NULL,
    [anulado] BIT NOT NULL CONSTRAINT [TipoGasto_anulado_df] DEFAULT 0,
    CONSTRAINT [TipoGasto_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[CierreCaja] (
    [id] INT NOT NULL IDENTITY(1,1),
    [idApertura] INT NOT NULL,
    [fechaCierre] DATETIME2 NOT NULL,
    [montoFinal] DECIMAL(18,4) NOT NULL,
    [observaciones] NVARCHAR(max),
    [anulado] BIT NOT NULL CONSTRAINT [CierreCaja_anulado_df] DEFAULT 0,
    CONSTRAINT [CierreCaja_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[ActividadesParque] (
    [id] INT NOT NULL IDENTITY(1,1),
    [idSectorParque] INT NOT NULL,
    [idUsuarioCreador] INT NOT NULL,
    [idUsuarioResponsable] INT NOT NULL,
    [nombreActividad] NVARCHAR(1000) NOT NULL,
    [fechaCreacion] DATETIME2 NOT NULL,
    [fechaActualizacion] DATETIME2 NOT NULL,
    [descripcionActividad] NVARCHAR(1000) NOT NULL,
    [imagen] NVARCHAR(1000),
    [anulado] BIT NOT NULL CONSTRAINT [ActividadesParque_anulado_df] DEFAULT 0,
    CONSTRAINT [ActividadesParque_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[SectorParque] (
    [id] INT NOT NULL IDENTITY(1,1),
    [nombre] NVARCHAR(255) NOT NULL,
    [fechaCreacion] DATETIME2 NOT NULL,
    [fechaActualizacion] DATETIME2 NOT NULL,
    [anulado] BIT NOT NULL CONSTRAINT [SectorParque_anulado_df] DEFAULT 0,
    CONSTRAINT [SectorParque_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- AddForeignKey
ALTER TABLE [dbo].[Usuario] ADD CONSTRAINT [Usuario_idPuesto_fkey] FOREIGN KEY ([idPuesto]) REFERENCES [dbo].[Puestos]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Permisos] ADD CONSTRAINT [Permisos_idModulo_fkey] FOREIGN KEY ([idModulo]) REFERENCES [dbo].[Modulo]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Permisos] ADD CONSTRAINT [Permisos_idUsuario_fkey] FOREIGN KEY ([idUsuario]) REFERENCES [dbo].[Usuario]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Ticket] ADD CONSTRAINT [Ticket_idTipoRecorrido_fkey] FOREIGN KEY ([idTipoRecorrido]) REFERENCES [dbo].[TipoRecorrido]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[VisitantePorTicket] ADD CONSTRAINT [VisitantePorTicket_idTicket_fkey] FOREIGN KEY ([idTicket]) REFERENCES [dbo].[Ticket]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[VisitantePorTicket] ADD CONSTRAINT [VisitantePorTicket_idTipoVisitante_fkey] FOREIGN KEY ([idTipoVisitante]) REFERENCES [dbo].[TipoVisitante]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[TicketPago] ADD CONSTRAINT [TicketPago_idTicket_fkey] FOREIGN KEY ([idTicket]) REFERENCES [dbo].[Ticket]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[TicketPago] ADD CONSTRAINT [TicketPago_idOpcionPago_fkey] FOREIGN KEY ([idOpcionPago]) REFERENCES [dbo].[OpcionPago]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[AperturaCaja] ADD CONSTRAINT [AperturaCaja_idUsuario_fkey] FOREIGN KEY ([idUsuario]) REFERENCES [dbo].[Usuario]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[AperturaCaja] ADD CONSTRAINT [AperturaCaja_idEstado_fkey] FOREIGN KEY ([idEstado]) REFERENCES [dbo].[EstadoCaja]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Gastos] ADD CONSTRAINT [Gastos_idAperturaCaja_fkey] FOREIGN KEY ([idAperturaCaja]) REFERENCES [dbo].[AperturaCaja]([id]) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Gastos] ADD CONSTRAINT [Gastos_idTipoGasto_fkey] FOREIGN KEY ([idTipoGasto]) REFERENCES [dbo].[TipoGasto]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[CierreCaja] ADD CONSTRAINT [CierreCaja_idApertura_fkey] FOREIGN KEY ([idApertura]) REFERENCES [dbo].[AperturaCaja]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[ActividadesParque] ADD CONSTRAINT [ActividadesParque_idUsuarioCreador_fkey] FOREIGN KEY ([idUsuarioCreador]) REFERENCES [dbo].[Usuario]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ActividadesParque] ADD CONSTRAINT [ActividadesParque_idUsuarioResponsable_fkey] FOREIGN KEY ([idUsuarioResponsable]) REFERENCES [dbo].[Usuario]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ActividadesParque] ADD CONSTRAINT [ActividadesParque_idSectorParque_fkey] FOREIGN KEY ([idSectorParque]) REFERENCES [dbo].[SectorParque]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
