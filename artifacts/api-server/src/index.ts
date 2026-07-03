import app from "./app";
import { logger } from "./lib/logger";
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";

// 1. Validar variables de entorno obligatorias
const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required.");
const port = Number(rawPort);

const DISCORD_TOKEN = process.env["DISCORD_TOKEN"];
const GEMINI_API_KEY = process.env["GEMINI_API_KEY"];
const CANAL_ENCUESTAS_ID = process.env["CANAL_ID"];
const DRIVE_API_KEY = process.env["DRIVE_API_KEY"];
const DRIVE_FOLDER_ROOT_ID = process.env["DRIVE_FOLDER_ID"];

// 2. Levantar Express
app.listen(port, (err) => {
  if (err) { logger.error({ err }, "Error listening on port"); process.exit(1); }
  logger.info({ port }, "Server listening");
});

// 3. Inicializar Clientes
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Inicializar cliente de Google Drive usando la API Key proporcionada
const drive = google.drive({ version: "v3", auth: DRIVE_API_KEY });

let cicloActivo = false;
let temporizadorSolucion: NodeJS.Timeout | null = null;
let temporizadorSiguiente: NodeJS.Timeout | null = null;

// 4. Función para obtener contenido de Drive basado en la clasificación de carpetas
async function obtenerContextoDesdeDrive(): Promise<{ textoContexto: string; materia: string }> {
  try {
    // 1. Listar las subcarpetas (clasificaciones/materias) dentro de la carpeta raíz
    const resCategorias = await drive.files.list({
      q: `'${DRIVE_FOLDER_ROOT_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
    });

    const carpetas = resCategorias.data.files || [];
    if (carpetas.length === 0) {
      return { textoContexto: "", materia: "General" };
    }

    // Seleccionar una carpeta/materia clasificada al azar
    const carpetaSeleccionada = carpetas[Math.floor(Math.random() * carpetas.length)];
    const materia = carpetaSeleccionada.name || "General";

    // 2. Listar archivos dentro de esa subcarpeta específica
    const resArchivos = await drive.files.list({
      q: `'${carpetaSeleccionada.id}' in parents and trashed = false and (mimeType = 'text/plain' or mimeType = 'application/pdf' or mimeType = 'application/vnd.google-apps.document')`,
      fields: "files(id, name, mimeType)",
      limit: 10,
    });

    const archivos = resArchivos.data.files || [];
    if (archivos.length === 0) {
      return { textoContexto: "", materia };
    }

    // Tomar un archivo de estudio al azar dentro de la materia elegida
    const archivoElegido = archivos[Math.floor(Math.random() * archivos.length)];
    
    logger.info(`Leyendo material de la materia [${materia}], archivo: ${archivoElegido.name}`);

    // 3. Descargar el contenido del archivo (Optimizado para archivos de texto/documentos)
    // Nota: Para PDFs complejos se requeriría un parseador extra, aquí extraemos metadatos/texto plano disponible
    const resContenido = await drive.files.get({
      fileId: archivoElegido.id,
      alt: "media",
    }, { responseType: "text" });

    const textoContexto = typeof resContenido.data === "string" ? resContenido.data.substring(0, 4000) : ""; 
    return { textoContexto, materia };

  } catch (error) {
    console.error("❌ Error accediendo a Google Drive:", error);
    return { textoContexto: "", materia: "General" };
  }
}

// 5. Crear el Panel de Activación Fijo
async function inicializarPanelActivacion() {
  try {
    const canal = await client.channels.fetch(CANAL_ENCUESTAS_ID || "");
    if (!canal || !canal.isTextBased()) return;

    const mensajes = await canal.messages.fetch({ limit: 50 });
    const panelExiste = mensajes.some(m => m.embeds[0]?.title?.includes("⚡ Centro de Activación: Gonzo God"));
    if (panelExiste) return;

    const embedPanel = new EmbedBuilder()
      .setTitle("⚡ Centro de Activación: Gonzo God")
      .setDescription("Usa el botón de abajo para activar las trivias de simulación automatizadas basadas en tus carpetas clasificadas de Google Drive.")
      .setColor("#EAB308")
      .setFooter({ text: "Gonzo God Bot • Conectado a Google Drive" });

    const botonActivar = new ButtonBuilder()
      .setCustomId("activar_ciclo_bot")
      .setLabel("🔌 Activar Ciclo de Estudio")
      .setStyle(ButtonStyle.Success);

    const fila = new ActionRowBuilder<ButtonBuilder>().addComponents(botonActivar);
    await canal.send({ embeds: [embedPanel], components: [fila] });
  } catch (error) {
    console.error("❌ Error al crear el Panel:", error);
  }
}

// 6. Ciclo Principal con Inyección de Datos de Drive
async function iniciarCicloTrivias() {
  try {
    const canal = await client.channels.fetch(CANAL_ENCUESTAS_ID || "");
    if (!canal || !canal.isTextBased()) return;

    // Obtener el material de estudio clasificado de Drive de forma dinámica
    const { textoContexto, materia } = await obtenerContextoDesdeDrive();

    logger.info(`Solicitando pregunta a Gemini basada en el material de Drive de la materia: ${materia}...`);

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Eres un experto evaluador del Preicfes. Utiliza el siguiente fragmento de material de estudio adjunto para extraer o formular una pregunta rigurosa de opción múltiple de la materia "${materia}". 
      
      [MATERIAL DE ESTUDIO DE DRIVE]:
      ${textoContexto || "No hay texto disponible, genera una pregunta estándar de esta materia."}

      Devuelve UN JSON con este formato exacto: 
      {
        "pregunta": "enunciado de la pregunta basado en el texto", 
        "opciones": ["A) texto de la opción A", "B) texto de la opción B", "C) texto de la opción C", "D) texto de la opción D"], 
        "correcta": 0, 
        "justificacion": "explicación de por qué es la correcta según el material dado",
        "descartes": {
          "A": "por qué es incorrecta",
          "B": "por qué es incorrecta",
          "C": "por qué es incorrecta",
          "D": "por qué es incorrecta"
        }
      }`,
    });

    const textoLimpiado = response.text.replace(/```json|```/g, "").trim();
    const triviaData = JSON.parse(textoLimpiado);
    const textoOpciones = triviaData.opciones.join("\n");

    const embedPregunta = new EmbedBuilder()
      .setTitle(`📝 Simulacro Preicfes [Drive]: ${materia}`)
      .setDescription(`**${triviaData.pregunta}**\n\n${textoOpciones}`)
      .setColor("#3B82F6")
      .setFooter({ text: "Tienes 30 minutos para responder antes de la justificación." });

    const mensajeEnviado = await canal.send({ embeds: [embedPregunta] });

    await canal.send({
      poll: {
        question: { text: "Selecciona tu respuesta:" },
        answers: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }],
        allowMultiselect: false,
        duration: 1, 
      }
    });

    // Temporizador de 30 minutos para la solución
    temporizadorSolucion = setTimeout(async () => {
      try {
        let textoDescartes = "";
        for (const [letra, explicacion] of Object.entries(triviaData.descartes)) {
          textoDescartes += `❌ **Opción ${letra}:** ${explicacion}\n`;
        }

        const embedSolucion = new EmbedBuilder()
          .setTitle("✅ Solución y Análisis de Opciones")
          .setDescription(`La respuesta correcta era: **${triviaData.opciones[triviaData.correcta]}**\n\n🟢 **Justificación:**\n${triviaData.justificacion}\n\n🔍 **Análisis de los Descartes:**\n${textoDescartes}`)
          .setColor("#10B981");
        
        await canal.send({ embeds: [embedSolucion], reply: { messageReference: mensajeEnviado.id } });
      } catch (e) {
        console.error("❌ Error enviando la solución:", e);
      }

      if (cicloActivo) {
        temporizadorSiguiente = setTimeout(iniciarCicloTrivias, 10000);
      }
    }, 30 * 60 * 1000);

  } catch (error: any) {
    const errorStr = JSON.stringify(error) || "";
    const errMsg = error.message || "";

    if (errMsg.includes("429") || errorStr.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED")) {
      console.error("❌ CUOTA AGOTADA: Esperando 5 minutos...");
      temporizadorSiguiente = setTimeout(iniciarCicloTrivias, 5 * 60 * 1000); 
    } else {
      console.error("❌ ERROR EN TRIVIA (Reintentando en 30s):", errMsg);
      temporizadorSiguiente = setTimeout(iniciarCicloTrivias, 30000);
    }
  }
}

// 7. Interacciones del Botón
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === "activar_ciclo_bot") {
    if (cicloActivo) {
      return await interaction.reply({ content: "ℹ️ El ciclo ya está corriendo activamente con tus carpetas de Drive.", ephemeral: true });
    }

    try {
      cicloActivo = true;
      await interaction.reply({ content: "⚡ ¡Conexión con Google Drive establecida! Iniciando lectura de clasificaciones...", ephemeral: true });
      iniciarCicloTrivias();
    } catch (error) {
      console.error(error);
      cicloActivo = false;
    }
  }
});

client.once("ready", () => {
  logger.info(`¡Bot conectado exitosamente como ${client.user?.tag}!`);
  inicializarPanelActivacion();
});

if (DISCORD_TOKEN) { client.login(DISCORD_TOKEN); }
