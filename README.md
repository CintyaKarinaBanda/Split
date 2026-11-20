# SPLIT — Las cuentas claras 💜

MVP Full Stack para dividir gastos en grupo. Incluye frontend React, API Express, base de datos SQLite real, cálculos en centavos, sugerencias para liquidar deudas, grupos, integrantes y gastos persistentes.

## Requisitos
- Windows 10/11 (también Mac/Linux)
- Node.js 24 y npm

## Arrancar
Desde PowerShell, abre esta carpeta y ejecuta lo siguiente. En CMD puedes usar `npm` en lugar de `npm.cmd`.

```powershell
npm.cmd install
npm.cmd run install:all
npm.cmd run dev
```

Abre **http://127.0.0.1:5173**. Puedes comprobar el estado de la API en `http://127.0.0.1:3001/api/health`.

El primer arranque carga un grupo de demostración llamado *Viaje a la playa*. Los datos quedan guardados en `server/data/split.sqlite`. No hace falta instalar SQLite por separado: se usa `node:sqlite` de Node.js.

## Scripts
- `npm run dev`: inicia frontend y backend.
- `npm test`: ejecuta las pruebas unitarias y el flujo REST con SQLite temporal, incluida la persistencia tras reiniciar. La prueba de integración abre un puerto local efímero.
- `npm run build`: genera la versión de producción del frontend.
- `npm start`: sirve la interfaz compilada y la API privada desde Express.
- `npm run backup -- ruta/respaldo.sqlite`: copia en línea la base de `DB_PATH`, comprueba su integridad y rechaza sobrescribir un archivo.

## Arquitectura
- `client/src/App.jsx`: interfaz, estado del grupo activo y llamadas a la API. En desarrollo, Vite redirige `/api` a Express.
- `client/src/money.js`: conversión directa de texto a centavos y formato MXN para la vista.
- `client/src/styles.css`: diseño responsive y animaciones.
- `server/index.js`: rutas REST, validaciones y SQL.
- `server/access.js`: sesiones e invitaciones de un solo uso con autorización por plan.
- `server/db.js`: esquema SQLite y datos demo.
- `server/logic.js`: división de centavos y cálculo de balances.

## Endpoints
- `GET /api/health`
- `GET | POST | DELETE /api/session` — consulta, activa con `{ "code": "…" }` o cierra una sesión
- `POST /api/groups/:id/invite` — genera una invitación nueva, disponible para la persona administradora
- `DELETE /api/groups/:id/guest-access` — revoca los accesos de invitados a ese plan y su invitación sin usar
- `GET /api/groups`
- `POST /api/groups` — `{ "name": "Nueva salida", "emoji": "🍕" }`
- `GET /api/groups/:id`
- `DELETE /api/groups/:id` — elimina el plan y sus movimientos
- `GET /api/groups/:id/people` — lista personas disponibles para agregar al plan
- `POST /api/groups/:id/members` — acepta `name` para crear o `person_key` para reutilizar a una persona, con `expense_ids` opcional para recalcular gastos anteriores
- `PATCH /api/groups/:id/members/:memberId` — actualiza el nombre con `{ "name": "Alex" }`
- `DELETE /api/groups/:id/members/:memberId` — quita al integrante de los gastos futuros y conserva su historial
- `POST /api/groups/:id/recalculate-shares` — con `expense_ids`, vuelve a dividir esos gastos entre sus participantes activos
- `POST /api/groups/:id/expenses` — `{ "description": "Pizza", "amount_cents": 30000, "paid_by": 1, "participant_ids": [1,2,3], "category": "Comida" }`
- `PATCH /api/groups/:id/expenses/:expenseId` — modifica los campos indicados y actualiza el reparto cuando cambian el importe o los participantes
- `DELETE /api/groups/:id/expenses/:expenseId`
- `POST /api/groups/:id/settlements` — `{ "from_member": 2, "to_member": 1, "amount_cents": 10000 }`
- `DELETE /api/groups/:id/settlements/:settlementId` — deshace ese registro y devuelve los saldos recalculados

## Beta privada en producción

`npm run dev` conserva el modo local de demostración. En producción, la persona administradora inicia sesión con su clave y puede crear planes, invitar y revocar accesos. Cada invitación vence en 24 horas, se usa una sola vez y autoriza al navegador a ver y editar un plan. La sesión se guarda en una cookie segura y vence en 30 días. Para entrar desde otro navegador o tras cerrar la sesión, la persona invitada necesita otro enlace. La membresía del plan y el registro de quien participó en un gasto son independientes.

