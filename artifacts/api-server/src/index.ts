import app from "./app";
import { logger } from "./lib/logger";
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
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

// 2. Levantar Express para Render
app.listen(port, (err) => {
  if (err) { logger.error({ err }, "Error listening on port"); process.exit(1); }
  logger.info({ port }, "Server listening");
});

// 3. Inicializar Clientes
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const drive = google.drive({ version: "v3", auth: DRIVE_API_KEY });

let cicloActivo = false;
let temporizadorCiclo: NodeJS.Timeout | null = null;
let datosTriviaActual: any = null;

// 4. Función para obtener material de estudio clasificado de Google Drive
async function obtenerContextoDesdeDrive(): Promise<{ textoContexto: string; materia: string }> {
  try {
    // Listar las subcarpetas dentro de la carpeta raíz de Drive
    const resCategorias = await drive.files.list({
      q: `'${DRIVE_FOLDER_ROOT_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
    });

    const carpetas = resCategorias.data.files || [];
    if (carpetas.length === 0) return { textoContexto: "", materia: "General" };

    // Seleccionar una materia/subcarpeta al azar
    const carpetaSeleccionada = carpetas[Math.floor(Math.random() * carpetas.length)];
    const materia = carpetaSeleccionada.name || "General";

    // Listar archivos dentro de esa subcarpeta elegida
    const resArchivos = await drive.files.list({
      q: `'${carpetaSeleccionada.id}' in parents and trashed = false and (mimeType = 'text/plain' or mimeType = 'application/pdf' or mimeType = 'application/vnd.google-apps.document')`,
      fields: "files(id, name, mimeType)",
      limit: 10,
    });

    const archivos = resArchivos.data.files || [];
    if (archivos.length === 0) return { textoContexto: "", materia };

    // Tomar un archivo de estudio al azar
    const archivoElegido = archivos[Math.floor(Math.random() * archivos.length)];
    
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
      .setDescription("Usa el botón de abajo para iniciar el ciclo continuo de simulacros basados en tu material de Google Drive. Cada pregunta durará 30 minutos.")
      .setColor("#EAB308");

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

// 6. Ciclo Principal Automatizado (Pregunta -> 30 mins -> Justificación -> Siguiente Pregunta)
async function iniciarCicloTrivias() {
  try {
    const canal = await client.channels.fetch(CANAL_ENCUESTAS_ID || "");
    if (!canal || !canal.isTextBased()) return;

    // Obtener material clasificado de Drive
    const { textoContexto, materia } = await obtenerContextoDesdeDrive();

    // Generar la pregunta estructurada con Gemini 2.5 Flash
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Eres un experto evaluador del Preicfes. Utiliza el siguiente fragmento para formular una pregunta rigurosa de opción múltiple de la materia o tema "${materia}".
      
      [MATERIAL DE ESTUDIO DE DRIVE]:
      ${textoContexto || "Genera una pregunta estándar de esta materia."}

      Devuelve UN JSON estricto con este formato exacto:
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

    const textoLimpiado = response.text.replace(/```json|
