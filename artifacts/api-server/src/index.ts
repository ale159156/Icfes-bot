import app from "./app";
import { logger } from "./lib/logger";
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required.");
const port = Number(rawPort);

const DISCORD_TOKEN = process.env["DISCORD_TOKEN"];
const GEMINI_API_KEY = process.env["GEMINI_API_KEY"];
const CANAL_ENCUESTAS_ID = process.env["CANAL_ID"];
const DRIVE_API_KEY = process.env["DRIVE_API_KEY"];
const DRIVE_FOLDER_ROOT_ID = process.env["DRIVE_FOLDER_ID"];

app.listen(port, (err) => {
  if (err) { logger.error({ err }, "Error listening on port"); process.exit(1); }
  logger.info({ port }, "Server listening");
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const drive = google.drive({ version: "v3", auth: DRIVE_API_KEY });

let cicloActivo = false;
let temporizadorCiclo: NodeJS.Timeout | null = null;
let datosTriviaActual: any = null;

async function obtenerContextoDesdeDrive(): Promise<{ textoContexto: string; materia: string }> {
  try {
    const resCategorias = await drive.files.list({
      q: `'${DRIVE_FOLDER_ROOT_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
    });

    const carpetas = resCategorias.data.files || [];
    if (carpetas.length === 0) return { textoContexto: "", materia: "General" };

    const carpetaSeleccionada = carpetas[Math.floor(Math.random() * carpetas.length)];
    const materia = carpetaSeleccionada.name || "General";

    const resArchivos = await drive.files.list({
      q: `'${carpetaSeleccionada.id}' in parents and trashed = false and (mimeType = 'text/plain' or mimeType = 'application/pdf' or mimeType = 'application/vnd.google-apps.document')`,
      fields: "files(id, name, mimeType)",
      limit: 10,
    });

    const archivos = resArchivos.data.files || [];
    if (archivos.length === 0) return { textoContexto: "", materia };

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

async function iniciarCicloTrivias() {
  try {
    const canal = await client.channels.fetch(CANAL_ENCUESTAS_ID || "");
    if (!canal || !canal.isTextBased()) return;

    const { textoContexto, materia } = await obtenerContextoDesdeDrive();

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Eres un experto evaluador del Preicfes. Utiliza el siguiente fragmento para formular una pregunta de opción múltiple de la materia "${materia}".
      
      [MATERIAL DE ESTUDIO]:
      ${textoContexto || "Genera una pregunta estándar de esta materia."}

      Devuelve UN JSON estricto:
      {
        "pregunta": "enunciado", 
        "opciones": ["A) opción A", "B) opción B", "C) opción C", "D) opción D"], 
        "correcta": 0, 
        "justificacion": "explicación de la correcta",
        "descartes": {
          "A": "explicación A",
          "B": "explicación B",
          "C": "explicación C",
          "D": "explicación D"
        }
      }`,
    });

    const textoLimpiado = response.text.replace(/```json|```/g, "").trim();
    datosTriviaActual = JSON.parse(textoLimpiado);
    const textoOpciones = datosTriviaActual.opciones.join("\n");

    const embedPregunta = new EmbedBuilder()
      .setTitle(`📝 Simulacro Preicfes [Drive]: ${materia}`)
      .setDescription(`**${datosTriviaActual.pregunta}**\n\n${textoOpciones}`)
      .setColor("#3B82F6")
      .setFooter({ text: "La justificación general se enviará automáticamente en 30 minutos." });

    await canal.send({ embeds: [embedPregunta] });

    await canal.send({
      poll: {
        question: { text: "Selecciona tu respuesta:" },
        answers: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }],
        allowMultiselect: false,
        duration: 1, 
      }
    });

    temporizadorCiclo = setTimeout(async () => {
      try {
        let textoDescartes = "";
        for (const [letra, explicacion] of Object.entries(datosTriviaActual.descartes)) {
          textoDescartes += `❌ **Opción ${letra}:** ${explicacion}\n`;
        }

        const embedSolucion = new EmbedBuilder()
          .setTitle("✅ Justificación General del Ejercicio")
          .setDescription(`La opción correcta era: **${datosTriviaActual.opciones[datosTriviaActual.correcta]}**\n\n🟢 **Justificación:**\n${datosTriviaActual.justificacion}\n\n🔍 **Análisis de los Descartes:**\n${textoDescartes}`)
          .setColor("#10B981");

        await canal.send({ embeds: [embedSolucion] });

        if (cicloActivo) {
          setTimeout(iniciarCicloTrivias, 5000); 
        }
      } catch (e) {
        console.error("❌ Error enviando la justificación:", e);
        if (cicloActivo) iniciarCicloTrivias();
      }
    }, 30 * 60 * 1000);

  } catch (error: any) {
    console.error("❌ Error en el ciclo:", error);
    if (cicloActivo) temporizadorCiclo = setTimeout(iniciarCicloTrivias, 60000);
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === "activar_ciclo_bot") {
    if (cicloActivo) {
      return await interaction.reply({ content: "ℹ️ El ciclo ya está corriendo.", ephemeral: true });
    }

    try {
      cicloActivo = true;
      await interaction.reply({ content: "⚡ ¡Conexión establecida con Drive! Iniciando simuladores automáticos de 30 minutos...", ephemeral: true });
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
