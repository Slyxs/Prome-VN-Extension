# Plan: Contexto conversacional e historial de sprites/BG/CG

> Estado: planificación / no implementación.  
> Objetivo: mejorar la precisión del LLM en `analyzeMessageWithLLM` sin sobrecargar la llamada ni confundir al modelo.

---

## 1. Contexto conversacional (enviar historia al LLM)

### 1.1 Qué buscamos

El LLM actualmente clasifica **mensaje a mensaje**, sin recordar:

- Dónde está la escena actual (interior/exterior, ciudad, bosque, cafetería…).
- Qué hora del día es.
- Qué personajes están presentes.
- Qué evento narrativo acaba de ocurrir.

Añadiendo un resumen o ventana de contexto, el modelo podría:

- No cambiar el BG a menos que detecte una transición real de escenario.
- Mantener coherencia de expresiones entre mensajes consecutivos.
- Inferir "escenario implícito" cuando el texto no lo menciona explícitamente.

### 1.2 Riesgos principales

| Riesgo | Descripción |
|--------|-------------|
| **Confusión de temporalidad** | Si enviamos mensajes viejos como "contexto actual", el LLM puede creer que esos eventos están ocurriendo ahora. |
| **Aumento de tokens** | Cada mensaje añadido encarece la llamada y la hace más lenta. |
| **Ruido > señal** | Mensajes irrelevantes desvían la clasificación del mensaje actual. |
| **Dependencia de estado no guardado** | Si el resumen no se persiste, se pierde al recargar la página. |

### 1.3 Estrategias posibles

#### A) Ventana deslizante de últimos N mensajes

- Enviar los últimos `N` mensajes (por ejemplo, `3` a `7`) como contexto.
- Pros: simple, sin estado persistente.
- Contras: el modelo puede confundir "mensaje anterior" con "mensaje actual"; no captura escenarios estables a largo plazo.

#### B) Resumen acumulativo generado periódicamente

- Cada `X` mensajes (o cada `X` minutos), pedirle a un LLM económico un resumen de:
  - Ubicación actual.
  - Hora del día / clima.
  - Personajes presentes.
  - Estado emocional general / evento reciente.
- Guardar ese resumen en `extension_settings`.
- Incluir el resumen en el prompt de clasificación como "narrative context".
- Pros: barato (se regenera poco), estable, persistente.
- Contras: requiere un segundo prompt y decidir cuándo refrescarlo.

#### C) Detección de cambio de escenario + snapshot

- No enviar historial crudo.
- En cambio, detectar automáticamente cuándo el mensaje actual menciona un cambio de ubicación/escenario (por ejemplo, con keywords o con una mini-llamada).
- Actualizar un `currentScene` guardado.
- Enviar solo `currentScene` al prompt.
- Pros: mínimo ruido, muy preciso para BG.
- Contras: puede perderse cambios implícitos o sutiles.

#### D) Combinación: resumen ligero + últimos 2 mensajes

- Guardar un resumen acumulativo (estrategia B).
- Incluir también los últimos `1-2` mensajes **claramente etiquetados como previos**.
- Ejemplo de prompt:

```
Narrative context (maintained across the chat):
- Current location: Eldoria forest glade
- Time: late afternoon
- Present characters: Seraphina, user
- Recent event: user was rescued from beasts

Previous messages (for tone reference only):
[Seraphina]: "..."
[user]: "..."

Now classify THIS message:
[Seraphina]: "..."
```

### 1.4 Intervalo ideal para refrescar el contexto

| Opción | Cuándo | Para qué sirve |
|--------|--------|----------------|
| `x + 5` mensajes | Cada vez que el contador de mensajes desde el último resumen supere un umbral | Estabiliza escenarios sin saturar |
| Cada `N` mensajes fijos (p. ej. 10) | Predecible, fácil de explicar al usuario | Mantener resumen fresco |
| Al detectar posible cambio de escenario | Keyword/heurística en el mensaje actual | BG preciso sin llamadas extra |
| Manual (botón) | Usuario fuerza refresco | Casos especiales |
| Híbrido: cada `N` mensajes + triggers de escenario | Cubre ambos casos | Recomendado |

**Recomendación tentativa:**

- Refrescar resumen cada **10–15 mensajes** o cuando se detecte una palabra/cláusula de transición ("arrive at", "enter", "leave", "go to", "return to", "the next morning", etc.).
- No enviar mensajes crudos al prompt de clasificación; usar solo el resumen + el mensaje actual.

---

## 2. Historial de sprites / BG / CG

### 2.1 Qué buscamos

Actualmente cada mensaje se clasifica de forma independiente. Queremos un historial local que recuerde:

- Última expresión usada por personaje.
- Último BG usado en el chat.
- Último CG mostrado.

### 2.2 Usos posibles

