# =============================================================================
#  Backend (NestJS + Prisma/SQL Server)
#
#  Debian slim y no Alpine a propósito: los motores de Prisma para SQL Server se
#  compilan contra glibc y OpenSSL, y en Alpine (musl) hay que acertar con
#  `binaryTargets` o el cliente falla al conectar, en ejecución y no al compilar.
#  Con slim, `prisma generate` corre DENTRO de la imagen y resuelve el motor que
#  corresponde a esta plataforma sin configurar nada.
# =============================================================================

# --- Etapa 1: dependencias completas, cliente de Prisma y compilación --------
FROM node:24-slim AS builder

WORKDIR /app

# Los manifiestos primero: mientras no cambien, Docker reutiliza la capa de
# `npm ci`, que es la lenta.
COPY package*.json ./
COPY prisma.config.ts ./
RUN npm ci

# El esquema antes del resto del código: `prisma generate` solo depende de él.
# `prisma.config.ts` exige DATABASE_URL aunque generar no se conecta a la base:
# una dirección de relleno, solo para este paso, para no meter la real en la
# imagen. En ejecución la real llega por el .env del compose.
COPY prisma ./prisma
RUN DATABASE_URL="sqlserver://localhost:1433;database=build;user=build;password=build" npx prisma generate

COPY . .
RUN npm run build

# --- Etapa 2: tareas de administración ---------------------------------------
# `prisma db push` y los scripts de índices necesitan el CLI de Prisma y ts-node,
# que son dependencias de desarrollo. Esta etapa los conserva para poder correr
# esas tareas sin meterlas en la imagen que atiende peticiones.
FROM builder AS tareas

CMD ["sh", "-c", "npx prisma db push && npx ts-node prisma/aplicar-indices-offline.ts && npx ts-node prisma/aplicar-indices-reportes.ts"]

# --- Etapa 3: imagen de ejecución --------------------------------------------
FROM node:24-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Solo dependencias de producción: la imagen no necesita el compilador ni el CLI.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# El cliente generado. `@prisma/client` lo lee de `node_modules/.prisma`, así que
# se trae de la etapa de compilación en vez de volver a generarlo acá.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist

# Los logos que pdfkit mete en los PDF de tickets y recibos. El código los busca
# en `logos/optimizados` relativo al directorio de trabajo, así que tienen que
# existir ahí dentro del contenedor. Si faltan, el pase se emite igual pero sin
# logos y solo queda una advertencia en el log.
COPY --from=builder /app/logos/optimizados ./logos/optimizados

# Carpeta de las imágenes de actividades. Es un punto de montaje: sin el volumen
# del compose, lo que se suba vive solo hasta el siguiente redespliegue.
ENV UPLOADS_DIR=/app/uploads
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

# Sin esto el proceso corre como root dentro del contenedor.
USER node

EXPOSE 4000

# `dist/src/main` y no `dist/main`: hay un `prisma.config.ts` en la raíz, así que
# el compilador conserva la carpeta `src` en la salida.
CMD ["node", "dist/src/main"]