1. Genera una clave de administración aleatoria con `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Guárdala en tu gestor de contraseñas y configúrala como `SPLIT_OWNER_KEY` en el hosting.
2. Para probar en tu equipo, configura `SPLIT_OWNER_KEY`, `DB_PATH` con una ruta de SQLite distinta a la demo, y `HOST=127.0.0.1` mediante la terminal o un archivo `.env` en la raíz. Ejecuta `npm run build` y `npm start`. Si ambas versiones corren a la vez, configura también otro `PORT`, por ejemplo `3100`. Abre la URL de loopback que indica la consola.
3. Para desplegar en Render, conecta un repositorio con este código y crea un Blueprint usando `render.yaml`. Provisiona una instancia Starter de pago con un disco persistente de 1 GB, usa `/var/data/split.sqlite` para la base y sirve la app detrás del HTTPS de Render. Empieza con un archivo nuevo en el volumen. Si decides migrar datos de la demo, importa deliberadamente un respaldo verificado. [Blueprints de Render](https://render.com/docs/infrastructure-as-code)
4. Antes de usar datos reales, intercambia una invitación ficticia en dos navegadores, verifica que el invitado solo vea su plan y prueba una restauración en una instancia separada. Ejecuta el respaldo con `npm run backup -- ruta/respaldo.sqlite` y conserva una copia fuera del volumen de la aplicación. Para restaurar, detén el servicio y usa el respaldo verificado como archivo SQLite en `DB_PATH` antes de volver a iniciarlo.

SPLIT registra gastos y pagos en MXN. La transferencia se realiza fuera de la app. Las sugerencias calculan pagos válidos a partir de los saldos netos. La beta funciona con una sola instancia y un acceso de administración.

## Preparación para entrevista
1. Crea un grupo y agrega a Ana, Luis y Sofía. Registra un gasto de **$1.00** pagado por Ana y dividido entre los tres.
2. Sigue el dato desde React. El formulario convierte el texto a `100` centavos y envía `POST /api/groups/:id/expenses` con el pagador y los participantes. Vite reenvía la petición a Express.
3. Explica la transacción. Express valida que los participantes pertenezcan al grupo y guarda el gasto en `expenses` y sus partes en `expense_shares`. Se guardan juntos para evitar gastos incompletos. El cociente entero da 33 centavos por persona y el primer participante recibe el centavo sobrante.
4. Lee el resultado. Express acredita 100 centavos a Ana y descuenta a cada persona su parte. Devuelve saldos de +66, −33 y −33 centavos. React actualiza el panel con el JSON de la API.
5. Marca los dos pagos de $0.33. Express valida cada importe contra la deuda pendiente y registra el movimiento en `settlements`. Cada pago aumenta el saldo del deudor y reduce el del acreedor en la misma cantidad. Recarga para comprobar los saldos en cero.

## Cambios de esta iteración

- Desde la tarjeta **Integrantes** se puede agregar, renombrar o quitar a alguien. Una persona comparte su nombre entre planes y cada plan lleva sus saldos por separado. Los registros anteriores a esta función conservan sus identidades individuales.
- Al agregar a alguien, los gastos históricos quedan sin seleccionar por defecto. La API vuelve a dividir en centavos los gastos seleccionados dentro de la misma transacción del alta, conserva los pagos registrados y devuelve los saldos y sugerencias recalculados.
- Quitar a alguien retira su fila del **Balance del grupo** y permite volver a repartir los gastos seleccionados. **Pagos pendientes → Revisar repartos** ofrece el mismo ajuste para personas que ya habían salido. Se conservan la persona que adelantó el importe y los pagos efectuados.
- Cada gasto se puede editar o eliminar desde **Movimientos recientes**. Las sugerencias se recalculan a partir del nuevo reparto y los pagos registrados se conservan.
- **Pagos pendientes** ofrece tres vistas. **Por persona** agrupa por quien paga y muestra el estado de cada transferencia. **Pendientes** y **Registrados** separan las sugerencias de los pagos efectuados.
- En **Registrados**, **Deshacer** corrige un pago marcado por error. **Copiar resumen** copia las transferencias pendientes y el total en MXN para compartirlos en el chat.
- Desde **Balance del grupo** o **Pagos pendientes** puedes abrir el desglose de una persona. Muestra el dinero adelantado, su parte de los gastos, los pagos enviados y recibidos, y las transferencias sugeridas para liquidar su saldo neto.
- **Movimientos recientes** y **Balance del grupo** muestran hasta cuatro filas a la vez. Se puede recorrer el resto dentro de cada panel.
- **Eliminar plan** pide confirmación antes de eliminar sus movimientos e integrantes. Las otras membresías de las mismas personas se conservan.
- El panel prioriza el grupo activo y sus acciones, adapta las tarjetas y la navegación a pantallas pequeñas y respeta la preferencia de movimiento reducido.
- Se deshabilita el alta de gastos en grupos vacíos. Los formularios presentan errores en su propio diálogo y la navegación descarta las respuestas de solicitudes de grupos anteriores.
- Los importes aceptan punto o coma decimal, con hasta dos decimales. La API valida los centavos enteros y permite saldar una deuda acumulada superior al límite de un gasto individual.
- La prueba de integración cubre altas, el reparto con resto, datos inválidos, pagos duplicados y persistencia en disco.
#   S p l i t  
 