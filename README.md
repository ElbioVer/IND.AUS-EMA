# Indicador de Ausentismo / Presentismo

Aplicación web de EMA Servicios para seguir el **ausentismo y presentismo del personal** por Unidad de Negocio, Gerencia, Departamento y Sector. Funciona desde cualquier PC o celular, se puede instalar como app (PWA) y los datos quedan guardados en el servidor: no hace falta volver a cargar los archivos en cada visita.

## Qué muestra

| Pestaña | Contenido |
|---|---|
| **Resumen** | Indicadores generales, ranking de Unidades de Negocio y cumplimiento del objetivo de ausentismo (semáforo). |
| **Resumen por Gerencia** | El mismo análisis para una Gerencia elegida, desglosado por Departamento. |
| **Evolución mensual** | Tendencia del ausentismo mes a mes frente al objetivo. |
| **Tipos de ausencia** | Composición por tipo y por motivo, y gráfico AP vs ANP. |
| **Crónicos** | Casos de ausencia continua: días corridos (tolerando fines de semana, feriados y días "con aviso"), tipo calculado automáticamente (Actual, Crónico, Reserva de Puesto, Proceso de Baja), fecha de inicio editable y alertas por fecha de notificación (naranja una semana antes, rojo desde el día). |
| **Ranking** | Posiciones por unidad con filtros por motivo y agrupador. |
| **Detalle Empleados** | Ficha de un empleado, días por categoría y detalle de ausencias; se puede imprimir (horizontal). |
| **Gestión de Plantel** | Carga y actualización del plantel (altas y bajas) y control de consistencia. |

Los filtros globales son **Mes, Gerencia, Departamento y Sector**. Los motivos de ausencia (AP/ANP) que se excluyen del cálculo se pueden tildar o destildar y se aplican en toda la app.

## Cómo calcula

- **Ausentismo %** = ausencias contadas (AP + ANP, menos los motivos excluidos) sobre los jornales de dotación.
- Con plantel cargado, la dotación se calcula por **días activos** de cada legajo (alta/baja) dentro del período; sin plantel, se cuentan las filas del Excel.

## Uso

**Consulta (uso diario):** abrir la app e ingresar con usuario y contraseña. Nada más.

**Actualización (administrador):**
1. **Ausentismo:** *Actualizar archivo* con el Excel nuevo. Muestra un resumen (filas nuevas, modificadas, sin cambios) y, al confirmar, sube solo lo nuevo o modificado. Nada de lo cargado se borra.
2. **Plantel:** pestaña *Gestión de Plantel* → *Actualizar plantel* (.xlsx o .csv). Se revisan las columnas detectadas y se suben solo los legajos nuevos o modificados.

## Cómo cuida el consumo de datos

- Cada dispositivo guarda una copia local (IndexedDB). La primera vez descarga todo; después, al abrir, solo pide lo que cambió desde la última visita.
- Las librerías externas y la propia app quedan en caché del navegador/PWA.
- Las cargas de archivos envían únicamente filas nuevas o modificadas, para que el resto de los usuarios tampoco tenga que volver a descargar la base completa.
- No hay actualización automática en segundo plano ni conexiones permanentes.

## Instalar como app

- **PC (Chrome/Edge):** ícono de instalar en la barra de direcciones, o menú ⋮ → *Instalar*.
- **Android (Chrome):** menú ⋮ → *Instalar aplicación*.
- **iPhone (Safari):** Compartir → *Añadir a pantalla de inicio*.

## Tecnología y archivos

Una sola página HTML (React, SheetJS y Supabase vía CDN), publicada en GitHub Pages. Los datos y el acceso por usuario están en **Supabase** (tablas `ausentismo_registros`, `plantel_empleados`, `cronicos_casos`, `cronicos_config`, con acceso restringido a usuarios autenticados).

| Archivo | Función |
|---|---|
| `index.html` | La aplicación completa |
| `manifest.webmanifest`, `sw.js` | Instalación como app y caché |
| `icon-*.png`, `apple-touch-icon.png`, `favicon-48.png` | Íconos |

Para publicar un cambio: subir los archivos modificados al repositorio (*Add file → Upload files → Commit*). Los usuarios reciben la versión nueva al volver a abrir la app.

## Mantenimiento (plan gratuito de Supabase)

- Si nadie usa la app durante ~7 días, el proyecto gratuito puede pausarse; se reactiva desde el panel de Supabase.
- Conviene revisar de vez en cuando *Settings → Usage* (tráfico y tamaño de la base).
- Recomendado una sola vez, en el *SQL Editor*, para acelerar las consultas de novedades:

```sql
create index if not exists ausentismo_registros_updated_at_idx on public.ausentismo_registros (updated_at);
create index if not exists plantel_empleados_updated_at_idx on public.plantel_empleados (updated_at);
```
