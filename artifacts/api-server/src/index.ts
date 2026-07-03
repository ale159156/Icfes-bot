import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";
import http from "http";

// 1. SERVIDOR WEB (Obligatorio para que Render mantenga el puerto abierto)
const server = http.createServer((req, res) => res.end("Bot activo"));
server.listen(process.env.PORT || 3000);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const ai = new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"]! });
const drive = google.drive({ version: "v3", auth: process.env["DRIVE_API_KEY"] });

let cicloActivo = false;
let datosTriviaActual: any = null;

// 2. FUNCIÓN PARA OBTENER CONTENIDO (Con filtro estricto anti-basura)
async function obtenerContenidoValido(): Promise<{ texto: string; materia: string }> {
  try {
    const res = await drive.files.list({ q: `'${process.env["DRIVE_FOLDER_ID"]}' in parents and trashed = false`, fields: "files(id, name)" });
    const archivos = (res.data.files || []).filter(f => f.name?.endsWith('.txt') || f.name?.endsWith('.pdf'));
    if (archivos.length === 0) return { texto: "", materia: "" };

    const arch = archivos[Math.floor(Math.random() * archivos.length)];
    const resCont = await drive.files.get({ fileId: arch.id!, alt: "media" }, { responseType: "text" });
    const texto = resCont.data.trim();

    // Filtro: Si detecta metadatos técnicos de escaneo, descarta el archivo
    if (texto.length < 500 || texto.toLowerCase().includes("camscanner")) return { texto: "", materia: "" };
    return { texto: texto.substring(0, 4000), materia: arch.name! };
  } catch { return { texto: "", materia: "" }; }
}

// 3. CICLO DE PREGUNTAS (Con manejo de errores para evitar que se detenga)
async function iniciarCicloTrivias() {
  if (!cicloActivo) return;

  const { texto, materia } = await obtenerContenidoValido();
  if (!texto) { setTimeout(iniciarCicloTrivias, 60000); return; }

  try {
    const response = await ai.models.generateContent({ 
        model: "gemini-2.0-flash", 
        contents: `Eres un tutor experto ICFES. Crea UNA pregunta de opción múltiple basada en este texto: ${texto}. Devuelve SOLO JSON: {"pregunta": "...", "opciones": ["A) ...", "B) ...", "C) ...", "D) ..."], "correcta": 0, "justificacion": "...", "descartes": {"A": "...", "B": "...", "C": "...", "D": "..."}}` 
    });

    datosTriviaActual = JSON.parse(response.text.replace(/```json|```/g, "").trim());
    const canal = await client.channels.fetch(process.env["CANAL_ID"]!);

    if (canal?.isTextBased()) {
      await canal.send(`@everyone ¡Nueva pregunta de simulacro! [${materia}]`);
      await canal.send({ embeds: [new EmbedBuilder().setTitle("📝 Simulacro ICFES").setDescription(`**${datosTriviaActual.pregunta}**\n\n${datosTriviaActual.opciones.join("\n")}`).setColor("#3B82F6")] });
      await canal.send({ poll: { question: { text: "Responde:" }, answers: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }], duration: 1 } });
      setTimeout(enviarJustificacion, 1800000); // 30 min para responder
    }
  } catch (e) { setTimeout(iniciarCicloTrivias, 60000); } // Reintenta si hay error
}

async function enviarJustificacion() {
  if (!datosTriviaActual) return;
  const canal = await client.channels.fetch(process.env["CANAL_ID"]!);
  if (canal?.isTextBased()) {
    let desc = "";
    ["A", "B", "C", "D"].forEach((l, i) => { if (i !== datosTriviaActual.correcta) desc += `❌ **${l}:** ${datosTriviaActual.descartes[l]}\n`; });
    await canal.send({ embeds: [new EmbedBuilder().setTitle("✅ Justificación").setDescription(`Correcta: **${datosTriviaActual.opciones[datosTriviaActual.correcta]}**\n\n🟢 **Justificación:**\n${datosTriviaActual.justificacion}\n\n🔍 **Descartes:**\n${desc}`).setColor("#10B981")] });
  }
  datosTriviaActual = null;
  if (cicloActivo) setTimeout(iniciarCicloTrivias, 120000); 
}

// 4. INICIALIZACIÓN Y LIMPIEZA DE BOTONES (Soluciona "Interaction failed")
client.once("ready", async () => {
  const canal = await client.channels.fetch(process.env["CANAL_LOGS_ID"]!);
  if (canal?.isTextBased()) {
    const msgs = await canal.messages.fetch({ limit: 5 });
    for (const msg of msgs.values()) if (msg.author.id === client.user?.id) await msg.delete().catch(() => {});

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("iniciar").setLabel("Iniciar").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("pausar").setLabel("Pausar").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("saltar").setLabel("Saltar").setStyle(ButtonStyle.Danger)
    );
    await canal.send({ embeds: [new EmbedBuilder().setTitle("⚡ Centro de Activación").setDescription("Controles remotos")], components: [row] });
  }
});

client.on("interactionCreate", async (i) => {
  if (!i.isButton()) return;
  await i.reply({ content: "Procesando...", flags: [MessageFlags.Ephemeral] }); // Usa flags en vez de ephemeral
  if (i.customId === "iniciar") { cicloActivo = true; iniciarCicloTrivias(); await i.editReply("⚡ Ciclo iniciado."); }
  else if (i.customId === "pausar") { cicloActivo = false; await i.editReply("⏸️ Ciclo pausado."); }
  else if (i.customId === "saltar") { enviarJustificacion(); await i.editReply("⏭️ Saltando..."); }
});

client.login(process.env["DISCORD_TOKEN"]);