| Uso | Descripción |
|-----|-------------|
| **Fallback de expresión** | Si un segmento no tiene expresión válida, usar la última del historial en lugar de la primera disponible. |
| **Revertir al borrar mensaje** | Si el usuario borra el último mensaje, restaurar la expresión/BG/CG anterior. |
| **Evitar cambios de BG espurios** | Si el LLM devuelve un BG nuevo sin justificación, comparar con el actual y rechazarlo si no hay evidencia de cambio. |
| **Coherencia entre mensajes** | Personaje no cambia de expresión radicalmente sin motivo entre un mensaje y otro. |

### 2.3 Dónde guardarlo

- En memoria dentro del módulo de análisis (array `history`).
- Opcionalmente persistir en `extension_settings` para sobrevivir recargas.
- Estructura sugerida:

```js
const spriteHistory = [
  {
    messageId: 42,
    characterName: "Seraphina",
    expression: "caring",
    background: "forest glade.jpg",
    cg: null,
    timestamp: Date.now(),
  },
  // ...
];
```

### 2.4 Intervalo / trigger

Este historial **no requiere LLM**, por lo que puede actualizarse:

- **Después de cada clasificación exitosa**: guardar el estado final aplicado.
- **Al borrar un mensaje**: hacer `pop()` o buscar el estado anterior por `messageId`.
- **Al cambiar de chat**: limpiar o recargar desde settings.

### 2.5 Integración con el prompt del LLM

Podemos añadir al prompt del clasificador una línea tipo:

```
Current active background: "forest glade.jpg"
Most recent expression for Seraphina: "caring"
```

Esto ayuda al modelo a:

- No inventar un BG diferente si la escena no cambia.
- Mantener continuidad de expresión cuando el texto es neutro.

---

## 3. Propuesta de arquitectura final (para discutir)

```
┌─────────────────────────────────────────────┐
│  Chat en SillyTavern                         │
│  (mensajes entrantes, borrados, cambios)    │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  Módulo de Historial (sin LLM)               │
│  - Guarda última expr/BG/CG por personaje   │
│  - Permite revertir al borrar mensaje       │
│  - Suministra estado actual al prompt       │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  Detectores de cambio de escenario           │
│  - Keywords/heurísticas                      │
│  - Opcional: mini-LLM para transiciones     │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  Resumen narrativo (LLM, poco frecuente)     │
│  - Se refresca cada N mensajes o trigger    │
│  - Guarda: ubicación, hora, personajes,     │
│    evento reciente                           │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  Clasificador de mensaje actual (LLM)        │
│  - Prompt = resumen + estado actual + msg   │
│  - Devuelve segmentos con expr/BG/CG         │
└─────────────────────────────────────────────┘
```

---

## 4. Preguntas pendientes para decidir implementación

1. ¿El resumen narrativo se genera con el **mismo endpoint/configuración** del análisis, o preferimos un modelo más barato/ligero?
2. ¿El historial de sprites/BG/CG debe **persistir** en `extension_settings` o basta con memoria de sesión?
3. ¿El usuario quiere un control UI para:
   - Forzar refresco de contexto manualmente?
   - Ajustar cada cuántos mensajes se refresca?
   - Ver el contexto actual y el historial?
4. ¿Se prefiere detectar cambios de escenario con **keywords** primero, o directamente con una llamada al LLM?
5. ¿El historial de sprites es por **personaje** o global del chat?

---

## 5. Recomendaciones iniciales

| Aspecto | Recomendación |
|---------|---------------|
| Contexto al LLM | **No enviar mensajes crudos**. Usar un resumen acumulativo ligero. |
| Refresco del resumen | Cada **10–15 mensajes** + triggers de cambio de escenario. |
| Historial de sprites/BG/CG | **Siempre activo**, actualizado post-clasificación, usado para fallback y revert. |
| BG en el prompt | Incluir el BG actual activo para evitar cambios espurios. |
| Expresiones en el prompt | Incluir "última expresión del personaje" como sugerencia, no como obligación. |

---

## 6. Posibles formatos de prompt con contexto

```
You are the narrative director of a visual novel-style roleplay chat.

=== NARRATIVE CONTEXT (maintained across the conversation) ===
- Current location: Eldoria forest glade
- Time of day: late afternoon
- Active background: "forest glade.jpg"
- Present characters: Seraphina, user
- Recent event: Seraphina rescued the user from beasts; they are now resting in her glade.

=== CURRENT MESSAGE TO CLASSIFY ===
[Seraphina]: "Well, yes — we're in a forest. Eldoria, to be precise..."

=== INSTRUCTIONS ===
- Use the narrative context only to understand the scene.
- Do NOT treat previous events as happening again unless the current message explicitly says so.
- Only change "background" if the current message explicitly describes a new location/scene.
- ... (resto de reglas actuales)
```

---

## 7. Notas de implementación futura

- El resumen narrativo podría almacenarse en `extension_settings[extensionName].narrativeContext`.
- El historial de sprites podría almacenarse en `extension_settings[extensionName].spriteHistory`.
- Sería útil exponer funciones como:
  - `updateNarrativeContext(messageId)`
  - `getCurrentBackground()`
  - `getLastExpression(characterName)`
  - `revertHistoryOnMessageDelete(messageId)`
- Considerar límite de tamaño del historial (ej. últimos 50 estados) para no inflar settings.
