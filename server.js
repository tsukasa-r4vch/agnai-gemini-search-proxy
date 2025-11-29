import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-2.5-flash-lite";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const OPENROUTER_MODELS = [
  "openrouter:google/gemini-2.0-flash-exp:free"
];
const GEMINI_MODELS = [
  "models/gemini-2.0-flash-lite",
  "models/gemini-2.5-flash-lite"
];

// -----------------------------
// サービス稼働確認
// -----------------------------
app.get("/", (_, res) =>
  res.send(`✅ Gemini + OpenRouter Proxy running`)
);

// -----------------------------
// モデル一覧取得 (OpenAI互換)
// -----------------------------
app.get("/v1/models", (_, res) => {
  const models = [
    ...GEMINI_MODELS.map((m) => ({ id: m, object: "model" })),
    ...OPENROUTER_MODELS.map((m) => ({ id: m, object: "model" }))
  ];
  res.json({ data: models });
});

// -----------------------------
// OpenAI互換エンドポイント
// -----------------------------
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { model, messages } = req.body;
    const selectedModel = model || GEMINI_MODEL;

    // 入力チェック
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "No messages found" });
    }

    // -----------------------------
    // システムプロンプト
    // -----------------------------
    const systemPrompt = messages.find(m => m.role === "system")?.content || "";

    // -----------------------------
    // 会話履歴
    // -----------------------------
    const chatHistory = messages
      .filter(m => m.role !== "system")
      .map(m => `${m.role}: ${m.content}`)
      .join("\n\n");

    const prompt = `
システムプロンプト:
${systemPrompt}

会話履歴:
${chatHistory}
    `;

    // -----------------------------
    // API判定
    // -----------------------------
    let apiUrl, apiKeyHeader, body;

    if (selectedModel.startsWith("openrouter:")) {
      // OpenRouter
      const modelName = selectedModel.replace("openrouter:", "");
      apiUrl = `https://openrouter.ai/api/v1/chat/completions`;

      apiKeyHeader = { Authorization: `Bearer ${OPENROUTER_API_KEY}` };
      body = {
        model: modelName,
        messages: [{ role: "user", content: prompt }]
      };
    } else {
      // Gemini
      apiUrl = `https://generativelanguage.googleapis.com/v1beta/${selectedModel}:generateContent?key=${GEMINI_API_KEY}`;
      apiKeyHeader = {};
      body = {
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      };
    }

    // -----------------------------
    // API実行（429時リトライ）
    // -----------------------------
    let answer = "（回答が得られませんでした）";
    const maxRetries = 5;
    let attempt = 0;

    while (attempt < maxRetries) {
      const apiRes = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeader },
        body: JSON.stringify(body)
      });

      const data = await safeJson(apiRes);

      if (selectedModel.startsWith("openrouter:")) {
        answer = data?.choices?.[0]?.message?.content || answer;
      } else {
        answer = data?.candidates?.[0]?.content?.parts?.[0]?.text || answer;
      }

      if (answer !== "（回答が得られませんでした）") break;

      if (apiRes.status === 429) {
        console.warn(`⚠️ Rate limited, retrying in 1s... (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, 1000));
        attempt++;
      } else {
        break;
      }
    }

    // -----------------------------
    // OpenAI形式で返す
    // -----------------------------
    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: selectedModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: answer },
          finish_reason: "stop"
        }
      ]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------
// 安全なJSON解析
// -----------------------------
async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error("⚠️ Invalid JSON:", text.slice(0, 500));
    return {};
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🌐 Server running on port ${PORT}`)
);
