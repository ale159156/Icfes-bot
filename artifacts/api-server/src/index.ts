import app from "./app";
import { logger } from "./lib/logger";
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";

// --- 1. CONFIGURACIÓN ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const ai = new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"]! });
const drive = google.drive({ version: "v3", auth: process.env["DRIVE_API_KEY"] });

let cicloActivo = false;
let datosTriviaActual: any = null;

// --- 2. FUNCIONES LÓGICAS ---
async function obtenerContenidoYGenerarPregunta(intentos = 3) {
  for (let i = 0; i < intentos; i++) {
    try {
      const folderId = process.env["DRIVE_FOLDER_ID"];
      if (!folderId) throw new Error("DRIVE_FOLDER_ID no configurado");

      // 1. Obtenemos la lista AQUÍ, dentro del try
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "files(id, name, mimeType)"
      });

      const archivos = (res.data.files || []).filter(f => f.name?.endsWith('.txt') || f.name?.endsWith('.pdf'));
      if (archivos.length === 0) throw new Error("No hay archivos en la carpeta");

      // 2. Elegimos el archivo
      const arch = archivos[Math.floor(Math.random() * archivos.length)];
      const resCont = await drive.files.get({ fileId: arch.id!, alt: "media" }, { responseType: "text" });
      const texto = resCont.data.trim();

      // 3. Generamos contenido con IA
      const prompt = `Analiza el siguiente texto y busca una pregunta de examen tipo ICFES. 
      Si encuentras una pregunta con sus opciones (A, B, C, D), extráela. 
      Si el texto no contiene preguntas, responde SOLO con: {"error": "no pregunta"}.
      Texto: "${texto.substring(0, 3000)}"`;

      const response = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt });
      // ...

      const responseText = response.text || "";
      const startIndex = responseText.indexOf('{');
      const endIndex = responseText.lastIndexOf('}');
      if (startIndex === -1 || endIndex === -1) throw new Error("Formato JSON inválido");

      return JSON.parse(responseText.substring(startIndex, endIndex + 1));

    } catch (e: any) {
      console.warn(`Intento ${i + 1} fallido: ${e.message}`);
      if (e.status === 503 || e.message?.includes("503")) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        break; 
      }
    }
  }
  return null;
}

async function enviarJustificacion() {
  if (!datosTriviaActual) return;
  const canal = await client.channels.fetch(process.env["CANAL_ID"]!);
  if (canal?.isTextBased()) {
    let desc = Object.entries(datosTriviaActual.descartes).map(([k, v]) => `❌ **${k}:** ${v}`).join("\n");
    await canal.send({ embeds: [new EmbedBuilder().setTitle("✅ Justificación").setDescription(`Correcta: **${datosTriviaActual.opciones[datosTriviaActual.correcta]}**\n\n🟢 **Justificación:**\n${datosTriviaActual.justificacion}\n\n🔍 **Descartes:**\n${desc}`).setColor("#10B981")] });
  }
  datosTriviaActual = null;
  if (cicloActivo) setTimeout(iniciarCicloTrivias, 120000);
}

async function iniciarCicloTrivias() {
  console.log("DEBUG: Iniciando ciclo de trivia..."); // <--- ESTO SALDRÁ EN RENDER

  if (!cicloActivo) {
    console.log("DEBUG: Ciclo detenido, cancelando...");
    return;
  }

  const trivia = await obtenerContenidoYGenerarPregunta();
  if (!trivia) {
    console.log("DEBUG: Error al generar trivia con IA.");
    setTimeout(iniciarCicloTrivias, 60000); 
    return;
  }

  console.log("DEBUG: Trivia generada. Buscando canal ID:", process.env["CANAL_ID"]);

  datosTriviaActual = trivia;
  const canal = await client.channels.fetch(process.env["CANAL_ID"]!);

  if (canal?.isTextBased()) {
    console.log("DEBUG: Canal encontrado, enviando mensaje...");
    await canal.send({ embeds: [new EmbedBuilder().setTitle("📝 Simulacro ICFES").setDescription(`**${trivia.pregunta}**\n\n${trivia.opciones.join("\n")}`).setColor("#3B82F6")] });
    await canal.send({ poll: { question: { text: "Responde:" }, answers: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }], duration: 1 } });
    setTimeout(enviarJustificacion, 1800000);
    console.log("DEBUG: Mensaje enviado con éxito.");
  } else {
    console.log("DEBUG: ERROR CRÍTICO: No se pudo enviar mensaje. ¿Tiene el bot permiso para escribir en ese canal?");
  }
}

// --- 3. EVENTOS ---
client.once("clientReady", async () => {
  logger.info("Bot conectado.");
  logger.info("--- VERSIÓN DEL BOT: 2026-07-03 ---");
  const canal = await client.channels.fetch(process.env["CANAL_LOGS_ID"]!);
  if (canal?.isTextBased()) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("iniciar").setLabel("Iniciar").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("pausar").setLabel("Pausar").setStyle(ButtonStyle.Secondary)
    );
    await canal.send({ embeds: [new EmbedBuilder().setTitle("⚡ Centro de Activación")], components: [row] });
  }
});

client.on("interactionCreate", async (i) => {
  if (!i.isButton()) return;

  // Verificamos si ya fue diferida para evitar el error 10062
  if (!i.deferred && !i.replied) {
      await i.deferReply({ flags: [MessageFlags.Ephemeral] });
  }

  try {
    if (i.customId === "iniciar") {
      cicloActivo = true;
      await i.editReply("⚡ Ciclo iniciado. Generando pregunta...");

      // Ejecutamos la trivia sin bloquear el hilo principal
      iniciarCicloTrivias().catch(err => console.error(err));

    } else if (i.customId === "pausar") {
      cicloActivo = false;
      await i.editReply("⏸️ Ciclo pausado.");
    }
  } catch (e) { 
    console.error("Error en interacción:", e);
    // Solo intentamos editar si aún no hemos respondido
    if (!i.replied) {
        await i.editReply("❌ Error al procesar.");
    }
  }
});

client.login(process.env["DISCORD_TOKEN"]);

// --- 4. EXPRESS ---
const port = Number(process.env["PORT"] || 10000);
app.listen(port, () => logger.info({ port }, "Servidor y Bot activos"));