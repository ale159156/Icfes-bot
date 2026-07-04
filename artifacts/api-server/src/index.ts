import app from "./app.js";
import { logger } from "./lib/logger.js";
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";

// --- 1. CONFIGURACIÓN ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const ai = new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"]! });
const drive = google.drive({ version: "v3", auth: process.env["DRIVE_API_KEY"] });

let cicloActivo = false;
let preguntasCache = []; // Caché inteligente
let timeoutHandle = null;

// --- 2. LÓGICA DE EXTRACCIÓN (NO MODIFICA, SOLO EXTRAE) ---
async function recargarCacheDePreguntas() {
    const res = await drive.files.list({ q: `'${process.env["DRIVE_FOLDER_ID"]}' in parents and trashed = false`, fields: "files(id, name)" });
    const archivos = (res.data.files || []).filter(f => f.name?.endsWith('.txt') || f.name?.endsWith('.pdf'));
    const arch = archivos[Math.floor(Math.random() * archivos.length)];
    const resCont = await drive.files.get({ fileId: arch.id!, alt: "media" }, { responseType: "text" });

    const prompt = `Extrae 5 preguntas de este texto tal cual. NO modifiques el enunciado ni las opciones.
    Devuelve SOLO un JSON:
    { "preguntas": [ { "pregunta": "...", "opciones": ["A) ...", "B) ...", "C) ...", "D) ..."], "correcta": 0, "justificacion": "...", "analisis_distractores": {"A": "...", "B": "...", "C": "...", "D": "..."} } ] }
    Texto: "${resCont.data.substring(0, 4000)}"`;

    const response = await ai.models.generateContent({ model: "gemini-2.0-flash", contents: prompt });
    const jsonString = response.text.match(/\{.*\}/s)[0];
    preguntasCache = JSON.parse(jsonString).preguntas;
}

// --- 3. FLUJO DE TRIVIA ---
async function iniciarCiclo() {
    if (!cicloActivo) return;
    if (preguntasCache.length === 0) await recargarCacheDePreguntas();
    
    const trivia = preguntasCache.shift();
    const canal = await client.channels.fetch(process.env["CANAL_ID"]!);

    const embed = new EmbedBuilder()
        .setTitle("📝 Simulacro ICFES")
        .setDescription(`${trivia.pregunta}\n\n${trivia.opciones.join("\n")}`)
        .setColor("#3B82F6");

    await canal.send({ embeds: [embed] });
    timeoutHandle = setTimeout(() => enviarJustificacion(trivia), 1800000); // 30 min
}

async function enviarJustificacion(trivia) {
    const canal = await client.channels.fetch(process.env["CANAL_ID"]!);
    const desc = Object.entries(trivia.analisis_distractores).map(([k, v]) => `❌ **${k}:** ${v}`).join("\n");
    
    await canal.send({ embeds: [new EmbedBuilder().setTitle("✅ Justificación").setDescription(`Correcta: **${trivia.opciones[trivia.correcta]}**\n\n${trivia.justificacion}\n\n🔍 **Distractores:**\n${desc}`).setColor("#10B981")] });
    if (cicloActivo) iniciarCiclo();
}

// --- 4. INTERACCIONES Y PANEL ---
client.once("clientReady", async () => {
    logger.info("Bot conectado.");
    const canal = await client.channels.fetch(process.env["CANAL_LOGS_ID"]!);
    // Borrar mensajes previos si deseas un panel único (opcional: limpiar canal)
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("iniciar").setLabel("Iniciar").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("pausar").setLabel("Pausar").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("saltar").setLabel("Saltar").setStyle(ButtonStyle.Primary)
    );
    await canal.send({ content: "### 🎮 Panel de Control ICFES", components: [row] });
});

client.on("interactionCreate", async (i) => {
    if (!i.isButton()) return;
    await i.deferReply({ flags: [MessageFlags.Ephemeral] });

    if (i.customId === "iniciar") {
        cicloActivo = true;
        iniciarCiclo();
        await i.editReply("⚡ Ciclo iniciado.");
    } else if (i.customId === "pausar") {
        cicloActivo = false;
        clearTimeout(timeoutHandle);
        await i.editReply("⏸️ Pausado.");
    } else if (i.customId === "saltar") {
        clearTimeout(timeoutHandle);
        iniciarCiclo();
        await i.editReply("⏭️ Saltando...");
    }
    setTimeout(() => i.deleteReply().catch(() => {}), 3000);
});

client.login(process.env["DISCORD_TOKEN"]);
app.listen(Number(process.env["PORT"] || 10000), () => logger.info("Servidor activo"));
